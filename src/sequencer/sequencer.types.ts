/**
 * sequencer.types.ts — Data model for the step sequencer.
 *
 * v1 scope (see the "Step Sequencer" plan): live/MIDI-driven playback only —
 * no native `.xpj` sequence export. One in-memory pattern at a time.
 */

import type { PadIndex } from "../types/mpc.types";

/** Tone.js time notation — reused directly for `Tone.Transport.scheduleRepeat`. */
export type StepResolution = "8n" | "16n" | "32n";

/** Steps per beat for each resolution, assuming 4/4 time. */
export const STEPS_PER_BEAT: Record<StepResolution, number> = {
  "8n": 2,
  "16n": 4,
  "32n": 8,
};

export const BEATS_PER_BAR = 4;

export const MIN_BARS = 1;
export const MAX_BARS = 8;

export type Step = {
  active: boolean;
  /** 0..1. Only meaningful when `active` is true. */
  velocity: number;
};

export type Pattern = {
  bars: number;
  resolution: StepResolution;
  /** Keyed by GlobalPadIdx (0..127); only pads with at least one step need an entry. */
  steps: Record<PadIndex, Step[]>;
};

/** Total step count for a given bar count + resolution (4/4 time). */
export function totalSteps(bars: number, resolution: StepResolution): number {
  return bars * BEATS_PER_BAR * STEPS_PER_BEAT[resolution];
}

function defaultStep(): Step {
  return { active: false, velocity: 0.9 };
}

/** Resize a single pad's step array to `newLength`, preserving in-range steps. */
export function resizeSteps(steps: Step[], newLength: number): Step[] {
  if (steps.length === newLength) return steps;
  if (steps.length > newLength) return steps.slice(0, newLength);
  return [...steps, ...Array.from({ length: newLength - steps.length }, defaultStep)];
}

/** Build an empty pattern of the given size — no active steps on any pad. */
export function createEmptyPattern(bars: number = 1, resolution: StepResolution = "16n"): Pattern {
  return { bars, resolution, steps: {} };
}

/** Read a pad's step array, returning an all-inactive array if the pad has no entry yet. */
export function getPadSteps(pattern: Pattern, padIdx: PadIndex): Step[] {
  const existing = pattern.steps[padIdx];
  if (existing) return existing;
  return Array.from({ length: totalSteps(pattern.bars, pattern.resolution) }, defaultStep);
}
