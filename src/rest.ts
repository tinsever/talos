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
  /** Share identical in-flight GETs within this client; each caller owns its response. */
  coalesceGets?: boolean;
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
  coalesce?: boolean;
}

interface SharedGet {
  controller: AbortController;
  promise: Promise<unknown>;
  callers: number;
  settled: boolean;
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
  private sharedGets: Map<string, SharedGet> | undefined;
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
    const path = route.includes("{") ? route.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const value = input.params?.[name];
      if (value === undefined || value === null || String(value).length === 0)
        throw new TypeError(`Missing path parameter: ${name}`);
      const encoded = encodeURIComponent(String(value));
      if (encoded === "." || encoded === "..")
        throw new TypeError(`Invalid path parameter: ${name}`);
      return encoded;
    }) : route;
    let url = route === "/.well-known/fluxer"
      ? new URL(path, this.options.origin ?? this.base).href
      : this.base + path;
    if (input.query) {
      const target = new URL(url);
      for (const name in input.query) {
        if (!Object.hasOwn(input.query, name)) continue;
        const value = input.query[name];
        if (value === undefined) continue;
        if (Array.isArray(value))
          for (const item of value) target.searchParams.append(name, String(item));
        else target.searchParams.set(name, String(value));
      }
      url = target.href;
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
      if (method === "GET" && body === undefined &&
          (input.coalesce ?? this.options.coalesceGets)) {
        // Effective headers include authentication. Never share across tokens,
        // URLs, query strings, or differing request headers.
        const identity = JSON.stringify([route, url, [...headers]]);
        return (await this.shareGet(identity, control.signal, (signal) =>
          this.lock(key, signal, () =>
            this.execute(method, route, key, url, headers, body, signal),
          ),
        )) as ResponseData<M, P>;
      }
      return (await this.lock(key, control.signal, () =>
        this.execute(method, route, key, url, headers, body, control.signal),
      )) as ResponseData<M, P>;
    } finally {
      this.pending--;
      control.dispose();
    }
  }

  private async shareGet(
    identity: string,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const entries = this.sharedGets ??= new Map<string, SharedGet>();
    let shared = entries.get(identity);
    if (!shared) {
      const controller = new AbortController();
      const entry: SharedGet = {
        controller,
        callers: 0,
        settled: false,
        promise: Promise.resolve().then(() => operation(controller.signal)),
      };
      const finish = () => {
        entry.settled = true;
        if (entries.get(identity) === entry) entries.delete(identity);
      };
      entry.promise = entry.promise.then(
        (value) => { finish(); return value; },
        (error) => { finish(); throw error; },
      );
      entries.set(identity, entry);
      shared = entry;
    }
    shared.callers++;
    try {
      const value = await abortable(shared.promise, signal);
      signal.throwIfAborted();
      // The canonical result never escapes: one consumer's mutation cannot
      // affect another, including consumers resolving in later microtasks.
      return structuredClone(value);
    } finally {
      if (--shared.callers === 0 && !shared.settled) {
        if (entries.get(identity) === shared) entries.delete(identity);
        shared.controller.abort(signal.reason);
      }
    }
  }

  private async lock<T>(
    key: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<T> {
    const read =
      key.startsWith("GET ") ||
      key.startsWith("HEAD ") ||
      key.startsWith("OPTIONS ");
    if (read && this.rateLimits.canPipeline?.(key)) {
      signal.throwIfAborted();
      return fn();
    }
    const previous = this.tails.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous ? previous.then(() => current) : current;
    this.tails.set(key, tail);
    let acquired = false;
    try {
      if (previous) await abortable(previous, signal);
      acquired = true;
      signal.throwIfAborted();
      // Waiting readers recheck the state learned by the first response.
      if (read && this.rateLimits.canPipeline?.(key)) release();
      return await fn();
    } finally {
      release();
      if (acquired) {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      } else {
        // A cancelled waiter must not let a later write bypass its predecessor.
        void tail.then(() => {
          if (this.tails.get(key) === tail) this.tails.delete(key);
        });
      }
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

  private execute(
    method: Method,
    route: string,
    key: string,
    url: string,
    headers: Headers,
    body: BodyInit | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    let releaseActive: (() => void) | undefined;
    const run = async (): Promise<unknown> => {
      const safe = method === "GET" || method === "HEAD" || method === "OPTIONS" ||
        method === "PUT" || method === "DELETE";
      for (let attempt = 0; ; attempt++) {
        const start = this.options.onDiagnostic ? Date.now() : 0;
        let response: Response;
        let data: unknown;
        let rateLimit: { wait: number; global: boolean } | undefined;
        let penalizing = false;
        try {
          const release = this.scheduler.tryAcquire(signal) ??
            await this.scheduler.acquire(signal);
          releaseActive = release;
          try {
            signal.throwIfAborted();
            await this.rateLimits.reserve(key, signal);
            signal.throwIfAborted();
            response = await this.fetcher(url, {
              method,
              headers,
              signal,
              credentials: "omit",
              redirect:
                route === "/.well-known/fluxer" && !headers.has("Authorization")
                  ? "follow"
                  : "error",
              ...(body === undefined ? {} : { body }),
            });
            signal.throwIfAborted();
            const observation = this.rateLimits.observe(key, response.headers);
            if (observation) await observation;
            signal.throwIfAborted();
            if (this.options.onDiagnostic)
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
                : await (json
                    ? response.json()
                    : response.ok
                      ? response.blob()
                      : response.text());
            signal.throwIfAborted();
            if (response.status === 429) {
              const denial = data && typeof data === "object"
                ? data as Record<string, unknown> : {};
              const seconds = Number(
                denial.retry_after ?? response.headers.get("Retry-After") ?? 1,
              );
              const wait = Number.isFinite(seconds) && seconds > 0
                ? seconds * 1_000 : 1_000;
              const global = denial.global === true ||
                response.headers.get("X-RateLimit-Global") === "true";
              rateLimit = { wait, global };
              // Record the penalty before a released slot admits queued reads,
              // including when a distributed store updates asynchronously.
              penalizing = true;
              const penalty = this.rateLimits.penalize(key, wait, global);
              if (penalty) await penalty;
              signal.throwIfAborted();
              penalizing = false;
            }
          } finally {
            release();
            releaseActive = undefined;
          }
        } catch (error) {
          signal.throwIfAborted();
          if (penalizing || !safe || attempt >= this.maxRetries) throw error;
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
          const { wait, global } = rateLimit!;
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
    };
    // Race the whole execution once. A transport/store that ignores abort must
    // still release its slot immediately; late completions check the signal
    // before observing headers, parsing data, diagnosing, or retrying.
    return abortable(run(), signal).finally(() => releaseActive?.());
  }
}
