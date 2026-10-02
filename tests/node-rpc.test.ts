import { MessageChannel } from "node:worker_threads";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { IPCRateLimitStore, serveRateLimits } from "../src/node.js";
import type { RateLimitStore } from "../src/rate-limits.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function channel() {
  const { port1, port2 } = new MessageChannel();
  cleanups.push(() => { port1.close(); port2.close(); });
  return { port1, port2 };
}

it("validates both coordinator and worker pending limits", () => {
  const { port1, port2 } = channel();
  const store: RateLimitStore = { reserve: async () => {}, observe() {}, penalize() {} };
  for (const limit of [0, -1, 0.5, Infinity]) {
    expect(() => serveRateLimits(port1, store, limit)).toThrow(RangeError);
    expect(() => new IPCRateLimitStore(port2, limit)).toThrow(RangeError);
  }
});

it("rejects extra pending work and rejects every pending call when the coordinator closes", async () => {
  const { port2 } = channel(), remote = new IPCRateLimitStore(port2, 1);
  cleanups.push(remote.close);
  const pending = remote.reserve("route", new AbortController().signal);
  const closed = expect(pending).rejects.toThrow("coordinator closed");
  await expect(remote.observe("other", new Headers())).rejects.toThrow("queue is full");
  remote.close();
  remote.close();
  await closed;
  await expect(remote.penalize("other", 1, false)).rejects.toThrow("coordinator closed");
});

it("rejects already aborted work without posting a reservation", async () => {
  const { port1, port2 } = channel(), remote = new IPCRateLimitStore(port2), post = vi.spyOn(port2, "postMessage");
  cleanups.push(remote.close);
  await expect(remote.reserve("route", AbortSignal.abort("stop"))).rejects.toBe("stop");
  expect(post).not.toHaveBeenCalled();
  const receiving = once(port1, "message");
  const pending = remote.observe("route", new Headers({ "Authorization": "Bot private", "Content-Type": "text/plain", "X-RateLimit-Remaining": "2" }));
  const [command] = await receiving;
  expect(command.headers).toEqual([["x-ratelimit-remaining", "2"]]);
  port1.postMessage({ id: command.id });
  await pending;
});

it("isolates invalid commands and coordinator store failures", async () => {
  const { port1, port2 } = channel(), penalize = vi.fn(), store: RateLimitStore = {
    reserve: async () => { throw new Error("private implementation details"); },
    observe() {}, penalize,
  };
  const stop = serveRateLimits(port1, store), remote = new IPCRateLimitStore(port2);
  cleanups.push(stop, remote.close);
  await expect(remote.reserve("route", new AbortController().signal)).rejects.toThrow("Rate limit coordination failed");
  for (const value of [-1, NaN, Infinity])
    await expect(remote.penalize("route", value, false)).rejects.toThrow("Rate limit coordination failed");
  expect(penalize).not.toHaveBeenCalled();
  const reply = once(port2, "message");
  port2.postMessage({ id: 100, key: "route", kind: "unknown" });
  expect((await reply)[0]).toEqual({ id: 100, error: true });
});

it("bounds parent work and aborts reservations on cleanup", async () => {
  const { port1, port2 } = channel();
  let started!: (signal: AbortSignal) => void;
  const reserved = new Promise<AbortSignal>(resolve => { started = resolve; });
  const store: RateLimitStore = {
    reserve: (_key, signal) => {
      started(signal);
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    observe() {}, penalize() {},
  };
  const stop = serveRateLimits(port1, store, 1);
  cleanups.push(stop);
  port2.postMessage({ id: 0, key: "route", kind: "reserve" });
  const signal = await reserved;
  const reply = once(port2, "message");
  port2.postMessage({ id: 1, key: "other", kind: "reserve" });
  expect((await reply)[0]).toEqual({ id: 1, error: true });
  stop();
  stop();
  expect(signal.aborted).toBe(true);
});

it("cleans up pending calls when posting to the transport throws", async () => {
  const { port2 } = channel(), remote = new IPCRateLimitStore(port2, 1);
  cleanups.push(remote.close);
  const failure = new Error("transport failed"), post = vi.spyOn(port2, "postMessage").mockImplementation(() => { throw failure; });
  await expect(remote.observe("route", new Headers())).rejects.toBe(failure);
  await expect(remote.penalize("route", 1, false)).rejects.toBe(failure);
  post.mockRestore();
});

it("preserves cancellation even when sending the cancel command fails", async () => {
  const { port2 } = channel(), remote = new IPCRateLimitStore(port2), controller = new AbortController();
  cleanups.push(remote.close);
  const pending = remote.reserve("route", controller.signal);
  const cancelled = expect(pending).rejects.toBe("stop");
  const post = vi.spyOn(port2, "postMessage").mockImplementation(() => { throw new Error("closed transport"); });
  controller.abort("stop");
  await cancelled;
  post.mockRestore();
});
