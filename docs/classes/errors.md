# Error classes

These extend JavaScript `Error` and expose `name`, `message`, and the usual
runtime stack. You normally catch them rather than construct them. Network
failures, abort reasons, local validation errors, and some media failures use
other error types; do not assume every failure is one of these classes.

## FluxerAPIError

Import from `talos-fluxer` or `talos-fluxer/rest`.
Constructor: `new FluxerAPIError(status, method, route, body)`.

| Property | Meaning |
| --- | --- |
| `status` | HTTP response status. |
| `method` | Request method. |
| `route` | Route template, rather than the concrete URL. |
| `body` | Parsed API error body, or response text. |
| `code` | String error code if provided by the response; otherwise `undefined`. |

Raised for non-success API responses once retry policy is exhausted or does not
apply. Its message uses the API's string `message` when available.
See [handling REST errors](../rest.md#handle-errors) and
[the source](../../src/errors.ts).

## GatewayError

Import from `talos-fluxer` or `talos-fluxer/gateway`.
Constructor: `new GatewayError(message, code?)`.

`code` is an optional numeric gateway close code. Used for protocol validation,
invalid gateway state, reconnect-budget exhaustion, and other gateway failures.
See [the source](../../src/errors.ts).

## RequestQueueFullError

Import from `talos-fluxer` or `talos-fluxer/rest`.
Constructor: `new RequestQueueFullError(limit)`.

`limit` is the REST client's configured pending-request capacity. This error means
a new request was rejected locally before being queued. Slow down producers or
bound application work; see [REST queue capacity](../rest.md#deadlines-and-queue-capacity).
Source: [errors.ts](../../src/errors.ts).

## UploadError

Import from `talos-fluxer` or `talos-fluxer/uploads`.
Constructor: `new UploadError(message, status?)`.

`status` is an optional HTTP status. Raised for invalid upload plans or endpoints
and unsuccessful upload transfers. REST planning failures can instead be
`FluxerAPIError`; cancellation can throw an abort reason. Source:
[uploads.ts](../../src/uploads.ts).

## VoiceLifecycleError

Import from `talos-fluxer/voice`.
Constructor: `new VoiceLifecycleError(message, reason)`.

`reason` is a `VoiceCloseReason`: `manual`, `gateway`, `voice-state`, `grant`, or
`media`. The class represents a terminal signaling interruption during a pending
join, such as a gateway interruption, server move, or replaced grant. Ordinary
media setup errors and join timeouts can have other types. Source:
[voice.ts](../../src/voice.ts).
