# Rate-limit stores

REST clients call the `RateLimitStore` methods to reserve work, observe response
headers, and record HTTP 429 penalties. Applications normally pass a store through
`rest.rateLimitStore` rather than calling these methods themselves.

Keep each store scoped to one API endpoint and credential. Keys do not include
that scope automatically. See [REST behaviour](../rest.md#retries).

## MemoryRateLimitStore

Import from `talos-fluxer` or `talos-fluxer/rate-limits`.
`new MemoryRateLimitStore(maxBuckets?)` defaults to 1,000 bucket and alias entries.
The capacity must be a positive integer. See [the source](../../src/rate-limits.ts).

| Method | Result and behaviour |
| --- | --- |
| `reserve(key, signal)` | `Promise<void>`; waits for route and global limits, then reserves an available slot when the bucket is known. |
| `observe(key, headers)` | `void`; records bucket IDs, remaining quota, and reset times from response headers. |
| `penalize(key, retryMs, global)` | `void`; blocks the route or the entire store for the supplied delay in milliseconds. |
| `canPipeline(key)` | `boolean`; indicates whether known route state permits concurrent reads. Each request must still call `reserve()`. |

Share one instance across REST clients using the same API and credential:

```ts
import { MemoryRateLimitStore, RESTClient } from "talos-fluxer";

const store = new MemoryRateLimitStore();
const first = new RESTClient({ api, token, rateLimitStore: store });
const second = new RESTClient({ api, token, rateLimitStore: store });
```

This coordinates one process. A custom distributed implementation must make
`reserve()` atomic and namespace its state by API and credential.
The optional `canPipeline(key)` hint enables concurrent reads within the REST
client's concurrency bound. Omit it to retain sequential requests on each route.
The in-memory store wakes queued reservations when fresh quota arrives and
admits one probe after a window expires, avoiding simultaneous unreserved bursts.

## IPCRateLimitStore

Import from `talos-fluxer/node`. Construct
`new IPCRateLimitStore(port, maxPending?)` on the worker side of a Node
`MessageChannel`. Pending RPC capacity defaults to 1,000. See
[the source](../../src/node.ts).

| Method | Result and behaviour |
| --- | --- |
| `reserve(key, signal)` | `Promise<void>`; requests a reservation from the parent and forwards cancellation. |
| `observe(key, headers)` | `Promise<void>`; forwards rate-limit headers to the parent. |
| `penalize(key, retryMs, global)` | `Promise<void>`; forwards a route or global penalty. |
| `close()` | `void`; detaches listeners and rejects pending coordination requests. |

The parent must call `serveRateLimits(otherPort, store, maxPending?)`. That
function returns a cleanup callback. `close()` disposes the store's listeners;
it does not close the underlying port.

Pending RPC overflow and a closed coordinator reject with ordinary `Error`
objects. Use [the parent](../../examples/node-parent.mjs) and
[worker](../../examples/node-worker.mjs) examples for port transfer and supervision.
