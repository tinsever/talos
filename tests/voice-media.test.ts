import { afterEach, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/gateway.js";
import { TypedEmitter } from "../src/events.js";
import {
  VoiceConnection,
  VoicePlayer,
  VoiceSession,
  liveKitAdapter,
  type LiveKitRoom,
  type VoiceAdapter,
  type VoiceTransportEvents,
} from "../src/voice.js";
import { FakeSocket } from "./helpers.js";

const grant = {
  guild_id: "10",
  channel_id: "20",
  connection_id: "connection",
  token: "secret-token",
  endpoint: "wss://voice.example",
};
const joinOptions = { guildId: "10", channelId: "20" };
const gateways: GatewayClient[] = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.disconnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function audioTrack() {
  const track = {
    kind: "audio",
    enabled: true,
    stop: vi.fn(),
    clone: vi.fn<() => MediaStreamTrack>(),
  };
  track.clone.mockImplementation(() => audioTrack());
  return track as unknown as MediaStreamTrack & typeof track;
}
function room() {
  const events = new Map<string, Set<(...args: any[]) => void>>();
  const media = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    startAudio: vi.fn().mockResolvedValue(undefined),
    localParticipant: {
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      publishTrack: vi.fn().mockResolvedValue({ trackSid: "published" }),
      unpublishTrack: vi.fn().mockResolvedValue(undefined),
    },
    remoteParticipants: new Map(),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const set = events.get(event) ?? new Set();
      set.add(listener);
      events.set(event, set);
    }),
    off: vi.fn((event: string, listener: (...args: any[]) => void) => {
      events.get(event)?.delete(listener);
    }),
    emit(event: string, ...args: any[]) {
      for (const listener of [...(events.get(event) ?? [])]) listener(...args);
    },
    listenerCount() {
      return [...events.values()].reduce((count, set) => count + set.size, 0);
    },
  } satisfies LiveKitRoom & {
    emit(event: string, ...args: any[]): void;
    listenerCount(): number;
  };
  return media;
}
async function ready() {
  const socket = new FakeSocket();
  const gateway = new GatewayClient({
    url: "wss://example",
    token: "synthetic",
    webSocket: () => socket,
  });
  gateways.push(gateway);
  const connecting = gateway.connect();
  socket.hello();
  socket.ready();
  await connecting;
  const receive = (data = grant) =>
    socket.receive(0, data, "VOICE_SERVER_UPDATE", 2);
  return { socket, gateway, receive };
}
async function connect(media = room()) {
  const { gateway, receive, socket } = await ready();
  const pending = VoiceConnection.join(
    gateway,
    liveKitAdapter(() => media),
    joinOptions,
  );
  receive();
  return { voice: await pending, media, gateway, receive, socket };
}
const signal = () => new AbortController().signal;

it("publishes a clone with the Fluxer microphone source and stops it without owning the input", async () => {
  const { voice, media } = await connect();
  const track = audioTrack();
  const clone = audioTrack();
  track.clone.mockReturnValue(clone);
  const publication = await voice.publishAudio(track);
  expect(media.localParticipant.publishTrack).toHaveBeenCalledWith(clone, {
    source: "microphone",
  });
  await Promise.all([publication.stop(), publication.stop()]);
  expect(media.localParticipant.unpublishTrack).toHaveBeenCalledOnce();
  expect(media.localParticipant.unpublishTrack).toHaveBeenCalledWith(
    clone,
    false,
  );
  expect(clone.stop).toHaveBeenCalledOnce();
  expect(track.stop).not.toHaveBeenCalled();
  await voice.disconnect();
});

it("stops a clone after publication failure", async () => {
  const { voice, media } = await connect();
  const track = audioTrack(),
    clone = audioTrack();
  track.clone.mockReturnValue(clone);
  media.localParticipant.publishTrack.mockRejectedValue(
    new Error("publish failed"),
  );
  await expect(voice.publishAudio(track)).rejects.toThrow("publish failed");
  expect(clone.stop).toHaveBeenCalledOnce();
  await voice.disconnect();
});

