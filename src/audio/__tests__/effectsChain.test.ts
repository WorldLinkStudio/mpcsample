/**
 * effectsChain.test.ts — Unit tests for the pure, Tone-free parts of the
 * effects rack: default params and tail-time estimation.
 *
 * `renderEffectsChain`/`previewEffectsChain` themselves drive real Tone.js
 * nodes (`Tone.Offline`, `Tone.Reverb.generate()`, ...) against a real
 * `AudioBuffer`/`OfflineAudioContext`, which jsdom does not implement —
 * mirrors `SampleRecorder.ts` (also Web-Audio-heavy, also untested here).
 * They're exercised manually via the Effects Rack panel instead.
 */

import { describe, expect, it } from "vitest";
import {
  _resetEffectIdCounter,
  createEffect,
  defaultParamsFor,
  EFFECT_TYPES,
} from "../effects.types";
import { estimateTailSeconds } from "../effectsChain";

describe("defaultParamsFor", () => {
  it("returns sane defaults for every effect type", () => {
    for (const type of EFFECT_TYPES) {
      const params = defaultParamsFor(type);
      expect(params).toBeTruthy();
      expect(typeof params).toBe("object");
    }
  });
});

describe("createEffect", () => {
  it("assigns a unique, stable id and the type's default params", () => {
    _resetEffectIdCounter();
    const a = createEffect("filter");
    const b = createEffect("filter");
    expect(a.id).not.toBe(b.id);
    expect(a.type).toBe("filter");
    expect(a.params).toEqual(defaultParamsFor("filter"));
  });
});

describe("estimateTailSeconds", () => {
  it("is zero for an empty chain", () => {
    expect(estimateTailSeconds([])).toBe(0);
  });

  it("is zero for effects with no natural tail (filter/distortion/bitcrusher/chorus)", () => {
    const chain = [
      createEffect("filter"),
      createEffect("distortion"),
      createEffect("bitcrusher"),
      createEffect("chorus"),
    ];
    expect(estimateTailSeconds(chain)).toBe(0);
  });

  it("accounts for reverb decay + pre-delay", () => {
    const reverb = createEffect("reverb");
    reverb.params.decay = 3;
    reverb.params.preDelay = 0.2;
    expect(estimateTailSeconds([reverb])).toBeCloseTo(3.2, 5);
  });

  it("accounts for delay feedback ring-out", () => {
    const delay = createEffect("delay");
    delay.params.delayTime = 0.5;
    delay.params.feedback = 0.5;
    // feedback^n < 0.001 at n = ceil(log(0.001)/log(0.5)) = 10 → 5s tail.
    expect(estimateTailSeconds([delay])).toBeCloseTo(5, 5);
  });

  it("sums tails across multiple effects in the chain", () => {
    const reverb = createEffect("reverb");
    reverb.params.decay = 2;
    reverb.params.preDelay = 0;
    const delay = createEffect("delay");
    delay.params.delayTime = 0.1;
    delay.params.feedback = 0.1;
    const combined = estimateTailSeconds([reverb, delay]);
    expect(combined).toBeGreaterThan(2);
  });

  it("caps the total tail so a runaway chain can't render forever", () => {
    const chain = Array.from({ length: 10 }, () => {
      const reverb = createEffect("reverb");
      reverb.params.decay = 10;
      reverb.params.preDelay = 0.5;
      return reverb;
    });
    expect(estimateTailSeconds(chain)).toBe(15);
  });
});
