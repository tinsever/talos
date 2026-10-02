import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import { readFile } from "node:fs/promises";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nodeHTTPTransport } from "../src/node.js";
import type { NodeHTTPTransport } from "../src/node.js";
import { RESTClient } from "../src/rest.js";

let server: Server;
let api: string;
let transport: NodeHTTPTransport;
let handler: (request: IncomingMessage, response: ServerResponse) => void;
const value = { id: "1", username: "bot" };
beforeEach(async () => {
  handler = (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  server = createServer((request, response) => handler(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  transport = nodeHTTPTransport();
});
afterEach(async () => {
  transport.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.restoreAllMocks();
});

it("validates pool limits and reuses sockets for authenticated JSON GETs and writes", async () => {
  for (const maxConnections of [0, -1, NaN, Infinity, 1.5])
    expect(() => nodeHTTPTransport({ maxConnections })).toThrow(RangeError);
  let connections = 0;
  server.on("connection", () => connections++);
  const seen: { method: string; path: string; body: string }[] = [];
  handler = async (request, response) => {
    expect(request.headers.authorization).toBe("Bot synthetic");
    expect(request.headers["accept-language"]).toBe("en-US");
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ method: request.method!, path: request.url!, body });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const rest = new RESTClient({ api: api + "/prefix", token: "synthetic", fetch: transport.fetch });
  expect(await rest.request("GET", "/users/@me")).toEqual(value);
  await rest.request("POST", "/channels/{channel_id}/messages", {
    params: { channel_id: "10" }, body: { content: "hello 🌍" },
  });
  expect(seen).toEqual([
    { method: "GET", path: "/prefix/v1/users/@me", body: "" },
    { method: "POST", path: "/prefix/v1/channels/10/messages", body: '{"content":"hello 🌍"}' },
  ]);
  expect(connections).toBe(1);
  expect(rest.stats.pending).toBe(0);
});

it("returns real, cloneable Responses with streaming bodies, URL, and bodyUsed", async () => {
  const response = await transport.fetch(api, { redirect: "error" });
  expect(response).toBeInstanceOf(Response);
  expect(response.url).toBe(api + "/");
  expect(response.bodyUsed).toBe(false);
  const clone = response.clone();
  expect(clone.url).toBe(response.url);
  expect(clone.clone().url).toBe(response.url);
  expect(await response.json()).toEqual(value);
  expect(response.bodyUsed).toBe(true);
  expect(await clone.json()).toEqual(value);
  await expect(response.text()).rejects.toThrow();
});

it("bounds pooled connections during bursts and reuses them", async () => {
  transport.close();
  transport = nodeHTTPTransport({ maxConnections: 2 });
  let active = 0, peak = 0, connections = 0;
  server.on("connection", () => connections++);
  handler = (_request, response) => {
    peak = Math.max(peak, ++active);
    setTimeout(() => {
      active--;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    }, 5);
  };
  for (let burst = 0; burst < 2; burst++) {
    const results = await Promise.all(Array.from({ length: 12 }, async () =>
      (await transport.fetch(api, { redirect: "error" })).json()));
    expect(results).toEqual(Array(12).fill(value));
  }
  expect(peak).toBe(2);
  expect(connections).toBe(2);
});

it.each(["gzip", "deflate", "br", "gzip, br"])("decodes %s without changing wire headers", async (encoding) => {
  handler = (request, response) => {
    expect(request.headers["accept-encoding"]).toContain("gzip");
    const json = Buffer.from(JSON.stringify(value));
    const body = encoding === "gzip" ? gzipSync(json) :
      encoding === "deflate" ? deflateSync(json) :
      encoding === "br" ? brotliCompressSync(json) : brotliCompressSync(gzipSync(json));
    response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": encoding,
      "Content-Length": String(body.length) });
    response.end(body);
  };
  const response = await transport.fetch(api, { redirect: "error" });
  expect(response.headers.get("Content-Encoding")).toBe(encoding);
  expect(await response.json()).toEqual(value);
});

it("forwards binary responses and drains empty status and HEAD responses", async () => {
  handler = (request, response) => {
    if (request.url === "/empty") { response.writeHead(204); response.end(); }
    else { response.writeHead(200, { "Content-Type": "application/octet-stream" }); response.end("binary"); }
  };
  const binary = await transport.fetch(api, { redirect: "error" });
  const cloned = binary.clone();
  const blob = await binary.blob();
  expect(await blob.text()).toBe("binary");
  expect(blob.type).toBe("application/octet-stream");
  expect((await cloned.blob()).type).toBe("application/octet-stream");
  expect((await transport.fetch(api + "/empty", { redirect: "error" })).body).toBeNull();
  const head = await transport.fetch(api, { method: "HEAD", redirect: "error" });
  expect(head.body).toBeNull();
  expect(await head.text()).toBe("");
});

it("blocks authenticated API redirects while native fetch handles discovery redirects", async () => {
  let finalCalls = 0;
  handler = (request, response) => {
    if (request.url === "/final") { finalCalls++; response.end("final"); }
    else { response.writeHead(302, { Location: "/final" }); response.end(); }
  };
  await expect(transport.fetch(api, { redirect: "error", headers: { Authorization: "Bot synthetic" } }))
    .rejects.toThrow("redirect");
  expect(finalCalls).toBe(0);
  const followed = await transport.fetch(api);
  expect(followed.redirected).toBe(true);
  expect(await followed.text()).toBe("final");
  expect(finalCalls).toBe(1);
});