it("unpublishes late audio after disconnect and disposes every resource even when unpublishing fails", async () => {
  const { voice, media } = await connect();
  const published = deferred<{ trackSid: string }>();
  media.localParticipant.publishTrack.mockReturnValue(published.promise);
  const track = audioTrack(),
    clone = audioTrack();
  track.clone.mockReturnValue(clone);
  const publication = voice.publishAudio(track);
  const failed = expect(publication).rejects.toThrow("disconnected");
  await voice.disconnect();
  published.resolve({ trackSid: "late" });
  await failed;
  expect(clone.stop).toHaveBeenCalledOnce();
  expect(track.stop).not.toHaveBeenCalled();
  expect(media.listenerCount()).toBe(0);
});

it("receives tracks and speakers, controls local deafening, and updates the gateway", async () => {
  const { voice, media, socket } = await connect();
  const received = vi.fn(),
    removed = vi.fn(),
    speakers = vi.fn();
  voice.on("audioTrack", received);
  voice.on("audioTrackRemoved", removed);
  voice.on("speakers", speakers);
  const native = audioTrack();
  const element = { remove: vi.fn() } as unknown as HTMLMediaElement;
  const remote = {
    kind: "audio",
    mediaStreamTrack: native,
    attach: vi.fn(() => element),
    detach: vi.fn(() => [element]),
  };
  media.emit(
    "trackSubscribed",
    remote,
    { trackSid: "remote" },
    { identity: "speaker" },
  );
  expect(voice.audioTracks[0]).toMatchObject({
    id: "remote",
    participantId: "speaker",
    mediaStreamTrack: native,
  });
  expect(received).toHaveBeenCalledOnce();
  voice.audioTracks[0]!.attach();
  expect(remote.attach).toHaveBeenCalledOnce();
  media.emit("activeSpeakersChanged", [{ identity: "speaker" }]);
  expect(speakers).toHaveBeenCalledWith(["speaker"]);
  await voice.setDeafened(true);
  expect(native.enabled).toBe(false);
  expect(socket.frames.at(-1)?.d).toMatchObject({
    self_deaf: true,
    connection_id: "connection",
  });
  await voice.setDeafened(false);
  expect(native.enabled).toBe(true);
  await voice.startAudio();
  expect(media.startAudio).toHaveBeenCalledOnce();
  media.emit("trackUnsubscribed", remote);
  expect(voice.audioTracks).toEqual([]);
  expect(removed).toHaveBeenCalledOnce();
  await voice.disconnect();
});

it("auto-attaches audio, collects tracks subscribed during connect, and removes its output on shutdown", async () => {
  const media = room(),
    native = audioTrack();
  const element = { remove: vi.fn() } as unknown as HTMLMediaElement;
  const track = {
    kind: "audio",
    mediaStreamTrack: native,
    attach: vi.fn(() => element),
    detach: vi.fn(() => [element]),
  };
  media.remoteParticipants.set("speaker", {
    identity: "speaker",
    audioTrackPublications: new Map([["remote", { track }]]),
  });
  const output = { appendChild: vi.fn() } as unknown as HTMLElement;
  const transport = await liveKitAdapter(() => media, {
    audioOutput: output,
  }).connect(grant, { signal: signal(), selfDeaf: true, selfMute: true });
  expect(native.enabled).toBe(false);
  expect(output.appendChild).toHaveBeenCalledWith(element);
  expect(media.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
    false,
  );
  expect(transport.audioTracks).toHaveLength(1);
  await transport.disconnect();
  expect(track.detach).toHaveBeenCalledWith(element);
  expect(element.remove).toHaveBeenCalledOnce();
  expect(native.enabled).toBe(true);
  expect(media.listenerCount()).toBe(0);
});

it("restores a previously disabled remote track and suppresses tracks arriving while deafened", async () => {
  const { voice, media } = await connect();
  await voice.setDeafened(true);
  const track = {
    kind: "audio",
    mediaStreamTrack: audioTrack(),
    attach: vi.fn(),
    detach: vi.fn(),
  };
  track.mediaStreamTrack.enabled = false;
  media.emit(
    "trackSubscribed",
    track,
    { trackSid: "remote" },
    { identity: "speaker" },
  );
  await voice.setDeafened(false);
  expect(track.mediaStreamTrack.enabled).toBe(false);
  await voice.disconnect();
});

