import { create } from "zustand";
import { LED_COLORS } from "../data/ledColors";
import type { GlobalPadIdx, SampleId, SampleKit, SamplePad } from "../kits/kit.types";
import type {
  AudioEngineLike,
  KnobName,
  LedColor,
  MidiOutputLike,
  MidiStatus,
  PadIndex,
  PadVisualState,
} from "../types/mpc.types";

const SETTINGS_KEY = "mpc.settings";

type PersistedSettings = {
  dialogPosition: "center" | "top-right" | "bottom-right";
  autoOpenExportFolder: boolean;
  unmountAfterExport: boolean;
  visualizerMode: "waveform" | "fft" | "oscilloscope";
  hudVisible: boolean;
};

function readSettings(): PersistedSettings {
  const defaults: PersistedSettings = {
    dialogPosition: "center",
    autoOpenExportFolder: false,
    unmountAfterExport: false,
    visualizerMode: "waveform" as const,
    hudVisible: true,
  };
  if (typeof window === "undefined") return defaults;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    const validPositions = new Set(["center", "top-right", "bottom-right"]);
    return {
      dialogPosition:
        typeof parsed.dialogPosition === "string" && validPositions.has(parsed.dialogPosition)
          ? (parsed.dialogPosition as PersistedSettings["dialogPosition"])
          : "center",
      autoOpenExportFolder:
        typeof parsed.autoOpenExportFolder === "boolean" ? parsed.autoOpenExportFolder : false,
      unmountAfterExport:
        typeof parsed.unmountAfterExport === "boolean" ? parsed.unmountAfterExport : false,
      visualizerMode:
        typeof parsed.visualizerMode === "string" &&
        new Set(["waveform", "fft", "oscilloscope"]).has(parsed.visualizerMode)
          ? (parsed.visualizerMode as PersistedSettings["visualizerMode"])
          : "waveform",
      hudVisible: typeof parsed.hudVisible === "boolean" ? parsed.hudVisible : true,
    };
  } catch {
    return defaults;
  }
}

function writeSettings(s: PersistedSettings): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // localStorage may be unavailable — ignore
  }
}

const _settingsInit = readSettings();

const UI_TRANSFORM_KEY = "mpc.uiTransform";

type UiTransformSnapshot = {
  uiScale: number;
  uiOffset: { x: number; y: number };
};

function readUiTransform(): UiTransformSnapshot {
  const defaults: UiTransformSnapshot = { uiScale: 1, uiOffset: { x: 0, y: 0 } };
  if (typeof window === "undefined") return defaults;
  try {
    const raw = localStorage.getItem(UI_TRANSFORM_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<UiTransformSnapshot>;
    const scale = typeof parsed.uiScale === "number" ? parsed.uiScale : 1;
    const ox = typeof parsed.uiOffset?.x === "number" ? parsed.uiOffset.x : 0;
    const oy = typeof parsed.uiOffset?.y === "number" ? parsed.uiOffset.y : 0;
    return {
      uiScale: Math.max(0.5, Math.min(2, scale)),
      uiOffset: { x: ox, y: oy },
    };
  } catch {
    return defaults;
  }
}

function writeUiTransform(scale: number, offset: { x: number; y: number }): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(UI_TRANSFORM_KEY, JSON.stringify({ uiScale: scale, uiOffset: offset }));
  } catch {
    // localStorage may be unavailable (e.g. private browsing quota exceeded) — ignore
  }
}

const _uiTransformInit = readUiTransform();

type KnobState = {
  k1: number;
  k2: number;
  k3: number;
  mainVol: number;
  dataEnc: number;
};

type ExportProgress = {
  /** Number of sample buffers fully fetched so far. */
  loaded: number;
  /** Total sample buffers required for the export. */
  total: number;
};

