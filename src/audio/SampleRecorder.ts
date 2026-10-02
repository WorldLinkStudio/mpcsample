/**
 * SampleRecorder.ts — System/app-audio capture engine for the sample recorder.
 *
 * Captures audio via `navigator.mediaDevices.getDisplayMedia()`. macOS's
 * native system picker (`useSystemPicker`) was tried first but never
 * actually returns an audio track in this Electron version — a confirmed,
 * still-open Electron bug (electron/electron#44685). The working fix (see
 * `electron/main.ts`'s `handleDisplayMediaRequest` and the
 * `MacLoopbackAudioForScreenShare`/`MacSckSystemAudioLoopbackOverride`
 * feature flags enabled there) grants real macOS system-audio loopback
 * directly, with no picker UI at all — no virtual audio cable involved, but
 * also no per-window selection: it captures whatever's currently audible
 * through the Mac's output, system-wide.
 *
 * `video: true` is requested (and every video track immediately stopped) —
 * `getDisplayMedia` audio-only requests are unreliable across engines; video
 * is never rendered or retained.
 *
 * Recording uses its own dedicated native `AudioContext` — NOT
 * `Tone.getContext().rawContext`: that's actually Tone's own
 * `standardized-audio-context` wrapper (confirmed live: its constructor is
 * named "AudioContext" but `instanceof AudioContext` is false, and it simply
 * doesn't implement `createScriptProcessor`, deliberately, since that API is
 * deprecated). The wrapper's `decodeAudioData` does work — used post-recording
 * for waveform preview in `SampleRecorder.tsx`, matching `SampleEngine.ts`'s
 * existing convention there — but building a `ScriptProcessorNode` capture
 * graph needs a real native context, hence a fresh one here.
 *
 * The processor is connected through a zero-gain node to `destination` —
 * required to keep a `ScriptProcessorNode` firing in some engines, but going
 * straight to `destination` would audibly double whatever's already playing
 * since the captured stream *is* that already-playing system audio.
 *
 * `ScriptProcessorNode` (deprecated but still functional) is used over
 * `AudioWorkletNode` deliberately: recordings here are short (seconds), and
 * a worklet would need its own bundled module file for no real benefit at
 * this scale.
 */

export type RecordingResult = {
  /** One Float32Array per channel, all the same length, samples in [-1, 1]. */
  samples: Float32Array[];
  sampleRate: number;
  durationSec: number;
};

const PROCESSOR_BUFFER_SIZE = 4096;
const MAX_CHANNELS = 2;

export class SampleRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private muteGain: GainNode | null = null;
  private chunks: Float32Array[][] = [];
  private numChannels = 2;
  private recording = false;
  private onLevel: ((rms: number) => void) | undefined;

  get isRecording(): boolean {
    return this.recording;
  }

  /**
   * Start capturing macOS system-audio loopback (whatever's currently
   * audible through the Mac's output) and accumulating it. `onLevel` is
   * called on every processing block with the current RMS level (0..~1)
   * for a live meter.
   *
   * @throws {Error} If capture is denied (e.g. Screen & System Audio
   *   Recording permission not granted), or nothing is actually playing.
   */
  async start(onLevel?: (rms: number) => void): Promise<void> {
    if (this.recording) return;
    this.onLevel = onLevel;

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      // Chromium's `audio: true` shorthand defaults to
      // echoCancellation/noiseSuppression/autoGainControl all `true` and
      // channelCount to mono — voice-call DSP tuned for mic input, not
      // system/app audio loopback. Applied to music/video it badly mangles
      // quality (confirmed live via `track.getSettings()`: all three were on
      // and channelCount was 1 despite stereo being available). Disable the
      // voice processing and request real stereo explicitly.
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    for (const track of displayStream.getVideoTracks()) track.stop();

    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      for (const track of displayStream.getTracks()) track.stop();
      throw new Error(
        "No audio track was captured — make sure something is actually playing through your Mac's audio output, then try again.",
      );
    }
    this.stream = new MediaStream(audioTracks);

    const ctx = new AudioContext();
    this.ctx = ctx;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.numChannels = Math.max(1, Math.min(MAX_CHANNELS, this.source.channelCount || 2));
    this.chunks = Array.from({ length: this.numChannels }, () => []);

    this.processor = ctx.createScriptProcessor(
      PROCESSOR_BUFFER_SIZE,
      this.numChannels,
      this.numChannels,
    );
    this.processor.onaudioprocess = (e) => {
      if (!this.recording) return;
      let sumSquares = 0;
      let sampleCount = 0;
      for (let ch = 0; ch < this.numChannels; ch++) {
        const data = e.inputBuffer.getChannelData(ch);
        this.chunks[ch].push(new Float32Array(data));
        for (let i = 0; i < data.length; i++) {
          sumSquares += data[i] * data[i];
          sampleCount++;
        }
      }
      this.onLevel?.(sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0);
    };

    this.muteGain = ctx.createGain();
    this.muteGain.gain.value = 0;

    this.source.connect(this.processor);
    this.processor.connect(this.muteGain);
    this.muteGain.connect(ctx.destination);

    this.recording = true;
  }

  /** Stop recording, tear down the capture graph, and return the accumulated audio. */
  stop(): RecordingResult {
    if (!this.recording) {
      throw new Error("SampleRecorder.stop() called while not recording.");
    }
    this.recording = false;

    const sampleRate = this.ctx?.sampleRate ?? 44100;

    const samples = this.chunks.map((chunkList) => {
      const total = chunkList.reduce((sum, c) => sum + c.length, 0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const c of chunkList) {
        merged.set(c, offset);
        offset += c.length;
      }
      return merged;
    });
    const durationSec = samples[0] ? samples[0].length / sampleRate : 0;

    this.teardown();
    return { samples, sampleRate, durationSec };
  }

  /** Abort an in-progress recording without returning a result (e.g. the panel was closed mid-recording). */
  cancel(): void {
    if (!this.recording) return;
    this.recording = false;
    this.teardown();
  }

  private teardown(): void {
    this.source?.disconnect();
    this.processor?.disconnect();
    this.muteGain?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.source = null;
    this.processor = null;
    this.muteGain = null;
    this.stream = null;
    this.chunks = [];
  }
}
