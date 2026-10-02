import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { GatewayClient, RESTClient } from "../dist/index.js";
import { nodeHTTPTransport } from "../dist/node.js";
const durationMs = Number(process.env.TALOS_SOAK_MS ?? 60000);
if (!Number.isFinite(durationMs) || durationMs < 1000)
  throw new Error("TALOS_SOAK_MS must be at least 1000");
const retained = [];
let generated = 0;
let lastSoak = 0,
  uniqueReceived = 0,
  endingRun = false;
const errorTypes = {};
let sessions = 0,
  resumes = 0,
  received = 0,
  reconnects = 0,
  sequence = 0,
  httpRequests = 0,
  limits = 0,
  errors = 0;
const server = createServer((req, res) => {
  httpRequests++;
  if (httpRequests % 31 === 0) {
    limits++;
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ retry_after: 0.005, global: true }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: "1", username: "bot" }));
});
const ws = new WebSocketServer({ server });
ws.on("connection", (socket) => {
  let count = 0;
  socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 500 } }));
  const interval = setInterval(() => {
    if (socket.readyState !== 1 || endingRun) return;
    const frame = { op: 0, t: "SOAK_EVENT", s: ++sequence, d: { sequence } };
    retained.push(frame);
    if (retained.length > 4096) retained.shift();
    generated++;
    socket.send(JSON.stringify(frame));
    if (++count >= 20) socket.close(1012, "fault injection");
  }, 25);
  socket.on("close", () => clearInterval(interval));
  socket.on("message", (data) => {
    const frame = JSON.parse(data);
    if (frame.op === 2) {
      sessions++;
      socket.send(
        JSON.stringify({
          op: 0,
          t: "READY",
          s: ++sequence,
          d: { session_id: "soak", user: { id: "1" } },
        }),
      );
    } else if (frame.op === 6) {
      resumes++;
      for (const replay of retained)
        if (replay.s > frame.d?.seq) socket.send(JSON.stringify(replay));
      socket.send(
        JSON.stringify({ op: 0, t: "RESUMED", s: ++sequence, d: {} }),
      );
    } else if (frame.op === 1) socket.send(JSON.stringify({ op: 11 }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const transport = process.env.TALOS_SOAK_NODE_HTTP === "1"
  ? nodeHTTPTransport({ maxConnections: 4 }) : undefined;
const gateway = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token: "synthetic",
    webSocket: (url) => new WebSocket(url),
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    processDispatch: async () => {},
  }),
  rest = new RESTClient({
    api: `http://127.0.0.1:${port}`,
    token: "synthetic",
    ...(transport ? { fetch: transport.fetch } : {}),
    maxConcurrentRequests: 4,
    maxPendingRequests: 50,
  });
gateway.on("dispatch", (frame) => {
  if (frame.t === "SOAK_EVENT") {
    received++;
    if (frame.s > lastSoak) {
      uniqueReceived++;
      lastSoak = frame.s;
    }
  }
});
gateway.on("reconnect", () => reconnects++);
gateway.on("error", (error) => {
  errors++;
  const name = error instanceof Error ? error.message : "unknown";
  errorTypes[name] = (errorTypes[name] ?? 0) + 1;
});
const started = Date.now(),
  samples = [];
let requestsDone = 0;
try {
  await gateway.connect();
  while (Date.now() - started < durationMs) {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        rest.request("GET", "/users/{user_id}", {
          params: { user_id: String(i) },
        }),
      ),
    );
    requestsDone += 20;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (samples.length === 0 || Date.now() - samples.at(-1).at >= 1000) {
      global.gc?.();
      samples.push({
        at: Date.now(),
        heap: process.memoryUsage().heapUsed,
        rss: process.memoryUsage().rss,
      });
    }
  }
} finally {
  endingRun = true;
  const drainDeadline = Date.now() + 5000;
  while (uniqueReceived < generated && Date.now() < drainDeadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  gateway.disconnect();
  transport?.close();
  for (const socket of ws.clients) socket.terminate();
  await new Promise((resolve) => ws.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
const result = {
  nodeHTTPPools: transport !== undefined,
  durationMs: Date.now() - started,
  requestsDone,
  httpRequests,
  rateLimits: limits,
  sessions,
  resumes,
  reconnects,
  received,
  errors,
  pending: rest.stats.pending,
  generated,
  uniqueReceived,
  duplicates: received - uniqueReceived,
  eventDifference: generated - uniqueReceived,
  errorTypes,
  heapDeltaBytes: samples.at(-1).heap - samples[0].heap,
  rssDeltaBytes: samples.at(-1).rss - samples[0].rss,
  samples: samples.length,
};
console.log(JSON.stringify(result, null, 2));
if (
  result.pending !== 0 ||
  result.errors !== 0 ||
  result.eventDifference !== 0 ||
  received === 0 ||
  (durationMs > 2000 && resumes === 0)
)
  process.exitCode = 1;