type State = {
  isStarted: boolean;

  /**
   * Active kit identifier — matches `SampleKit.id` and the
   * `public/kits/<id>/` directory name.
   * Default: `"london-full"` (matches the first preset in the registry).
   */
  activeKitId: string;

  /**
   * Fully resolved kit metadata, populated by `loadKit()` at runtime.
   * `null` until the manifest has been fetched and parsed.
   */
  activeKit: SampleKit | null;

  /**
   * Per-pad sample assignments for all 128 pads.
   * `null` at a given index means the pad is unpopulated/silent.
   * Populated from `activeKit.pads` by `loadKit()`, then patched by
   * `setPadSample`, `movePadSample`, and `swapPad`.
   */
  padMap: Record<GlobalPadIdx, SamplePad | null>;

  /**
   * Raw bytes for user-imported WAV files, keyed by `SampleId`.
   * Retained for export (so we can include imported WAVs in the ZIP).
   */
  userSamples: Map<SampleId, Uint8Array>;

  ledColor: LedColor;

  /** Visual state for all 128 pads (bank-agnostic). */
  pads: Record<PadIndex, PadVisualState>;

  knobs: KnobState;

  /** Crossfader position 0..1 (drives BPM). */
  fader: number;

  /**
   * Currently visible bank index (0=A … 7=H).
   * The UI always shows the active bank's 16 pads.
   */
  bankIdx: number;

  /**
   * Highest bank index that contains at least one populated pad.
   * Default: 3 (A–D always visible).  Raised to 7 when a kit populates
   * bank E (idx 64+) or higher, revealing the E–H bank buttons.
   */
  maxBank: number;

  masterDb: number; // -40..6 dB
  bpm: number; // 60..180
  midiStatus: MidiStatus;
  midiDeviceName: string | null;
  sampleName: string;

  /** Per-pad fetch/decode-in-progress flags for the loading indicator. */
  loadingPads: Record<GlobalPadIdx, boolean>;

  /** `true` while an `.xpj` ZIP export is in progress. */
  isExporting: boolean;

  /**
   * Live export progress, or `null` when no export is running.
   * Updated by `prefetchAll`'s `onProgress` callback.
   */
  exportProgress: ExportProgress | null;

  engineRef: AudioEngineLike | null;

  /**
   * Registered MIDI output (implemented by `MidiInput`, which owns both
   * directions of the shared `MIDIAccess`). `null` when MIDI hasn't started
   * or the Web MIDI API is unavailable.
   */
  midiOutRef: MidiOutputLike | null;

  /** Zoom scale for the whole MPC device. Clamped to [0.5, 2]. Default 1. */
  uiScale: number;

  /** Pan offset for the MPC device stage. Default { x: 0, y: 0 }. */
  uiOffset: { x: number; y: number };

  /** Position of the export dialog overlay. Default "center". */
  dialogPosition: "center" | "top-right" | "bottom-right";

  /** When true, the export folder is opened in Finder after a successful desktop export. */
  autoOpenExportFolder: boolean;

  /** When true, the MPC SD volume is automatically ejected after a successful desktop export. */
  unmountAfterExport: boolean;

  /** Visualizer mode: static sample waveform (default), FFT spectrum, or oscilloscope. */
  visualizerMode: "waveform" | "fft" | "oscilloscope";

  /** Whether the bottom-left HUD (shortcuts/status/toolbar) is shown. Default true. */
  hudVisible: boolean;

  /** GlobalPadIdx of the most recently triggered pad; drives the waveform display. */
  lastTriggeredPad: PadIndex | null;
};