it("keeps non-redirect errors as REST API errors", async () => {
  handler = (_request, response) => {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end('{"code":"UNAUTHORIZED"}');
  };
  const rest = new RESTClient({ api, token: "s", fetch: transport.fetch, maxRetries: 0 });
  await expect(rest.request("GET", "/users/@me")).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
});

it("shares identical GETs and honors a real 429 retry without sharing writes", async () => {
  let calls = 0;
  handler = (_request, response) => {
    calls++;
    response.writeHead(calls === 1 ? 429 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(calls === 1 ? { retry_after: 0.005, global: true } : value));
  };
  const rest = new RESTClient({ api, token: "s", fetch: transport.fetch, coalesceGets: true });
  const users = await Promise.all(Array.from({ length: 50 }, () => rest.request("GET", "/users/@me")));
  expect(calls).toBe(2);
  expect(new Set(users).size).toBe(50);
  users[0]!.username = "changed";
  expect(users[1]!.username).toBe("bot");
  await Promise.all(Array.from({ length: 2 }, () => rest.request("POST", "/channels/{channel_id}/messages", {
    params: { channel_id: "10" }, body: { content: "hello" },
  })));
  expect(calls).toBe(4);
  expect(rest.stats.pending).toBe(0);
});

it("keeps native multipart serialization and Request handling", async () => {
  const seen: string[] = [];
  handler = async (request, response) => {
    expect(request.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push(body);
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(value));
  };
  const form = new FormData();
  form.append("payload_json", '{"content":"file"}');
  form.append("file", new Blob(["bytes"]), "file.txt");
  const rest = new RESTClient({ api, token: "s", fetch: transport.fetch });
  await rest.request("POST", "/channels/{channel_id}/messages", { params: { channel_id: "10" }, body: form });
  await (await transport.fetch(new Request(api, { method: "POST", body: form }))).json();
  expect(seen).toHaveLength(2);
  for (const body of seen) { expect(body).toContain('filename="file.txt"'); expect(body).toContain("bytes"); }
});

it("delegates advanced fetch options intact and rejects GET bodies", async () => {
  const native = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("native"));
  transport.close(); transport = nodeHTTPTransport();
  const input = { redirect: "error", integrity: "sha256-test" } as const;
  expect(await (await transport.fetch(api, input)).text()).toBe("native");
  expect(native).toHaveBeenCalledWith(api, input);
  await expect(transport.fetch(api, { redirect: "error", body: "unexpected" })).rejects.toThrow("GET/HEAD");
});

it("cancels requests waiting for headers and rejects already-aborted calls with their reason", async () => {
  let arrived = false;
  handler = () => { arrived = true; };
  await expect(transport.fetch(api, { redirect: "error", signal: AbortSignal.abort("before") })).rejects.toBe("before");
  expect(arrived).toBe(false);
  const controller = new AbortController();
  const request = transport.fetch(api, { redirect: "error", signal: controller.signal });
  const rejected = expect(request).rejects.toBe("stop");
  await vi.waitFor(() => expect(arrived).toBe(true));
  controller.abort("stop"); await rejected;
});

it("cancels response-body work and immediately releases REST capacity", async () => {
  let arrived = false;
  handler = (_request, response) => {
    arrived = true; response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"id":');
  };
  const rest = new RESTClient({ api, token: "s", fetch: transport.fetch, maxConcurrentRequests: 1 });
  const controller = new AbortController();
  const request = rest.request("GET", "/users/@me", { signal: controller.signal });
  const rejected = expect(request).rejects.toBe("stop");
  await vi.waitFor(() => expect(arrived).toBe(true));
  controller.abort("stop"); await rejected;
  expect(rest.stats).toEqual({ active: 0, pending: 0, waiting: 0 });
});

it("closes active and queued pooled work and rejects new calls", async () => {
  transport.close(); transport = nodeHTTPTransport({ maxConnections: 1 });
  let arrived = false;
  handler = () => { arrived = true; };
  const first = transport.fetch(api, { redirect: "error" });
  const second = transport.fetch(api, { redirect: "error" });
  const rejected = Promise.all([expect(first).rejects.toThrow("closed"), expect(second).rejects.toThrow("closed")]);
  await vi.waitFor(() => expect(arrived).toBe(true));
  transport.close(); transport.close(); await rejected;
  await expect(transport.fetch(api, { redirect: "error" })).rejects.toThrow("closed");
});

it("rejects truncated compressed response bodies", async () => {
  handler = (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
    response.end(gzipSync(Buffer.from(JSON.stringify(value))).subarray(0, 10));
  };
  const response = await transport.fetch(api, { redirect: "error" });
  await expect(response.json()).rejects.toThrow();
});

it("keeps HTTPS certificate verification enabled", async () => {
  const tls = createHTTPSServer({
    key: await readFile(new URL("./fixtures/localhost-key.pem", import.meta.url)),
    cert: await readFile(new URL("./fixtures/localhost-cert.pem", import.meta.url)),
  }, (_request, response) => response.end("private"));
  await new Promise<void>(resolve => tls.listen(0, "127.0.0.1", resolve));
  try {
    const url = `https://127.0.0.1:${(tls.address() as { port: number }).port}`;
    await expect(transport.fetch(url, { redirect: "error" })).rejects.toThrow();
  } finally {
    tls.closeAllConnections(); await new Promise<void>(resolve => tls.close(() => resolve()));
  }
});
