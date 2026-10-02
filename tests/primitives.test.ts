import { afterEach, describe, expect, it, vi } from "vitest";
import { LRUCache, MemoryRateLimitStore, discover, FluxerAPIError } from "../src/index.js";
import { TypedEmitter } from "../src/events.js";
import { Semaphore } from "../src/scheduler.js";
import { snapshot } from "../src/snapshot.js";
import { abortable, deadline, delay, positive } from "../src/utils.js";
import { json } from "./helpers.js";

afterEach(() => vi.useRealTimers());

describe("bounded cache", () => {
  it("rejects invalid capacity and expiration", () => {
    for (const size of [-1, 1.5, NaN, Infinity])
      expect(() => new LRUCache(size)).toThrow(RangeError);
    for (const ttl of [0, -1, NaN])
      expect(() => new LRUCache(1, ttl)).toThrow(RangeError);
  });

  it("expires entries at their deadline and preserves recency of reads and replacements", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cache = new LRUCache<string, number>(2, 10);
    cache.set("a", 1).set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    vi.setSystemTime(5);
    cache.set("a", 4);
    expect([...cache.items()]).toEqual([["c", 3], ["a", 4]]);
    vi.setSystemTime(10);
    expect(cache.get("c")).toBeUndefined();
    expect(cache.size).toBe(1);
    vi.setSystemTime(15);
    expect(cache.sweep()).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("sweeps iteration and permits disabled caching", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cache = new LRUCache<string, number>(2, 1);
    cache.set("a", 1);
    vi.setSystemTime(1);
    expect([...cache.items()]).toEqual([]);
    const disabled = new LRUCache<string, number>(0);
    expect(disabled.set("a", 1)).toBe(disabled);
    expect(disabled.get("a")).toBeUndefined();
  });
});

describe("event delivery", () => {
  it("isolates synchronous and asynchronous listener failures while delivering to every listener", async () => {
    const failures = vi.fn(), emitter = new TypedEmitter<{ value: number }>(failures);
    const sync = new Error("sync"), async = new Error("async"), listener = vi.fn();
    emitter.on("value", () => { throw sync; });
    emitter.on("value", async () => { throw async; });
    emitter.on("value", listener);
    emitter.emit("value", 7);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith(7);
    expect(failures.mock.calls).toEqual([[sync, "value"], [async, "value"]]);
  });

  it("removes a once listener before reentrant emissions", () => {
    const emitter = new TypedEmitter<{ value: number }>(), values: number[] = [];
    emitter.once("value", value => { values.push(value); emitter.emit("value", 2); });
    emitter.emit("value", 1);
    emitter.emit("value", 3);
    expect(values).toEqual([1]);
  });

  it("delivers a stable listener snapshot while subscriptions change", () => {
    const emitter = new TypedEmitter<{ value: number }>(), calls: string[] = [];
    let unsubscribe = () => {};
    emitter.on("value", () => { unsubscribe(); calls.push("first"); emitter.on("value", () => calls.push("new")); });
    unsubscribe = emitter.on("value", () => calls.push("second"));
    emitter.emit("value", 1);
    expect(calls).toEqual(["first", "second"]);
    calls.length = 0;
    emitter.emit("value", 2);
    expect(calls).toEqual(["first", "new"]);
  });
});

describe("cancellation and deadlines", () => {
  it("preserves abort reasons and removes listeners after a promise settles", async () => {
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(abortable(Promise.resolve(7), controller.signal)).resolves.toBe(7);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    const error = new Error("failed");
    await expect(abortable(Promise.reject(error), controller.signal)).rejects.toBe(error);
    controller.abort("cancelled");
    await expect(abortable(Promise.resolve(9), controller.signal)).rejects.toBe("cancelled");
    await expect(delay(1, controller.signal)).rejects.toBe("cancelled");
  });

  it("disposes timers and parent subscriptions without aborting completed work", async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, "removeEventListener");
    const control = deadline(10, controller.signal);
    control.dispose();
    controller.abort("late");
    await vi.advanceTimersByTimeAsync(20);
    expect(control.signal.aborted).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    const aborted = deadline(10, controller.signal);
    expect(aborted.signal.reason).toBe("late");
    aborted.dispose();
  });

  it("observes underlying failures after work was already cancelled", async () => {
    let fail!: (error: unknown) => void;
    const operation = new Promise<never>((_resolve, reject) => { fail = reject; });
    await expect(abortable(operation, AbortSignal.abort("stop"))).rejects.toBe("stop");
    fail(new Error("late underlying failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it("rejects invalid timer durations before timer overflow", () => {
    for (const ms of [0, -1, NaN, Infinity, 2147483648])
      expect(() => positive(ms, "duration")).toThrow(RangeError);
    expect(positive(2147483647, "duration")).toBe(2147483647);
  });
});

