import { LRUCache } from "./cache.js";
import { delay } from "./utils.js";
/** Distributed implementations must make reserve atomic and namespace by API and credential. */
export interface RateLimitStore {
  reserve(key: string, signal: AbortSignal): Promise<void>;
  observe(key: string, headers: Headers): void | Promise<void>;
  penalize(key: string, retryMs: number, global: boolean): void | Promise<void>;
}
interface Bucket {
  remaining: number;
  resetAt: number;
}
/** Share this instance across REST clients for one credential and API. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly aliases: LRUCache<string, string>;
  private readonly buckets: LRUCache<string, Bucket>;
  private globalReset = 0;
  constructor(maxBuckets = 1000) {
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1)
      throw new RangeError("maxBuckets must be positive");
    this.aliases = new LRUCache(maxBuckets);
    this.buckets = new LRUCache(maxBuckets);
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
        await delay(Math.min(wait, 2147483647), signal);
        continue;
      }
      if (bucket && bucket.resetAt > now) bucket.remaining--;
      return;
    }
  }
  observe(key: string, headers: Headers): void {
    const id = headers.get("X-RateLimit-Bucket");
    if (id) this.aliases.set(key, id);
    const remainingText = headers.get("X-RateLimit-Remaining"),
      afterText = headers.get("X-RateLimit-Reset-After"),
      resetText = headers.get("X-RateLimit-Reset");
    if (remainingText === null || (afterText === null && resetText === null))
      return;
    const remaining = Number(remainingText),
      resetAt =
        afterText === null
          ? Number(resetText) * 1000
          : Date.now() + Number(afterText) * 1000;
    if (!Number.isFinite(remaining) || !Number.isFinite(resetAt)) return;
    const bucketKey = id ?? this.aliases.get(key) ?? key,
      old = this.buckets.get(bucketKey);
    this.buckets.set(bucketKey, {
      remaining:
        old && old.resetAt > Date.now()
          ? Math.min(old.remaining, remaining)
          : remaining,
      resetAt: Math.max(old?.resetAt ?? 0, resetAt),
    });
  }
  penalize(key: string, retryMs: number, global: boolean): void {
    if (global)
      this.globalReset = Math.max(this.globalReset, Date.now() + retryMs);
    else
      this.buckets.set(this.aliases.get(key) ?? key, {
        remaining: 0,
        resetAt: Date.now() + retryMs,
      });
  }
}