it("reports reconnecting health without ending media, then ends on a terminal media disconnect", async () => {
  const { voice, media } = await connect();
  const closed = vi.fn();
  voice.on("closed", closed);
  media.emit("reconnecting");
  expect(voice.state).toBe("reconnecting");
  expect(voice.toJSON().active).toBe(true);
  media.emit("reconnected");
  expect(voice.state).toBe("connected");
  media.emit("disconnected");
  expect(voice.toJSON().active).toBe(false);
  expect(closed).toHaveBeenCalledWith("media");
  await voice.disconnect();
  expect(media.disconnect).toHaveBeenCalledOnce();
});

it("initializes encryption before connect and releases its worker once on shutdown", async () => {
  const media = room(),
    order: string[] = [];
  const encrypted = Object.assign(media, {
    isE2EEEnabled: false,
    setE2EEEnabled: vi.fn(async () => {
      order.push("enable");
      encrypted.isE2EEEnabled = true;
    }),
  });
  media.connect.mockImplementation(async () => {
    order.push("connect");
  });
  const keyProvider = {
      setKey: vi.fn(async () => {
        order.push("key");
      }),
    },
    dispose = vi.fn();
  const createRoom = vi.fn(room);
  const adapter = liveKitAdapter(createRoom, {
    encryption: () => ({ room: encrypted, keyProvider, dispose }),
  });
  expect(adapter.supportsE2EE).toBe(true);
  const transport = await adapter.connect(
    { ...grant, e2ee_key: "private-key" },
    { signal: signal() },
  );
  expect(order).toEqual(["key", "enable", "connect"]);
  expect(keyProvider.setKey).toHaveBeenCalledWith("private-key");
  expect(createRoom).not.toHaveBeenCalled();
  await Promise.all([transport.disconnect(), transport.disconnect()]);
  expect(dispose).toHaveBeenCalledOnce();
});

it.each(["key failure", "enable failure", "not enabled"])(
  "rejects encrypted media with %s and cleans up without connecting plaintext",
  async (failure) => {
    const media = Object.assign(room(), {
      isE2EEEnabled: failure !== "not enabled",
      setE2EEEnabled: vi.fn().mockResolvedValue(undefined),
    });
    const keyProvider = { setKey: vi.fn().mockResolvedValue(undefined) },
      dispose = vi.fn();
    if (failure === "key failure")
      keyProvider.setKey.mockRejectedValue(new Error("key failure"));
    if (failure === "enable failure")
      media.setE2EEEnabled.mockRejectedValue(new Error("enable failure"));
    await expect(
      liveKitAdapter(room, {
        encryption: () => ({ room: media, keyProvider, dispose }),
      }).connect({ ...grant, e2ee_key: "key" }, { signal: signal() }),
    ).rejects.toThrow();
    expect(media.connect).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(media.disconnect).toHaveBeenCalledOnce();
  },
);

it("rejects empty encryption keys before allocating and connects plaintext only for grants without a key", async () => {
  const encryption = vi.fn();
  const createRoom = vi.fn(room);
  const adapter = liveKitAdapter(createRoom, { encryption });
  await expect(
    adapter.connect({ ...grant, e2ee_key: "" }, { signal: signal() }),
  ).rejects.toThrow("empty");
  expect(encryption).not.toHaveBeenCalled();
  expect(createRoom).not.toHaveBeenCalled();
  await (await adapter.connect(grant, { signal: signal() })).disconnect();
  expect(encryption).not.toHaveBeenCalled();
  expect(createRoom).toHaveBeenCalledOnce();
});

