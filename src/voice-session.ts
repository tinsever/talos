import { TypedEmitter } from "./events.js";
import type { GatewayClient } from "./gateway.js";
import {
  VoiceConnection,
  VoiceLifecycleError,
  type VoiceAdapter,
  type VoiceAudioTrack,
  type VoiceCloseReason,
  type VoiceJoinOptions,
  type VoicePublication,
} from "./voice.js";
import { abortable, deadline, delay, positive } from "./utils.js";

export interface VoiceRecoveryOptions {
  /** Total rejoin budget for this session, including repeated media failures. Default 5. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Deadline for waiting for a ready gateway before each rejoin. Default 30 seconds. */
  gatewayTimeoutMs?: number;
}
export interface VoiceSessionOptions extends VoiceJoinOptions {
  recovery?: VoiceRecoveryOptions;
}
export interface VoiceSessionEvents {
  state: "connected" | "reconnecting" | "disconnected";
  connection: VoiceConnection;
  retry: { attempt: number; reason: VoiceCloseReason };
  audioTrack: VoiceAudioTrack;
  audioTrackRemoved: VoiceAudioTrack;
  speakers: readonly string[];
  error: unknown;
}
/** Owns successive connections and rejoins with fresh grants after network failures. */
export class VoiceSession extends TypedEmitter<VoiceSessionEvents> {
  private readonly control = new AbortController();
  private readonly lifecycleListeners: (() => void)[] = [];
  private current: VoiceConnection | undefined;
  private recovering: Promise<void> | undefined;
  private recoveryReason: VoiceCloseReason | undefined;
  private readonly tracks = new Map<string, VoiceAudioTrack>();
  private stopping: Promise<void> | undefined;
  private attempts = 0;
  private muted: boolean;
  private deafened: boolean;
  private status: VoiceSessionEvents["state"] = "connected";
  private constructor(
    private readonly gateway: GatewayClient,
    private readonly adapter: VoiceAdapter,
    private readonly options: VoiceSessionOptions,
  ) {
    super((error) => gateway.emit("error", error));
    this.muted = options.selfMute ?? true;
    this.deafened = options.selfDeaf ?? false;
  }
  static async join(
    gateway: GatewayClient,
    adapter: VoiceAdapter,
    options: VoiceSessionOptions,
  ): Promise<VoiceSession> {
    const recovery = { ...options.recovery };
    const maxAttempts = recovery.maxAttempts ?? 5;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0)
      throw new RangeError("maxAttempts must be a non-negative safe integer");
    positive(recovery.baseDelayMs ?? 1000, "baseDelayMs");
    positive(recovery.maxDelayMs ?? 30000, "maxDelayMs");
    positive(recovery.gatewayTimeoutMs ?? 30000, "gatewayTimeoutMs");
    // Snapshot preferences and policy. The caller signal only covers the initial join.
    const session = new VoiceSession(gateway, adapter, {
      ...options,
      recovery,
    });
    const connection = await VoiceConnection.join(gateway, adapter, {
      ...options,
      selfMute: session.muted,
      selfDeaf: session.deafened,
    });
    session.bind(connection);
    return session;
  }
  get state(): VoiceSessionEvents["state"] {
    return this.status;
  }
  get connection(): VoiceConnection | undefined {
    return this.current;
  }
  get audioTracks(): readonly VoiceAudioTrack[] {
    return [...this.tracks.values()];
  }
  private setState(state: VoiceSessionEvents["state"]): void {
    if (state === this.status) return;
    this.status = state;
    this.emit("state", state);
  }
  private bind(connection: VoiceConnection): void {
    this.current = connection;
    for (const event of ["speakers", "error"] as const)
      this.lifecycleListeners.push(
        connection.on(event, (value) => this.emit(event, value)),
      );
    this.lifecycleListeners.push(
      connection.on("audioTrack", (track) => {
        this.tracks.set(track.id, track);
        this.emit("audioTrack", track);
      }),
    );
    this.lifecycleListeners.push(
      connection.on("audioTrackRemoved", (track) => {
        this.tracks.delete(track.id);
        this.emit("audioTrackRemoved", track);
      }),
    );
    this.lifecycleListeners.push(
      connection.on("state", (state) => {
        if (state !== "disconnected") this.setState(state);
      }),
    );
    this.lifecycleListeners.push(
      connection.on("closed", (reason) => this.closed(connection, reason)),
    );
    if (!connection.toJSON().active) this.closed(connection, "media");
    else {
      this.setState(connection.state);
      this.emit("connection", connection);
      for (const track of connection.audioTracks) {
        this.tracks.set(track.id, track);
        this.emit("audioTrack", track);
      }
    }
  }
  private unbind(): void {
    for (const off of this.lifecycleListeners.splice(0)) off();
  }
  private closed(connection: VoiceConnection, reason: VoiceCloseReason): void {
    if (this.control.signal.aborted || connection !== this.current) return;
    this.unbind();
    this.clearTracks();
    if (reason === "manual" || reason === "voice-state") {
      void this.disconnect().catch((error) => this.emit("error", error));
      return;
    }
    this.setState("reconnecting");
    this.recoveryReason = reason;
    this.scheduleRecovery(connection);
  }
  private clearTracks(): void {
    const tracks = [...this.tracks.values()];
    this.tracks.clear();
    for (const track of tracks) this.emit("audioTrackRemoved", track);
  }
  private scheduleRecovery(connection: VoiceConnection): void {
    // Run after the closed event returns, so disconnect's cleanup promise exists.
    if (!this.recovering) {
      this.recovering = Promise.resolve()
        .then(() => {
          const reason = this.recoveryReason!;
          this.recoveryReason = undefined;
          return this.recover(connection, reason);
        })
        .catch((error) => {
          if (!this.control.signal.aborted) {
            this.emit("error", error);
            void this.disconnect().catch((cleanupError) =>
              this.emit("error", cleanupError),
            );
          }
        })
        .finally(() => {
          this.recovering = undefined;
          if (
            this.recoveryReason &&
            !this.control.signal.aborted &&
            this.current
          )
            this.scheduleRecovery(this.current);
        });
    }
  }
  private async waitForGateway(): Promise<void> {
    const control = deadline(
      this.options.recovery?.gatewayTimeoutMs ?? 30000,
      this.control.signal,
    );
    let off = () => {};
    try {
      const ready = new Promise<void>((resolve) => {
        off = this.gateway.on("state", (state) => {
          if (state === "ready") resolve();
        });
        if (this.gateway.state === "ready") resolve();
      });
      await abortable(ready, control.signal);
    } finally {
      off();
      control.dispose();
    }
  }
  private async recover(
    previous: VoiceConnection,
    reason: VoiceCloseReason,
  ): Promise<void> {
    try {
      await previous.disconnect();
    } catch (error) {
      this.emit("error", error);
    }
    const policy = this.options.recovery;
    while (!this.control.signal.aborted) {
      if (this.attempts >= (policy?.maxAttempts ?? 5))
        throw new Error("Voice recovery budget exhausted");
      this.attempts++;
      this.emit("retry", { attempt: this.attempts, reason });
      await delay(
        Math.min(
          policy?.maxDelayMs ?? 30000,
          (policy?.baseDelayMs ?? 1000) * 2 ** Math.min(this.attempts - 1, 30),
        ),
        this.control.signal,
      );
      try {
        await this.waitForGateway();
        this.control.signal.throwIfAborted();
        const connection = await VoiceConnection.join(
          this.gateway,
          this.adapter,
          {
            guildId: this.options.guildId,
            channelId: this.options.channelId,
            selfMute: this.muted,
            selfDeaf: this.deafened,
            ...(this.options.timeoutMs !== undefined
              ? { timeoutMs: this.options.timeoutMs }
              : {}),
            signal: this.control.signal,
          },
        );
        if (this.control.signal.aborted) {
          await connection.disconnect();
          return;
        }
        // A transport can end synchronously as it is bound. Retry it in this loop.
        if (!connection.toJSON().active) {
          await connection.disconnect();
          continue;
        }
        this.bind(connection);
        return;
      } catch (error) {
        this.control.signal.throwIfAborted();
        if (
          error instanceof VoiceLifecycleError &&
          error.reason === "voice-state"
        ) {
          void this.disconnect().catch((cleanupError) =>
            this.emit("error", cleanupError),
          );
          return;
        }
        this.emit("error", error);
      }
    }
  }
  private requireConnection(): VoiceConnection {
    if (this.status === "disconnected")
      throw new Error("Voice is disconnected");
    if (!this.current?.toJSON().active)
      throw new Error("Voice is reconnecting");
    return this.current;
  }
  async setMuted(muted: boolean): Promise<void> {
    const connection = this.requireConnection();
    await connection.setMuted(muted);
    this.muted = muted;
  }
  async setDeafened(deafened: boolean): Promise<void> {
    const connection = this.requireConnection();
    await connection.setDeafened(deafened);
    this.deafened = deafened;
  }
  startAudio(): Promise<void> {
    return this.requireConnection().startAudio();
  }
  publishAudio(track: MediaStreamTrack): Promise<VoicePublication> {
    return this.requireConnection().publishAudio(track);
  }
  disconnect(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.control.abort(new DOMException("Voice session stopped", "AbortError"));
    this.unbind();
    this.clearTracks();
    this.setState("disconnected");
    this.stopping = Promise.resolve().then(async () => {
      try {
        await this.current?.disconnect();
      } finally {
        await this.recovering;
        this.current = undefined;
      }
    });
    return this.stopping;
  }
  toJSON(): {
    guildId: string | null;
    channelId: string;
    connectionId: string | undefined;
    state: VoiceSessionEvents["state"];
    attempts: number;
  } {
    return {
      guildId: this.options.guildId,
      channelId: this.options.channelId,
      connectionId: this.current?.connectionId,
      state: this.status,
      attempts: this.attempts,
    };
  }
}
