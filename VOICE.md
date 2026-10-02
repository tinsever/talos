# Voice support contract

Talos provides gateway signaling, media adapter lifecycle management, and optional
LiveKit audio publishing, receiving, browser playback, E2EE, and automatic rejoining
through `talos-fluxer/voice`. Install `livekit-client` separately; the core SDK has
no runtime media dependencies. The bundled media integration targets the browser
LiveKit SDK. Node/Bun applications can supply a transport backed by their media
library; Talos does not bundle native WebRTC, FFmpeg, or a Node audio decoder.

| Capability            | Support                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Join signaling        | Sends gateway opcode 4 and matches grants by guild/channel, including calls with `guildId: null`. Requires a ready gateway.                                                                                                                                                                 |
| Join cancellation     | A deadline (30 seconds by default) and optional signal cover grant receipt, security setup, media connection, and initial controls. Failed joins release the pending-channel guard and dispose late transports.                                                                             |
| Microphone            | `setMuted` controls the microphone, then updates gateway state. Explicit initial `selfMute` is passed to the adapter; LiveKit applies it before returning.                                                                                                                                  |
| Deafening             | `setDeafened` disables remote audio tracks locally, then updates gateway state. Initial `selfDeaf` is applied to both existing and newly received LiveKit tracks.                                                                                                                           |
| Publishing            | `publishAudio(MediaStreamTrack)` publishes an audio track with Fluxer's microphone source. LiveKit publishes a clone, retaining application ownership of the input. The returned publication's `stop()` is idempotent.                                                                      |
| Browser file playback | `VoicePlayer` decodes a URL, Blob/File, ArrayBuffer, or AudioBuffer with Web Audio, publishes it, and plays items in order. Cancellation and shutdown dispose contexts, generated tracks, and publications.                                                                                 |
| Receiving             | `audioTracks`, `audioTrack`, and `audioTrackRemoved` expose remote audio tracks, participant identities, native MediaStreamTracks, and attach/detach controls. `speakers` reports active LiveKit participant identities.                                                                    |
| Browser output        | Supply `audioOutput` to attach remote audio elements automatically. Call `startAudio()` from a user gesture when browser autoplay policy requires it.                                                                                                                                       |
| E2EE                  | Supply the `encryption` factory to create a fresh room, key provider, and worker per encrypted grant. The adapter sets the grant key, enables encryption, checks `isE2EEEnabled`, and only then connects. Missing support, empty keys, or setup failures reject without plaintext fallback. |
| Media health          | `state` reports `connected`, `reconnecting`, and `disconnected`. LiveKit's transient reconnect keeps the connection active; its terminal disconnect closes the connection.                                                                                                                  |
| Automatic recovery    | `VoiceSession` waits for a ready gateway and requests a fresh grant after a gateway interruption, terminal media disconnect, or replacement grant. Backoff, deadlines, and a total retry budget bound recovery. Mute/deaf preferences carry over.                                           |
| Disconnect            | Removes lifecycle and media listeners, sends a best-effort leave by connection ID, unpublishes managed tracks, disconnects the room, removes automatic output, and releases encryption resources. Concurrent calls share cleanup.                                                           |

## Connections and recovery

`VoiceConnection` owns one transport. A gateway interruption, matching server
leave/move, replacement grant, or terminal media disconnect closes it. Its `active`
serialization field describes lifecycle; use `state` for transport connectivity.
Custom adapters without health events cannot provide a media health guarantee.

`VoiceSession` owns successive connections. Recovery defaults to five total rejoin
attempts over the session's lifetime, delays starting at 1 second and capped at
30 seconds, and a 30-second wait for gateway readiness per attempt. Each rejoin
also has the join deadline. Successful rejoins do not reset the total budget.
`maxAttempts: 0` disables rejoining. Subscribe to `retry`, `connection`, `state`, and
`error` to observe recovery. The `connection` getter changes after each rejoin.

A server leave/move or explicit disconnect ends the session permanently; recovery
does not undo a moderation action or move the connection back. A replacement grant
causes cleanup and a fresh join to the configured channel, rather than reusing the
old transport/token/key. Talos does not refresh expiring tokens proactively or
continue an in-progress player, recording, or application-owned published stream
across a new connection. Use the `connection` event to rebuild these resources.
`VoiceSession` defaults to `selfMute: true`; explicitly enable the microphone when
wanted. Operations while recovering reject until a connection is available.

The initial caller signal/deadline stops applying after a successful join, including
for a session. Use `disconnect()` to stop an established connection or session.
Session disconnect aborts backoff, gateway waits, and pending joins. Cleanup errors
from automatic shutdown or late transports are also reported through the gateway's
`error` event. Adapter cleanup must settle for shutdown to finish.

Only one join may be pending per gateway/channel. Applications own established
connections and must close them. Leave commands are best effort. Before a grant
arrives, Talos has no connection ID to leave. Grants have no client attempt ID,
so delayed grants after cancellation cannot be reliably distinguished from a new
attempt for the same channel. Automatic rejoining inherits this protocol limit.

## LiveKit setup

This example assumes a ready `GatewayClient` and a browser/bundler supported by
`livekit-client` (the integration was typechecked with 2.22.3). The factory must
construct the encrypted room with the same provider and worker it returns. If
allocation fails inside the factory, the factory must dispose its partial resources.

