import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startBrowserServer } from "./server.mjs";

test("closes sockets and pending uploads on shutdown", async () => {
  const server = await startBrowserServer();
  let closed = false;
  try {
    const socket = new WebSocket(server.origin.replace(/^http/, "ws"));
    await once(socket, "open");
    const socketClosed = once(socket, "close");
    const transfer = fetch(`${server.origin}/storage/cancel`, {
      method: "PUT",
      body: "pending",
    });
    const canceled = assert.rejects(transfer, TypeError);
    for (let attempt = 0; ; attempt++) {
      const status = await (await fetch(`${server.origin}/__status`)).json();
      if (status.pendingUploads === 1) break;
      if (attempt > 100) throw new Error("Upload did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await server.close();
    closed = true;
    await socketClosed;
    await canceled;
    await assert.rejects(fetch(server.origin), TypeError);
  } finally {
    if (!closed) await server.close();
  }
});