it("cancels encryption setup and releases resources even if the provider settles late", async () => {
  const key = deferred<void>(),
    control = new AbortController();
  const media = Object.assign(room(), {
    isE2EEEnabled: false,
    setE2EEEnabled: vi.fn(),
  });
  const dispose = vi.fn();
  const pending = liveKitAdapter(room, {
    encryption: () => ({
      room: media,
      keyProvider: { setKey: () => key.promise },
      dispose,
    }),
  }).connect({ ...grant, e2ee_key: "key" }, { signal: control.signal });
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  control.abort();
  await Promise.resolve();
  key.resolve();
  await failed;
  expect(media.setE2EEEnabled).not.toHaveBeenCalled();
  expect(media.connect).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
});

it("still releases encryption resources if unpublishing and room disconnect both reject", async () => {
  const media = Object.assign(room(), {
    isE2EEEnabled: true,
    setE2EEEnabled: vi.fn().mockResolvedValue(undefined),
  });
  const dispose = vi.fn();
  const transport = await liveKitAdapter(room, {
    encryption: () => ({
      room: media,
      keyProvider: { setKey: async () => {} },
      dispose,
    }),
  }).connect({ ...grant, e2ee_key: "key" }, { signal: signal() });
  const track = audioTrack(),
    clone = audioTrack();
  track.clone.mockReturnValue(clone);
  await transport.publishAudio!(track);
  media.localParticipant.unpublishTrack.mockRejectedValue(
    new Error("unpublish failed"),
  );
  media.disconnect.mockRejectedValue(new Error("disconnect failed"));
  await expect(transport.disconnect()).rejects.toThrow("cleanup failed");
  expect(dispose).toHaveBeenCalledOnce();
  expect(clone.stop).toHaveBeenCalledOnce();
});

async function sessionFixture(
  recovery = {
    baseDelayMs: 10,
    maxDelayMs: 20,
    maxAttempts: 3,
    gatewayTimeoutMs: 30,
  },
) {
  const { gateway, socket, receive } = await ready();
  const transports: (TypedEmitter<VoiceTransportEvents> & {
    disconnect: ReturnType<typeof vi.fn>;
    setMicrophoneEnabled: ReturnType<typeof vi.fn>;
    setDeafened: ReturnType<typeof vi.fn>;
  })[] = [];
  const adapter: VoiceAdapter = {
    connect: vi.fn(async () => {
      const transport = Object.assign(
        new TypedEmitter<VoiceTransportEvents>(),
        {
          disconnect: vi.fn().mockResolvedValue(undefined),
          setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
          setDeafened: vi.fn().mockResolvedValue(undefined),
        },
      );
      transports.push(transport);
      return transport;
    }),
  };
  const pending = VoiceSession.join(gateway, adapter, {
    ...joinOptions,
    recovery,
  });
  receive();
  const session = await pending;
  return { session, transports, adapter, gateway, socket, receive };
}

it("automatically rejoins after media failure with fresh grants and restored mute/deaf preferences", async () => {
  vi.useFakeTimers();
  const { session, transports, adapter, receive } = await sessionFixture();
  await session.setMuted(false);
  await session.setDeafened(true);
  const first = session.connection;
  transports[0]!.emit("state", "disconnected");
  expect(session.state).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(10);
  receive({ ...grant, connection_id: "fresh" });
  await vi.advanceTimersByTimeAsync(0);
  expect(session.state).toBe("connected");
  expect(session.connection).not.toBe(first);
  expect(vi.mocked(adapter.connect).mock.calls[1]?.[1]).toMatchObject({
    selfMute: false,
    selfDeaf: true,
  });
  expect(JSON.stringify(session)).not.toMatch(/secret-token/);
  await session.disconnect();
  expect(
    transports.every(
      (transport) => transport.disconnect.mock.calls.length === 1,
    ),
  ).toBe(true);
});

it("rejoins for replacement grants and handles a synchronous second failure during binding", async () => {
  vi.useFakeTimers();
  const { session, receive } = await sessionFixture();
  session.on("connection", () =>
    receive({ ...grant, endpoint: "wss://rotate" }),
  );
  receive({ ...grant, endpoint: "wss://new" });
  await vi.advanceTimersByTimeAsync(10);
  receive();
  await vi.advanceTimersByTimeAsync(0);
  expect(session.state).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(20);
  expect(session.toJSON().attempts).toBe(2);
  await session.disconnect();
});

