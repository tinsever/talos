import { afterEach, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/gateway.js";
import type { DispatchEvents } from "../src/gateway-types.js";
import {
  VoiceConnection,
  liveKitAdapter,
  type VoiceAdapter,
  type VoiceTransport,
} from "../src/voice.js";
import { FakeSocket } from "./helpers.js";

const gateways: GatewayClient[] = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.disconnect();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const options = { guildId: "10", channelId: "20" };
const grant: DispatchEvents["VOICE_SERVER_UPDATE"] = {
  guild_id: "10",
  channel_id: "20",
  connection_id: "connection",
  token: "private-token",
  endpoint: "wss://voice.example",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function ready() {
  const socket = new FakeSocket();
  const gateway = new GatewayClient({
    url: "wss://example",
    token: "synthetic",
    webSocket: () => socket,
  });
  gateways.push(gateway);
  const connected = gateway.connect();
  socket.hello();
  socket.ready();
  await connected;
  const transport = {
    disconnect: vi.fn<VoiceTransport["disconnect"]>(),
    setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
  };
  const adapter = {
    connect: vi.fn<VoiceAdapter["connect"]>().mockResolvedValue(transport),
  };
  const receive = (data = grant) =>
    socket.receive(0, data, "VOICE_SERVER_UPDATE", 2);
  const join = async () => {
    const pending = VoiceConnection.join(gateway, adapter, options);
    receive();
    return pending;
  };
  return { socket, gateway, transport, adapter, receive, join };
}

it.each([0, -1, NaN, Infinity, 2_147_483_648])(
  "does not reserve the channel or send a join with invalid timeout %s",
  async (timeoutMs) => {
    const { gateway, socket, adapter, join } = await ready();
    const count = socket.frames.length;
    await expect(
      VoiceConnection.join(gateway, adapter, { ...options, timeoutMs }),
    ).rejects.toThrow("timeoutMs");
    expect(socket.frames).toHaveLength(count);
    await (await join()).disconnect();
  },
);

it("does not send a pre-aborted join and permits a subsequent attempt", async () => {
  const { gateway, socket, adapter, join } = await ready();
  const control = new AbortController();
  const error = new Error("cancelled by caller");
  control.abort(error);
  const count = socket.frames.length;
  await expect(
    VoiceConnection.join(gateway, adapter, {
      ...options,
      signal: control.signal,
    }),
  ).rejects.toBe(error);
  expect(socket.frames).toHaveLength(count);
  expect(adapter.connect).not.toHaveBeenCalled();
  await (await join()).disconnect();
});

it("releases the channel and listeners when sending the join fails", async () => {
  const { gateway, adapter, receive, join } = await ready();
  const error = new Error("socket send failed");
  vi.spyOn(gateway, "send").mockImplementationOnce(() => {
    throw error;
  });
  await expect(VoiceConnection.join(gateway, adapter, options)).rejects.toBe(
    error,
  );
  receive();
  expect(adapter.connect).not.toHaveBeenCalled();
  await (await join()).disconnect();
});

it("prevents concurrent joins without disturbing the first attempt", async () => {
  const { gateway, adapter, receive } = await ready();
  const first = VoiceConnection.join(gateway, adapter, options);
  await expect(VoiceConnection.join(gateway, adapter, options)).rejects.toThrow(
    "already pending",
  );
  receive();
  await (await first).disconnect();
  expect(adapter.connect).toHaveBeenCalledTimes(1);
});

it("snapshots join options so caller mutation cannot leave a channel reserved", async () => {
  const { gateway, adapter, receive, join } = await ready();
  const mutable = { ...options };
  const pending = VoiceConnection.join(gateway, adapter, mutable);
  mutable.channelId = "99";
  mutable.guildId = "88";
  receive();
  const voice = await pending;
  expect(voice.toJSON()).toMatchObject(options);
  await voice.disconnect();
  await (await join()).disconnect();
});

it("accepts only the first matching grant and leaves using its identity", async () => {
  const { gateway, socket, adapter, receive } = await ready();
  const pending = VoiceConnection.join(gateway, adapter, options);
  receive({ ...grant, guild_id: "99" });
  receive();
  receive({ ...grant, connection_id: "replacement" });
  const voice = await pending;
  expect(adapter.connect.mock.calls[0]?.[0]).toEqual(grant);
  await voice.disconnect();
  expect(socket.frames.at(-1)?.d).toMatchObject({
    connection_id: "connection",
    channel_id: null,
  });
});

it("matches a call grant with no guild ID", async () => {
  const { gateway, adapter, receive } = await ready();
  const pending = VoiceConnection.join(gateway, adapter, {
    ...options,
    guildId: null,
  });
  receive();
  expect(adapter.connect).not.toHaveBeenCalled();
  const { guild_id: _guild, ...callGrant } = grant;
  receive(callGrant);
  await (await pending).disconnect();
});

it.each(["waiting for a grant", "connecting media"])(
  "times out while %s, closes late media, and permits retry",
  async (phase) => {
    vi.useFakeTimers();
    const { gateway, adapter, receive, join, transport } = await ready();
    const media = deferred<VoiceTransport>();
    const started = deferred<AbortSignal>();
    adapter.connect.mockImplementationOnce((_grant, { signal }) => {
      started.resolve(signal);
      return media.promise;
    });
    const pending = VoiceConnection.join(gateway, adapter, {
      ...options,
      timeoutMs: 25,
    });
    const failed = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    let mediaSignal: AbortSignal | undefined;
    if (phase === "connecting media") {
      receive();
      mediaSignal = await started.promise;
    }
    await vi.advanceTimersByTimeAsync(25);
    await failed;
    if (mediaSignal) {
      expect(mediaSignal.aborted).toBe(true);
      media.resolve(transport);
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.disconnect).toHaveBeenCalledTimes(1);
    } else {
      receive();
      expect(adapter.connect).not.toHaveBeenCalled();
      adapter.connect.mockReset().mockResolvedValue(transport);
    }
    await (await join()).disconnect();
    gateway.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["waiting for a grant", "connecting media"])(
  "aborts while %s and permits retry",
  async (phase) => {
    const { gateway, adapter, receive, join, transport } = await ready();
    const media = deferred<VoiceTransport>();
    const started = deferred<AbortSignal>();
    adapter.connect.mockImplementationOnce((_grant, { signal }) => {
      started.resolve(signal);
      return media.promise;
    });
    const control = new AbortController();
    const error = new Error("cancel voice");
    const pending = VoiceConnection.join(gateway, adapter, {
      ...options,
      signal: control.signal,
    });
    const failed = expect(pending).rejects.toBe(error);
    let mediaSignal: AbortSignal | undefined;
    if (phase === "connecting media") {
      receive();
      mediaSignal = await started.promise;
    }
    control.abort(error);
    await failed;
    expect(mediaSignal?.aborted ?? true).toBe(true);
    if (mediaSignal) {
      media.resolve(transport);
      await media.promise;
      await Promise.resolve();
      expect(transport.disconnect).toHaveBeenCalledTimes(1);
    } else {
      adapter.connect.mockReset().mockResolvedValue(transport);
    }
    await (await join()).disconnect();
  },
);

it.each(["close", "reconnect"])(
  "cancels media connection on gateway %s and disposes late media",
  async (event) => {
    const { gateway, socket, receive, transport } = await ready();
    const media = deferred<VoiceTransport>();
    const started = deferred<AbortSignal>();
    const adapter: VoiceAdapter = {
      connect: (_grant, { signal }) => {
        started.resolve(signal);
        return media.promise;
      },
    };
    const pending = VoiceConnection.join(gateway, adapter, options);
    const failed = expect(pending).rejects.toThrow(
      "Gateway disconnected during voice join",
    );
    receive();
    const signal = await started.promise;
    if (event === "close") gateway.disconnect();
    else socket.closed();
    await failed;
    expect(signal.aborted).toBe(true);
    media.resolve(transport);
    await media.promise;
    await Promise.resolve();
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  },
);

it("cancels a join if the gateway reconnects before its grant", async () => {
  const { gateway, socket, adapter } = await ready();
  const pending = VoiceConnection.join(gateway, adapter, options);
  const failed = expect(pending).rejects.toThrow(
    "Gateway disconnected during voice join",
  );
  socket.closed();
  await failed;
  expect(adapter.connect).not.toHaveBeenCalled();
});

it.each(["leave", "replacement grant"])(
  "cancels media connection on a server %s",
  async (event) => {
    const { gateway, adapter, receive, transport } = await ready();
    const media = deferred<VoiceTransport>();
    const started = deferred<AbortSignal>();
    adapter.connect.mockImplementation((_grant, { signal }) => {
      started.resolve(signal);
      return media.promise;
    });
    const pending = VoiceConnection.join(gateway, adapter, options);
    const failed = expect(pending).rejects.toThrow(
      event === "leave"
        ? "Voice disconnected during voice join"
        : "Voice grant replaced during voice join",
    );
    receive();
    const signal = await started.promise;
    if (event === "leave") {
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
    } else receive({ ...grant, token: "replacement-token" });
    await failed;
    expect(signal.aborted).toBe(true);
    media.resolve(transport);
    await media.promise;
    await Promise.resolve();
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  },
);

it.each(["grant", "media"])(
  "honors cancellation at the %s resolution boundary",
  async (phase) => {
    const { gateway, adapter, receive, transport } = await ready();
    const control = new AbortController();
    const media = deferred<VoiceTransport>();
    const started = deferred<void>();
    adapter.connect.mockImplementation(() => {
      started.resolve();
      return media.promise;
    });
    const pending = VoiceConnection.join(gateway, adapter, {
      ...options,
      signal: control.signal,
    });
    const failed = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    receive();
    if (phase === "media") {
      await started.promise;
      media.resolve(transport);
    }
    control.abort();
    await failed;
    if (phase === "grant") expect(adapter.connect).not.toHaveBeenCalled();
    else expect(transport.disconnect).toHaveBeenCalledTimes(1);
  },
);

it("preserves media failure when the leave command also fails and permits retry", async () => {
  const { gateway, adapter, receive, join } = await ready();
  const error = new Error("media failed");
  adapter.connect.mockRejectedValueOnce(error);
  const pending = VoiceConnection.join(gateway, adapter, options);
  receive();
  vi.spyOn(gateway, "send").mockImplementationOnce(() => {
    throw new Error("leave failed");
  });
  await expect(pending).rejects.toBe(error);
  await (await join()).disconnect();
});

it("reports failed late-media disposal without an unhandled rejection", async () => {
  const { gateway, adapter, receive } = await ready();
  const media = deferred<VoiceTransport>();
  const started = deferred<void>();
  adapter.connect.mockImplementation(() => {
    started.resolve();
    return media.promise;
  });
  const errors = deferred<unknown>();
  gateway.on("error", errors.resolve);
  const control = new AbortController();
  const pending = VoiceConnection.join(gateway, adapter, {
    ...options,
    signal: control.signal,
  });
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  receive();
  await started.promise;
  control.abort();
  await failed;
  const error = new Error("late cleanup failed");
  media.resolve({
    disconnect: () => {
      throw error;
    },
  });
  expect(await errors.promise).toBe(error);
});

it.each(["close", "reconnect"])(
  "ends an established connection on gateway %s",
  async (event) => {
    const { gateway, socket, join, transport } = await ready();
    const voice = await join();
    if (event === "close") gateway.disconnect();
    else socket.closed();
    expect(voice.toJSON().active).toBe(false);
    await voice.disconnect();
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
    await expect(voice.setMuted(true)).rejects.toThrow("disconnected");
  },
);

it.each([null, "99"])(
  "ends media when its own voice state changes to channel %s",
  async (channelId) => {
    const { gateway, join, transport } = await ready();
    const voice = await join();
    const state = {
      guild_id: "10",
      channel_id: channelId,
      connection_id: "other",
      user_id: "1",
      mute: false,
      deaf: false,
      self_mute: false,
      self_deaf: false,
    };
    gateway.emit("dispatch", {
      op: 0,
      t: "VOICE_STATE_UPDATE",
      s: 3,
      d: state,
    });
    expect(voice.toJSON().active).toBe(true);
    gateway.emit("dispatch", {
      op: 0,
      t: "VOICE_STATE_UPDATE",
      s: 4,
      d: { ...state, connection_id: "connection" },
    });
    expect(voice.toJSON().active).toBe(false);
    await voice.disconnect();
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  },
);

it("ends an established connection when its grant is replaced", async () => {
  const { join, receive, transport } = await ready();
  const voice = await join();
  receive({ ...grant, connection_id: "other" });
  expect(voice.toJSON().active).toBe(true);
  receive({ ...grant, endpoint: "wss://replacement.example" });
  expect(voice.toJSON().active).toBe(false);
  await voice.disconnect();
  expect(transport.disconnect).toHaveBeenCalledTimes(1);
});

it("reports automatic media cleanup failure through the gateway error event", async () => {
  const { gateway, join, transport } = await ready();
  const voice = await join();
  const error = new Error("cleanup failed");
  transport.disconnect.mockRejectedValue(error);
  const reported = deferred<unknown>();
  gateway.on("error", reported.resolve);
  gateway.disconnect();
  expect(await reported.promise).toBe(error);
  expect(voice.toJSON().active).toBe(false);
  await expect(voice.disconnect()).rejects.toBe(error);
  expect(transport.disconnect).toHaveBeenCalledTimes(1);
});

it("makes concurrent disconnect callers wait for the same cleanup", async () => {
  const { join, transport, socket } = await ready();
  const voice = await join();
  const cleanup = deferred<void>();
  transport.disconnect.mockReturnValue(cleanup.promise);
  const first = voice.disconnect();
  const second = voice.disconnect();
  const settled = vi.fn();
  void second.then(settled);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(voice.toJSON().active).toBe(false);
  expect(transport.disconnect).toHaveBeenCalledTimes(1);
  cleanup.resolve();
  await Promise.all([first, second]);
  await voice.disconnect();
  expect(
    socket.frames.filter(
      (frame) =>
        frame.op === 4 &&
        (frame.d as { channel_id: unknown }).channel_id === null,
    ),
  ).toHaveLength(1);
});

it("disconnects media even if the gateway leave fails", async () => {
  const { gateway, join, transport } = await ready();
  const voice = await join();
  const error = new Error("leave failed");
  vi.spyOn(gateway, "send").mockImplementationOnce(() => {
    throw error;
  });
  await expect(voice.disconnect()).rejects.toBe(error);
  await expect(voice.disconnect()).rejects.toBe(error);
  expect(transport.disconnect).toHaveBeenCalledTimes(1);
});

it("does not send a mute update after disconnect during microphone control", async () => {
  const { join, transport, socket } = await ready();
  const voice = await join();
  const changed = deferred<void>();
  transport.setMicrophoneEnabled.mockReturnValue(changed.promise);
  const pending = voice.setMuted(true);
  const failed = expect(pending).rejects.toThrow("disconnected");
  await voice.disconnect();
  const count = socket.frames.length;
  changed.resolve();
  await failed;
  expect(socket.frames).toHaveLength(count);
});

it("removes join-only abort and timeout effects after successful connection", async () => {
  vi.useFakeTimers();
  const { gateway, adapter, receive, transport } = await ready();
  const control = new AbortController();
  const pending = VoiceConnection.join(gateway, adapter, {
    ...options,
    signal: control.signal,
    timeoutMs: 25,
  });
  receive();
  const voice = await pending;
  control.abort();
  await vi.advanceTimersByTimeAsync(25);
  expect(voice.toJSON().active).toBe(true);
  expect(adapter.connect.mock.calls[0]?.[1].signal.aborted).toBe(false);
  expect(transport.disconnect).not.toHaveBeenCalled();
  await voice.disconnect();
});

it.each(["key", ""])(
  "rejects an E2EE grant (%s) before connecting an unsupported adapter",
  async (key) => {
    const { gateway, adapter, receive, join, socket } = await ready();
    const pending = VoiceConnection.join(gateway, adapter, options);
    receive({ ...grant, e2ee_key: key });
    await expect(pending).rejects.toThrow("required E2EE");
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(socket.frames.at(-1)?.d).toMatchObject({
      channel_id: null,
      connection_id: grant.connection_id,
    });
    await (await join()).disconnect();
  },
);

it("passes private E2EE material only to an explicitly capable adapter", async () => {
  const { gateway, adapter, receive } = await ready();
  const pending = VoiceConnection.join(
    gateway,
    { ...adapter, supportsE2EE: true },
    options,
  );
  receive({ ...grant, e2ee_key: "private-key" });
  const voice = await pending;
  expect(adapter.connect.mock.calls[0]?.[0].e2ee_key).toBe("private-key");
  expect(JSON.stringify(voice)).not.toMatch(/private-key|private-token/);
  await voice.disconnect();
});

function room() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn<VoiceTransport["disconnect"]>(),
    localParticipant: {
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    },
  };
}

