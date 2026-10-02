import { describe, expect, it } from "vitest";
import { createEmptyPattern, getPadSteps, resizeSteps, totalSteps } from "../sequencer.types";

describe("totalSteps", () => {
  it("computes 1 bar / 16th notes as 16 steps", () => {
    expect(totalSteps(1, "16n")).toBe(16);
  });

  it("computes 1 bar / 8th notes as 8 steps", () => {
    expect(totalSteps(1, "8n")).toBe(8);
  });

  it("computes 2 bars / 32nd notes as 64 steps", () => {
    expect(totalSteps(2, "32n")).toBe(64);
  });
});

describe("resizeSteps", () => {
  it("returns the same array reference when length is unchanged", () => {
    const steps = [{ active: true, velocity: 0.9 }];
    expect(resizeSteps(steps, 1)).toBe(steps);
  });

  it("truncates when shrinking, preserving in-range steps", () => {
    const steps = [
      { active: true, velocity: 0.9 },
      { active: false, velocity: 0.9 },
      { active: true, velocity: 0.5 },
    ];
    const result = resizeSteps(steps, 2);
    expect(result).toEqual([
      { active: true, velocity: 0.9 },
      { active: false, velocity: 0.9 },
    ]);
  });

  it("pads with inactive default steps when growing", () => {
    const steps = [{ active: true, velocity: 0.9 }];
    const result = resizeSteps(steps, 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ active: true, velocity: 0.9 });
    expect(result[1]).toEqual({ active: false, velocity: 0.9 });
    expect(result[2]).toEqual({ active: false, velocity: 0.9 });
  });
});

describe("createEmptyPattern", () => {
  it("defaults to 1 bar / 16th notes with no steps recorded", () => {
    const pattern = createEmptyPattern();
    expect(pattern.bars).toBe(1);
    expect(pattern.resolution).toBe("16n");
    expect(pattern.steps).toEqual({});
  });
});

describe("getPadSteps", () => {
  it("returns an all-inactive array sized to the pattern when the pad has no entry", () => {
    const pattern = createEmptyPattern(1, "16n");
    const steps = getPadSteps(pattern, 5);
    expect(steps).toHaveLength(16);
    expect(steps.every((s) => !s.active)).toBe(true);
  });

  it("returns the pad's actual steps when present", () => {
    const pattern = createEmptyPattern(1, "16n");
    pattern.steps[5] = [{ active: true, velocity: 1 }];
    expect(getPadSteps(pattern, 5)).toBe(pattern.steps[5]);
  });
});
