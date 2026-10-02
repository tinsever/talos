# Gateway and events

`Client` combines discovery, REST, resource helpers, and the gateway. Use
`GatewayClient` directly when you only need the WebSocket connection; it takes
`url` and a raw `token` and emits the lower-level gateway events.

## Subscribe to events

`on()` returns an unsubscribe function:

```ts
const off = client.on("messageCreate", (message) => {
  console.log(message.channelId, message.content);
});

// Call this when the component or task no longer needs the listener.
off();
```

Use `messageCreate` for a wrapped `Message`. `messageUpdate` is a partial payload
with `id` and `channel_id`; `messageDelete` contains IDs. Fetch a message if an
update handler needs fields that were not included in the update.

For other gateway events, `onDispatch()` gives typed data for a named dispatch:

```ts
client.onDispatch("GUILD_ROLE_DELETE", ({ guild_id, role_id }) => {
  console.log(`Role ${role_id} was removed from guild ${guild_id}`);
});
```

The `dispatch` event exposes the frame itself: `{ op, t, s, d }`. Its data is
`unknown`; narrow it before using it. Known names and payload types live in
[gateway-types.ts](../src/gateway-types.ts).

Listeners run in registration order, but their returned promises are not awaited.
Async handlers can overlap, and a slow handler does not hold back the next
dispatch. Thrown errors and rejected promises are forwarded to `error`. Register
an error listener so you can see them.

## Wait for a response

Register the wait before sending the prompt so a fast answer is not missed:

```ts
const controller = new AbortController();
const answer = client.waitFor(
  "messageCreate",
  (message) =>
    message.channelId === channelId && message.author.id === userId,
  { timeoutMs: 30_000, signal: controller.signal },
);

try {
  const [message] = await Promise.all([
    answer,
    client.messages.send(channelId, "What should I call you?", {
      signal: controller.signal,
    }),
  ]);
  console.log(message.content);
} finally {
  controller.abort();
}
```

`waitFor()` rejects on timeout or cancellation and removes its listener. A
predicate that throws also rejects the wait.

To collect several events, use the bounded iterator:

```ts
for await (const message of client.collect("messageCreate", {
  filter: (message) => message.channelId === channelId && !message.author.bot,
  max: 3,
  timeoutMs: 30_000,
  maxBuffered: 20,
})) {
  console.log(message.content);
}
```

A collector timeout ends iteration normally. Cancellation, a throwing filter,
and buffer overflow reject. Breaking the loop removes the listener. The default
buffer holds 100 events; this is a bound on unread events, not gateway traffic.

## Reconnection

The gateway manages heartbeats and reconnects after recoverable interruptions.
It attempts Resume when it has a usable session and sequence, and falls back to
Identify when the session cannot be resumed. A new session emits `ready`; a
successful Resume emits `resumed`.

| Gateway option | Default |
| --- | --- |
| `handshakeTimeoutMs` | `30_000` |
| `maxReconnects` | `20` |
| `reconnectBaseMs` | `1_000` |
| `reconnectMaxMs` | `30_000` |

Reconnect delays grow exponentially and use jitter. The attempt counter resets
when the gateway becomes ready. Fatal protocol/authentication close codes and an
exhausted reconnect budget end the connection.

Observe `state` for lifecycle changes, `reconnect` for `{ attempt, delayMs }`,
`heartbeat` for `{ latencyMs }`, and `close` for the server's code and reason.
If `state` becomes `closed`, the client clears its current user and caches.

The signal passed to `connect()` only applies during startup. Use `disconnect()`
to stop an established client. Rotating credentials with `client.updateToken()`
updates REST and future gateway authentication; it does not reconnect an existing
socket by itself.

## Persist work before advancing the sequence

Use `gateway.processDispatch` when Resume should reflect work saved to durable
storage. Talos awaits this hook in dispatch order, then advances the sequence and
emits the ordinary dispatch event. Ordinary listeners do not provide that ordering.

```ts
import { Client } from "talos-fluxer";

interface Inbox {
  put(key: string, frame: unknown, signal: AbortSignal): Promise<void>;
}

export function createDurableBot(token: string, inbox: Inbox): Client {
  return new Client({
    token,
    gateway: {
      maxPendingDispatches: 500,
      processDispatch: async (frame, { signal }) => {
        if (frame.t !== "MESSAGE_CREATE") return;
        const data = frame.d as { id?: unknown; channel_id?: unknown };
        if (typeof data.id !== "string" || typeof data.channel_id !== "string") {
          throw new Error("Invalid message dispatch");
        }
        await inbox.put(`message:${data.channel_id}:${data.id}`, frame, signal);
      },
    },
  });
}
```

Implement `put()` as an idempotent write keyed by the message ID, then process
saved work separately. If the hook rejects, Talos reports the error and restarts
the connection. If Resume succeeds, unfinished dispatches can be replayed.
Duplicates are possible; this is not an exactly-once delivery guarantee, and a
session that cannot resume can leave gaps.

`maxPendingDispatches` defaults to 1,000. Filling the queue causes a gateway
failure. Honor the hook's signal so interrupted connections do not leave work
running indefinitely. `ready` and `resumed` are lifecycle events and can fire
before their dispatch has completed this hook.

## Shards and workers

`ShardManager` from `talos-fluxer/shards` reads `/gateway/bot`, creates clients,
and coordinates startup. Its clients share a REST rate-limit store and an
Identify limiter. `count` can override the recommended shard count.

For worker threads, see [the parent](../examples/node-parent.mjs) and
[the worker](../examples/node-worker.mjs). They use `WorkerSupervisor` and share
REST rate limits over IPC. Deployments with multiple managers or processes also
need to coordinate Identify through `identifyLimiter` or `gateway.beforeIdentify`.
