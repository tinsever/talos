import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import { GatewayClient } from "../src/gateway.js";
import { ShardManager } from "../src/shards.js";
import { WorkerSupervisor } from "../src/supervisor.js";
import type { SupervisedWorker } from "../src/supervisor.js";
import { FakeSocket, json } from "./helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const endpoints = { api_public: "https://example", gateway: "wss://example" };
const metadata = () =>
  json({
    shards: 2,
    session_start_limit: { max_concurrency: 1 },
  });

describe("shard startup", () => {
  it("applies the deadline to metadata requests", async () => {
    vi.useFakeTimers();
    const createClient = vi.fn();
    const manager = new ShardManager({
      token: "test",
      endpoints,
      createClient,
      rest: { fetch: () => new Promise(() => {}) },
    });
    cleanup.push(() => manager.disconnect());
    const assertion = expect(
      manager.connect({ timeoutMs: 20 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(createClient).not.toHaveBeenCalled();
    expect(manager.shards).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds adapters that ignore cancellation and removes queued shard starts", async () => {
    vi.useFakeTimers();
    const connect = vi.fn(() => new Promise<void>(() => {}));
    const disconnect = vi.fn();
    const manager = new ShardManager({
      token: "test",
      endpoints,
      count: 2,
      rest: { fetch: async () => metadata() },
      createClient: () => ({ connect, disconnect }) as unknown as Client,
    });
    cleanup.push(() => manager.disconnect());
    const assertion = expect(
      manager.connect({ timeoutMs: 20 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let cancelled startup dispose the next connection", async () => {
    const pending = deferred<Response>();
    const disconnect = vi.fn();
    const manager = new ShardManager({
      token: "test",
      endpoints,
      count: 1,
      rest: {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockReturnValueOnce(pending.promise)
          .mockImplementation(async () => metadata()),
      },
      createClient: () =>
        ({ connect: async () => {}, disconnect }) as unknown as Client,
    });
    cleanup.push(() => manager.disconnect());
    const first = manager.connect();
    const failed = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    manager.disconnect();
    const second = manager.connect();
    await failed;
    await second;
    pending.resolve(metadata());
    await flush();
    expect(manager.shards).toHaveLength(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("disposes clients created before a factory exception", async () => {
    const disconnect = vi.fn();
    const manager = new ShardManager({
      token: "test",
      endpoints,
      count: 2,
      rest: { fetch: async () => metadata() },
      createClient: vi
        .fn()
        .mockReturnValueOnce({ connect: vi.fn(), disconnect })
        .mockImplementationOnce(() => {
          throw new Error("factory failed");
        }),
    });
    cleanup.push(() => manager.disconnect());
    await expect(manager.connect()).rejects.toThrow("factory failed");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(manager.shards).toHaveLength(0);
  });

  it("validates a deadline before activating the manager", async () => {
    const manager = new ShardManager({ token: "test", endpoints });
    cleanup.push(() => manager.disconnect());
    await expect(manager.connect({ timeoutMs: 0 })).rejects.toThrow(
      "timeoutMs",
    );
    await expect(manager.connect({ timeoutMs: Infinity })).rejects.toThrow(
      "timeoutMs",
    );
  });
});

describe("worker supervision", () => {
  it("includes spawning in the startup timeout and disposes a late worker", async () => {
    vi.useFakeTimers();
    const pending = deferred<SupervisedWorker>();
    const stop = vi.fn();
    const supervisor = new WorkerSupervisor({
      count: 1,
      startupTimeoutMs: 20,
      spawn: () => pending.promise,
    });
    cleanup.push(() => supervisor.stop());
    const assertion = expect(supervisor.start()).rejects.toThrow(
      "startup timed out",
    );
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    pending.resolve({
      ready: Promise.reject(new Error("cancelled startup")),
      closed: Promise.reject(new Error("cancelled transport")),
      stop,
    });
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps stop idempotent and prevents new startup until shutdown completes", async () => {
    const stopped = deferred<void>();
    const stop = vi.fn(() => stopped.promise);
    const supervisor = new WorkerSupervisor({
      count: 1,
      spawn: async () => ({
        ready: Promise.resolve(),
        closed: new Promise(() => {}),
        stop,
      }),
    });
    cleanup.push(() => supervisor.stop());
    await supervisor.start();
    const first = supervisor.stop();
    expect(supervisor.stop()).toBe(first);
    await expect(supervisor.start()).rejects.toThrow("stopping");
    stopped.resolve();
    await first;
    expect(stop).toHaveBeenCalledTimes(1);
    await supervisor.start();
  });

  it("handles worker exits and rejected exit signals during startup", async () => {
    for (const closed of [
      Promise.resolve({ code: 2 }),
      Promise.reject(new Error("transport failed")),
    ]) {
      closed.catch(() => {});
      const stop = vi.fn();
      const supervisor = new WorkerSupervisor({
        count: 1,
        spawn: async () => ({ ready: new Promise(() => {}), closed, stop }),
      });
      cleanup.push(() => supervisor.stop());
      await expect(supervisor.start()).rejects.toThrow();
      expect(stop).toHaveBeenCalledTimes(1);
    }
  });

  it("cleans up all workers after restart exhaustion and allows a fresh start", async () => {
    vi.useFakeTimers();
    const exits: ReturnType<typeof deferred<{ code: number }>>[] = [];
    const stops: ReturnType<typeof vi.fn>[] = [];
    const supervisor = new WorkerSupervisor({
      count: 2,
      maxRestarts: 0,
      spawn: async () => {
        const exit = deferred<{ code: number }>(),
          stop = vi.fn();
        exits.push(exit);
        stops.push(stop);
        return { ready: Promise.resolve(), closed: exit.promise, stop };
      },
    });
    cleanup.push(() => supervisor.stop());
    const errors = vi.fn(),
      stopped = vi.fn();
    supervisor.on("error", errors);
    supervisor.on("stopped", stopped);
    await supervisor.start();
    exits[0]!.resolve({ code: 1 });
    await flush();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(stops[1]).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
    await supervisor.start();
    expect(exits).toHaveLength(4);
  });

  it("reports shutdown errors without rejecting stop", async () => {
    const supervisor = new WorkerSupervisor({
      count: 1,
      spawn: async () => ({
        ready: Promise.resolve(),
        closed: new Promise(() => {}),
        stop: () => {
          throw new Error("stop failed");
        },
      }),
    });
    cleanup.push(() => supervisor.stop());
    const errors = vi.fn();
    supervisor.on("error", errors);
    await supervisor.start();
    await supervisor.stop();
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "stop failed" }),
    );
  });
});

describe("gateway frame and lifecycle isolation", () => {
  it.each([
    "null",
    "[]",
    "{",
    '{"op":"0"}',
    '{"op":0,"t":"READY","s":1,"d":{"session_id":"s","user":{"id":"1"}}}',
  ])("rejects malformed or out-of-order initial frames: %s", async (raw) => {
    const socket = new FakeSocket();
    const gateway = new GatewayClient({
      url: endpoints.gateway,
      token: "test",
      webSocket: () => socket,
      maxReconnects: 0,
    });
    cleanup.push(() => gateway.disconnect());
    const dispatch = vi.fn();
    gateway.on("dispatch", dispatch);
    const failed = expect(gateway.connect()).rejects.toThrow();
    socket.emit("message", { data: raw });
    await failed;
    expect(dispatch).not.toHaveBeenCalled();
    expect(socket.listenerCount).toBe(0);
  });

  it.each(["reconnect", "disconnect"])(
    "retains a connection started by a durable hook's abort handler during %s",
    async (operation) => {
      const sockets = [new FakeSocket(), new FakeSocket()];
      let index = 0,
        replacement: Promise<unknown> | undefined;
      const gateway = new GatewayClient({
        url: endpoints.gateway,
        token: "test",
        webSocket: () => sockets[index++]!,
        processDispatch: async (_, { signal }) => {
          if (index !== 1) return;
          signal.addEventListener(
            "abort",
            () => {
              gateway.disconnect();
              replacement = gateway.connect();
            },
            { once: true },
          );
        },
      });
      const first = gateway.connect();
      sockets[0]!.hello();
      sockets[0]!.ready();
      await first;
      await flush();
      if (operation === "reconnect") sockets[0]!.receive(7);
      else gateway.disconnect();
      expect(sockets[1]!.listenerCount).toBe(3);
      sockets[1]!.hello();
      sockets[1]!.ready();
      await replacement;
      expect(gateway.state).toBe("ready");
      gateway.disconnect();
      await flush();
    },
  );

  it("keeps rediscovery started by a closed observer active", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const discovery = deferred<Response>();
    let index = 0,
      replacement: Promise<void> | undefined;
    const client = new Client({
      token: "test",
      rest: {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(json({ endpoints }))
          .mockReturnValueOnce(discovery.promise),
      },
      gateway: { webSocket: () => sockets[index++]! },
    });
    cleanup.push(() => client.disconnect());
    const first = client.connect();
    const failed = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    sockets[0]!.hello();
    const off = client.on("state", (state) => {
      if (state === "closed") {
        off();
        replacement = client.connect();
      }
    });
    client.disconnect();
    await failed;
    discovery.resolve(json({ endpoints }));
    await flush();
    sockets[1]!.hello();
    sockets[1]!.ready();
    await replacement;
    expect(client.user?.id).toBe("1");
    expect(client.gateway.state).toBe("ready");
  });

  it("does not forward stale gateway events after reconnecting the client", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let index = 0;
    const client = new Client({
      token: "test",
      endpoints,
      gateway: { webSocket: () => sockets[index++]! },
    });
    cleanup.push(() => client.disconnect());
    const first = client.connect();
    sockets[0]!.hello();
    sockets[0]!.ready();
    await first;
    const old = client.gateway;
    client.disconnect();
    const second = client.connect();
    sockets[1]!.hello();
    sockets[1]!.ready();
    await second;
    const forwarded = vi.fn();
    client.on("error", forwarded);
    client.on("heartbeat", forwarded);
    old.emit("error", new Error("stale"));
    old.emit("heartbeat", { latencyMs: 1 });
    expect(forwarded).not.toHaveBeenCalled();
    expect(client.user?.id).toBe("1");
  });
});
