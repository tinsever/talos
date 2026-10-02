import { Agent as HTTPAgent, request as httpRequest } from "node:http";
import { Agent as HTTPSAgent, request as httpsRequest } from "node:https";
import type { ClientRequest } from "node:http";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

class HTTPResponse extends Response {
  #address: string;
  constructor(body: BodyInit | null, init: ResponseInit, address: string) {
    super(body, init);
    this.#address = address;
  }
  override get url(): string { return this.#address; }
  override clone(): HTTPResponse {
    const clone = super.clone();
    return new HTTPResponse(clone.body, {
      status: clone.status, statusText: clone.statusText, headers: clone.headers,
    }, this.#address);
  }
  override blob(): Promise<Blob> {
    if (!process.versions.bun) return super.blob();
    // Bun 1.4.2 loses the MIME type when blob() consumes a Web stream. Let its
    // buffered Response path apply native MIME parsing, including invalid types.
    return this.arrayBuffer().then(bytes => new Response(bytes, { headers: this.headers }).blob());
  }
}

export interface NodeHTTPTransportOptions {
  /** Maximum pooled sockets per origin. Defaults to 10. */
  maxConnections?: number;
}
export interface NodeHTTPTransport {
  /** Inject into RESTOptions.fetch; JSON API requests use bounded HTTP/HTTPS pools. */
  fetch: typeof globalThis.fetch;
  /** Cancel pooled work and close its sockets. Call after disconnecting clients. */
  close(): void;
}

/** Optional Node transport. Multipart, Request objects, and redirects use native fetch. */
export function nodeHTTPTransport(
  options: NodeHTTPTransportOptions = {},
): NodeHTTPTransport {
  const capacity = options.maxConnections ?? 10;
  if (!Number.isInteger(capacity) || capacity < 1)
    throw new RangeError("maxConnections must be a positive integer");
  let closed = false;
  let http: HTTPAgent | undefined;
  let https: HTTPSAgent | undefined;
  const active = new Map<ClientRequest, (reason: unknown) => void>();
  const fallback = globalThis.fetch;
  const agentOptions = {
    keepAlive: true,
    maxSockets: capacity,
    maxFreeSockets: capacity,
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (closed) throw new Error("Node HTTP transport is closed");
    // Preserve the runtime's complete body serialization and redirect behavior
    // outside the simple JSON API path. Never buffer multipart uploads here.
    if (input instanceof Request || init?.redirect !== "error" ||
        init.cache !== undefined || init.integrity !== undefined ||
        init.keepalive !== undefined || init.mode !== undefined ||
        init.referrer !== undefined || init.referrerPolicy !== undefined ||
        (init.body !== undefined && init.body !== null && typeof init.body !== "string")) {
      if (!fallback) throw new TypeError("This operation requires native fetch");
      return fallback(input, init);
    }
    const url = new URL(String(input));
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username || url.password)
      throw new TypeError("Expected an HTTP(S) URL without credentials");
    const headers = new Headers(init.headers);
    init.signal?.throwIfAborted();
    const method = init.method?.toUpperCase() ?? "GET";
    if (init.body !== undefined && init.body !== null && (method === "GET" || method === "HEAD"))
      throw new TypeError("GET/HEAD requests cannot have a body");
    if (!headers.has("Accept")) headers.set("Accept", "*/*");
    if (!headers.has("Accept-Encoding")) headers.set("Accept-Encoding", "gzip, deflate, br");
    if (typeof init.body === "string" && !headers.has("Content-Type"))
      headers.set("Content-Type", "text/plain;charset=UTF-8");
    const secure = url.protocol === "https:";
    const agent = secure ? (https ??= new HTTPSAgent(agentOptions)) :
      (http ??= new HTTPAgent(agentOptions));
    return new Promise<Response>((resolve, reject) => {
      const request = (secure ? httpsRequest : httpRequest)(url, {
        agent,
        method,
        headers: Object.fromEntries(headers),
      }, (incoming) => {
        try {
          const responseHeaders = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2)
            responseHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
          const status = incoming.statusCode!;
          if ([301, 302, 303, 307, 308].includes(status) && responseHeaders.has("Location")) {
            incoming.destroy();
            reject(new TypeError("Unexpected API redirect"));
            return;
          }
          const empty = method === "HEAD" || status === 204 || status === 205 || status === 304;
          let body: Readable = incoming;
          if (empty) incoming.resume();
          else {
            // Decode stacked content codings in reverse order. pipeline forwards
            // truncated transport/compression errors to the response body.
            const codings = responseHeaders.get("Content-Encoding")?.toLowerCase().split(",").map(value => value.trim()) ?? [];
            const decoders = codings.reverse().map(coding =>
              coding === "gzip" || coding === "x-gzip" ? createGunzip() :
              coding === "deflate" ? createInflate() :
              coding === "br" ? createBrotliDecompress() : undefined);
            if (decoders.length > 0 && decoders.every(decoder => decoder !== undefined)) {
              for (const decoder of decoders) {
                pipeline(body, decoder!, () => {});
                body = decoder!;
              }
            } else {
              for (const decoder of decoders) decoder?.destroy();
            }
          }
          const stream = empty ? null : Readable.toWeb(body, {
            strategy: {
              highWaterMark: body.readableHighWaterMark,
              size: (chunk: Uint8Array) => chunk.byteLength,
            },
          }) as ReadableStream<Uint8Array>;
          const response = new HTTPResponse(stream, {
            status,
            statusText: incoming.statusMessage ?? "",
            headers: responseHeaders,
          }, url.href);
          resolve(response);
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      const abort = () => {
        reject(init.signal!.reason);
        request.destroy(new DOMException("The operation was aborted", "AbortError"));
      };
      active.set(request, reject);
      request.once("close", () => {
        active.delete(request);
        init.signal?.removeEventListener("abort", abort);
      });
      request.once("error", reject);
      init.signal?.addEventListener("abort", abort, { once: true });
      if (init.signal?.aborted) { abort(); return; }
      request.end(init.body);
    });
  };
  return {
    fetch,
    close() {
      if (closed) return;
      closed = true;
      for (const [request, reject] of active) {
        const error = new Error("Node HTTP transport closed");
        reject(error);
        request.destroy(error);
      }
      active.clear();
      http?.destroy();
      https?.destroy();
    },
  };
}
