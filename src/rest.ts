import { MemoryRateLimitStore } from "./rate-limits.js";
import type { RateLimitStore } from "./rate-limits.js";
import { FluxerAPIError, RequestQueueFullError } from "./errors.js";
import { Semaphore } from "./scheduler.js";
import { routes } from "./generated/routes.js";
import type { Method, PathsFor, RequestArgs, ResponseData } from "./types.js";
import { abortable, deadline, delay, positive } from "./utils.js";

export { FluxerAPIError, RequestQueueFullError } from "./errors.js";
export type {
  Method,
  PathsFor,
  RequestOptions,
  ResponseData,
} from "./types.js";
export interface RESTDiagnostic {
  type: "response" | "retry" | "rateLimit";
  method: Method;
  /** Template path; never includes tokens or query values. */
  route: string;
  attempt: number;
  status?: number;
  delayMs?: number;
  global?: boolean;
  durationMs?: number;
}
export interface RESTOptions {
  /** Advertised api_public endpoint, including any path prefix, without /v1. */
  api: string;
  /** Instance origin for the unversioned discovery operation. */
  origin?: string;
  token?: string;
  authScheme?: "Bot" | "Bearer" | "Session" | "Admin";
  fetch?: typeof globalThis.fetch;
  locale?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxBuckets?: number;
  rateLimitStore?: RateLimitStore;
  maxConcurrentRequests?: number;
  /** Total accepted requests, including route queues, rate waits, and active work. */
  maxPendingRequests?: number;
  onDiagnostic?: (event: RESTDiagnostic) => void;
}
interface RuntimeOptions {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  auth?: boolean;
  timeoutMs?: number;
  reason?: string;
}

