import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/gateway.js";
import type { GatewayOptions } from "../src/gateway.js";
import { FakeSocket, message, user } from "./helpers.js";

const gateways: GatewayClient[] = [];
function setup(options: Partial<GatewayOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const factory = vi.fn((url: string) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const gateway = new GatewayClient({
    url: "wss://example/gateway",
    token: "raw.token",
    webSocket: factory,
    reconnectBaseMs: 100,
    ...options,
  });
  gateways.push(gateway);
  return { gateway, sockets, factory };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.disconnect();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Gateway protocol and lifecycle", () => {
  it("waits for Hello, identifies with raw token, and resolves on READY", async () => {
    const { gateway, sockets, factory } = setup({
      ignoredEvents: ["TYPING_START"],
      shard: [0, 2],
    });
    const pending = gateway.connect();
    const socket = sockets[0]!;
    expect(socket.frames).toHaveLength(0);
    const url = new URL(factory.mock.calls[0]![0]);
    expect(url.searchParams.get("v")).toBe("1");
    expect(url.searchParams.get("compress")).toBe("none");
    socket.hello();
    expect(gateway.state).toBe("identifying");
    expect(socket.frames[0]).toMatchObject({
      op: 2,
      d: {
        token: "raw.token",
        properties: { browser: "Talos" },
        shard: [0, 2],
        ignored_events: ["TYPING_START"],
      },
    });
    expect(socket.frames[0]!.d).not.toHaveProperty("intents");
    socket.ready();
    expect(await pending).toMatchObject({ user, session_id: "session" });
    expect(gateway.state).toBe("ready");
  });
  it("responds immediately to requested heartbeats with the last delivered sequence", async () => {
    const { gateway, sockets } = setup();
    const pending = gateway.connect();
    const socket = sockets[0]!;
    socket.hello();
    socket.ready();
    await pending;
    socket.receive(0, message(), "MESSAGE_CREATE", 7);
    const latency = vi.fn();
    gateway.on("heartbeat", latency);
    socket.receive(1, null);
    expect(socket.frames.at(-1)).toEqual({ op: 1, d: 7 });
    await vi.advanceTimersByTimeAsync(20);
    socket.receive(11);
    expect(latency).toHaveBeenCalledWith({ latencyMs: 20 });
  });
  it("reconnects after missing ACK and resumes with the prior session and sequence", async () => {
    const { gateway, sockets } = setup();
    const pending = gateway.connect();
    sockets[0]!.hello();
    sockets[0]!.ready();
    await pending;
    sockets[0]!.receive(0, message(), "MESSAGE_CREATE", 5);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(gateway.state).toBe("reconnecting");
    expect(sockets[0]!.listenerCount).toBe(0);
    await vi.advanceTimersByTimeAsync(75);
    sockets[1]!.hello();
    expect(sockets[1]!.frames[0]).toEqual({
      op: 6,
      d: { token: "raw.token", session_id: "session", seq: 5 },
    });
    sockets[1]!.receive(0, {}, "RESUMED", 5);
    expect(gateway.state).toBe("ready");
  });
  it("handles Reconnect and ignores delayed close/messages from the old socket", async () => {
    const { gateway, sockets } = setup();
    const pending = gateway.connect();
    sockets[0]!.hello();
    sockets[0]!.ready();
    await pending;
    const dispatch = vi.fn();
    gateway.on("dispatch", dispatch);
    sockets[0]!.receive(7);
    sockets[0]!.closed(4000);
    sockets[0]!.receive(0, message(), "MESSAGE_CREATE", 999);
    await vi.advanceTimersByTimeAsync(75);
    expect(sockets).toHaveLength(2);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("identifies on the same socket after a rejected Resume", async () => {
    const { gateway, sockets } = setup();
    const pending = gateway.connect();
    sockets[0]!.hello();
    sockets[0]!.ready();
    await pending;
    sockets[0]!.closed();
    await vi.advanceTimersByTimeAsync(75);
    const next = sockets[1]!;
    next.hello();
    expect(next.frames[0]!.op).toBe(6);
    next.receive(9, false);
    expect(next.frames[1]!.op).toBe(2);
    next.receive(1, null);
    expect(next.frames.at(-1)).toEqual({ op: 1, d: null });
    next.ready("new-session");
    expect(gateway.state).toBe("ready");
  });
  it("drops a retained session after its 60 second retention window", async () => {
    const { gateway, sockets } = setup({
      reconnectBaseMs: 80_000,
      reconnectMaxMs: 80_000,
    });
    const pending = gateway.connect();
    sockets[0]!.hello();
    sockets[0]!.ready();
    await pending;
    sockets[0]!.closed();
    await vi.advanceTimersByTimeAsync(60_000);
    sockets[1]!.hello();
    expect(sockets[1]!.frames[0]!.op).toBe(2);
  });
  it("stops on invalid credentials instead of retrying authentication", async () => {
    const { gateway, sockets } = setup();
    const pending = gateway.connect();
    const assertion = expect(pending).rejects.toMatchObject({
      name: "GatewayError",
      code: 4004,
    });
    sockets[0]!.closed(4004, "Invalid token");
    await assertion;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
    expect(gateway.state).toBe("closed");
  });
  it("re-identifies after invalid sequence without reusing the rejected sequence", async () => {
    const { gateway, sockets } = setup();
    const pending = gateway.connect();
    sockets[0]!.hello();
    sockets[0]!.ready();
    await pending;
    sockets[0]!.closed(4007);
    await vi.advanceTimersByTimeAsync(75);
    sockets[1]!.hello();
    expect(sockets[1]!.frames[0]!.op).toBe(2);
  });
  it("ignores future server opcodes without reconnecting", async () => {
    const { gateway, sockets } = setup();
    const pending = gateway.connect();
    sockets[0]!.hello();
    sockets[0]!.ready();
    await pending;
    const unknown = vi.fn();
    gateway.on("unknownOpcode", unknown);
    sockets[0]!.receive(42, {});
    expect(unknown).toHaveBeenCalledWith(42);
    expect(gateway.state).toBe("ready");
  });
  it("bounds reconnect attempts and rejects the initial connection", async () => {
    const { gateway, sockets } = setup({ maxReconnects: 1 });
    const pending = gateway.connect();
    const assertion = expect(pending).rejects.toThrow("budget exhausted");
    sockets[0]!.closed();
    await vi.advanceTimersByTimeAsync(75);
    sockets[1]!.closed();
    await assertion;
    expect(gateway.state).toBe("closed");
  });
  it("bounds a silent handshake and initial connection lifetime", async () => {
    const { gateway, sockets } = setup({ handshakeTimeoutMs: 100 });
    const pending = gateway.connect({ timeoutMs: 250 });
    const assertion = expect(pending).rejects.toThrow("deadline exceeded");
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(sockets).toHaveLength(2);
    expect(sockets.every((socket) => socket.listenerCount === 0)).toBe(true);
  });
  it("cancels an in-flight connection and disposes listeners and timers", async () => {
    const { gateway, sockets } = setup();
    const controller = new AbortController();
    const pending = gateway.connect({ signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await assertion;
    expect(sockets[0]!.listenerCount).toBe(0);
  });
  it("does not reconnect after manual disconnect", async () => {
    const { gateway, sockets } = setup();
    const pending = gateway.connect();
    sockets[0]!.hello();
    sockets[0]!.ready();
    await pending;
    gateway.disconnect();
    sockets[0]!.closed();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.listenerCount).toBe(0);
  });
  it("rejects oversized commands and commands before READY", async () => {
    const { gateway, sockets } = setup();
    expect(() => gateway.send(3, {})).toThrow("not ready");
    const pending = gateway.connect();
    sockets[0]!.hello();
    sockets[0]!.ready();
    await pending;
    expect(() => gateway.send(3, { text: "ü".repeat(3000) })).toThrow(
      "4096 bytes",
    );
  });
  it("captures async listener failures and does not loop on failing error handlers", async () => {
    const { gateway, sockets } = setup();
    const pending = gateway.connect();
    const error = vi.fn(async () => {
      throw new Error("observer");
    });
    gateway.on("error", error);
    gateway.on("dispatch", async () => {
      throw new Error("handler");
    });
    sockets[0]!.hello();
    sockets[0]!.ready();
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledTimes(1);
  });
  it("validates raw token, shard bounds, and filters before connecting", () => {
    expect(() => setup({ token: "Bot token" })).toThrow("raw");
    expect(() => setup({ shard: [1, 1] })).toThrow("shard");
    expect(() =>
      setup({ ignoredEvents: Array(257).fill("TYPING_START") }),
    ).toThrow("256");
  });
});