it("rejects E2EE when the bundled adapter is used directly", async () => {
  const createRoom = vi.fn(room);
  const adapter = liveKitAdapter(createRoom);
  expect(adapter.supportsE2EE).not.toBe(true);
  await expect(
    adapter.connect(
      { ...grant, e2ee_key: "private-key" },
      {
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toThrow("required E2EE");
  expect(createRoom).not.toHaveBeenCalled();
});

it("connects a LiveKit room and delegates microphone control and disconnect", async () => {
  const media = room();
  const control = new AbortController();
  const transport = await liveKitAdapter(() => media).connect(grant, {
    signal: control.signal,
  });
  expect(media.connect).toHaveBeenCalledWith(grant.endpoint, grant.token);
  await transport.setMicrophoneEnabled!(false);
  expect(media.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
    false,
  );
  control.abort();
  expect(media.disconnect).not.toHaveBeenCalled();
  await transport.disconnect();
  expect(media.disconnect).toHaveBeenCalledTimes(1);
});

it("disposes a LiveKit room when already aborted without starting media", async () => {
  const media = room();
  const control = new AbortController();
  control.abort();
  await expect(
    liveKitAdapter(() => media).connect(grant, { signal: control.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(media.connect).not.toHaveBeenCalled();
  expect(media.disconnect).toHaveBeenCalledTimes(1);
});

it("preserves a LiveKit connection error if cleanup rejects", async () => {
  const media = room();
  const error = new Error("connect failed");
  media.connect.mockRejectedValue(error);
  media.disconnect.mockRejectedValue(new Error("cleanup failed"));
  await expect(
    liveKitAdapter(() => media).connect(grant, {
      signal: new AbortController().signal,
    }),
  ).rejects.toBe(error);
  expect(media.disconnect).toHaveBeenCalledTimes(1);
});

it("handles rejected LiveKit abort cleanup and disconnects a late successful room again", async () => {
  const media = room();
  const connected = deferred<void>();
  const control = new AbortController();
  media.connect.mockReturnValue(connected.promise);
  media.disconnect.mockRejectedValueOnce(new Error("abort cleanup failed"));
  const pending = liveKitAdapter(() => media).connect(grant, {
    signal: control.signal,
  });
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  control.abort();
  await Promise.resolve();
  expect(media.disconnect).toHaveBeenCalledTimes(1);
  connected.resolve();
  await failed;
  expect(media.disconnect).toHaveBeenCalledTimes(2);
});
