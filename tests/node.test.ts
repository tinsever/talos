import { MessageChannel } from "node:worker_threads";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it, expect } from "vitest";
import {
  serveRateLimits,
  IPCRateLimitStore,
  nodeWorkerFactory,
} from "../src/node.js";
import { MemoryRateLimitStore } from "../src/rate-limits.js";
it("shares atomic rate reservations through real MessagePorts and cancels pending work", async () => {
  const { port1, port2 } = new MessageChannel(),
    stop = serveRateLimits(port1, new MemoryRateLimitStore()),
    remote = new IPCRateLimitStore(port2),
    control = new AbortController();
  try {
    await remote.penalize("route", 1000, true);
    const reservation = remote.reserve("other", control.signal);
    const cancelled = expect(reservation).rejects.toMatchObject({
      name: "AbortError",
    });
    control.abort();
    await cancelled;
    await remote.observe(
      "route",
      new Headers({
        "X-RateLimit-Remaining": "1",
        "X-RateLimit-Reset-After": "0",
      }),
    );
  } finally {
    remote.close();
    stop();
    port1.close();
    port2.close();
  }
});
it("starts and stops a real Node worker with an explicit ready handshake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "talos-worker-"));
  const module = join(directory, "worker.mjs");
  await writeFile(
    module,
    "import {parentPort}from 'node:worker_threads';parentPort.postMessage({type:'talos:ready'});setInterval(()=>{},1000);",
  );
  const control = new AbortController();
  try {
    const worker = await nodeWorkerFactory(pathToFileURL(module))(0, {
      signal: control.signal,
    });
    await worker.ready;
    await worker.stop();
    expect((await worker.closed).code).toBeTypeOf("number");
  } finally {
    control.abort();
    await rm(directory, { recursive: true, force: true });
  }
});
it("transfers a rate-limit coordination port into a real worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "talos-ipc-worker-")),
    module = join(directory, "worker.mjs");
  await writeFile(
    module,
    "import{parentPort,workerData}from'node:worker_threads';const port=workerData.data.port;port.once('message',reply=>{if(reply.error)throw Error('coordination failed');parentPort.postMessage({type:'talos:ready'});});port.postMessage({id:1,kind:'observe',key:'route',headers:[['X-RateLimit-Remaining','1'],['X-RateLimit-Reset-After','0']]});",
  );
  const { port1, port2 } = new MessageChannel(),
    stop = serveRateLimits(port1, new MemoryRateLimitStore()),
    control = new AbortController();
  try {
    const worker = await nodeWorkerFactory(pathToFileURL(module), {
      workerData: { port: port2 },
      transferList: [port2],
    })(0, { signal: control.signal });
    await worker.ready;
    await worker.stop();
  } finally {
    control.abort();
    stop();
    port1.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects worker readiness when a worker exits without its handshake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "talos-worker-exit-"));
  const module = join(directory, "worker.mjs");
  await writeFile(module, "process.exit(7);");
  try {
    const worker = await nodeWorkerFactory(pathToFileURL(module))(0, {
      signal: new AbortController().signal,
    });
    await expect(worker.ready).rejects.toThrow("Worker exited before readiness (7)");
    expect(await worker.closed).toEqual({ code: 7 });
    await worker.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports startup exceptions through readiness and closes the failed worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "talos-worker-error-"));
  const module = join(directory, "worker.mjs");
  await writeFile(module, "throw new Error('startup failed');");
  try {
    const worker = await nodeWorkerFactory(pathToFileURL(module))(0, {
      signal: new AbortController().signal,
    });
    await expect(worker.ready).rejects.toThrow("startup failed");
    expect((await worker.closed).code).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("terminates an aborted real worker before startup is acknowledged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "talos-worker-abort-"));
  const module = join(directory, "worker.mjs");
  await writeFile(module, "setInterval(() => {}, 1000);");
  const controller = new AbortController();
  try {
    const factory = nodeWorkerFactory(pathToFileURL(module));
    await expect(factory(0, { signal: AbortSignal.abort("stop") })).rejects.toBe("stop");
    const worker = await factory(0, { signal: controller.signal });
    const readiness = expect(worker.ready).rejects.toThrow("Worker exited before readiness");
    controller.abort();
    await readiness;
    expect((await worker.closed).code).toBeTypeOf("number");
  } finally {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
});
