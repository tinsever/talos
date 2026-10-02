import { parentPort, workerData } from "node:worker_threads";
import { Client } from "../dist/index.js";
import { IPCRateLimitStore } from "../dist/node.js";
import WebSocket from "ws";
const { id, data } = workerData,
  store = new IPCRateLimitStore(data.ratePort);
// Parent launches at most two workers here, below the shared source-IP Identify budget.
// Larger deployments should also coordinate gateway.beforeIdentify across processes.
const client = new Client({
  token: data.token,
  origin: data.origin,
  rest: { rateLimitStore: store },
  gateway: { shard: [id, data.count], webSocket: (url) => new WebSocket(url) },
});
client.on("error", (error) =>
  console.error(error instanceof Error ? error.name : "Gateway error"),
);
client.on("messageCreate", async (message) => {
  if (!message.author.bot && message.content === "!ping")
    await message.reply("Pong from a worker");
});
await client.connect();
parentPort.postMessage({ type: "talos:ready" });
