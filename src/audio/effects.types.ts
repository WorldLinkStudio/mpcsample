/**
 * effects.types.ts — Data model for the offline effects rack.
 *
 * An `EffectInstance` is a plain, serializable description of one node in a
 * chain (type + params); the actual Tone.js node is only constructed at
 * render/preview time (see `effectsChain.ts`). Keeping this layer
 * Tone-free means the chain itself can be built/edited/validated without
 * ever touching the Web Audio API.
 */

export type EffectType = "filter" | "distortion" | "bitcrusher" | "chorus" | "delay" | "reverb";

export type FilterParams = {
  filterType: "lowpass" | "highpass";
  /** Hz, 20..20000. */
  frequency: number;
  /** Resonance, 0.1..20. */
  Q: number;
};

export type DistortionParams = {
  /** 0..1 drive amount. */
  amount: number;
};

export type BitCrusherParams = {
  /** Integer bit depth, 1..16. */
  bits: number;
};

export type ChorusParams = {
  /** LFO rate in Hz, 0.1..10. */
  frequency: number;
  /** Base delay in ms, 1..20. */
  delayTime: number;
  /** 0..1. */
  depth: number;
};

export type DelayParams = {
  /** Seconds, 0.01..1. */
  delayTime: number;
  /** 0..0.95 — kept below 1 so the offline render always terminates. */
  feedback: number;
  /** 0..1 wet mix. */
  wet: number;
};

export type ReverbParams = {
  /** Seconds, 0.1..10. */
  decay: number;
  /** Seconds, 0..0.5. */
  preDelay: number;
  /** 0..1 wet mix. */
  wet: number;
};

export type ParamsFor<T extends EffectType> = T extends "filter"
  ? FilterParams
  : T extends "distortion"
    ? DistortionParams
    : T extends "bitcrusher"
      ? BitCrusherParams
      : T extends "chorus"
        ? ChorusParams
        : T extends "delay"
          ? DelayParams
          : ReverbParams;

export type EffectInstance = {
  [T in EffectType]: { id: string; type: T; params: ParamsFor<T> };
}[EffectType];

/** Display order + labels for the "add effect" picker. */
export const EFFECT_TYPES: readonly EffectType[] = [
  "filter",
  "distortion",
  "bitcrusher",
  "chorus",
  "delay",
  "reverb",
];

export const EFFECT_LABELS: Record<EffectType, string> = {
  filter: "Filter",
  distortion: "Distortion",
  bitcrusher: "Bit Crusher",
  chorus: "Chorus",
  delay: "Delay",
  reverb: "Reverb",
};

export function defaultParamsFor<T extends EffectType>(type: T): ParamsFor<T> {
  switch (type) {
    case "filter":
      return { filterType: "lowpass", frequency: 2000, Q: 1 } as ParamsFor<T>;
    case "distortion":
      return { amount: 0.4 } as ParamsFor<T>;
    case "bitcrusher":
      return { bits: 8 } as ParamsFor<T>;
    case "chorus":
      return { frequency: 1.5, delayTime: 3.5, depth: 0.7 } as ParamsFor<T>;
    case "delay":
      return { delayTime: 0.25, feedback: 0.35, wet: 0.5 } as ParamsFor<T>;
    case "reverb":
      return { decay: 2, preDelay: 0.01, wet: 0.5 } as ParamsFor<T>;
    default:
      throw new Error(`defaultParamsFor: unknown effect type "${type}"`);
  }
}

let _idCounter = 0;

/** Reset the id counter (tests only). */
export function _resetEffectIdCounter(): void {
  _idCounter = 0;
}

export function createEffect<T extends EffectType>(type: T): EffectInstance {
  const id = `fx-${++_idCounter}`;
  return { id, type, params: defaultParamsFor(type) } as EffectInstance;
}
