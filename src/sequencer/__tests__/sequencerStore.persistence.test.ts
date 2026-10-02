/* eslint-disable @typescript-eslint/no-empty-function */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPattern } from "../sequencer.types";
import { useSequencerStore } from "../sequencerStore";

// ── localStorage mock — mirrors src/state/__tests__/uiTransform.test.ts ────────

let store: Record<string, string> = {};

const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete store[key];
  }),
  clear: vi.fn(() => {
    store = {};
  }),
  length: 0,
  key: vi.fn(() => null),
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

const PATTERN_KEY = "mpc.sequencerPattern";

beforeEach(() => {
  store = {};
  useSequencerStore.setState({ pattern: createEmptyPattern(), isPlaying: false, currentStep: -1 });
  // Clear mock call history *after* the reset above (which itself triggers a
  // subscribe-driven write) so each test starts from a clean call count.
  vi.clearAllMocks();
});

describe("sequencerStore persistence", () => {
  it("persists the pattern to localStorage when a step is toggled", () => {
    useSequencerStore.getState().toggleStep(0, 3);
    const saved = JSON.parse(store[PATTERN_KEY]);
    expect(saved.steps["0"][3].active).toBe(true);
  });

  it("persists bars/resolution changes", () => {
    useSequencerStore.getState().setBars(2);
    useSequencerStore.getState().setResolution("8n");
    const saved = JSON.parse(store[PATTERN_KEY]);
    expect(saved.bars).toBe(2);
    expect(saved.resolution).toBe("8n");
  });

  it("does NOT write to localStorage for transient playback state (isPlaying/currentStep)", () => {
    useSequencerStore.getState().setIsPlaying(true);
    useSequencerStore.getState().setCurrentStep(5);
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it("persists clearPattern", () => {
    useSequencerStore.getState().toggleStep(0, 0);
    useSequencerStore.getState().clearPattern();
    const saved = JSON.parse(store[PATTERN_KEY]);
    expect(saved.steps).toEqual({});
  });
});
