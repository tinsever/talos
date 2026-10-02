import { TypedEmitter } from "./events.js";
import type {
  VoiceAdapter,
  VoiceAudioTrack,
  VoicePublication,
  VoiceTransport,
  VoiceTransportEvents,
} from "./voice.js";

type RoomEvent =
  | "trackSubscribed"
  | "trackUnsubscribed"
  | "activeSpeakersChanged"
  | "reconnecting"
  | "signalReconnecting"
  | "reconnected"
  | "disconnected"
  | "mediaDevicesError"
  | "encryptionError"
  | "trackSubscriptionFailed";
interface RemoteTrack {
  kind: string;
  sid?: string | undefined;
  mediaStreamTrack: MediaStreamTrack;
  attach(element?: HTMLMediaElement): HTMLMediaElement;
  detach(element?: HTMLMediaElement): HTMLMediaElement[];
}
interface Participant {
  identity: string;
  audioTrackPublications?: ReadonlyMap<
    string,
    { track?: RemoteTrack | undefined }
  >;
}
/** Structural subset of livekit-client's Room; media dependencies stay optional. */
export interface LiveKitRoom {
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void> | void;
  localParticipant: {
    setMicrophoneEnabled(enabled: boolean): Promise<unknown>;
    // LiveKit's source is a string enum. Keep its options at this library boundary.
    publishTrack?(
      track: MediaStreamTrack,
      options?: any,
    ): Promise<{ trackSid: string }>;
    unpublishTrack?(
      track: MediaStreamTrack,
      stopOnUnpublish?: boolean,
    ): Promise<unknown>;
  };
  remoteParticipants?: ReadonlyMap<string, Participant>;
  on?(event: RoomEvent, listener: (...args: any[]) => void): unknown;
  off?(event: RoomEvent, listener: (...args: any[]) => void): unknown;
  startAudio?(): Promise<void>;
  setE2EEEnabled?(enabled: boolean): Promise<void>;
  readonly isE2EEEnabled?: boolean;
}
export interface LiveKitEncryption {
  /** A fresh Room constructed with this key provider and an E2EE worker. */
  room: LiveKitRoom;
  keyProvider: { setKey(key: string): Promise<void> };
  /** Release the worker and application-owned encryption resources. */
  dispose(): Promise<void> | void;
}
export interface LiveKitAdapterOptions {
  /** A new encrypted room/provider/worker per attempt. Never reuse rooms or keys. */
  encryption?: () => LiveKitEncryption;
  /** Automatically attach remote audio here. Omit to consume tracks yourself. */
  audioOutput?: HTMLElement;
}

