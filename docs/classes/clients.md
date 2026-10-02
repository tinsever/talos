# Client, RESTClient, and GatewayClient

## Client

Import from `talos-fluxer`. `new Client(options)` combines REST, resources, and
gateway events. Pass a raw `token`; optionally set `origin`, `endpoints`, `rest`,
`gateway`, and `cache`. See [ClientOptions](../../src/client.ts).

| Property | Value |
| --- | --- |
| `user` | Connected user snapshot, or `undefined` before readiness and after closure. |
| `instance` | Discovered instance or supplied endpoints after initialization. |
| `rest` | `RESTClient`. |
| `gateway` | `GatewayClient`. |
| `messages` | `Messages`. |
| `uploads` | `Uploads`. |
| `resources` | `Resources`. |
| `users`, `channels`, `guilds`, `invites`, `webhooks` | Shortcuts to the matching resource managers. |
| `cache` | Message `LRUCache`, keyed by `channelId:messageId`. |

Manager getters throw before initialization. Wait for `connect()` before using
them. Client caches are disabled until you configure a capacity.

| Method | Result and behaviour |
| --- | --- |
| `connect({ signal?, timeoutMs? }?)` | `Promise<void>`; discovers endpoints and waits for gateway readiness. Default deadline: 60 seconds. |
| `disconnect()` | `void`; stops the gateway, clears the current user and caches. |
| `updateToken(token)` | `void`; updates REST and future gateway authentication. |
| `onDispatch(event, listener)` | Unsubscribe function; delivers typed data for a gateway dispatch name. |
| `waitFor(event, predicate, { timeoutMs, signal? })` | Promise of the first matching event; rejects on timeout or cancellation. |
| `collect(event, options)` | Bounded async event iterator; requires `timeoutMs`, accepts `filter`, `max`, `signal`, and `maxBuffered`. |

Inherited event methods: `on`, `once`, `emit`, `removeAllListeners`. Events include
the gateway events below and `messageCreate`, `messageUpdate`, and `messageDelete`.
Updates are partial; creation events contain a wrapped `Message`.

Calling `connect()` while already running rejects. The startup signal stops
applying once connected. Rotating a token does not reconnect the socket.
See the [bot guide](../guide.md) and [event guide](../gateway.md).

## RESTClient

Import from `talos-fluxer` or `talos-fluxer/rest`.
`new RESTClient(options)` requires `api`, the public API endpoint. A `token` is
required only for authenticated requests. It works without a gateway connection.

Options include `origin`, `authScheme`, `fetch`, `locale`, `timeoutMs`,
`maxRetries`, `maxBuckets`, `rateLimitStore`, `maxConcurrentRequests`,
`maxPendingRequests`, and `onDiagnostic`. See [RESTOptions](../../src/rest.ts)
and the [defaults and retry policy](../rest.md).

| Member | Result and behaviour |
| --- | --- |
| `stats` | `{ pending, active, waiting }` request counts. |
| `request(method, route, options?)` | Promise of the schema-defined response; use a route template and separate `params`, `query`, and `body`. Some routes require options. |
| `updateToken(token)` | `void`; changes the credential for subsequent requests. |

`request` options also accept `headers`, `auth`, `signal`, `timeoutMs`, and
`reason`. Authentication defaults to the `Bot` scheme. The endpoint's path prefix
is preserved, and Talos handles `/v1`.

Requests count against pending capacity while queued, rate-limited, or active.
Exceeding capacity rejects with `RequestQueueFullError`. Non-success API responses
become `FluxerAPIError`; abort reasons and network errors pass through directly.

## GatewayClient

Import from `talos-fluxer` or `talos-fluxer/gateway`.
`new GatewayClient(options)` requires a gateway `url` and raw `token`. Inject
`webSocket` when your runtime has no global WebSocket. Unlike `Client`, this class
does not discover endpoints or create resource managers.

Other options include `properties`, `ignoredEvents`, `shard`, `maxReconnects`,
`handshakeTimeoutMs`, `reconnectBaseMs`, `reconnectMaxMs`, `beforeIdentify`,
`processDispatch`, and `maxPendingDispatches`. See
[GatewayOptions](../../src/gateway.ts).

| Member | Result and behaviour |
| --- | --- |
| `state` | `idle`, `connecting`, `identifying`, `resuming`, `ready`, `reconnecting`, or `closed`. |
| `connect({ signal?, timeoutMs? }?)` | `Promise<ReadyData>`; opens a connection and waits for initial readiness. |
| `disconnect(error?)` | `void`; ends the connection and rejects pending startup with the supplied reason. |
| `onDispatch(event, listener)` | Unsubscribe function; delivers the named dispatch's typed data. |
| `updateToken(token)` | `void`; changes the token used by future authentication. |
| `setPresence({ status, afk?, custom_status? })` | `void`; sends presence, limited locally to five changes per 20 seconds. |
| `send(op, data)` | `void`; sends an advanced command with opcode `3`, `4`, `8`, `14`, `15`, or `16`. Requires `ready`. |

`status` accepts `online`, `idle`, `dnd`, and `invisible`. Prefer `setPresence()`
over sending opcode 3 directly so the local presence limit applies.

Inherited event methods: `on`, `once`, `emit`, `removeAllListeners`.

| Event | Payload |
| --- | --- |
| `ready` | `ReadyData` for a new session. |
| `resumed` | No payload; the previous session resumed. |
| `dispatch` | `{ op, t, s, d }`, with `d: unknown`. |
| `state` | The new gateway state. |
| `error` | An error or other failure value. |
| `heartbeat` | `{ latencyMs }`. |
| `reconnect` | `{ attempt, delayMs }`. |
| `close` | `{ code, reason }`. |
| `unknownOpcode` | Numeric opcode. |

Reconnections attempt Resume where possible. A fresh Identify can emit `ready`
again. Async listeners are not awaited; use `processDispatch` to save work before
advancing the sequence. See [gateway recovery](../gateway.md#reconnection).
