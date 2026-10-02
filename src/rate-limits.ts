import { LRUCache } from "./cache.js";
import { abortReason, delay } from "./utils.js";
/** Distributed implementations must make reserve atomic and namespace by API and credential. */
export interface RateLimitStore {
  reserve(key: string, signal: AbortSignal): Promise<void>;
  observe(key: string, headers: Headers): void | Promise<void>;
  penalize(key: string, retryMs: number, global: boolean): void | Promise<void>;
  /** Optional hint for concurrent reads. Reservations must still be atomic. */
  canPipeline?(key: string): boolean;
}
interface Bucket {
  remaining: number;
  resetAt: number;
  windowMs?: number;
  probing?: boolean;
  waiters?: Set<() => void>;
}
/** Share this instance across REST clients for one credential and API. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly aliases: LRUCache<string, string>;
  private readonly buckets: LRUCache<string, Bucket>;
  private readonly observed: LRUCache<string, boolean>;
  private globalReset = 0;
  constructor(maxBuckets = 1000) {
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1)
      throw new RangeError("maxBuckets must be positive");
    this.aliases = new LRUCache(maxBuckets);
    this.buckets = new LRUCache(maxBuckets);
    this.observed = new LRUCache(maxBuckets);
  }
  canPipeline(key: string): boolean {
    const unlimited = this.observed.get(key);
    if (unlimited === undefined) return false;
    if (this.globalReset > 0) {
      if (this.globalReset > Date.now()) return false;
      this.globalReset = 0;
    }
    if (unlimited) return true;
    const bucket = this.buckets.get(this.aliases.get(key) ?? key);
    // Probe an expired window serially before admitting another read burst.
    return !!bucket && bucket.remaining > 0 && bucket.resetAt > Date.now();
  }
  async reserve(key: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const bucket = this.buckets.get(this.aliases.get(key) ?? key);
      const now = Date.now(),
        wait =
          Math.max(
            this.globalReset,
            bucket && bucket.remaining <= 0 ? bucket.resetAt : 0,
          ) - now;
      if (wait > 0) {
        if (bucket && bucket.resetAt > this.globalReset)
          await this.wait(bucket, wait, signal);
        else await delay(Math.min(wait, 2147483647), signal);
        continue;
      }
      if (bucket) {
        if (bucket.resetAt <= now && bucket.windowMs !== undefined) {
          // Reset-After is the time left, not necessarily a full window. Admit
          // one probe, then learn fresh quota instead of releasing a herd.
          bucket.remaining = 1;
          bucket.resetAt = now + bucket.windowMs;
          bucket.probing = true;
        }
        if (bucket.resetAt > now) bucket.remaining--;
      }
      return;
    }
  }
  observe(key: string, headers: Headers): void {
    const id = headers.get("X-RateLimit-Bucket");
    if (id) this.aliases.set(key, id);
    const remainingText = headers.get("X-RateLimit-Remaining"),
      afterText = headers.get("X-RateLimit-Reset-After"),
      resetText = headers.get("X-RateLimit-Reset");
    if (remainingText === null || (afterText === null && resetText === null)) {
      const previous = this.observed.get(key);
      const unlimited = previous !== false && !id && remainingText === null &&
        afterText === null && resetText === null;
      if (previous !== unlimited) this.observed.set(key, unlimited);
      return;
    }
    this.observed.set(key, false);
    const remaining = Number(remainingText),
      resetAt =
        afterText === null
          ? Number(resetText) * 1000
          : Date.now() + Number(afterText) * 1000;
    if (!Number.isFinite(remaining) || !Number.isFinite(resetAt)) return;
    const now = Date.now();
    const bucketKey = id ?? this.aliases.get(key) ?? key,
      old = this.buckets.get(bucketKey);
    const windowMs = afterText === null ? resetAt - now : Number(afterText) * 1000;
    this.buckets.set(bucketKey, {
      remaining:
        old && !old.probing && old.resetAt > now
          ? Math.min(old.remaining, remaining)
          : remaining,
      resetAt: old?.probing ? resetAt : Math.max(old?.resetAt ?? 0, resetAt),
      ...(windowMs > 0 ? { windowMs } : {}),
    });
    for (const wake of old?.waiters ?? []) wake();
  }
  penalize(key: string, retryMs: number, global: boolean): void {
    if (global)
      this.globalReset = Math.max(this.globalReset, Date.now() + retryMs);
    else {
      this.observed.set(key, false);
      const bucketKey = this.aliases.get(key) ?? key;
      const old = this.buckets.get(bucketKey);
      this.buckets.set(bucketKey, {
        ...old,
        remaining: 0,
        resetAt: Math.max(old?.resetAt ?? 0, Date.now() + retryMs),
        probing: false,
        waiters: new Set(),
      });
      for (const wake of old?.waiters ?? []) wake();
    }
  }
  private wait(bucket: Bucket, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiters = bucket.waiters ??= new Set();
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        signal.removeEventListener("abort", abort);
      };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(abortReason(signal)); };
      const timer = setTimeout(wake, Math.min(ms, 2147483647));
      waiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
