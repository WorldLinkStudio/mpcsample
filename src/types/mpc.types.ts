import type { SampleId, SampleKit, SamplePad } from "../kits/kit.types";

// Re-export kit types for convenience so callers can import from one location.
export type { SampleId, SampleKit, SamplePad };

/**
 * Flat pad index in the MPC address space.
 *
 * Originally 0..15 (single bank).  Now spans 0..127 across 8 banks (A–H):
 *   bankIdx  = padIndex >> 4   (0=A … 7=H)
 *   localIdx = padIndex & 0xf  (0..15 within the bank)
 *
 * MIDI note 36 maps to globalPadIdx 0 (bank A, pad 1).
 */
export type PadIndex = number;

export type PadVisualState = "idle" | "armed" | "press";

/**
 * @deprecated Synth kits retired; the active kit is now identified by
 *   `SampleKit.id` (a plain string).  `KitName` is kept exported so
 *   legacy synth tests continue to compile during the transition period.
 *   Remove after WP-C deletes the synth engine files.
 */
export type KitName = "HIP-HOP" | "TRAP" | "HOUSE" | "TR-808" | "TR-909";

export type LedColor = "BLUE" | "GREEN" | "PURPLE" | "ORANGE" | "RED";
export type KnobName = "k1" | "k2" | "k3" | "mainVol" | "dataEnc";
export type MidiStatus =
  | "idle"
  | "searching"
  | "connected"
  | "no-devices"
  | "unsupported"
  | "denied";

export type PadDefinition = Readonly<{
  /** Absolute pad index 0..127 (globalPadIdx). */
  idx: PadIndex;
  /** 1..16 visual pad number within the active bank. */
  num: number;
  /** e.g. "TRIM SAMPLE" */
  label: string;
  /** QWERTY key e.g. "1", "z" */
  key: string;
}>;

export type LedPalette = Readonly<{
  ring: string; // armed glow color
  press: string; // press primary color
  press2: string; // press secondary (gradient end)
}>;

/**
 * Capability contract shared by AudioEngine (synth, legacy) and
 * SampleEngine (sample-based, new primary engine).
 *
 * All methods that existed before this refactor are KEPT for compatibility.
 * Sample-engine additions are additive below the separator comment.
 */
export interface AudioEngineLike {
  start(): Promise<void>;

  /**
   * Trigger pad at `idx` (now a GlobalPadIdx, 0..127) with the given
   * velocity.  `time` is an optional Tone.js transport time for
   * sub-millisecond scheduling.
   */
  trigger(idx: PadIndex, velocity: number, time?: number): void;

  /**
   * Release pad at `idx` (GlobalPadIdx, 0..127).
   * One-shot samples may ignore this; sustained voices should stop.
   */
  release(idx: PadIndex): void;

  /**
   * Switch the active synth kit (legacy path).
   * @deprecated Use `loadKit(SampleKit)` for sample-based kits.
   */
  setKit(kit: KitName): void;

  setKnob(name: KnobName, normalizedValue: number): void;
  setMasterDb(db: number): void;
  setBpm(bpm: number): void;

  /** Swap the voices assigned to two pads (legacy synth path). */
  swapPadVoice(idxA: PadIndex, idxB: PadIndex): void;

  getWaveform(): Float32Array | null;
  getSpectrum(): Float32Array | null;
  /** Returns the raw PCM channel-0 data for the loaded sample buffer on pad `idx`. Optional — only sample-based engines implement this. */
  getPadChannelData?(idx: PadIndex): Float32Array | null;
  isReady(): boolean;
  dispose(): void;

  // ── Sample-engine additions ───────────────────────────────────────────────

  /**
   * Load a `SampleKit` into the engine, replacing any previously loaded kit.
   * Resolves when the engine's internal state is updated.  Lazy-loading of
   * individual sample buffers may still be in flight after this resolves.
   */
  loadKit(kit: SampleKit): Promise<void>;

  /**
   * Assign (or clear) the sample for a specific pad.
   * `pad === null` silences the pad without removing it from the pad map.
   */
  setPadSample(idx: PadIndex, pad: SamplePad | null): void;

  /**
   * Update playback rate for a pad based on coarse (semitones) and fine
   * (cents) tune values.  Applied as
   * `playbackRate = 2^((coarseTune + fineTune/100) / 12)`.
   */
  setPadTune(idx: PadIndex, coarseTune: number, fineTune: number): void;

  /**
   * Update the linear gain coefficient for a pad.
   * `gainCoefficient === 1.0` is unity gain.
   */
  setPadGain(idx: PadIndex, gainCoefficient: number): void;

  /**
   * Set the trim region for a pad (sample frames, matching the `.xpj` unit).
   * Applied as `player.start(time, startSec, durationSec)` during playback.
   * Pass startFrames=0 and endFrames=totalFrames to restore full-length playback.
   */
  setPadTrim(idx: PadIndex, startFrames: number, endFrames: number): void;

  /**
   * Returns `true` while the sample buffer for `idx` is being fetched /
   * decoded.  Drives the per-pad loading indicator in the UI.
   */
  isPadLoading(idx: PadIndex): boolean;

  /**
   * Eagerly fetch and decode all sample URLs in the currently loaded kit.
   * Used before export to ensure every pad's bytes are available.
   * Reports progress via optional callback.
   */
  prefetchAll(onProgress?: (loaded: number, total: number) => void): Promise<void>;

  /**
   * Decode raw WAV bytes and register them under `sampleId` for immediate
   * playback.  Called after the user drag-drops a `.wav` file.
   */
  registerImportedSample(sampleId: SampleId, bytes: Uint8Array): Promise<void>;

  /**
   * Stop all currently playing pad samples immediately.
   * Optional so legacy engine stubs don't need to implement it.
   */
  stopAll?(): void;
}

/**
 * Capability contract for sending pad triggers back out over MIDI (e.g. to
 * make the physical MPC Sample's pads light up/sound when a pad is triggered
 * from this app's UI). Implemented by `MidiInput` (which owns the shared
 * `MIDIAccess` object and so has both directions).
 */
export interface MidiOutputLike {
  /** True if at least one MIDI output port is currently available. */
  hasOutput(): boolean;
  /** Send a Note On for `padIdx` (GlobalPadIdx, 0..127) at velocity 0..1. No-op if unrepresentable (padIdx > 91, note > 127) or no output is connected. */
  sendNoteOn(padIdx: PadIndex, velocity: number): void;
  /** Send a Note Off for `padIdx` (GlobalPadIdx, 0..127). */
  sendNoteOff(padIdx: PadIndex): void;
}

export type MidiEvent =
  | {
      type: "noteOn";
      /** GlobalPadIdx, 0..127 */
      padIdx: PadIndex;
      velocity: number;
    }
  | {
      type: "noteOff";
      /** GlobalPadIdx, 0..127 */
      padIdx: PadIndex;
    }
  | { type: "cc"; controller: number; value: number };
