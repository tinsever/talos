import { TypedEmitter } from "./events.js";
import type { VoicePublication, VoiceTransportEvents } from "./voice.js";
import { abortable, abortReason } from "./utils.js";

export type VoiceAudioSource = string | URL | Blob | ArrayBuffer | AudioBuffer;
export interface VoicePlayerOptions {
  /** A fresh context per item. Defaults to the browser's AudioContext. */
  createAudioContext?: () => AudioContext;
  fetch?: typeof globalThis.fetch;
}
interface PlayerEvents {
  state: "idle" | "playing" | "closed";
  error: unknown;
}
interface PlayOptions {
  signal?: AbortSignal;
}
interface AudioConnection {
  publishAudio(track: MediaStreamTrack): Promise<VoicePublication>;
  on(
    event: "state",
    listener: (state: VoiceTransportEvents["state"]) => unknown,
  ): () => void;
  on(event: "closed", listener: (reason: unknown) => unknown): () => void;
}
/** FIFO browser file/buffer player. Decodes with Web Audio and publishes an audio track. */
export class VoicePlayer extends TypedEmitter<PlayerEvents> {
  private readonly control = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private readonly off: (() => void)[];
  private closed = false;
  private status: PlayerEvents["state"] = "idle";
  constructor(
    private readonly voice: AudioConnection,
    private readonly options: VoicePlayerOptions = {},
  ) {
    super();
    this.off = [
      voice.on("closed", () => {
        void this.disconnect();
      }),
    ];
  }
  get state(): PlayerEvents["state"] {
    return this.status;
  }
  private setState(state: PlayerEvents["state"]): void {
    if (state !== this.status) {
      this.status = state;
      this.emit("state", state);
    }
  }
  /** Resolves after playback and disposal; rejects on cancellation or media failure. */
  play(source: VoiceAudioSource, options: PlayOptions = {}): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Voice player is closed"));
    if (options.signal?.aborted)
      return Promise.reject(abortReason(options.signal));
    const control = new AbortController();
    const stop = () => control.abort(abortReason(this.control.signal));
    const cancel = () => control.abort(abortReason(options.signal!));
    this.control.signal.addEventListener("abort", stop, { once: true });
    options.signal?.addEventListener("abort", cancel, { once: true });
    const task = this.tail
      .then(() => {
        control.signal.throwIfAborted();
        return this.perform(source, control.signal);
      })
      .finally(() => {
        this.control.signal.removeEventListener("abort", stop);
        options.signal?.removeEventListener("abort", cancel);
      });
    this.tail = task.catch((error) => {
      if (!control.signal.aborted) this.emit("error", error);
    });
    // A queued cancellation rejects immediately, while the queue retains its position.
    return abortable(task, control.signal);
  }
  private async perform(
    source: VoiceAudioSource,
    signal: AbortSignal,
  ): Promise<void> {
    const context = this.options.createAudioContext?.() ?? new AudioContext();
    let node: AudioBufferSourceNode | undefined;
    let destination: MediaStreamAudioDestinationNode | undefined;
    let publication: VoicePublication | undefined;
    const cleanups: (() => void)[] = [];
    let failed = false;
    try {
      await abortable(context.resume(), signal);
      let buffer: AudioBuffer;
      if (typeof source === "string" || source instanceof URL) {
        const response = await abortable(
          (this.options.fetch ?? globalThis.fetch)(source, { signal }),
          signal,
        );
        if (!response.ok)
          throw new Error(`Audio download failed (${response.status})`);
        buffer = await abortable(
          context.decodeAudioData(
            await abortable(response.arrayBuffer(), signal),
          ),
          signal,
        );
      } else if (source instanceof ArrayBuffer) {
        buffer = await abortable(
          context.decodeAudioData(source.slice(0)),
          signal,
        );
      } else if (source instanceof Blob) {
        buffer = await abortable(
          context.decodeAudioData(
            await abortable(source.arrayBuffer(), signal),
          ),
          signal,
        );
      } else buffer = source;
      signal.throwIfAborted();
      node = context.createBufferSource();
      node.buffer = buffer;
      destination = context.createMediaStreamDestination();
      node.connect(destination);
      const track = destination.stream.getAudioTracks()[0];
      if (!track)
        throw new Error("Audio context did not produce an audio track");
      const publishing = this.voice.publishAudio(track);
      try {
        publication = await abortable(publishing, signal);
      } catch (error) {
        void publishing
          .then(
            (late) => late.stop(),
            () => {},
          )
          .catch((cleanupError) => this.emit("error", cleanupError));
        throw error;
      }
      signal.throwIfAborted();
      const ended = new Promise<void>((resolve, reject) => {
        const done = () => resolve();
        node!.addEventListener("ended", done, { once: true });
        cleanups.push(() => node!.removeEventListener("ended", done));
        cleanups.push(
          this.voice.on("state", (state) => {
            if (state !== "connected")
              reject(new Error("Voice playback interrupted"));
          }),
        );
      });
      node.start();
      this.setState("playing");
      await abortable(ended, signal);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      for (const cleanup of cleanups) cleanup();
      try {
        node?.stop();
      } catch {}
      const errors: unknown[] = [];
      try {
        node?.disconnect();
      } catch (error) {
        errors.push(error);
      }
      try {
        destination?.disconnect();
      } catch (error) {
        errors.push(error);
      }
      for (const track of destination?.stream.getTracks() ?? [])
        try {
          track.stop();
        } catch (error) {
          errors.push(error);
        }
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => publication?.stop()),
        Promise.resolve().then(() => context.close()),
      ]);
      this.setState(this.closed ? "closed" : "idle");
      for (const result of cleanup)
        if (result.status === "rejected") errors.push(result.reason);
      if (errors.length) {
        if (!failed)
          throw new AggregateError(errors, "Voice playback cleanup failed");
        for (const error of errors) this.emit("error", error);
      }
    }
  }
  /** Cancel the active item and all queued items, then wait for cleanup. */
  disconnect(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.control.abort(
        new DOMException("Voice player stopped", "AbortError"),
      );
      for (const off of this.off) off();
      this.setState("closed");
    }
    return this.tail;
  }
}