describe("concurrency queue", () => {
  it("rejects invalid capacities and already cancelled acquisitions", async () => {
    for (const capacity of [0, -1, NaN, 1.5])
      expect(() => new Semaphore(capacity)).toThrow(RangeError);
    const semaphore = new Semaphore(1);
    await expect(semaphore.acquire(AbortSignal.abort("stop"))).rejects.toBe("stop");
    expect(semaphore.stats).toEqual({ active: 0, queued: 0 });
  });

  it("serves waiters in FIFO order, drops cancellations, and makes release idempotent", async () => {
    const semaphore = new Semaphore(1), release = await semaphore.acquire(new AbortController().signal);
    const cancelled = new AbortController(), order: number[] = [];
    const first = semaphore.acquire(new AbortController().signal).then(release => { order.push(1); return release; });
    const second = semaphore.acquire(cancelled.signal);
    const assertion = expect(second).rejects.toBe("skip");
    const third = semaphore.acquire(new AbortController().signal).then(release => { order.push(3); return release; });
    cancelled.abort("skip");
    await assertion;
    expect(semaphore.stats).toEqual({ active: 1, queued: 2 });
    release();
    release();
    const firstRelease = await first;
    expect(order).toEqual([1]);
    expect(semaphore.stats).toEqual({ active: 1, queued: 1 });
    firstRelease();
    (await third)();
    expect(order).toEqual([1, 3]);
    expect(semaphore.stats).toEqual({ active: 0, queued: 0 });
  });
});

describe("shared rate limits", () => {
  it("validates bucket capacity", () => {
    for (const size of [0, -1, NaN, 1.5])
      expect(() => new MemoryRateLimitStore(size)).toThrow(RangeError);
  });

  it("shares aliases and never increases an active bucket's remaining quota from stale responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new MemoryRateLimitStore(), signal = new AbortController().signal;
    store.observe("a", new Headers({ "X-RateLimit-Bucket": "shared", "X-RateLimit-Remaining": "1", "X-RateLimit-Reset-After": "1" }));
    store.observe("b", new Headers({ "X-RateLimit-Bucket": "shared" }));
    await store.reserve("b", signal);
    store.observe("a", new Headers({ "X-RateLimit-Remaining": "100", "X-RateLimit-Reset-After": "1" }));
    let finished = false;
    const pending = store.reserve("a", signal).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
  });

  it("uses epoch resets and ignores malformed numeric headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new MemoryRateLimitStore(), signal = new AbortController().signal;
    store.observe("a", new Headers({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1" }));
    store.observe("a", new Headers({ "X-RateLimit-Remaining": "invalid", "X-RateLimit-Reset-After": "2" }));
    const pending = store.reserve("a", signal);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    store.observe("b", new Headers({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "invalid" }));
    await store.reserve("b", signal);
    await expect(store.reserve("a", AbortSignal.abort("stop"))).rejects.toBe("stop");
  });
});

describe("immutable snapshots", () => {
  it("clones nested and cyclic data and protects the original from caller mutations", () => {
    const input = { nested: { value: 1 }, list: [{ value: 2 }], self: null as unknown };
    input.self = input;
    const result = snapshot(input);
    expect(result).not.toBe(input);
    expect(result.self).toBe(result);
    expect(Object.isFrozen(result.nested)).toBe(true);
    expect(Object.isFrozen(result.list[0])).toBe(true);
    expect(() => { result.nested.value = 4; }).toThrow(TypeError);
    input.nested.value = 3;
    expect(result.nested.value).toBe(1);
    expect(snapshot(null)).toBe(null);
  });
});

describe("instance discovery", () => {
  it("rejects unsafe origins before fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const origin of ["file:///tmp/fluxer", "https://user:password@example"])
      await expect(discover(origin, { fetch })).rejects.toThrow("without credentials");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports non-success responses and malformed discovery documents", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({}, 503));
    await expect(discover("https://example", { fetch })).rejects.toThrow("HTTP 503");
    for (const data of [null, {}, { endpoints: null }, { endpoints: {} }, { endpoints: { api_public: "https://api.example", gateway: 123 } }]) {
      fetch.mockResolvedValue(json(data));
      await expect(discover("https://example", { fetch })).rejects.toThrow(/Invalid Fluxer|missing endpoints/);
    }
    for (const api_public of ["https://user:password@example", "https://example?key=x", "https://example#token"]) {
      fetch.mockResolvedValue(json({ endpoints: { api_public, gateway: "wss://example" } }));
      await expect(discover("https://example", { fetch })).rejects.toThrow("Invalid endpoints");
    }
  });

  it("retains structured error metadata and uses a safe fallback message", () => {
    const error = new FluxerAPIError(500, "GET", "/users", "broken");
    expect(error.message).toBe("Fluxer API returned HTTP 500");
    expect(error.code).toBeUndefined();
    expect(error.body).toBe("broken");
    const detailed = new FluxerAPIError(403, "GET", "/users", { message: "Forbidden", code: "NO_PERMISSION" });
    expect(detailed.message).toBe("Forbidden");
    expect(detailed.code).toBe("NO_PERMISSION");
  });
});