class LiveKitTransport
  extends TypedEmitter<VoiceTransportEvents>
  implements VoiceTransport
{
  private readonly tracks = new Map<RemoteTrack, VoiceAudioTrack>();
  private readonly elements = new Map<RemoteTrack, HTMLMediaElement>();
  private readonly enabled = new Map<RemoteTrack, boolean>();
  private readonly lifecycleListeners: (() => void)[] = [];
  private readonly publications = new Set<VoicePublication>();
  private closing: Promise<void> | undefined;
  private deafened = false;
  state: VoiceTransportEvents["state"] = "connected";
  constructor(
    private readonly room: LiveKitRoom,
    private readonly options: LiveKitAdapterOptions,
    private readonly dispose: () => Promise<void> | void,
  ) {
    super();
    const listen = (event: RoomEvent, listener: (...args: any[]) => void) => {
      if (!room.on || !room.off) return;
      room.on(event, listener);
      this.lifecycleListeners.push(() => {
        room.off!(event, listener);
      });
    };
    listen(
      "trackSubscribed",
      (
        track: RemoteTrack,
        publication: { trackSid: string },
        participant: Participant,
      ) => {
        try {
          this.addTrack(track, publication.trackSid, participant.identity);
        } catch (error) {
          this.emit("error", error);
        }
      },
    );
    listen("trackUnsubscribed", (track: RemoteTrack) => {
      try {
        this.removeTrack(track);
      } catch (error) {
        this.emit("error", error);
      }
    });
    listen("activeSpeakersChanged", (speakers: Participant[]) =>
      this.emit(
        "speakers",
        speakers.map((speaker) => speaker.identity),
      ),
    );
    for (const event of ["reconnecting", "signalReconnecting"] as const)
      listen(event, () => this.setState("reconnecting"));
    listen("reconnected", () => this.setState("connected"));
    listen("disconnected", () => this.setState("disconnected"));
    listen("mediaDevicesError", (error: unknown) => this.emit("error", error));
    listen("encryptionError", (error: unknown) => this.emit("error", error));
    listen("trackSubscriptionFailed", (id: string) =>
      this.emit("error", new Error(`Audio subscription failed: ${id}`)),
    );
  }
  collectTracks(): void {
    for (const participant of this.room.remoteParticipants?.values() ?? [])
      for (const [id, publication] of participant.audioTrackPublications ?? [])
        if (publication.track)
          this.addTrack(publication.track, id, participant.identity);
  }
  get audioTracks(): readonly VoiceAudioTrack[] {
    return [...this.tracks.values()];
  }
  isDisconnected(): boolean {
    return this.state === "disconnected";
  }
  private setState(state: VoiceTransportEvents["state"]): void {
    if (this.closing || this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }
  private addTrack(
    track: RemoteTrack,
    id: string,
    participantId: string,
  ): void {
    if (this.closing || track.kind !== "audio" || this.tracks.has(track))
      return;
    const audio: VoiceAudioTrack = {
      id,
      participantId,
      mediaStreamTrack: track.mediaStreamTrack,
      attach: (element) => track.attach(element),
      detach: (element) => track.detach(element),
    };
    this.tracks.set(track, audio);
    if (this.deafened) {
      this.enabled.set(track, track.mediaStreamTrack.enabled);
      track.mediaStreamTrack.enabled = false;
    }
    if (this.options.audioOutput) {
      const element = track.attach();
      this.elements.set(track, element);
      this.options.audioOutput.appendChild(element);
    }
    this.emit("audioTrack", audio);
  }
  private removeTrack(track: RemoteTrack): void {
    const audio = this.tracks.get(track);
    if (!audio) return;
    this.tracks.delete(track);
    const enabled = this.enabled.get(track);
    if (enabled !== undefined) track.mediaStreamTrack.enabled = enabled;
    this.enabled.delete(track);
    const element = this.elements.get(track);
    this.elements.delete(track);
    const errors: unknown[] = [];
    if (element) {
      try {
        track.detach(element);
      } catch (error) {
        errors.push(error);
      }
      try {
        element.remove();
      } catch (error) {
        errors.push(error);
      }
    }
    this.emit("audioTrackRemoved", audio);
    if (errors.length)
      throw new AggregateError(errors, "Audio output cleanup failed");
  }
  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    if (this.closing) throw new Error("Voice is disconnected");
    await this.room.localParticipant.setMicrophoneEnabled(enabled);
  }
  async setDeafened(deafened: boolean): Promise<void> {
    if (this.closing) throw new Error("Voice is disconnected");
    if (deafened === this.deafened) return;
    this.deafened = deafened;
    for (const track of this.tracks.keys()) {
      if (deafened) {
        this.enabled.set(track, track.mediaStreamTrack.enabled);
        track.mediaStreamTrack.enabled = false;
      } else {
        track.mediaStreamTrack.enabled = this.enabled.get(track) ?? true;
        this.enabled.delete(track);
      }
    }
  }
  async startAudio(): Promise<void> {
    if (this.closing) throw new Error("Voice is disconnected");
    if (!this.room.startAudio)
      throw new Error("Room cannot start audio playback");
    await this.room.startAudio();
  }
  async publishAudio(track: MediaStreamTrack): Promise<VoicePublication> {
    if (this.closing) throw new Error("Voice is disconnected");
    if (track.kind !== "audio") throw new Error("Expected an audio track");
    const local = this.room.localParticipant;
    if (!local.publishTrack || !local.unpublishTrack)
      throw new Error("Room cannot publish audio");
    const ownedTrack = track.clone();
    let published: { trackSid: string };
    try {
      published = await local.publishTrack(ownedTrack, {
        source: "microphone",
      });
    } catch (error) {
      ownedTrack.stop();
      throw error;
    }
    let stopping: Promise<void> | undefined;
    const publication: VoicePublication = {
      id: published.trackSid,
      stop: () => {
        stopping ??= Promise.resolve().then(async () => {
          try {
            await local.unpublishTrack!(ownedTrack, false);
          } finally {
            ownedTrack.stop();
            this.publications.delete(publication);
          }
        });
        return stopping;
      },
    };
    if (this.closing) {
      await publication.stop();
      throw new Error("Voice is disconnected");
    }
    this.publications.add(publication);
    return publication;
  }
  disconnect(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "disconnected";
    for (const off of this.lifecycleListeners.splice(0)) off();
    this.closing = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      for (const track of [...this.tracks.keys()]) {
        try {
          this.removeTrack(track);
        } catch (error) {
          errors.push(error);
        }
      }
      let roomCleanup: Promise<void>;
      try {
        roomCleanup = Promise.resolve(this.room.disconnect());
      } catch (error) {
        roomCleanup = Promise.reject(error);
      }
      const results = await Promise.allSettled([
        roomCleanup,
        ...[...this.publications].map((publication) => publication.stop()),
      ]);
      for (const result of results)
        if (result.status === "rejected") errors.push(result.reason);
      try {
        await this.dispose();
      } catch (error) {
        errors.push(error);
      }
      this.removeAllListeners();
      if (errors.length)
        throw new AggregateError(errors, "Voice media cleanup failed");
    });
    return this.closing;
  }
}