export class RESTClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly rateLimits: RateLimitStore;
  private readonly tails = new Map<string, Promise<void>>();
  private pending = 0;
  private readonly scheduler: Semaphore;
  private readonly maxPending: number;
  get stats(): { pending: number; active: number; waiting: number } {
    const { active } = this.scheduler.stats;
    return { pending: this.pending, active, waiting: this.pending - active };
  }
  constructor(private readonly options: RESTOptions) {
    const base = new URL(options.api);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new TypeError(
        "api must be an HTTP(S) endpoint without credentials, query, or fragment",
      );
    this.base = base.href.replace(/\/$/, "").replace(/\/v1$/, "") + "/v1";
    const fetcher = options.fetch ?? globalThis.fetch;
    if (!fetcher)
      throw new TypeError(
        "This runtime requires an injected fetch implementation",
      );
    this.fetcher = fetcher.bind(globalThis);
    this.timeoutMs = positive(options.timeoutMs ?? 60_000, "timeoutMs");
    this.maxRetries = options.maxRetries ?? 5;
    this.scheduler = new Semaphore(options.maxConcurrentRequests ?? 10);
    this.maxPending = options.maxPendingRequests ?? 1_000;
    if (!Number.isInteger(this.maxPending) || this.maxPending < 1)
      throw new RangeError("maxPendingRequests must be a positive integer");
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0)
      throw new RangeError("maxRetries must be a non-negative integer");
    const maxBuckets = options.maxBuckets ?? 1_000;
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1)
      throw new RangeError("maxBuckets must be a positive integer");
    this.rateLimits =
      options.rateLimitStore ?? new MemoryRateLimitStore(maxBuckets);
    if (
      options.token !== undefined &&
      (!options.token || options.token.trim() !== options.token)
    )
      throw new TypeError(
        "token must be non-empty without surrounding whitespace",
      );
  }

  updateToken(token: string): void {
    if (!token || token.trim() !== token)
      throw new TypeError("A non-empty token without whitespace is required");
    this.options.token = token;
  }

  async request<M extends Method, P extends PathsFor<M>>(
    method: M,
    route: P,
    ...args: RequestArgs<M, P>
  ): Promise<ResponseData<M, P>> {
    const input = (args as unknown as [RuntimeOptions?])[0] ?? {};
    const routeKey: string = method + " " + route;
    const metadata = routes[routeKey as keyof typeof routes];
    if (!metadata)
      throw new TypeError(`Unknown Fluxer route: ${method} ${route}`);
    const path = route.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const value = input.params?.[name];
      if (value === undefined || value === null || String(value).length === 0)
        throw new TypeError(`Missing path parameter: ${name}`);
      const encoded = encodeURIComponent(String(value));
      if (encoded === "." || encoded === "..")
        throw new TypeError(`Invalid path parameter: ${name}`);
      return encoded;
    });
    const url =
      route === "/.well-known/fluxer"
        ? new URL(path, this.options.origin ?? this.base)
        : new URL(this.base + path);
    for (const [name, value] of Object.entries(input.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value))
        for (const item of value) url.searchParams.append(name, String(item));
      else url.searchParams.set(name, String(value));
    }
    const headers = new Headers(input.headers);
    headers.delete("Authorization");
    if (input.auth ?? metadata.authenticated) {
      if (!this.options.token)
        throw new TypeError("This route requires a token");
      const scheme = this.options.authScheme ?? "Bot";
      headers.set(
        "Authorization",
        scheme === "Session"
          ? this.options.token
          : `${scheme} ${this.options.token}`,
      );
    }
    headers.set("Accept-Language", this.options.locale ?? "en-US");
    if (input.reason !== undefined)
      headers.set("X-Audit-Log-Reason", encodeURIComponent(input.reason));
    let body: BodyInit | undefined;
    if (input.body instanceof FormData) {
      body = input.body;
      headers.delete("Content-Type");
    } else if (input.body !== undefined) {
      body = JSON.stringify(input.body);
      headers.set("Content-Type", "application/json");
    }
    const control = deadline(
      positive(input.timeoutMs ?? this.timeoutMs, "timeoutMs"),
      input.signal,
    );
    if (this.pending >= this.maxPending) {
      control.dispose();
      throw new RequestQueueFullError(this.maxPending);
    }
    this.pending++;
    // Full concrete paths preserve Fluxer's resource-scoped buckets.
    const key = `${method} ${path}`;
    try {
      return (await this.lock(key, control.signal, () =>
        this.execute(method, route, key, url, headers, body, control.signal),
      )) as ResponseData<M, P>;
    } finally {
      this.pending--;
      control.dispose();
    }
  }

  private async lock<T>(
    key: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    try {
      await abortable(previous, signal);
      signal.throwIfAborted();
      return await fn();
    } finally {
      release();
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    }
  }

  private diagnostic(event: RESTDiagnostic): void {
    // Observability callbacks cannot interrupt request or rate-limit bookkeeping.
    try {
      this.options.onDiagnostic?.(event);
    } catch {
      /* observer failure */
    }
  }

  private async execute(
    method: Method,
    route: string,
    key: string,
    url: URL,
    headers: Headers,
    body: BodyInit | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const safe = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"].includes(method);
    for (let attempt = 0; ; attempt++) {
      const start = Date.now();
      let response: Response;
      let data: unknown;
      try {
        const release = await this.scheduler.acquire(signal);
        try {
          await abortable(this.rateLimits.reserve(key, signal), signal);
          response = await abortable(
            this.fetcher(url, {
              method,
              headers,
              signal,
              credentials: "omit",
              redirect:
                route === "/.well-known/fluxer" && !headers.has("Authorization")
                  ? "follow"
                  : "error",
              ...(body === undefined ? {} : { body }),
            }),
            signal,
          );
          await abortable(
            Promise.resolve(this.rateLimits.observe(key, response.headers)),
            signal,
          );
          this.diagnostic({
            type: "response",
            method,
            route,
            attempt,
            status: response.status,
            durationMs: Date.now() - start,
          });
          const json = response.headers.get("Content-Type")?.includes("json");
          data =
            response.status === 204 || method === "HEAD"
              ? undefined
              : await abortable(
                  json
                    ? response.json()
                    : response.ok
                      ? response.blob()
                      : response.text(),
                  signal,
                );
        } finally {
          release();
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!safe || attempt >= this.maxRetries) throw error;
        const wait =
          Math.min(10_000, 250 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
        this.diagnostic({
          type: "retry",
          method,
          route,
          attempt,
          delayMs: wait,
        });
        await delay(wait, signal);
        continue;
      }
      if (response.ok) return data;
      if (response.status === 429) {
        const denial =
          data && typeof data === "object"
            ? (data as Record<string, unknown>)
            : {};
        const seconds = Number(
          denial.retry_after ?? response.headers.get("Retry-After") ?? 1,
        );
        const wait =
          Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 1_000;
        const global =
          denial.global === true ||
          response.headers.get("X-RateLimit-Global") === "true";
        await abortable(
          Promise.resolve(this.rateLimits.penalize(key, wait, global)),
          signal,
        );
        this.diagnostic({
          type: "rateLimit",
          method,
          route,
          attempt,
          status: 429,
          delayMs: wait,
          global,
        });
        if (attempt < this.maxRetries) continue;
      } else if (response.status >= 500 && safe && attempt < this.maxRetries) {
        const wait =
          Math.min(10_000, 250 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
        this.diagnostic({
          type: "retry",
          method,
          route,
          attempt,
          status: response.status,
          delayMs: wait,
        });
        await delay(wait, signal);
        continue;
      }
      throw new FluxerAPIError(response.status, method, route, data);
    }
  }
}
