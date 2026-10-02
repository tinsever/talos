import { afterEach, describe, it, expect, vi } from "vitest";
import { TypedEmitter } from "../src/events.js";
import { RESTClient } from "../src/rest.js";
import { MemoryRateLimitStore } from "../src/rate-limits.js";
import { GatewayClient } from "../src/gateway.js";
import { IdentifyLimiter, ShardManager } from "../src/shards.js";
import { FakeSocket, json, user } from "./helpers.js";
const gateways: GatewayClient[] = [];
afterEach(() => {
  for (const g of gateways.splice(0)) g.disconnect();
  vi.useRealTimers();
});
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
describe("bounded work and lifecycle", () => {
  it("a stale unsubscribe cannot remove new subscriptions", () => {
    const events = new TypedEmitter<{ value: number }>();
    const old = events.on("value", () => {});
    events.removeAllListeners();
    const listener = vi.fn();
    events.on("value", listener);
    old();
    events.emit("value", 1);
    expect(listener).toHaveBeenCalledWith(1);
  });
  it("bounds concurrency and accepted work and frees aborted queue slots", async () => {
    const resolvers: ((r: Response) => void)[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        () => new Promise((resolve) => resolvers.push(resolve)),
      );
    const rest = new RESTClient({
      api: "https://example",
      token: "x",
      fetch,
      maxConcurrentRequests: 1,
      maxPendingRequests: 2,
      maxRetries: 0,
    });
    const control = new AbortController();
    const a = rest.request("GET", "/users/{user_id}", {
      params: { user_id: "1" },
    });
    const b = rest.request("GET", "/users/{user_id}", {
      params: { user_id: "2" },
      signal: control.signal,
    });
    const cancelled = expect(b).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rest.stats).toEqual({ pending: 2, active: 1, waiting: 1 });
    await expect(
      rest.request("GET", "/users/{user_id}", { params: { user_id: "3" } }),
    ).rejects.toMatchObject({ name: "RequestQueueFullError" });
    control.abort();
    await cancelled;
    resolvers[0]!(json(user));
    await a;
    expect(rest.stats.pending).toBe(0);
    expect(rest.stats.active).toBe(0);
  });
  it("shares global limits between separate REST clients", async () => {
    vi.useFakeTimers();
    const store = new MemoryRateLimitStore();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ retry_after: 0.1, global: true }, 429))
      .mockResolvedValue(json(user));
    const a = new RESTClient({
        api: "https://example",
        token: "x",
        fetch,
        rateLimitStore: store,
        maxRetries: 0,
      }),
      b = new RESTClient({
        api: "https://example",
        token: "x",
        fetch,
        rateLimitStore: store,
      });
    await expect(a.request("GET", "/users/@me")).rejects.toMatchObject({
      status: 429,
    });
    const next = b.request("GET", "/users/{user_id}", {
      params: { user_id: "2" },
    });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await next;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("disconnecting from connecting observers never constructs a socket", async () => {
    const factory = vi.fn(() => new FakeSocket());
    const g = new GatewayClient({
      url: "wss://example",
      token: "x",
      webSocket: factory,
    });
    gateways.push(g);
    g.on("state", (state) => {
      if (state === "connecting") g.disconnect();
    });
    await expect(g.connect()).rejects.toThrow("disconnected");
    expect(factory).not.toHaveBeenCalled();
  });
  it("disconnecting from ready observers cannot resolve the old connect", async () => {
    const socket = new FakeSocket(),
      g = new GatewayClient({
        url: "wss://example",
        token: "x",
        webSocket: () => socket,
      });
    gateways.push(g);
    g.on("ready", () => g.disconnect());
    const connection = g.connect();
    const failed = expect(connection).rejects.toThrow("disconnected");
    socket.hello();
    socket.ready();
    await failed;
    expect(socket.listenerCount).toBe(0);
    expect(g.state).toBe("closed");
  });
  it("a reconnect started by a closed observer retains its own pending promise", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let index = 0;
    const g = new GatewayClient({
      url: "wss://example",
      token: "x",
      webSocket: () => sockets[index++]!,
    });
    gateways.push(g);
    const first = g.connect();
    const failed = expect(first).rejects.toThrow("disconnected");
    let second: Promise<unknown> | undefined;
    const off = g.on("state", (state) => {
      if (state === "closed") {
        off();
        second = g.connect();
      }
    });
    g.disconnect();
    await failed;
    sockets[1]!.hello();
    sockets[1]!.ready();
    await second;
    expect(g.state).toBe("ready");
  });
  it("durable processing orders dispatches and only acknowledges completed work", async () => {
    const socket = new FakeSocket(),
      seen: number[] = [];
    let release!: () => void;
    const g = new GatewayClient({
      url: "wss://example",
      token: "x",
      webSocket: () => socket,
      processDispatch: async (frame) => {
        if (frame.s === 2)
          await new Promise<void>((resolve) => (release = resolve));
        seen.push(frame.s);
      },
    });
    gateways.push(g);
    const connection = g.connect();
    socket.hello(100000);
    socket.ready();
    await connection;
    await flush();
    socket.receive(0, {}, "TEST", 2);
    socket.receive(0, {}, "TEST", 3);
    await flush();
    socket.receive(1);
    expect(socket.frames.at(-1)?.d).toBe(1);
    expect(seen).toEqual([1]);
    socket.receive(11);
    release();
    await flush();
    socket.receive(1);
    expect(socket.frames.at(-1)?.d).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
  });
  it("waiting Identify work is cancelled before sending the token", async () => {
    let release!: () => void;
    const socket = new FakeSocket(),
      g = new GatewayClient({
        url: "wss://example",
        token: "x",
        webSocket: () => socket,
        beforeIdentify: () =>
          new Promise<void>((resolve) => (release = resolve)),
      });
    gateways.push(g);
    const connection = g.connect(),
      failed = expect(connection).rejects.toThrow("disconnected");
    socket.hello();
    await flush();
    g.disconnect();
    release();
    await failed;
    await flush();
    expect(socket.frames.some((f) => f.op === 2)).toBe(false);
  });
  it("limits presence commands without silent drops", async () => {
    const socket = new FakeSocket(),
      g = new GatewayClient({
        url: "wss://example",
        token: "x",
        webSocket: () => socket,
      });
    gateways.push(g);
    const p = g.connect();
    socket.hello();
    socket.ready();
    await p;
    for (let i = 0; i < 5; i++) g.setPresence({ status: "online" });
    expect(() => g.setPresence({ status: "idle" })).toThrow("5 per 20 seconds");
  });
  it("schedules source-IP admission and removes cancelled waiters", async () => {
    vi.useFakeTimers();
    const limiter = new IdentifyLimiter(1, 100),
      a = new AbortController();
    await limiter.acquire(a.signal);
    const cancelled = limiter.acquire(a.signal),
      failed = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    a.abort();
    await failed;
    const next = limiter.acquire(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    await next;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("starts all shards and closes every connection", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new ShardManager({
      token: "x",
      count: 2,
      endpoints: { api_public: "https://example", gateway: "wss://example" },
      rest: {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(
            json({
              url: "wss://example",
              shards: 2,
              session_start_limit: {
                total: 1000,
                remaining: 1000,
                reset_after: 60000,
                max_concurrency: 2,
              },
            }),
          ),
      },
      gateway: {
        webSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          setTimeout(() => {
            socket.hello();
            setTimeout(() => socket.ready(), 0);
          }, 0);
          return socket;
        },
      },
    });
    try {
      const shards = await manager.connect();
      expect(shards).toHaveLength(2);
      expect(
        sockets.map(
          (s) =>
            (s.frames.find((f) => f.op === 2)?.d as { shard: number[] }).shard,
        ),
      ).toEqual([
        [0, 2],
        [1, 2],
      ]);
    } finally {
      manager.disconnect();
    }
    expect(sockets.every((s) => s.listenerCount === 0)).toBe(true);
  });
});

it("invokes native-style fetch with the global receiver", async () => {
  const fetch = function (this: unknown) {
    expect(this).toBe(globalThis);
    return Promise.resolve(json(user));
  } as typeof globalThis.fetch;
  const rest = new RESTClient({ api: "https://example", token: "x", fetch });
  await rest.request("GET", "/users/@me");
});
