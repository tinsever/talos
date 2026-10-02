import { Client } from "./client.js";
import type { ClientOptions } from "./client.js";
import { discover } from "./discovery.js";
import { RESTClient } from "./rest.js";
import { MemoryRateLimitStore } from "./rate-limits.js";
import { Semaphore } from "./scheduler.js";
import { abortable, delay, positive } from "./utils.js";
/** Conservative rolling-window gate for the shared source-IP Identify budget. */
export class IdentifyLimiter {
  private readonly starts: number[] = [];
  private readonly gate = new Semaphore(1);
  constructor(
    readonly limit = 250,
    readonly windowMs = 60000,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 300)
      throw new RangeError("Identify limit must be 1..300");
    positive(windowMs, "windowMs");
  }
  async acquire(signal: AbortSignal): Promise<void> {
    const release = await this.gate.acquire(signal);
    try {
      for (;;) {
        const now = Date.now();
        while (
          this.starts[0] !== undefined &&
          this.starts[0] <= now - this.windowMs
        )
          this.starts.shift();
        if (this.starts.length < this.limit) {
          this.starts.push(now);
          return;
        }
        await delay(this.starts[0]! + this.windowMs - now, signal);
      }
    } finally {
      release();
    }
  }
}
export interface ShardManagerOptions extends Omit<ClientOptions, "gateway"> {
  gateway?: Omit<NonNullable<ClientOptions["gateway"]>, "shard">;
  count?: number;
  /** Share across managers using the same source IP; distributed backends can implement acquire. */
  identifyLimiter?: { acquire(signal: AbortSignal): Promise<void> };
  /** External worker/process implementations can supply an alternate Client factory. */
  createClient?: (options: ClientOptions) => Client;
}
export class ShardManager {
  private clients: Client[] = [];
  private control: AbortController | undefined;
  get shards(): readonly Client[] {
    return this.clients;
  }
  constructor(private readonly options: ShardManagerOptions) {}
  async connect(
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<readonly Client[]> {
    if (this.control) throw new Error("Shards are already running");
    options.signal?.throwIfAborted();
    const timeoutMs = positive(options.timeoutMs ?? 60_000, "timeoutMs");
    const control = new AbortController();
    this.control = control;
    const abort = () => control.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        control.abort(
          new DOMException("Shard startup deadline exceeded", "TimeoutError"),
        ),
      timeoutMs,
    );
    try {
      const endpoints =
        this.options.endpoints ??
        (
          await discover(this.options.origin ?? "https://fluxer.app", {
            signal: control.signal,
            ...(this.options.rest?.fetch
              ? { fetch: this.options.rest.fetch }
              : {}),
          })
        ).endpoints;
      control.signal.throwIfAborted();
      const rateLimitStore =
        this.options.rest?.rateLimitStore ??
        new MemoryRateLimitStore(this.options.rest?.maxBuckets);
      const rest = new RESTClient({
        ...this.options.rest,
        api: endpoints.api_public,
        token: this.options.token,
        rateLimitStore,
      });
      const info = await rest.request("GET", "/gateway/bot", {
        signal: control.signal,
      });
      control.signal.throwIfAborted();
      const count = this.options.count ?? info.shards;
      if (!Number.isInteger(count) || count < 1 || count > 16384)
        throw new RangeError("Shard count must be 1..16384");
      const limiter = this.options.identifyLimiter ?? new IdentifyLimiter();
      const concurrency = new Semaphore(
        Math.max(
          1,
          Math.min(info.session_start_limit.max_concurrency, count, 16),
        ),
      );
      const {
        count: _,
        identifyLimiter: __,
        createClient: ___,
        ...base
      } = this.options;
      const before = this.options.gateway?.beforeIdentify;
      const clients: Client[] = [];
      this.clients = clients;
      for (let id = 0; id < count; id++) {
        control.signal.throwIfAborted();
        const client = (
          this.options.createClient ?? ((options) => new Client(options))
        )({
          ...base,
          endpoints,
          rest: { ...base.rest, rateLimitStore },
          gateway: {
            ...base.gateway,
            shard: [id, count],
            beforeIdentify: async (context) => {
              await limiter.acquire(context.signal);
              await before?.(context);
            },
          },
        });
        if (control.signal.aborted) {
          client.disconnect();
          control.signal.throwIfAborted();
        }
        clients.push(client);
      }
      await abortable(
        Promise.all(
          clients.map(async (client) => {
            const release = await concurrency.acquire(control.signal);
            try {
              await abortable(
                client.connect({
                  signal: control.signal,
                  timeoutMs,
                }),
                control.signal,
              );
            } finally {
              release();
            }
          }),
        ),
        control.signal,
      );
      control.signal.throwIfAborted();
      return clients;
    } catch (error) {
      if (this.control === control) this.disconnect();
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  disconnect(): void {
    const clients = this.clients,
      control = this.control;
    this.clients = [];
    this.control = undefined;
    control?.abort(new DOMException("Shards disconnected", "AbortError"));
    for (const client of clients) client.disconnect();
  }
}