type Actions = {
  setStarted: (v: boolean) => void;
  setEngine: (engine: AudioEngineLike | null) => void;
  setMidiOut: (midiOut: MidiOutputLike | null) => void;

  /**
   * Stop all active audio immediately and reset all pad visual states.
   * Wired to the transport STOP button.
   */
  stopAll: () => void;

  /**
   * Trigger pad at `idx` (GlobalPadIdx, 0..127) with optional velocity.
   * Also sends a MIDI Note On to `midiOutRef` (if registered) so the
   * physical MPC's pad triggers too — unless `fromHardware` is true, which
   * `useMidiInput` sets for hardware-originated triggers to avoid echoing
   * the note straight back to the device that just sent it.
   */
  triggerPad: (idx: PadIndex, velocity?: number, time?: number, fromHardware?: boolean) => void;
  /** Schedule the visual release animation for `idx`. Also sends MIDI Note Off unless `fromHardware`. */
  releasePad: (idx: PadIndex, fromHardware?: boolean) => void;
  /** Visual-only press (audio already scheduled by PatternPlayer). */
  pressPad: (idx: PadIndex) => void;
  /** Visual-only release, mirroring `pressPad`. */
  unpressPad: (idx: PadIndex) => void;

  /**
   * Load a resolved `SampleKit` into the store.
   * Updates `activeKit`, `activeKitId`, `padMap`, and `maxBank`.
   */
  loadKit: (kit: SampleKit) => void;

  /** Set the active bank (0..7). Clamped to `maxBank`. */
  setBank: (n: number) => void;

  /**
   * Cycle to the next bank, wrapping at `maxBank + 1`.
   * Replaces the old 0..3 cycle.
   */
  cycleBank: () => void;

  /**
   * Update `activeKitId` without triggering a manifest fetch.
   * Use when you want to stage a kit switch before the manifest resolves.
   */
  setActiveKitId: (id: string) => void;

  /** Assign (or clear) the sample for a specific pad. */
  setPadSample: (idx: GlobalPadIdx, pad: SamplePad | null) => void;

  /**
   * Move the sample at `from` to `to`, leaving `from` empty.
   * Differs from `swapPad` which exchanges both slots.
   */
  movePadSample: (from: GlobalPadIdx, to: GlobalPadIdx) => void;

  /** Swap the samples at `from` and `to`. */
  swapPad: (from: GlobalPadIdx, to: GlobalPadIdx) => void;

  /** Update coarse/fine tune for a pad and forward to the engine. */
  setPadTune: (idx: GlobalPadIdx, coarseTune: number, fineTune: number) => void;

  /** Update linear gain for a pad and forward to the engine. */
  setPadGain: (idx: GlobalPadIdx, gainCoefficient: number) => void;

  /** Update trim start/end (in sample frames) for a pad and forward to the engine. */
  setPadTrim: (idx: GlobalPadIdx, startFrames: number, endFrames: number) => void;

  /**
   * Rename the exported kit name (writes to `activeKit.exportName`).
   * Creates an immutable clone of `activeKit` with the new name.
   */
  setKitName: (name: string) => void;

  /** Rename a pad's display label (writes to `padMap[idx].displayName`). */
  setPadName: (idx: GlobalPadIdx, name: string) => void;

  /** Mark a pad as loading (or not). */
  setPadLoading: (idx: GlobalPadIdx, loading: boolean) => void;

  /** Register raw WAV bytes for a user-imported sample. */
  registerUserSample: (id: SampleId, bytes: Uint8Array) => void;

  /** Toggle the global export-in-progress flag. */
  setExporting: (v: boolean) => void;

  /** Update (or clear) the export progress counter. */
  setExportProgress: (p: ExportProgress | null) => void;

  setLedColor: (c: LedColor) => void;
  setKnob: (name: KnobName, v: number) => void;
  setFader: (v: number) => void;
  setMasterDb: (db: number) => void;
  setBpm: (bpm: number) => void;
  setMidiStatus: (s: MidiStatus, deviceName?: string | null) => void;
  setSampleName: (s: string) => void;

  /**
   * Set the zoom scale, clamped to [0.5, 2] and rounded to 2 decimal places.
   * Persists to localStorage.
   */
  setUiScale: (scale: number) => void;

  /**
   * Adjust the current scale by `delta`, clamped to [0.5, 2].
   * Persists to localStorage.
   */
  zoomBy: (delta: number) => void;

  /**
   * Adjust the stage offset by `dx`/`dy`.
   * Persists to localStorage.
   */
  nudgeUiOffset: (dx: number, dy: number) => void;

  /**
   * Set the stage offset to an absolute position.
   * Persists to localStorage.
   */
  setUiOffset: (x: number, y: number) => void;

  /**
   * Reset scale to 1 and offset to (0, 0).
   * Persists to localStorage.
   */
  resetUiTransform: () => void;

  /** Set the export dialog position and persist to localStorage. */
  setDialogPosition: (pos: "center" | "top-right" | "bottom-right") => void;

  /** Set whether to auto-open the export folder after a successful export. */
  setAutoOpenExportFolder: (v: boolean) => void;

  /** Set whether to auto-eject the MPC SD volume after a successful desktop export. */
  setUnmountAfterExport: (v: boolean) => void;

  /** Set the visualizer mode and persist to localStorage. */
  setVisualizerMode: (mode: "waveform" | "fft" | "oscilloscope") => void;

  /** Show/hide the bottom-left HUD and persist to localStorage. */
  setHudVisible: (v: boolean) => void;
};

