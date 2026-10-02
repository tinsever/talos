# Internal classes and inherited methods

These four classes are not exported through the package's public import paths.
This page helps SDK contributors follow the implementation and explains methods
inherited by public classes. Applications should use the public classes and
factories described in the [reference index](index.md).

## TypedEmitter

Defined in [src/events.ts](../../src/events.ts). Constructor:
`new TypedEmitter<E>(onListenerError?)`, where `E` maps event names to payloads.
The optional callback receives a listener failure and its event name.

| Method | Result and behaviour |
| --- | --- |
| `on(event, listener)` | Unsubscribe function; installs a typed listener. |
| `once(event, listener)` | Unsubscribe function; removes the listener before invoking it for the first event. |
| `emit(event, value)` | `void`; invokes a snapshot of listeners in registration order. |
| `removeAllListeners()` | `void`; removes every listener. It does not stop the owning client or transport. |

`Client`, `GatewayClient`, `WorkerSupervisor`, `VoiceConnection`, `VoiceSession`,
and `VoicePlayer` inherit these methods. The internal `LiveKitTransport` does too.
Async listeners are not awaited. Synchronous exceptions and rejected promises
are caught and passed to the configured listener-error callback.

`Client` and `GatewayClient` forward listener failures to their `error` event,
except failures inside an `error` listener. `VoiceConnection` and `VoiceSession`
forward them to the gateway's `error` event. `WorkerSupervisor`, `VoicePlayer`,
and `LiveKitTransport` use the default callback, which discards listener failures;
handle failures within those listeners when they matter to your application.

`emit()` is public through inheritance, but emitting an event yourself does not
perform the corresponding network operation.

## Resource

Abstract base class in [src/resources.ts](../../src/resources.ts).
Constructor: `Resource<T>(data)` for subclasses.

| Member | Result and behaviour |
| --- | --- |
| `data` | Deeply cloned and frozen API snapshot. |
| `toJSON()` | Returns `data`. |

`UserResource`, `Channel`, `Guild`, `GuildMember`, `Role`, and `Webhook` inherit
these members. `Webhook` strips its token before calling the base constructor.
This class adds no network behaviour; actions live on its subclasses.

## Semaphore

FIFO concurrency gate in [src/scheduler.ts](../../src/scheduler.ts).
Constructor: `new Semaphore(capacity)`, where capacity is a positive integer.

| Member | Result and behaviour |
| --- | --- |
| `capacity` | Maximum simultaneous reservations. |
| `stats` | `{ active, queued }` counts. |
| `acquire(signal)` | Promise of an idempotent release function. Cancellation removes queued waiters. |

The owner must call the release function after its work settles, generally in a
`finally` block. REST, upload, and shard startup code use this gate internally.

## LiveKitTransport

Internal implementation of `VoiceTransport` in
[src/voice-livekit.ts](../../src/voice-livekit.ts). Created by `liveKitAdapter()`
after allocating a room. Constructor:
`LiveKitTransport(room, options, dispose)`, where `dispose` releases encryption
resources owned by that attempt.

| Member | Result and behaviour |
| --- | --- |
| `state` | `connected`, `reconnecting`, or `disconnected`. |
| `audioTracks` | Snapshot array of currently tracked remote audio. |
| `collectTracks()` | `void`; discovers audio already present in remote participants. |
| `isDisconnected()` | `boolean`; checks the terminal media state. |
| `setMicrophoneEnabled(enabled)` | `Promise<void>`; calls the room's microphone control. |
| `setDeafened(deafened)` | `Promise<void>`; disables or restores local remote tracks, including later additions. |
| `startAudio()` | `Promise<void>`; delegates playback activation to the room. |
| `publishAudio(track)` | `Promise<VoicePublication>`; publishes a cloned source track and manages its cleanup. |
| `disconnect()` | `Promise<void>`; removes listeners and output elements, stops publications, disconnects the room, and disposes encryption resources. |

It inherits `on`, `once`, `emit`, and `removeAllListeners` and translates room
events into the `VoiceTransportEvents` contract. Applications interact with it
through a `VoiceConnection` or `VoiceSession`.