```ts
import { Room, ExternalE2EEKeyProvider } from "livekit-client";
import { VoiceSession, liveKitAdapter } from "talos-fluxer/voice";

const adapter = liveKitAdapter(() => new Room(), {
  audioOutput: document.querySelector<HTMLElement>("#voice-audio")!,
  encryption: () => {
    const keyProvider = new ExternalE2EEKeyProvider();
    const worker = new Worker(
      new URL("livekit-client/e2ee-worker", import.meta.url),
      { type: "module" },
    );
    try {
      return {
        room: new Room({ encryption: { keyProvider, worker } }),
        keyProvider,
        dispose: () => worker.terminate(),
      };
    } catch (error) {
      worker.terminate();
      throw error;
    }
  },
});

const voice = await VoiceSession.join(gateway, adapter, {
  guildId: "guild-id",
  channelId: "channel-id",
  selfMute: true,
  recovery: { maxAttempts: 5 },
});

voice.on("speakers", (identities) => console.log(identities));
voice.on("error", (error) => console.error(error));
// Bind these actions to user gestures to satisfy browser media permission policy.
startButton.addEventListener("click", () => void voice.startAudio());
microphoneButton.addEventListener("click", () => void voice.setMuted(false));
// When finished:
await voice.disconnect();
```

For an unencrypted room, omit `encryption`. Encrypted grants will then be rejected.
The setup follows [LiveKit's encryption guide](https://docs.livekit.io/transport/encryption/start/)
and [Fluxer's shared-key initialization](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppConnectionHostAdapter.ts).
Encryption and codecs are implemented by LiveKit and the runtime. Talos does not
verify other participants' encryption configuration or add encryption to signaling.

## Publishing and queued file playback

```ts
import {
  VoiceConnection,
  VoicePlayer,
  liveKitAdapter,
} from "talos-fluxer/voice";

const voice = await VoiceConnection.join(
  gateway,
  liveKitAdapter(() => new Room()),
  {
    guildId: "guild-id",
    channelId: "channel-id",
    selfMute: true,
  },
);

// Publish any audio MediaStreamTrack, such as a Web Audio mixed stream.
const publication = await voice.publishAudio(audioTrack);
await publication.stop(); // Leaves the caller's audioTrack alive.

const player = new VoicePlayer(voice);
try {
  // Start from a user gesture if the browser requires audio context activation.
  const first = player.play("/sounds/first.wav");
  const second = player.play(fileInput.files![0]!);
  await Promise.all([first, second]); // Each promise covers its own playback.
} finally {
  await player.disconnect();
  await voice.disconnect();
}
```

The player fetches and decodes each complete source into memory. Browser-supported
formats, CORS, and autoplay policy apply. It does not transcode unsupported formats,
stream arbitrarily large files, or expose raw codec packets. A per-item abort signal
cancels that item; `player.disconnect()` cancels active and queued items and waits
for cleanup. A voice connection closing also closes its player. Transient media
reconnection interrupts the active item; callers decide whether to enqueue it again.

## Receiving and recording

Remote participant IDs are LiveKit identities, not necessarily bare Fluxer user
IDs. Read `audioTracks` immediately after joining for already-subscribed tracks;
then listen for additions/removals. Omit `audioOutput` when managing elements or
recording yourself. Local deafening disables the exposed native tracks, including
audio consumed by recordings; it does not unsubscribe network traffic.

```ts
import type { VoiceAudioTrack } from "talos-fluxer/voice";

function record(track: VoiceAudioTrack) {
  const recorder = new MediaRecorder(new MediaStream([track.mediaStreamTrack]));
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  recorder.start();
  return {
    recorder,
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () =>
          resolve(new Blob(chunks, { type: recorder.mimeType }));
        recorder.stop();
      }),
  };
}

const recordings = new Map<string, ReturnType<typeof record>>();
for (const track of voice.audioTracks) recordings.set(track.id, record(track));
voice.on("audioTrack", (track) => recordings.set(track.id, record(track)));
voice.on("audioTrackRemoved", (track) => {
  const recording = recordings.get(track.id);
  if (recording?.recorder.state === "recording") recording.recorder.stop();
  recordings.delete(track.id);
});
```

Recording uses native `MediaRecorder`; Talos does not bundle a recorder, PCM frame
processor, or storage policy. Consumers own their manually attached elements,
recorders, and streams and must dispose them on removal or connection close.

## Custom adapter responsibilities

`connect(grant, { signal, selfMute?, selfDeaf? })` must create a separate transport
for each attempt, configure security and explicit initial media preferences, and
resolve only when ready. Honor cancellation and clean up partial allocations before
rejecting. Talos disconnects transports returned after a cancelled join.

All media methods and health events on `VoiceTransport` are optional, preserving
signaling-only adapters. Unsupported controls/publishing reject explicitly. Implement
`on` to expose track, speaker, error, and health events; an emitted terminal
`disconnected` ends the connection. `audioTracks` supplies the initial snapshot.
Advertise `supportsE2EE: true` only if the adapter configures the grant's encryption
before returning. Keep grants, tokens, keys, and transports out of diagnostics.
`VoiceConnection.toJSON()` and `VoiceSession.toJSON()` exclude them.

## Validation scope

Unit tests cover signaling, publishing, receiving, initial controls, encrypted setup,
cancellation, late media disposal, recovery budgets, and cleanup races. Browser tests
exercise native Web Audio decoding, URL fetching, queued publishing, actual audio
samples, and resource disposal using an injected SFU boundary. Native audio checks
require an audio output backend; CI supplies a PulseAudio null sink. Checks fail
when an AudioContext cannot start. They do not establish
live Fluxer/LiveKit calls or certify cross-client E2EE interoperability, codecs, or
production network recovery. Those require an authenticated deployment and peers.
