import { MessageChannel } from "node:worker_threads";
import { WorkerSupervisor } from "../dist/supervisor.js";
import { nodeWorkerFactory, serveRateLimits } from "../dist/node.js";
import { MemoryRateLimitStore } from "../dist/rate-limits.js";
const token = process.env.FLUXER_BOT_TOKEN;
if (!token) throw new Error("Populate .env");
const count = 2,
  store = new MemoryRateLimitStore();
const supervisor = new WorkerSupervisor({
  count,
  spawn(id, context) {
    const { port1, port2 } = new MessageChannel();
    serveRateLimits(port1, store);
    return nodeWorkerFactory(new URL("./node-worker.mjs", import.meta.url), {
      workerData: {
        token,
        count,
        origin: process.env.FLUXER_ORIGIN ?? "https://fluxer.app",
        ratePort: port2,
      },
      transferList: [port2],
    })(id, context);
  },
});
supervisor.on("error", (error) =>
  console.error(error instanceof Error ? error.name : "Worker error"),
);
process.once("SIGINT", () => void supervisor.stop());
process.once("SIGTERM", () => void supervisor.stop());
await supervisor.start();