/** Build a 128-entry visual-state record initialised to "armed". */
function buildInitialPads(): Record<PadIndex, PadVisualState> {
  const pads: Record<PadIndex, PadVisualState> = {};
  for (let i = 0; i < 128; i++) {
    pads[i] = "armed";
  }
  return pads;
}

/** Build a 128-entry pad-map record initialised to null. */
function buildInitialPadMap(): Record<GlobalPadIdx, SamplePad | null> {
  const map: Record<GlobalPadIdx, SamplePad | null> = {};
  for (let i = 0; i < 128; i++) {
    map[i] = null;
  }
  return map;
}

/**
 * Compute `maxBank` from a populated pad map.
 * Returns the highest bank index (0..7) that has at least one non-null pad,
 * with a minimum of 3 so banks A–D are always visible.
 */
function computeMaxBank(padMap: Record<GlobalPadIdx, SamplePad | null>): number {
  let max = 3;
  for (let i = 127; i >= 64; i--) {
    if (padMap[i] !== null) {
      max = Math.max(max, i >> 4);
      break;
    }
  }
  return max;
}

// Module-level so it survives store re-creation in HMR but is reset on
// real page reload.  Bounded to 128 entries (one slot per pad), preventing
// setTimeout accumulation under MIDI / keyboard spam.

const releaseTimers = new Map<PadIndex, ReturnType<typeof setTimeout>>();
const RELEASE_DELAY_MS = 60;

/** Cancel any pending release timers (test cleanup, dispose). */
export function _cancelAllReleaseTimers(): void {
  releaseTimers.forEach((id) => {
    clearTimeout(id);
  });
  releaseTimers.clear();
}

