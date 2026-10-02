import { Client } from "../dist/index.js";
import WebSocket from "ws";
import { writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
const token = process.env.FLUXER_BOT_TOKEN;
if (!token) throw new Error("Populate FLUXER_BOT_TOKEN in .env");
const durationMs = Number(process.env.TALOS_SOAK_MS ?? 86400000);
if (
  !Number.isSafeInteger(durationMs) ||
  durationMs < 1000 ||
  durationMs >= 2147483648
)
  throw new Error("Invalid TALOS_SOAK_MS");
const client = new Client({
  token,
  origin: process.env.FLUXER_ORIGIN ?? "https://fluxer.app",
  gateway: { webSocket: (url) => new WebSocket(url) },
  cache: { messages: 100, channels: 100, guilds: 100 },
});
const reportPath = process.env.TALOS_SOAK_REPORT;
const stats = {
  status: "starting",
  startedAt: new Date().toISOString(),
  dispatches: 0,
  reconnects: 0,
  resumes: 0,
  ready: 0,
  errors: 0,
  regressingSequences: 0,
  sequenceGaps: 0,
  samples: [],
};
let lastSequence = null;
client.on("dispatch", (frame) => {
  stats.dispatches++;
  if (lastSequence !== null && frame.s < lastSequence)
    stats.regressingSequences++;
  if (lastSequence !== null && frame.s > lastSequence + 1) stats.sequenceGaps++;
  lastSequence = frame.s;
});
client.on("ready", () => {
  stats.ready++;
  lastSequence = null;
});
client.on("resumed", () => stats.resumes++);
client.on("reconnect", () => stats.reconnects++);
client.on("error", () => stats.errors++);
client.on("state", (state) => {
  if (state === "closed" && stats.status === "running") {
    stats.status = "failed";
    stats.failure = { name: "GatewayClosed" };
    process.exitCode = 1;
    ending();
  }
});
let timer, sampler;
const started = Date.now();
let ending;
let reporting = Promise.resolve();
const stop = new Promise((resolve) => (ending = resolve));
const onStop = () => {
  stats.status = "stopped";
  client.disconnect();
  ending();
};
const save = async () => {
  if (reportPath) {
    const contents =
      JSON.stringify({ ...stats, durationMs: Date.now() - started }, null, 2) +
      "\n";
    reporting = reporting
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(reportPath), { recursive: true });
        const temporary = `${reportPath}.${process.pid}.tmp`;
        await writeFile(temporary, contents);
        await rename(temporary, reportPath);
      });
    await reporting;
  }
};
process.once("SIGINT", onStop);
process.once("SIGTERM", onStop);
try {
  await client.connect();
  stats.status = "running";
  await save();
  sampler = setInterval(() => {
    stats.samples.push({
      elapsedMs: Date.now() - started,
      heapBytes: process.memoryUsage().heapUsed,
      rssBytes: process.memoryUsage().rss,
    });
    if (stats.samples.length > 10000) stats.samples.shift();
    void save().catch(() => {
      stats.reportWriteFailures = (stats.reportWriteFailures ?? 0) + 1;
    });
  }, 60000);
  timer = setTimeout(() => {
    stats.status = "completed";
    ending();
  }, durationMs);
  await stop;
} catch (error) {
  if (stats.status !== "stopped") {
    stats.status = "failed";
    stats.failure = { name: error?.name, code: error?.code };
    process.exitCode = 1;
  }
} finally {
  clearTimeout(timer);
  clearInterval(sampler);
  client.disconnect();
  process.removeListener("SIGINT", onStop);
  process.removeListener("SIGTERM", onStop);
  stats.durationMs = Date.now() - started;
  stats.endedAt = new Date().toISOString();
  if (
    stats.status === "completed" &&
    (stats.ready === 0 || stats.regressingSequences > 0)
  ) {
    stats.status = "failed";
    stats.failure = { name: "ProtocolInvariantFailed" };
    process.exitCode = 1;
  }
  await save();
  console.log(JSON.stringify(stats, null, 2));
}
