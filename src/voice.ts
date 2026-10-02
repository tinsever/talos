import type { GatewayClient } from "./gateway.js";
import type { DispatchEvents } from "./gateway-types.js";
import { abortable, abortReason, deadline, positive } from "./utils.js";
import { TypedEmitter } from "./events.js";
export { liveKitAdapter } from "./voice-livekit.js";
export type {
  LiveKitRoom,
  LiveKitAdapterOptions,
  LiveKitEncryption,
} from "./voice-livekit.js";
export { VoicePlayer } from "./voice-player.js";
export type { VoiceAudioSource, VoicePlayerOptions } from "./voice-player.js";
export { VoiceSession } from "./voice-session.js";
export type {
  VoiceRecoveryOptions,
  VoiceSessionOptions,
  VoiceSessionEvents,
} from "./voice-session.js";

export interface VoiceAudioTrack {
  id: string;
  participantId: string;
  mediaStreamTrack: MediaStreamTrack;
  attach(element?: HTMLMediaElement): HTMLMediaElement;
  detach(element?: HTMLMediaElement): HTMLMediaElement[];
}
export interface VoicePublication {
  id: string;
  /** Unpublish without stopping the caller-owned source track. Idempotent. */
  stop(): Promise<void>;
}
export interface VoiceTransportEvents {
  state: "connected" | "reconnecting" | "disconnected";
  audioTrack: VoiceAudioTrack;
  audioTrackRemoved: VoiceAudioTrack;
  speakers: readonly string[];
  error: unknown;
}
export type VoiceCloseReason =
  | "manual"
  | "gateway"
  | "voice-state"
  | "grant"
  | "media";
/** A terminal signaling event that interrupted a pending join. */
export class VoiceLifecycleError extends Error {
  constructor(
    message: string,
    readonly reason: VoiceCloseReason,
  ) {
    super(message);
    this.name = "VoiceLifecycleError";
  }
}
export interface VoiceConnectionEvents extends VoiceTransportEvents {
  closed: VoiceCloseReason;
}
export interface VoiceTransport {
  disconnect(): Promise<void> | void;
  setMicrophoneEnabled?(enabled: boolean): Promise<void>;
  setDeafened?(deafened: boolean): Promise<void>;
  publishAudio?(track: MediaStreamTrack): Promise<VoicePublication>;
  startAudio?(): Promise<void>;
  readonly audioTracks?: readonly VoiceAudioTrack[];
  readonly state?: VoiceTransportEvents["state"];
  on?<K extends keyof VoiceTransportEvents>(
    event: K,
    listener: (value: VoiceTransportEvents[K]) => unknown,
  ): () => void;
}
export interface VoiceAdapter {
  /** Media tokens and E2EE material are private capabilities. Do not log the grant. */
  connect(
    grant: DispatchEvents["VOICE_SERVER_UPDATE"],
    context: { signal: AbortSignal; selfMute?: boolean; selfDeaf?: boolean },
  ): Promise<VoiceTransport>;
  /** Opt in only if connect configures encryption using the grant's e2ee_key. */
  supportsE2EE?: boolean;
}
export interface VoiceJoinOptions {
  guildId: string | null;
  channelId: string;
  selfMute?: boolean;
  selfDeaf?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}
