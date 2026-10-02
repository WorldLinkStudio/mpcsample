import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyPattern, totalSteps } from "../sequencer.types";
import { useSequencerStore } from "../sequencerStore";

beforeEach(() => {
  useSequencerStore.setState({
    pattern: createEmptyPattern(),
    isPlaying: false,
    currentStep: -1,
  });
});

describe("toggleStep", () => {
  it("activates an inactive step", () => {
    useSequencerStore.getState().toggleStep(0, 3);
    const steps = useSequencerStore.getState().pattern.steps[0];
    expect(steps?.[3].active).toBe(true);
  });

  it("deactivates an already-active step", () => {
    useSequencerStore.getState().toggleStep(0, 3);
    useSequencerStore.getState().toggleStep(0, 3);
    expect(useSequencerStore.getState().pattern.steps[0]?.[3].active).toBe(false);
  });

  it("does not affect other steps on the same pad", () => {
    useSequencerStore.getState().toggleStep(0, 3);
    const steps = useSequencerStore.getState().pattern.steps[0];
    expect(steps?.[0].active).toBe(false);
    expect(steps?.[4].active).toBe(false);
  });

  it("silently ignores an out-of-range step index", () => {
    expect(() => useSequencerStore.getState().toggleStep(0, 999)).not.toThrow();
    expect(useSequencerStore.getState().pattern.steps[0]).toBeUndefined();
  });
});

describe("setStepVelocity", () => {
  it("sets a step's velocity, clamped to 0..1", () => {
    useSequencerStore.getState().toggleStep(2, 0);
    useSequencerStore.getState().setStepVelocity(2, 0, 1.5);
    expect(useSequencerStore.getState().pattern.steps[2]?.[0].velocity).toBe(1);

    useSequencerStore.getState().setStepVelocity(2, 0, -0.5);
    expect(useSequencerStore.getState().pattern.steps[2]?.[0].velocity).toBe(0);
  });
});

describe("setBars", () => {
  it("clamps to MIN_BARS..MAX_BARS", () => {
    useSequencerStore.getState().setBars(0);
    expect(useSequencerStore.getState().pattern.bars).toBe(1);
    useSequencerStore.getState().setBars(99);
    expect(useSequencerStore.getState().pattern.bars).toBe(8);
  });

  it("resizes existing pads' step arrays, preserving in-range steps", () => {
    useSequencerStore.getState().toggleStep(0, 2); // step 2 active, 1 bar / 16n = 16 steps
    useSequencerStore.getState().setBars(2); // now 32 steps
    const steps = useSequencerStore.getState().pattern.steps[0];
    expect(steps).toHaveLength(32);
    expect(steps?.[2].active).toBe(true);
  });

  it("truncates steps beyond the new (smaller) length", () => {
    useSequencerStore.getState().setBars(2); // 32 steps
    useSequencerStore.getState().toggleStep(0, 20);
    useSequencerStore.getState().setBars(1); // back to 16 steps — index 20 is now out of range
    const steps = useSequencerStore.getState().pattern.steps[0];
    expect(steps).toHaveLength(16);
  });
});

describe("setResolution", () => {
  it("changes resolution and resizes step arrays to match", () => {
    useSequencerStore.getState().toggleStep(1, 1);
    useSequencerStore.getState().setResolution("8n");
    expect(useSequencerStore.getState().pattern.resolution).toBe("8n");
    expect(useSequencerStore.getState().pattern.steps[1]).toHaveLength(totalSteps(1, "8n"));
  });
});

describe("clearPattern", () => {
  it("removes all steps but keeps bars/resolution", () => {
    useSequencerStore.getState().setBars(3);
    useSequencerStore.getState().setResolution("32n");
    useSequencerStore.getState().toggleStep(0, 5);
    useSequencerStore.getState().clearPattern();
    const { pattern } = useSequencerStore.getState();
    expect(pattern.steps).toEqual({});
    expect(pattern.bars).toBe(3);
    expect(pattern.resolution).toBe("32n");
  });
});

describe("setIsPlaying", () => {
  it("sets currentStep to 0 when starting playback", () => {
    useSequencerStore.getState().setIsPlaying(true);
    expect(useSequencerStore.getState().isPlaying).toBe(true);
    expect(useSequencerStore.getState().currentStep).toBe(0);
  });

  it("resets currentStep to -1 when stopping", () => {
    useSequencerStore.getState().setIsPlaying(true);
    useSequencerStore.getState().setCurrentStep(7);
    useSequencerStore.getState().setIsPlaying(false);
    expect(useSequencerStore.getState().currentStep).toBe(-1);
  });
});
