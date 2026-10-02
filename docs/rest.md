# REST requests

Use `RESTClient` for scripts that do not need gateway events. It does not require
`Client.connect()` or a WebSocket:

```ts
import { discover, RESTClient } from "talos-fluxer";

const instance = await discover("https://fluxer.app");
const rest = new RESTClient({
  api: instance.endpoints.api_public,
  token,
});

const user = await rest.request("GET", "/users/@me");
console.log(user.username);
```

In an already connected bot, use `client.rest` instead. For another instance,
discover its origin and use the advertised `api_public` endpoint. Talos preserves
the endpoint's path prefix and handles `/v1`.

## Paths, query fields, and bodies

Pass the route template, with parameters in a separate object:

```ts
const messages = await client.rest.request(
  "GET",
  "/channels/{channel_id}/messages",
  {
    params: { channel_id: channelId },
    query: { limit: "50" },
  },
);
console.log(messages.length);
```

Talos encodes parameter values. Do not interpolate IDs into the route or prepend
`/v1`. The method and template must exist in the bundled schema; an unknown route
throws before making a request. TypeScript infers required parameters, request
bodies, and response types from that schema.

JSON bodies are serialized automatically. A `FormData` body is sent as multipart,
with the boundary chosen by the runtime. `reason` sets the encoded audit-log
reason header on operations that support it.

## Authentication

The default scheme is `Bot`. `RESTClient` also accepts `Bearer`, `Session`, and
`Admin` through `authScheme`; `Session` sends the raw token without a prefix.
Choose the scheme that matches your credential.

Whether a route needs authentication comes from the generated metadata and local
overrides. `auth: false` omits the token; `auth: true` requires one. A custom
`Authorization` header is removed, so configure authentication through the client.
Authenticated requests do not follow redirects.

## Deadlines and queue capacity

| Option | Default | What it controls |
| --- | --- | --- |
| `timeoutMs` | `60_000` | One request, including queues, rate-limit waits, and retries. |
| `maxRetries` | `5` | Retries after the initial attempt. |
| `maxConcurrentRequests` | `10` | Concurrent work, including rate-limit reservation waits. |
| `maxPendingRequests` | `1_000` | All accepted requests, including queued and active work. |
| `maxBuckets` | `1_000` | Capacity of the default in-memory rate-limit store. |

Per-request `timeoutMs` overrides the client default. `signal` can cancel a request
while it is queued or running. Timeouts and cancellations also bound retry waits.

Writes with the same method and concrete path run in order. With the default
in-memory store, `GET`, `HEAD`, and `OPTIONS` requests can overlap after the first
response establishes rate-limit state. Unknown and expired buckets are probed
before admitting another read burst; every read still reserves quota. Custom
stores retain sequential reads unless they implement `canPipeline(key)` and
atomic reservations. Different paths can run concurrently up to the configured
limit. When pending capacity is full, a new
request rejects with `RequestQueueFullError` rather than waiting in another queue.
`rest.stats` reports `pending`, `active`, and `waiting` counts.

Concurrent reads can complete out of order. If a response supplies no rate-limit
headers, the in-memory store permits bounded concurrency and learns limits from
HTTP 429 responses. Missing headers do not prove that the server has no limit.

## Retries

Talos retries network failures and HTTP 5xx responses for `GET`, `HEAD`, `OPTIONS`,
`PUT`, and `DELETE`, using exponential backoff with jitter. It does not retry those
failures for `POST` or `PATCH`.

HTTP 429 is handled for all methods: Talos records the route or global rate limit
before releasing the concurrency slot, then retries within `maxRetries` and the
request deadline. Requests already in flight may still complete. The delay comes from
`retry_after` or `Retry-After`, interpreted as seconds.

A failed message send can still have reached the server. Retrying a `POST` after a
network error can create a duplicate. Decide how your application will detect
duplicates before adding its own retry loop.

The default rate-limit store is local to one REST client. If multiple clients use
the same credential, pass a shared `MemoryRateLimitStore` through `rateLimitStore`.
Multiple processes need coordinated storage; the Node worker example uses
`IPCRateLimitStore` and `serveRateLimits()` from `talos-fluxer/node`.

## Handle errors

```ts
import { FluxerAPIError, RequestQueueFullError } from "talos-fluxer";

try {
  await client.messages.send(channelId, "Hello.");
} catch (error) {
  if (error instanceof FluxerAPIError) {
    console.error("API request failed", error.status, error.code, error.route);
  } else if (error instanceof RequestQueueFullError) {
    console.error("Too many pending requests", error.limit);
  } else {
    throw error;
  }
}
```

`FluxerAPIError` exposes `status`, `method`, the route template, `code` when the
response supplies one, and `body`. Network failures and abort reasons are thrown
directly. A 401 usually calls for checking the token and scheme; a 403 calls for
checking access and permissions. Repeating either unchanged will not fix it.

## Observe requests

Set `rest.onDiagnostic` in `Client` options, or `onDiagnostic` directly on a
`RESTClient`. It receives `response`, `retry`, and `rateLimit` records with fields
such as method, route template, status, attempt, and delay. Attempts start at zero.
The records omit tokens and query values. Callback exceptions do not interrupt
the request.

For REST-only resource helpers, construct `new Resources(() => rest)`. Its
`messages`, `channels`, `guilds`, and other helpers work without a gateway;
resource caches will receive API results, but no automatic gateway updates.