/** LiveKit audio publishing, receiving, output, and optional shared-key E2EE. */
export function liveKitAdapter(
  createRoom: () => LiveKitRoom,
  options: LiveKitAdapterOptions = {},
): VoiceAdapter {
  return {
    supportsE2EE: options.encryption !== undefined,
    async connect(grant, { signal, selfMute, selfDeaf }) {
      if (grant.e2ee_key !== undefined && !options.encryption)
        throw new Error("This voice adapter does not support required E2EE");
      // Validate before allocation. An empty key must never fall back to plaintext.
      if (grant.e2ee_key === "") throw new Error("The voice E2EE key is empty");
      const encryption =
        grant.e2ee_key !== undefined ? options.encryption!() : undefined;
      const room = encryption?.room ?? createRoom();
      let transport: LiveKitTransport | undefined;
      let cleanup: Promise<void> | undefined;
      let disposed = false;
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        await encryption?.dispose();
      };
      const disconnect = () => {
        cleanup ??= transport
          ? transport.disconnect()
          : Promise.resolve().then(async () => {
              try {
                await room.disconnect();
              } finally {
                await dispose();
              }
            });
        return cleanup;
      };
      const abort = () => {
        void disconnect().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        if (encryption) {
          if (!room.setE2EEEnabled)
            throw new Error("Room cannot enable required E2EE");
          await encryption.keyProvider.setKey(grant.e2ee_key!);
          signal.throwIfAborted();
          await room.setE2EEEnabled(true);
          signal.throwIfAborted();
          if (room.isE2EEEnabled !== true)
            throw new Error("Room did not enable required E2EE");
        }
        transport = new LiveKitTransport(room, options, dispose);
        if (selfDeaf !== undefined) await transport.setDeafened(selfDeaf);
        signal.throwIfAborted();
        await room.connect(grant.endpoint, grant.token);
        // An ignored cancellation may have allowed the room to connect again.
        if (signal.aborted) {
          await Promise.resolve()
            .then(() => room.disconnect())
            .catch(() => {});
          signal.throwIfAborted();
        }
        signal.throwIfAborted();
        if (transport.isDisconnected())
          throw new Error("Media disconnected during voice join");
        transport.collectTracks();
        signal.throwIfAborted();
        if (selfMute !== undefined)
          await transport.setMicrophoneEnabled(!selfMute);
        if (signal.aborted) {
          // A delayed microphone operation can allocate media after abort cleanup.
          await Promise.resolve()
            .then(() => room.disconnect())
            .catch(() => {});
        }
        signal.throwIfAborted();
        if (transport.isDisconnected())
          throw new Error("Media disconnected during voice join");
        return transport;
      } catch (error) {
        await disconnect().catch(() => {});
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
