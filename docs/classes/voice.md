# Voice classes

Import these classes from `talos-fluxer/voice`. Talos handles signaling and media
lifecycle through a `VoiceAdapter`. `liveKitAdapter()` is a factory function, not
a class; its optional browser media dependency is installed separately.
See [the voice support contract](../../VOICE.md) for LiveKit, encryption, and
runtime requirements.

## VoiceConnection

The constructor is private. Use
`VoiceConnection.join(gateway, adapter, options)` with a ready gateway.
See [the source](../../src/voice.ts).

Join options require `guildId` (a string, or `null` for calls) and `channelId`.
Optional fields are `selfMute`, `selfDeaf`, `signal`, and `timeoutMs`. The default
join deadline is 30 seconds. Only one join may be pending per gateway/channel.
Supply initial media preferences explicitly when you need them applied by the
adapter.

| Member | Result and behaviour |
| --- | --- |
| `guildId`, `channelId`, `connectionId` | Connection's signaling IDs. |
| `state` | `connected`, `reconnecting`, or `disconnected`. |
| `audioTracks` | Current remote `VoiceAudioTrack` objects. |
| `static join(gateway, adapter, options)` | `Promise<VoiceConnection>`; waits for a grant, adapter setup, and initial controls. |
| `setMuted(muted)` | `Promise<void>`; controls the microphone, then updates gateway state. |
| `setDeafened(deafened)` | `Promise<void>`; controls local remote audio, then updates gateway state. |
| `startAudio()` | `Promise<void>`; asks the transport to enable playback, usually from a browser gesture. |
| `publishAudio(track)` | `Promise<VoicePublication>`; publishes a `MediaStreamTrack`. |
| `disconnect()` | `Promise<void>`; sends a best-effort leave and disposes the transport. |
| `toJSON()` | IDs and an `active` lifecycle flag; excludes grants, tokens, and encryption keys. |

Inherited methods: `on`, `once`, `emit`, `removeAllListeners`. Events are `state`,
`audioTrack`, `audioTrackRemoved`, `speakers` (participant identity strings),
`error`, and `closed` (a `VoiceCloseReason`). Listener failures go to the gateway's
`error` event.

A gateway interruption, server move/leave, replacement grant, or terminal media
disconnect closes this object. It does not automatically rejoin. Unsupported
adapter media methods reject explicitly. The join signal stops applying after a
successful join; use `disconnect()` to close an established connection.

Given an adapter implementing `VoiceAdapter`:

```ts
import { VoiceConnection } from "talos-fluxer/voice";

const voice = await VoiceConnection.join(client.gateway, adapter, {
  guildId,
  channelId,
  selfMute: true,
});
console.log(voice.state);
await voice.disconnect();
```

## VoiceSession

The constructor is private. Use
`VoiceSession.join(gateway, adapter, options)` when you need automatic rejoining.
See [the source](../../src/voice-session.ts).

It accepts the connection join options plus `recovery`. `selfMute` defaults to
`true`. Recovery defaults are five total attempts, a one-second initial delay,
a 30-second maximum delay, and a 30-second gateway readiness deadline.
Set `recovery.maxAttempts: 0` to disable rejoining.

| Member | Result and behaviour |
| --- | --- |
| `state` | `connected`, `reconnecting`, or `disconnected`. |
| `connection` | Current `VoiceConnection`, or `undefined`; it changes after rejoining. |
| `audioTracks` | Current session's remote tracks. |
| `static join(gateway, adapter, options)` | `Promise<VoiceSession>`; establishes the first connection. |
| `setMuted(muted)` | `Promise<void>`; controls the current microphone and saves the preference. |
| `setDeafened(deafened)` | `Promise<void>`; controls the current connection and saves the preference. |
| `startAudio()` | `Promise<void>`; delegates playback activation to the current connection. |
| `publishAudio(track)` | `Promise<VoicePublication>`; publishes through the current connection. |
| `disconnect()` | `Promise<void>`; aborts recovery and joins, then cleans up. |
| `toJSON()` | Guild/channel IDs, current connection ID, state, and attempt count; excludes media secrets. |

Inherited methods: `on`, `once`, `emit`, `removeAllListeners`. Events are `state`,
`connection` (`VoiceConnection`), `retry: { attempt, reason }`, `audioTrack`,
`audioTrackRemoved`, `speakers`, and `error`. Listener failures go to the gateway's
`error` event.

Successful rejoins do not reset the total attempt budget. Server moves/leaves and
manual disconnect end the session permanently. Operations while recovering
reject. Publications, players, and application streams must be rebuilt for each
new connection; observe `connection` and also use the initial getter after join.

## VoicePlayer

Construct `new VoicePlayer(connection, options?)` with a `VoiceConnection`, or a
compatible object exposing audio publishing and the `state`/`closed` event
subscriptions. A `VoiceSession` itself does not expose `closed`; use its current
connection and rebuild the player after a rejoin. See
[the source](../../src/voice-player.ts).

Options are `createAudioContext` and `fetch`. The default context comes from the
browser's Web Audio API.

| Member | Result and behaviour |
| --- | --- |
| `state` | `idle`, `playing`, or `closed`. |
| `play(source, { signal? }?)` | `Promise<void>`; queues one source and resolves after playback and disposal. |
| `disconnect()` | `Promise<void>`; cancels active and queued items and waits for cleanup. |

`source` can be a string URL, `URL`, `Blob`/`File`, `ArrayBuffer`, or `AudioBuffer`.
Items play in order. Each source is fetched and decoded in full; browser codecs,
CORS, and autoplay rules apply. This player does not transcode or stream large
sources incrementally.

Inherited methods: `on`, `once`, `emit`, `removeAllListeners`. Events are `state`
and `error`. A connection closing closes its player; transient media
reconnection interrupts the active item. Player cleanup does not disconnect the
voice connection.

## Media interfaces

These are contracts, not constructible classes:

- `VoiceAdapter`: connects a grant to a fresh `VoiceTransport`; can advertise E2EE support.
- `VoiceTransport`: owns media controls, publications, tracks, and cleanup.
- `VoiceAudioTrack`: exposes `id`, `participantId`, `mediaStreamTrack`, `attach()`, and `detach()`.
- `VoicePublication`: exposes `id` and idempotent `stop()`. The caller's source track remains caller-owned.
- `LiveKitRoom`, `LiveKitAdapterOptions`, and `LiveKitEncryption`: configure the optional LiveKit boundary.

The [custom-adapter contract](../../VOICE.md#custom-adapter-responsibilities)
describes cancellation, cleanup, and encryption responsibilities.
