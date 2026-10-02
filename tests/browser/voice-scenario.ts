import { TypedEmitter } from "../../src/events.js";
import {
  VoicePlayer,
  liveKitAdapter,
  type VoiceConnectionEvents,
} from "../../src/voice.js";

/** Uses real Web Audio, MediaStream tracks and decoding; the SFU boundary is injected. */
export async function runVoiceBrowserTests() {
  const analysis = new AudioContext();
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      analysis.resume(),
      new Promise<void>((_, reject) => {
        startupTimer = setTimeout(
          () =>
            reject(
              new Error(
                "AudioContext could not start; configure an audio output backend before running browser tests",
              ),
            ),
          3000,
        );
      }),
    ]);
  } catch (error) {
    await analysis.close();
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  const tracks: MediaStreamTrack[] = [];
  const clones: MediaStreamTrack[] = [];
  let published = 0,
    unpublished = 0,
    peak = 0;
  const nodes: AudioNode[] = [];
  const analyzers: AnalyserNode[] = [];
  const transport = await liveKitAdapter(() => ({
    async connect() {},
    async disconnect() {},
    localParticipant: {
      async setMicrophoneEnabled() {},
      async publishTrack(track: MediaStreamTrack) {
        clones.push(track);
        const source = analysis.createMediaStreamSource(
          new MediaStream([track]),
        );
        const analyzer = analysis.createAnalyser();
        analyzer.fftSize = 256;
        source.connect(analyzer);
        nodes.push(source, analyzer);
        analyzers.push(analyzer);
        return { trackSid: `track-${++published}` };
      },
      async unpublishTrack() {
        unpublished++;
      },
    },
  })).connect(
    {
      endpoint: "wss://injected",
      token: "synthetic",
      channel_id: "20",
      connection_id: "test",
    },
    { signal: new AbortController().signal },
  );
  const voice = Object.assign(new TypedEmitter<VoiceConnectionEvents>(), {
    async publishAudio(track: MediaStreamTrack) {
      tracks.push(track);
      return transport.publishAudio!(track);
    },
  });
  const contexts: AudioContext[] = [];
  const player = new VoicePlayer(voice, {
    createAudioContext: () => {
      const context = new AudioContext();
      contexts.push(context);
      return context;
    },
  });
  const timer = setInterval(() => {
    for (const analyzer of analyzers) {
      const data = new Float32Array(analyzer.fftSize);
      analyzer.getFloatTimeDomainData(data);
      for (const sample of data) peak = Math.max(peak, Math.abs(sample));
    }
  }, 10);
  try {
    // A PCM WAV exercises native decodeAudioData, not just buffer forwarding.
    const samples = 12000,
      sampleRate = 48000;
    const wav = new ArrayBuffer(44 + samples * 2),
      view = new DataView(wav);
    const write = (offset: number, value: string) =>
      [...value].forEach((char, i) =>
        view.setUint8(offset + i, char.charCodeAt(0)),
      );
    write(0, "RIFF");
    view.setUint32(4, wav.byteLength - 8, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++)
      view.setInt16(
        44 + i * 2,
        Math.sin((i * 2 * Math.PI * 440) / sampleRate) * 16000,
        true,
      );
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    let playbackTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([player.play(wav), player.play(url)]),
        new Promise((_, reject) => {
          playbackTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `Audio playback timed out: ${published}/${unpublished}, contexts=${contexts.map((context) => `${context.state}:${context.currentTime}`).join(",")}`,
                ),
              ),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(playbackTimer);
      URL.revokeObjectURL(url);
    }
    if (published !== 2 || unpublished !== 2 || peak < 0.05)
      throw new Error(
        `Audio pipeline failed: ${published}/${unpublished}, peak=${peak}`,
      );
    if (
      tracks.some((track) => track.readyState !== "ended") ||
      clones.some((track) => track.readyState !== "ended")
    )
      throw new Error("Playback left tracks alive");
    if (contexts.some((context) => context.state !== "closed"))
      throw new Error("Playback left audio contexts alive");
    return {
      passed: true,
      checks: [
        "native-audio-decode",
        "native-audio-url",
        "native-audio-publish",
        "native-audio-samples",
        "native-audio-queue",
        "native-audio-disposal",
      ],
    };
  } finally {
    clearInterval(timer);
    for (const node of nodes) node.disconnect();
    await player.disconnect();
    await transport.disconnect();
    await analysis.close();
  }
}