it("waits for the gateway to be ready before requesting a fresh grant", async () => {
  vi.useFakeTimers();
  const { session, gateway, socket, receive } = await sessionFixture();
  gateway.disconnect();
  const count = socket.frames.length;
  await vi.advanceTimersByTimeAsync(10);
  expect(socket.frames).toHaveLength(count);
  // A ready notification alone is insufficient: the actual client state must be ready.
  socket.readyState = 1;
  const reconnecting = gateway.connect();
  socket.hello();
  socket.ready();
  await reconnecting;
  await vi.advanceTimersByTimeAsync(0);
  receive({ ...grant, connection_id: "fresh" });
  await vi.advanceTimersByTimeAsync(0);
  expect(session.state).toBe("connected");
  await session.disconnect();
});

it("does not rejoin a server leave or move", async () => {
  vi.useFakeTimers();
  const { session, gateway, adapter } = await sessionFixture();
  gateway.emit("dispatch", {
    op: 0,
    t: "VOICE_STATE_UPDATE",
    s: 3,
    d: {
      guild_id: "10",
      channel_id: null,
      connection_id: "connection",
      user_id: "1",
      mute: false,
      deaf: false,
      self_mute: false,
      self_deaf: false,
    },
  });
  expect(session.state).toBe("disconnected");
  await vi.advanceTimersByTimeAsync(1000);
  expect(adapter.connect).toHaveBeenCalledOnce();
  await session.disconnect();
});

it("bounds recovery across repeated successful rejoins and reports exhaustion", async () => {
  vi.useFakeTimers();
  const { session, transports, receive } = await sessionFixture({
    baseDelayMs: 10,
    maxDelayMs: 20,
    maxAttempts: 1,
    gatewayTimeoutMs: 30,
  });
  const errors = vi.fn();
  session.on("error", errors);
  transports[0]!.emit("state", "disconnected");
  await vi.advanceTimersByTimeAsync(10);
  receive({ ...grant, connection_id: "fresh" });
  await vi.advanceTimersByTimeAsync(0);
  transports[1]!.emit("state", "disconnected");
  await vi.advanceTimersByTimeAsync(0);
  expect(session.state).toBe("disconnected");
  expect(errors.mock.calls.at(-1)?.[0]).toMatchObject({
    message: "Voice recovery budget exhausted",
  });
  await session.disconnect();
});

it("cancels recovery during a pending join and cleans up late media", async () => {
  vi.useFakeTimers();
  const { session, transports, receive, adapter } = await sessionFixture();
  const media = deferred<any>();
  vi.mocked(adapter.connect).mockImplementationOnce(() => media.promise);
  transports[0]!.emit("state", "disconnected");
  await vi.advanceTimersByTimeAsync(10);
  receive();
  await vi.advanceTimersByTimeAsync(0);
  await session.disconnect();
  const disconnect = vi.fn();
  media.resolve({ disconnect });
  await vi.advanceTimersByTimeAsync(0);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(session.state).toBe("disconnected");
});

