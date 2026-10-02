# Shards and workers

Sharding splits gateway traffic across clients. Worker supervision handles the
lifecycle of the processes or threads running your code. See
[the event guide](../gateway.md#shards-and-workers) for how they fit together.

## IdentifyLimiter

Import from `talos-fluxer/shards`. Construct
`new IdentifyLimiter(limit?, windowMs?)`. The defaults allow 250 starts per
60-second rolling window. `limit` must be an integer from 1 to 300, and `windowMs`
must be positive. See [the source](../../src/shards.ts).

| Member | Result and behaviour |
| --- | --- |
| `limit` | Maximum starts in the configured window. |
| `windowMs` | Rolling-window duration in milliseconds. |
| `acquire(signal)` | `Promise<void>`; waits until an Identify attempt can start. |

Share a limiter across managers using the same source IP. For multiple processes,
provide a coordinated object with `acquire(signal)` or use `beforeIdentify`.
These defaults describe Talos's gate, not a guarantee of the instance's quota.

## ShardManager

Import from `talos-fluxer/shards`. `new ShardManager(options)` accepts the client
options plus `count`, `identifyLimiter`, and `createClient`. Its `gateway` options
exclude `shard`, which the manager sets for each client.

| Member | Result and behaviour |
| --- | --- |
| `shards` | Read-only array of created `Client` instances. |
| `connect({ signal?, timeoutMs? }?)` | `Promise<readonly Client[]>`; reads `/gateway/bot`, creates clients, and waits for startup. Default deadline: 60 seconds. |
| `disconnect()` | `void`; stops all managed clients. |

Without `count`, the manager uses the API's recommended shard count. It shares
one REST rate-limit store across clients and runs its Identify gate before every
Identify, including reconnects. A startup failure stops the created clients.

Use `createClient` to install listeners before each connection starts:

```ts
import { Client } from "talos-fluxer";
import { ShardManager } from "talos-fluxer/shards";

const manager = new ShardManager({
  token,
  createClient(options) {
    const client = new Client(options);
    client.on("error", (error) => console.error(error));
    client.on("messageCreate", async (message) => {
      if (!message.author.bot && message.content === "!ping") {
        await message.reply("Pong!");
      }
    });
    return client;
  },
});

process.once("SIGINT", () => manager.disconnect());
process.once("SIGTERM", () => manager.disconnect());
await manager.connect();
```

This example uses a runtime with a global WebSocket. Inject the factory through
`gateway.webSocket` on Node 20.

## WorkerSupervisor

Import from `talos-fluxer/supervisor`. `new WorkerSupervisor(options)` requires
`count` and `spawn(id, { signal })`. The spawn adapter returns a
`SupervisedWorker` with `ready`, `closed`, and `stop()`.
See [the source](../../src/supervisor.ts).

| Option | Default and meaning |
| --- | --- |
| `count` | Required; 1–16,384 worker slots. |
| `spawn` | Required; creates a worker and honors shutdown cancellation. |
| `maxRestarts` | `5` restarts per slot over the supervisor run. |
| `restartBaseMs` | `1_000`; exponential restart delay, capped at 30 seconds. |
| `startupTimeoutMs` | `60_000`; deadline for creating and readying each worker. |

| Method | Result and behaviour |
| --- | --- |
| `start()` | `Promise<void>`; resolves when all initial workers are ready. |
| `stop()` | `Promise<void>`; cancels startup and restarts, stops workers, and waits for monitored tasks. |

Inherited methods: `on`, `once`, `emit`, `removeAllListeners`. Events are
`ready: { id }`, `restart: { id, attempt }`, `error: unknown`, and `stopped` with
no payload.

A worker exit after readiness triggers a restart, including a clean exit. The
restart budget is not reset by a successful restart. Exhausting it stops the
supervisor group. Initial startup failure also stops the group. Concurrent
`stop()` calls share cleanup.

`nodeWorkerFactory(moduleURL, options?)` from `talos-fluxer/node` supplies the
adapter for Node worker threads. Workers signal readiness with
`parentPort.postMessage({ type: "talos:ready" })`. See
[the worker examples](../../examples/node-parent.mjs).
