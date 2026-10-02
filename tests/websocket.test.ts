import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { GatewayClient } from "../src/gateway.js";
import { user } from "./helpers.js";

describe("real Node WebSocket adapter", () => {
  for (const runtime of ["ws", "native"] as const) {
    it.skipIf(runtime === "native" && !globalThis.WebSocket)(
      `connects using ${runtime}, identifies, heartbeats, and shuts down cleanly`,
      async () => {
        const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await once(server, "listening");
        const port = (server.address() as AddressInfo).port;
        const frames: { op: number; d: unknown }[] = [];
        let receivedHeartbeat!: () => void;
        const sequencedHeartbeat = new Promise<void>((resolve) => {
          receivedHeartbeat = resolve;
        });
        server.on("connection", (socket) => {
          socket.send(
            JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }),
          );
          socket.on("message", (raw) => {
            const frame = JSON.parse(raw.toString());
            frames.push(frame);
            if (frame.op === 2) {
              socket.send(
                JSON.stringify({
                  op: 0,
                  t: "READY",
                  s: 1,
                  d: { session_id: "s", user },
                }),
              );
              socket.send(JSON.stringify({ op: 1, d: null }));
            } else if (frame.op === 1) {
              if (frame.d === 1) receivedHeartbeat();
              socket.send(JSON.stringify({ op: 11 }));
            }
          });
        });
        const gateway = new GatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: "raw.token",
          ...(runtime === "ws"
            ? { webSocket: (url: string) => new WebSocket(url) }
            : {}),
        });
        try {
          const heartbeat = new Promise<void>((resolve) =>
            gateway.once("heartbeat", () => resolve()),
          );
          await gateway.connect();
          await Promise.all([heartbeat, sequencedHeartbeat]);
          expect(frames).toContainEqual(
            expect.objectContaining({
              op: 2,
              d: expect.objectContaining({ token: "raw.token" }),
            }),
          );
          expect(frames).toContainEqual({ op: 1, d: 1 });
        } finally {
          gateway.disconnect();
          for (const client of server.clients) client.terminate();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
  }

  it("cancels ws while its upgrade handshake is still pending", async () => {
    const server = createServer();
    server.on("upgrade", () => {
      /* leave the WebSocket handshake pending */
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    let socket: WebSocket | undefined;
    const gateway = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "raw",
      webSocket: (url) => {
        socket = new WebSocket(url);
        return socket;
      },
    });
    try {
      const pending = gateway.connect();
      const assertion = expect(pending).rejects.toThrow("disconnected");
      const closed = new Promise<void>((resolve) =>
        socket!.once("close", () => resolve()),
      );
      gateway.disconnect();
      await assertion;
      await closed;
      expect(socket!.readyState).toBe(WebSocket.CLOSED);
      expect(socket!.listenerCount("error")).toBe(0);
    } finally {
      gateway.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