function playerFixture() {
  const voice = Object.assign(new TypedEmitter<any>(), {
    publishAudio: vi.fn().mockResolvedValue({
      id: "playback",
      stop: vi.fn().mockResolvedValue(undefined),
    }),
  });
  const contexts: ReturnType<typeof makeContext>[] = [];
  function makeContext() {
    const events = new EventTarget(),
      track = audioTrack();
    const node = Object.assign(events, {
      buffer: undefined as AudioBuffer | undefined,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    });
    const destination = {
      stream: { getAudioTracks: () => [track], getTracks: () => [track] },
      disconnect: vi.fn(),
    };
    const context = {
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      decodeAudioData: vi.fn().mockResolvedValue({ duration: 1 }),
      createBufferSource: () => node,
      createMediaStreamDestination: () => destination,
    };
    return { context, node, track, destination };
  }
  const player = new VoicePlayer(voice, {
    createAudioContext: () => {
      const item = makeContext();
      contexts.push(item);
      return item.context as unknown as AudioContext;
    },
  });
  return { player, voice, contexts };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

it("plays a FIFO queue and cleans up audio contexts, tracks and publications", async () => {
  const { player, voice, contexts } = playerFixture();
  const first = player.play(new ArrayBuffer(8)),
    second = player.play(new Blob(["audio"]));
  await flush();
  expect(contexts).toHaveLength(1);
  expect(player.state).toBe("playing");
  contexts[0]!.node.dispatchEvent(new Event("ended"));
  await first;
  await flush();
  expect(contexts).toHaveLength(2);
  contexts[1]!.node.dispatchEvent(new Event("ended"));
  await second;
  expect(
    contexts.every(
      ({ context, track }) =>
        context.close.mock.calls.length === 1 &&
        track.stop.mock.calls.length === 1,
    ),
  ).toBe(true);
  expect(voice.publishAudio).toHaveBeenCalledTimes(2);
  expect(player.state).toBe("idle");
  await player.disconnect();
});

it("cancels queued items promptly without allocating media and can still play subsequent items", async () => {
  const { player, contexts } = playerFixture();
  const first = player.play(new ArrayBuffer(8));
  await flush();
  const control = new AbortController();
  const queued = player.play(new ArrayBuffer(8), { signal: control.signal });
  const failed = expect(queued).rejects.toMatchObject({ name: "AbortError" });
  control.abort();
  await failed;
  expect(contexts).toHaveLength(1);
  contexts[0]!.node.dispatchEvent(new Event("ended"));
  await first;
  await flush();
  expect(contexts).toHaveLength(1);
  const third = player.play(new ArrayBuffer(8));
  await flush();
  contexts[1]!.node.dispatchEvent(new Event("ended"));
  await third;
  await player.disconnect();
});

it("cancels active playback and all queued items when the voice closes", async () => {
  const { player, voice, contexts } = playerFixture();
  const first = player.play(new ArrayBuffer(8)),
    second = player.play(new ArrayBuffer(8));
  const failed = Promise.all([
    expect(first).rejects.toMatchObject({ name: "AbortError" }),
    expect(second).rejects.toMatchObject({ name: "AbortError" }),
  ]);
  await flush();
  voice.emit("closed", "gateway");
  await failed;
  await player.disconnect();
  expect(contexts).toHaveLength(1);
  expect(contexts[0]!.context.close).toHaveBeenCalledOnce();
  expect(player.state).toBe("closed");
});

it("cleans up decoding failures and accepts another queue item", async () => {
  const { player, contexts } = playerFixture();
  const first = player.play(new ArrayBuffer(8));
  await Promise.resolve();
  contexts[0]!.context.decodeAudioData.mockRejectedValue(
    new Error("decode failed"),
  );
  await expect(first).rejects.toThrow("decode failed");
  expect(contexts[0]!.context.close).toHaveBeenCalledOnce();
  const second = player.play(new ArrayBuffer(8));
  await flush();
  contexts[1]!.node.dispatchEvent(new Event("ended"));
  await second;
  await player.disconnect();
});

it("unpublishes a late playback track after cancellation", async () => {
  const { player, voice, contexts } = playerFixture();
  const publishing = deferred<any>(),
    stop = vi.fn().mockResolvedValue(undefined);
  voice.publishAudio.mockReturnValue(publishing.promise);
  const control = new AbortController();
  const pending = player.play(new ArrayBuffer(8), { signal: control.signal });
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await flush();
  control.abort();
  await failed;
  await flush();
  publishing.resolve({ id: "late", stop });
  await flush();
  expect(stop).toHaveBeenCalledOnce();
  expect(contexts[0]!.track.stop).toHaveBeenCalledOnce();
  await player.disconnect();
});

it("cleans up media allocated by a microphone operation that settles after join cancellation", async () => {
  const media = room(),
    control = new AbortController(),
    microphone = deferred<void>();
  media.localParticipant.setMicrophoneEnabled.mockReturnValue(
    microphone.promise,
  );
  const pending = liveKitAdapter(() => media).connect(grant, {
    signal: control.signal,
    selfMute: false,
  });
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await flush();
  expect(media.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
    true,
  );
  control.abort();
  await flush();
  expect(media.disconnect).toHaveBeenCalledOnce();
  microphone.resolve();
  await failed;
  expect(media.disconnect).toHaveBeenCalledTimes(2);
});

it("treats a replacement grant for another channel as a server move", async () => {
  vi.useFakeTimers();
  const { session, receive, adapter } = await sessionFixture();
  receive({ ...grant, channel_id: "99" });
  await vi.advanceTimersByTimeAsync(0);
  expect(session.state).toBe("disconnected");
  expect(adapter.connect).toHaveBeenCalledOnce();
  await session.disconnect();
});

it("stops automatic recovery after a server leave during a pending rejoin", async () => {
  vi.useFakeTimers();
  const { session, transports, gateway, adapter, receive } =
    await sessionFixture();
  const late = deferred<any>();
  vi.mocked(adapter.connect).mockImplementationOnce(() => late.promise);
  transports[0]!.emit("state", "disconnected");
  await vi.advanceTimersByTimeAsync(10);
  receive();
  await vi.advanceTimersByTimeAsync(0);
  gateway.emit("dispatch", {
    op: 0,
    t: "VOICE_STATE_UPDATE",
    s: 3,
    d: {
      guild_id: "10",
      channel_id: null,
      connection_id: "connection",
      user_id: "1",
      mute: false,
      deaf: false,
      self_mute: false,
      self_deaf: false,
    },
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(session.state).toBe("disconnected");
  expect(adapter.connect).toHaveBeenCalledTimes(2);
  const disconnect = vi.fn();
  late.resolve({ disconnect });
  await vi.advanceTimersByTimeAsync(0);
  expect(disconnect).toHaveBeenCalledOnce();
  await session.disconnect();
});

it("removes session receive tracks on disconnection and reflects health for custom adapters", async () => {
  const { session, transports } = await sessionFixture();
  const track = {
    id: "remote",
    participantId: "speaker",
    mediaStreamTrack: audioTrack(),
    attach: vi.fn(),
    detach: vi.fn(),
  };
  const removed = vi.fn();
  session.on("audioTrackRemoved", removed);
  transports[0]!.emit("audioTrack", track);
  expect(session.audioTracks).toEqual([track]);
  transports[0]!.emit("state", "reconnecting");
  expect(session.connection!.state).toBe("reconnecting");
  transports[0]!.emit("state", "connected");
  expect(session.connection!.state).toBe("connected");
  await session.disconnect();
  expect(removed).toHaveBeenCalledWith(track);
  expect(session.audioTracks).toEqual([]);
});

it("keeps disposing a player after synchronous node cleanup errors", async () => {
  const { player, contexts } = playerFixture();
  const playback = player.play(new ArrayBuffer(8));
  const failed = expect(playback).rejects.toThrow("cleanup failed");
  await flush();
  contexts[0]!.node.disconnect.mockImplementation(() => {
    throw new Error("detach failed");
  });
  contexts[0]!.node.dispatchEvent(new Event("ended"));
  await failed;
  expect(contexts[0]!.context.close).toHaveBeenCalledOnce();
  expect(contexts[0]!.track.stop).toHaveBeenCalledOnce();
  await player.disconnect();
});

it("does not begin room connection when cancelled at the initial deafening boundary", async () => {
  const media = room(),
    control = new AbortController();
  const pending = liveKitAdapter(() => media).connect(grant, {
    signal: control.signal,
    selfDeaf: true,
  });
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  control.abort();
  await failed;
  expect(media.connect).not.toHaveBeenCalled();
  expect(media.disconnect).toHaveBeenCalledOnce();
});

it("preserves cancellation when disconnecting an ignored late room connection also fails", async () => {
  const media = room(),
    control = new AbortController(),
    connected = deferred<void>();
  media.connect.mockReturnValue(connected.promise);
  media.disconnect.mockRejectedValue(new Error("cleanup failed"));
  const pending = liveKitAdapter(() => media).connect(grant, {
    signal: control.signal,
  });
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  control.abort();
  await flush();
  connected.resolve();
  await failed;
  expect(media.disconnect).toHaveBeenCalledTimes(2);
});