const joining = new WeakMap<GatewayClient, Set<string>>();
/** A single voice connection. Use VoiceSession for automatic recovery. */
export class VoiceConnection extends TypedEmitter<VoiceConnectionEvents> {
  private active = true;
  private closing: Promise<void> | undefined;
  private readonly stateOff: () => void;
  private readonly voiceStateOff: () => void;
  private readonly grantOff: () => void;
  private readonly transportOff: (() => void)[] = [];
  private mediaState: VoiceTransportEvents["state"];
  private constructor(
    private readonly gateway: GatewayClient,
    private readonly transport: VoiceTransport,
    readonly guildId: string | null,
    readonly channelId: string,
    readonly connectionId: string,
  ) {
    super((error) => gateway.emit("error", error));
    this.mediaState = transport.state ?? "connected";
    const close = (reason: VoiceCloseReason) => {
      void this.end(reason).catch((error) => gateway.emit("error", error));
    };
    this.stateOff = gateway.on("state", (state) => {
      if (state !== "ready") close("gateway");
    });
    this.voiceStateOff = gateway.onDispatch("VOICE_STATE_UPDATE", (state) => {
      if (
        state.connection_id === connectionId &&
        (state.guild_id ?? null) === guildId &&
        state.channel_id !== channelId
      )
        close("voice-state");
    });
    this.grantOff = gateway.onDispatch("VOICE_SERVER_UPDATE", (grant) => {
      if (grant.connection_id === connectionId)
        close(
          grant.channel_id !== channelId || (grant.guild_id ?? null) !== guildId
            ? "voice-state"
            : "grant",
        );
    });
    if (transport.on) {
      for (const event of [
        "audioTrack",
        "audioTrackRemoved",
        "speakers",
        "error",
      ] as const)
        this.transportOff.push(
          transport.on(event, (value) => this.emit(event, value)),
        );
      this.transportOff.push(
        transport.on("state", (state) => {
          this.mediaState = state;
          this.emit("state", state);
          if (state === "disconnected") close("media");
        }),
      );
    }
    if (transport.state === "disconnected") close("media");
  }
  static async join(
    gateway: GatewayClient,
    adapter: VoiceAdapter,
    options: VoiceJoinOptions,
  ): Promise<VoiceConnection> {
    const { guildId, channelId, selfMute, selfDeaf, signal } = options;
    const timeoutMs = positive(options.timeoutMs ?? 30000, "timeoutMs");
    signal?.throwIfAborted();
    if (gateway.state !== "ready") throw new Error("Gateway is not ready");
    let pending = joining.get(gateway);
    if (!pending) {
      pending = new Set();
      joining.set(gateway, pending);
    }
    if (pending.has(channelId))
      throw new Error("A voice join is already pending for this channel");
    const lifecycle = new AbortController();
    const abort = () => lifecycle.abort(abortReason(signal!));
    signal?.addEventListener("abort", abort, { once: true });
    const control = deadline(timeoutMs, lifecycle.signal);
    pending.add(channelId);
    let off = () => {};
    let stateOff = () => {};
    let voiceStateOff = () => {};
    let grant: DispatchEvents["VOICE_SERVER_UPDATE"] | undefined;
    const leave = () => {
      if (grant && gateway.state === "ready")
        gateway.send(4, {
          guild_id: guildId,
          channel_id: null,
          connection_id: grant.connection_id,
        });
    };
    try {
      const received = new Promise<DispatchEvents["VOICE_SERVER_UPDATE"]>(
        (resolve) => {
          off = gateway.onDispatch("VOICE_SERVER_UPDATE", (data) => {
            if (grant && data.connection_id === grant.connection_id) {
              lifecycle.abort(
                new VoiceLifecycleError(
                  "Voice grant replaced during voice join",
                  data.channel_id !== channelId ||
                  (data.guild_id ?? null) !== guildId
                    ? "voice-state"
                    : "grant",
                ),
              );
              return;
            }
            if (
              !grant &&
              !control.signal.aborted &&
              data.channel_id === channelId &&
              (data.guild_id ?? null) === guildId
            ) {
              grant = data;
              resolve(data);
            }
          });
          stateOff = gateway.on("state", (state) => {
            if (state !== "ready")
              lifecycle.abort(
                new VoiceLifecycleError(
                  "Gateway disconnected during voice join",
                  "gateway",
                ),
              );
          });
          voiceStateOff = gateway.onDispatch("VOICE_STATE_UPDATE", (state) => {
            if (
              grant &&
              state.connection_id === grant.connection_id &&
              (state.guild_id ?? null) === guildId &&
              state.channel_id !== channelId
            )
              lifecycle.abort(
                new VoiceLifecycleError(
                  "Voice disconnected during voice join",
                  "voice-state",
                ),
              );
          });
        },
      );
      control.signal.throwIfAborted();
      gateway.send(4, {
        guild_id: guildId,
        channel_id: channelId,
        self_mute: selfMute ?? false,
        self_deaf: selfDeaf ?? false,
        self_video: false,
        self_stream: false,
      });
      grant = await abortable(received, control.signal);
      control.signal.throwIfAborted();
      if (grant.e2ee_key !== undefined && !adapter.supportsE2EE)
        throw new Error("This voice adapter does not support required E2EE");
      const connecting = adapter.connect(grant, {
        signal: control.signal,
        ...(selfMute !== undefined ? { selfMute } : {}),
        ...(selfDeaf !== undefined ? { selfDeaf } : {}),
      });
      let transport: VoiceTransport;
      try {
        transport = await abortable(connecting, control.signal);
        control.signal.throwIfAborted();
      } catch (error) {
        void connecting
          .then(
            (value) => value.disconnect(),
            () => {},
          )
          .catch((cleanupError) => gateway.emit("error", cleanupError));
        throw error;
      }
      return new VoiceConnection(
        gateway,
        transport,
        guildId,
        channelId,
        grant.connection_id,
      );
    } catch (error) {
      // A failed leave must not replace the join's cancellation or media error.
      try {
        leave();
      } catch {}
      throw error;
    } finally {
      off();
      stateOff();
      voiceStateOff();
      control.dispose();
      signal?.removeEventListener("abort", abort);
      pending.delete(channelId);
    }
  }
  async setMuted(muted: boolean): Promise<void> {
    if (!this.active) throw new Error("Voice is disconnected");
    if (!this.transport.setMicrophoneEnabled)
      throw new Error("Adapter cannot control the microphone");
    await this.transport.setMicrophoneEnabled(!muted);
    if (!this.active) throw new Error("Voice is disconnected");
    this.gateway.send(4, {
      guild_id: this.guildId,
      channel_id: this.channelId,
      connection_id: this.connectionId,
      self_mute: muted,
    });
  }
  get audioTracks(): readonly VoiceAudioTrack[] {
    return this.active ? (this.transport.audioTracks ?? []) : [];
  }
  get state(): VoiceTransportEvents["state"] {
    return this.active ? this.mediaState : "disconnected";
  }
  async startAudio(): Promise<void> {
    if (!this.active) throw new Error("Voice is disconnected");
    if (!this.transport.startAudio)
      throw new Error("Adapter cannot start audio playback");
    await this.transport.startAudio();
  }
  async publishAudio(track: MediaStreamTrack): Promise<VoicePublication> {
    if (!this.active) throw new Error("Voice is disconnected");
    if (track.kind !== "audio") throw new Error("Expected an audio track");
    if (!this.transport.publishAudio)
      throw new Error("Adapter cannot publish audio");
    const publication = await this.transport.publishAudio(track);
    if (!this.active) {
      await publication.stop();
      throw new Error("Voice is disconnected");
    }
    return publication;
  }
  async setDeafened(deafened: boolean): Promise<void> {
    if (!this.active) throw new Error("Voice is disconnected");
    if (!this.transport.setDeafened)
      throw new Error("Adapter cannot control receiving");
    await this.transport.setDeafened(deafened);
    if (!this.active) throw new Error("Voice is disconnected");
    this.gateway.send(4, {
      guild_id: this.guildId,
      channel_id: this.channelId,
      connection_id: this.connectionId,
      self_deaf: deafened,
    });
  }
  disconnect(): Promise<void> {
    return this.end("manual");
  }
  private end(reason: VoiceCloseReason): Promise<void> {
    if (this.closing) return this.closing;
    const tracks = this.transport.audioTracks ?? [];
    this.active = false;
    this.stateOff();
    this.voiceStateOff();
    this.grantOff();
    for (const off of this.transportOff.splice(0)) off();
    this.closing = Promise.resolve().then(async () => {
      try {
        if (this.gateway.state === "ready")
          this.gateway.send(4, {
            guild_id: this.guildId,
            channel_id: null,
            connection_id: this.connectionId,
          });
      } finally {
        await this.transport.disconnect();
      }
    });
    for (const track of tracks) this.emit("audioTrackRemoved", track);
    if (this.mediaState !== "disconnected") {
      this.mediaState = "disconnected";
      this.emit("state", "disconnected");
    }
    this.emit("closed", reason);
    return this.closing;
  }
  toJSON(): {
    guildId: string | null;
    channelId: string;
    connectionId: string;
    active: boolean;
  } {
    return {
      guildId: this.guildId,
      channelId: this.channelId,
      connectionId: this.connectionId,
      active: this.active,
    };
  }
}