export const useMPCStore = create<State & Actions>((set, get) => ({
  isStarted: false,
  activeKitId: "london-full",
  activeKit: null,
  padMap: buildInitialPadMap(),
  userSamples: new Map(),
  ledColor: "BLUE",
  pads: buildInitialPads(),
  knobs: { k1: 0.5, k2: 0.5, k3: 0.5, mainVol: 0.8, dataEnc: 0 },
  fader: 0.5,
  bankIdx: 0,
  maxBank: 3,
  masterDb: 0,
  bpm: 120,
  midiStatus: "idle",
  midiDeviceName: null,
  sampleName: "FULL LEVEL",
  loadingPads: {},
  isExporting: false,
  exportProgress: null,
  engineRef: null,
  midiOutRef: null,
  uiScale: _uiTransformInit.uiScale,
  uiOffset: _uiTransformInit.uiOffset,
  dialogPosition: _settingsInit.dialogPosition,
  autoOpenExportFolder: _settingsInit.autoOpenExportFolder,
  unmountAfterExport: _settingsInit.unmountAfterExport,
  visualizerMode: _settingsInit.visualizerMode,
  hudVisible: _settingsInit.hudVisible,
  lastTriggeredPad: null,

  setStarted: (v) => set({ isStarted: v }),

  setEngine: (engine) => set({ engineRef: engine }),

  setMidiOut: (midiOut) => set({ midiOutRef: midiOut }),

  stopAll: () => {
    _cancelAllReleaseTimers();
    get().engineRef?.stopAll?.();
    set({ pads: buildInitialPads() });
  },

  triggerPad: (idx, velocity = 0.9, time, fromHardware = false) => {
    // Cancel any pending release for this pad — prevents a stale timer from
    // flipping the new press back to 'armed' before the user releases.
    const existing = releaseTimers.get(idx);
    if (existing !== undefined) {
      clearTimeout(existing);
      releaseTimers.delete(idx);
    }
    const { engineRef, midiOutRef, pads } = get();
    set({ pads: { ...pads, [idx]: "press" }, lastTriggeredPad: idx });
    engineRef?.trigger(idx, velocity, time);
    if (!fromHardware) midiOutRef?.sendNoteOn(idx, velocity);
  },

  releasePad: (idx, fromHardware = false) => {
    // Replace any pending release timer to bound the queue size to 128.
    const existing = releaseTimers.get(idx);
    if (existing !== undefined) clearTimeout(existing);
    const id = setTimeout(() => {
      releaseTimers.delete(idx);
      set((state) => ({ pads: { ...state.pads, [idx]: "armed" } }));
    }, RELEASE_DELAY_MS);
    releaseTimers.set(idx, id);
    if (!fromHardware) get().midiOutRef?.sendNoteOff(idx);
  },

  pressPad: (idx) => {
    const existing = releaseTimers.get(idx);
    if (existing !== undefined) {
      clearTimeout(existing);
      releaseTimers.delete(idx);
    }
    set((state) => ({ pads: { ...state.pads, [idx]: "press" } }));
  },

  unpressPad: (idx) => {
    const existing = releaseTimers.get(idx);
    if (existing !== undefined) clearTimeout(existing);
    releaseTimers.delete(idx);
    set((state) => ({ pads: { ...state.pads, [idx]: "armed" } }));
  },

  loadKit: (kit) => {
    // Build a fresh padMap from the kit's pads array.
    const padMap = buildInitialPadMap();
    for (const pad of kit.pads) {
      padMap[pad.globalPadIdx] = pad;
    }
    const maxBank = computeMaxBank(padMap);
    const { bankIdx } = get();
    set({
      activeKit: kit,
      activeKitId: kit.id,
      padMap,
      maxBank,
      bankIdx,
    });
    // Engine.loadKit is forwarded via the activeKit subscription in
    // useAudioEngine (fires whenever activeKit reference changes), so we do NOT
    // call engineRef?.loadKit here to avoid a double-load.
  },

  setBank: (n) => {
    set({ bankIdx: Math.max(0, Math.min(n, 7)) });
  },

  cycleBank: () => {
    set((state) => ({
      bankIdx: (state.bankIdx + 1) % 8,
    }));
  },

  setActiveKitId: (id) => set({ activeKitId: id }),

  setPadSample: (idx, pad) => {
    const { padMap, engineRef } = get();
    set({ padMap: { ...padMap, [idx]: pad } });
    engineRef?.setPadSample(idx, pad);
  },

  movePadSample: (from, to) => {
    const { padMap, engineRef } = get();
    const movedPad = padMap[from] ?? null;
    // Update the globalPadIdx field on the moved pad so it reflects its new slot.
    const updatedPad = movedPad !== null ? { ...movedPad, globalPadIdx: to } : null;
    set({
      padMap: {
        ...padMap,
        [to]: updatedPad,
        [from]: null,
      },
    });
    engineRef?.setPadSample(from, null);
    engineRef?.setPadSample(to, updatedPad);
  },

  swapPad: (from, to) => {
    const { padMap, engineRef } = get();
    const padFrom = padMap[from] ?? null;
    const padTo = padMap[to] ?? null;
    // Update globalPadIdx on each pad to reflect their new positions.
    const updatedFrom = padTo !== null ? { ...padTo, globalPadIdx: from } : null;
    const updatedTo = padFrom !== null ? { ...padFrom, globalPadIdx: to } : null;
    set({
      padMap: {
        ...padMap,
        [from]: updatedFrom,
        [to]: updatedTo,
      },
    });
    engineRef?.swapPadVoice(from, to);
  },

  setPadTune: (idx, coarseTune, fineTune) => {
    const { padMap, engineRef } = get();
    const existing = padMap[idx];
    if (!existing) return;
    // Clamp: coarseTune -36..36 (integer), fineTune -100..100 (integer).
    const clampedCoarse = Math.max(-36, Math.min(36, Math.round(coarseTune)));
    const clampedFine = Math.max(-100, Math.min(100, Math.round(fineTune)));
    set({
      padMap: {
        ...padMap,
        [idx]: { ...existing, coarseTune: clampedCoarse, fineTune: clampedFine },
      },
    });
    engineRef?.setPadTune(idx, clampedCoarse, clampedFine);
  },

  setPadGain: (idx, gainCoefficient) => {
    const { padMap, engineRef } = get();
    const existing = padMap[idx];
    if (!existing) return;
    // Clamp: gain must be >= 0.
    const clampedGain = Math.max(0, gainCoefficient);
    set({
      padMap: {
        ...padMap,
        [idx]: { ...existing, gainCoefficient: clampedGain },
      },
    });
    engineRef?.setPadGain(idx, clampedGain);
  },

  setPadTrim: (idx, startFrames, endFrames) => {
    const { padMap, engineRef } = get();
    const existing = padMap[idx];
    if (!existing) return;
    const clampedStart = Math.max(0, Math.round(startFrames));
    const clampedEnd = Math.max(clampedStart + 1, Math.round(endFrames));
    set({
      padMap: {
        ...padMap,
        [idx]: { ...existing, sampleStart: clampedStart, sampleEnd: clampedEnd },
      },
    });
    engineRef?.setPadTrim(idx, clampedStart, clampedEnd);
  },

  setKitName: (name) => {
    const { activeKit } = get();
    if (!activeKit) return;
    set({ activeKit: { ...activeKit, exportName: name, displayName: name } });
  },

  setPadName: (idx, name) => {
    const { padMap } = get();
    const existing = padMap[idx];
    if (!existing) return;
    // Keep displayName (UI label) and sampleName (.xpj name) in sync so
    // renames are written faithfully into the exported project.
    set({
      padMap: {
        ...padMap,
        [idx]: { ...existing, displayName: name, sampleName: name },
      },
    });
  },

  setPadLoading: (idx, loading) => {
    const { loadingPads } = get();
    if (loading) {
      set({ loadingPads: { ...loadingPads, [idx]: true } });
    } else {
      const next = { ...loadingPads };
      delete next[idx];
      set({ loadingPads: next });
    }
  },

  registerUserSample: (id, bytes) => {
    const { userSamples } = get();
    const next = new Map(userSamples);
    next.set(id, bytes);
    set({ userSamples: next });
  },

  setExporting: (v) => set({ isExporting: v }),
  setExportProgress: (p) => set({ exportProgress: p }),

  setLedColor: (c) => {
    const palette = LED_COLORS[c];
    document.documentElement.style.setProperty("--led-blue", palette.ring);
    document.documentElement.style.setProperty("--pad-glow", palette.ring);
    set({ ledColor: c });
  },

  setKnob: (name, v) => {
    const { engineRef, knobs } = get();
    set({ knobs: { ...knobs, [name]: v } });
    engineRef?.setKnob(name, v);
  },

  setFader: (v) => {
    const bpm = Math.round(60 + v * 120);
    const { engineRef } = get();
    set({ fader: v, bpm });
    engineRef?.setBpm(bpm);
  },

  setMasterDb: (db) => {
    const { engineRef } = get();
    set({ masterDb: db });
    engineRef?.setMasterDb(db);
  },

  setBpm: (bpm) => {
    const { engineRef } = get();
    const clampedBpm = Math.max(60, Math.min(180, bpm));
    const fader = (clampedBpm - 60) / 120;
    set({ bpm: clampedBpm, fader });
    engineRef?.setBpm(clampedBpm);
  },

  setMidiStatus: (s, deviceName = null) => {
    set({ midiStatus: s, midiDeviceName: deviceName ?? null });
  },

  setSampleName: (s) => set({ sampleName: s }),

  setUiScale: (scale) => {
    const clamped = Math.round(Math.max(0.5, Math.min(2, scale)) * 100) / 100;
    const { uiOffset } = get();
    writeUiTransform(clamped, uiOffset);
    set({ uiScale: clamped });
  },

  zoomBy: (delta) => {
    const { uiScale, uiOffset } = get();
    const clamped = Math.round(Math.max(0.5, Math.min(2, uiScale + delta)) * 100) / 100;
    writeUiTransform(clamped, uiOffset);
    set({ uiScale: clamped });
  },

  nudgeUiOffset: (dx, dy) => {
    const { uiOffset, uiScale } = get();
    const next = { x: uiOffset.x + dx, y: uiOffset.y + dy };
    writeUiTransform(uiScale, next);
    set({ uiOffset: next });
  },

  setUiOffset: (x, y) => {
    const { uiScale } = get();
    const next = { x, y };
    writeUiTransform(uiScale, next);
    set({ uiOffset: next });
  },

  resetUiTransform: () => {
    writeUiTransform(1, { x: 0, y: 0 });
    set({ uiScale: 1, uiOffset: { x: 0, y: 0 } });
  },

  setDialogPosition: (pos) => {
    const { autoOpenExportFolder, unmountAfterExport, visualizerMode, hudVisible } = get();
    writeSettings({
      dialogPosition: pos,
      autoOpenExportFolder,
      unmountAfterExport,
      visualizerMode,
      hudVisible,
    });
    set({ dialogPosition: pos });
  },

  setAutoOpenExportFolder: (v) => {
    const { dialogPosition, unmountAfterExport, visualizerMode, hudVisible } = get();
    writeSettings({
      dialogPosition,
      autoOpenExportFolder: v,
      unmountAfterExport,
      visualizerMode,
      hudVisible,
    });
    set({ autoOpenExportFolder: v });
  },

  setUnmountAfterExport: (v) => {
    const { dialogPosition, autoOpenExportFolder, visualizerMode, hudVisible } = get();
    writeSettings({
      dialogPosition,
      autoOpenExportFolder,
      unmountAfterExport: v,
      visualizerMode,
      hudVisible,
    });
    set({ unmountAfterExport: v });
  },

  setVisualizerMode: (mode) => {
    const { dialogPosition, autoOpenExportFolder, unmountAfterExport, hudVisible } = get();
    writeSettings({
      dialogPosition,
      autoOpenExportFolder,
      unmountAfterExport,
      visualizerMode: mode,
      hudVisible,
    });
    set({ visualizerMode: mode });
  },

  setHudVisible: (v) => {
    const { dialogPosition, autoOpenExportFolder, unmountAfterExport, visualizerMode } = get();
    writeSettings({
      dialogPosition,
      autoOpenExportFolder,
      unmountAfterExport,
      visualizerMode,
      hudVisible: v,
    });
    set({ hudVisible: v });
  },
}));

/**
 * Build the kit to export by reading the live `padMap` (the source of truth
 * for all pad mutations) rather than the stale `activeKit.pads` snapshot.
 *
 * `activeKit.pads` is only set once by `loadKit` and is never updated when
 * pads are dropped, moved, swapped, or customised.  `padMap` reflects all of
 * those changes.  Using `padMap` means:
 *
 *   • Dropped WAV samples (url=null, bytes in userSamples) appear in the
 *     export even for new / blank projects.
 *   • Per-pad customisations (tune, gain, name, swap/move) are faithfully
 *     written into the .xpj.
 *
 * Returns `null` when no kit is loaded or no pads are populated.
 */
export function buildExportKit(
  activeKit: SampleKit | null,
  padMap: Record<GlobalPadIdx, SamplePad | null>,
): SampleKit | null {
  if (!activeKit) return null;
  const pads = (Object.values(padMap) as Array<SamplePad | null>)
    .filter((p): p is SamplePad => p !== null)
    .sort((a, b) => a.globalPadIdx - b.globalPadIdx);
  if (pads.length === 0) return null;
  return { ...activeKit, pads };
}
