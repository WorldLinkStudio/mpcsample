/**
 * sequencerStore.ts — Dedicated Zustand store for the step sequencer.
 *
 * Kept separate from `useMPCStore` deliberately (mirrors `library/libraryStore.ts`):
 * this is pattern-editing state, not core pad/kit state.
 */

import { create } from "zustand";
import type { PadIndex } from "../types/mpc.types";
import {
  createEmptyPattern,
  getPadSteps,
  MAX_BARS,
  MIN_BARS,
  type Pattern,
  resizeSteps,
  type StepResolution,
  totalSteps,
} from "./sequencer.types";

const PATTERN_KEY = "mpc.sequencerPattern";
const VALID_RESOLUTIONS: StepResolution[] = ["8n", "16n", "32n"];

/** Read the persisted pattern from localStorage. Falls back to an empty pattern on any issue. */
function readPersistedPattern(): Pattern {
  if (typeof window === "undefined") return createEmptyPattern();
  try {
    const raw = localStorage.getItem(PATTERN_KEY);
    if (!raw) return createEmptyPattern();
    const parsed = JSON.parse(raw) as Partial<Pattern>;
    if (typeof parsed.bars !== "number" || typeof parsed.steps !== "object" || !parsed.steps) {
      return createEmptyPattern();
    }
    const bars = Math.max(MIN_BARS, Math.min(MAX_BARS, Math.round(parsed.bars)));
    const resolution = VALID_RESOLUTIONS.includes(parsed.resolution as StepResolution)
      ? (parsed.resolution as StepResolution)
      : "16n";
    return { bars, resolution, steps: parsed.steps };
  } catch {
    return createEmptyPattern();
  }
}

/** Persist the current pattern to localStorage. Silently no-ops on any issue (e.g. quota). */
function writePersistedPattern(pattern: Pattern): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PATTERN_KEY, JSON.stringify(pattern));
  } catch {
    // localStorage may be unavailable/full — ignore, matches store.ts's convention.
  }
}

type SequencerState = {
  pattern: Pattern;
  isPlaying: boolean;
  /** Currently-playing step index, or -1 when stopped. */
  currentStep: number;
};

type SequencerActions = {
  toggleStep: (padIdx: PadIndex, stepIndex: number) => void;
  setStepVelocity: (padIdx: PadIndex, stepIndex: number, velocity: number) => void;
  setBars: (bars: number) => void;
  setResolution: (resolution: StepResolution) => void;
  clearPattern: () => void;
  setIsPlaying: (playing: boolean) => void;
  setCurrentStep: (step: number) => void;
};

/** Resize every pad's step array to match the pattern's current bars/resolution. */
function resizeAllPads(pattern: Pattern): Record<PadIndex, ReturnType<typeof resizeSteps>> {
  const newLength = totalSteps(pattern.bars, pattern.resolution);
  const next: Pattern["steps"] = {};
  for (const [padIdx, steps] of Object.entries(pattern.steps)) {
    next[Number(padIdx)] = resizeSteps(steps, newLength);
  }
  return next;
}

export const useSequencerStore = create<SequencerState & SequencerActions>((set, get) => ({
  pattern: readPersistedPattern(),
  isPlaying: false,
  currentStep: -1,

  toggleStep: (padIdx, stepIndex) =>
    set((state) => {
      const steps = getPadSteps(state.pattern, padIdx);
      const nextSteps = steps.slice();
      const current = nextSteps[stepIndex];
      if (!current) return state;
      nextSteps[stepIndex] = { ...current, active: !current.active };
      return {
        pattern: {
          ...state.pattern,
          steps: { ...state.pattern.steps, [padIdx]: nextSteps },
        },
      };
    }),

  setStepVelocity: (padIdx, stepIndex, velocity) =>
    set((state) => {
      const steps = getPadSteps(state.pattern, padIdx);
      const current = steps[stepIndex];
      if (!current) return state;
      const clamped = Math.max(0, Math.min(1, velocity));
      const nextSteps = steps.slice();
      nextSteps[stepIndex] = { ...current, velocity: clamped };
      return {
        pattern: {
          ...state.pattern,
          steps: { ...state.pattern.steps, [padIdx]: nextSteps },
        },
      };
    }),

  setBars: (bars) =>
    set((state) => {
      const clamped = Math.max(MIN_BARS, Math.min(MAX_BARS, Math.round(bars)));
      const pattern: Pattern = { ...state.pattern, bars: clamped };
      return { pattern: { ...pattern, steps: resizeAllPads(pattern) } };
    }),

  setResolution: (resolution) =>
    set((state) => {
      const pattern: Pattern = { ...state.pattern, resolution };
      return { pattern: { ...pattern, steps: resizeAllPads(pattern) } };
    }),

  clearPattern: () =>
    set({ pattern: createEmptyPattern(get().pattern.bars, get().pattern.resolution) }),

  setIsPlaying: (playing) => set({ isPlaying: playing, currentStep: playing ? 0 : -1 }),

  setCurrentStep: (step) => set({ currentStep: step }),
}));

// Persist the pattern (not isPlaying/currentStep — transient) whenever it changes,
// so the programmed sequence survives a reload instead of only living in memory.
useSequencerStore.subscribe((state, prevState) => {
  if (state.pattern !== prevState.pattern) {
    writePersistedPattern(state.pattern);
  }
});
