import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Tone mock ──────────────────────────────────────────────────────────────
// Captures the scheduled step-repeat callback so tests can invoke it directly
// to simulate an audio-clock tick, mirroring the pattern in
// src/audio/__tests__/SampleEngine.test.ts. `scheduleOnce`/`Draw.schedule`
// invoke their callback synchronously — fine for testing pure logic, since we
// aren't asserting real-time/animation-frame behavior here.

let capturedStepCallback: ((time: number) => void) | null = null;
const mockTransport = {
  scheduleRepeat: vi.fn((cb: (time: number) => void) => {
    capturedStepCallback = cb;
    return 1;
  }),
  scheduleOnce: vi.fn((cb: () => void) => {
    cb();
    return 2;
  }),
  start: vi.fn(),
  stop: vi.fn(),
  clear: vi.fn(),
};
const mockDraw = { schedule: vi.fn((cb: () => void) => cb()) };

vi.mock("tone", () => ({
  getTransport: vi.fn(() => mockTransport),
  getDraw: vi.fn(() => mockDraw),
}));

// ── Store mocks ────────────────────────────────────────────────────────────

const mockEngine = { trigger: vi.fn() };
const mockMidiOut = { sendNoteOn: vi.fn(), sendNoteOff: vi.fn() };
const mockPressPad = vi.fn();
const mockUnpressPad = vi.fn();

vi.mock("../../state/store", () => ({
  useMPCStore: {
    getState: vi.fn(() => ({
      engineRef: mockEngine,
      midiOutRef: mockMidiOut,
      pressPad: mockPressPad,
      unpressPad: mockUnpressPad,
    })),
  },
}));

// eslint-disable-next-line import/first
import { PatternPlayer } from "../PatternPlayer";
// eslint-disable-next-line import/first
import { createEmptyPattern } from "../sequencer.types";
// eslint-disable-next-line import/first
import { useSequencerStore } from "../sequencerStore";

beforeEach(() => {
  vi.clearAllMocks();
  capturedStepCallback = null;
  useSequencerStore.setState({
    pattern: createEmptyPattern(1, "16n"),
    isPlaying: false,
    currentStep: -1,
  });
});

describe("PatternPlayer.start", () => {
  it("schedules a repeat at the pattern's resolution and starts the transport", () => {
    const player = new PatternPlayer();
    player.start();
    expect(mockTransport.scheduleRepeat).toHaveBeenCalledWith(expect.any(Function), "16n");
    expect(mockTransport.start).toHaveBeenCalledOnce();
    expect(useSequencerStore.getState().isPlaying).toBe(true);
  });

  it("is idempotent — calling start() twice does not schedule a second repeat", () => {
    const player = new PatternPlayer();
    player.start();
    player.start();
    expect(mockTransport.scheduleRepeat).toHaveBeenCalledOnce();
  });
});

describe("PatternPlayer.stop", () => {
  it("clears the scheduled repeat and stops the transport", () => {
    const player = new PatternPlayer();
    player.start();
    player.stop();
    expect(mockTransport.clear).toHaveBeenCalledWith(1);
    expect(mockTransport.stop).toHaveBeenCalledOnce();
    expect(useSequencerStore.getState().isPlaying).toBe(false);
    expect(useSequencerStore.getState().currentStep).toBe(-1);
  });

  it("does nothing (no throw) when called before start()", () => {
    const player = new PatternPlayer();
    expect(() => player.stop()).not.toThrow();
  });
});

describe("PatternPlayer step playback", () => {
  it("triggers the engine and MIDI out for active steps only, on the correct step", () => {
    useSequencerStore.getState().toggleStep(0, 0); // pad 0 active on step 0
    useSequencerStore.getState().toggleStep(1, 4); // pad 1 active on step 4 (not step 0)

    const player = new PatternPlayer();
    player.start();
    capturedStepCallback?.(0.5);

    expect(mockEngine.trigger).toHaveBeenCalledWith(0, 0.9, 0.5);
    expect(mockMidiOut.sendNoteOn).toHaveBeenCalledWith(0, 0.9);
    expect(mockEngine.trigger).not.toHaveBeenCalledWith(1, expect.anything(), expect.anything());
  });

  it("updates sequencerStore.currentStep via Tone.Draw", () => {
    const player = new PatternPlayer();
    player.start();
    capturedStepCallback?.(0.5);
    expect(useSequencerStore.getState().currentStep).toBe(0);
  });

  it("advances and wraps the step index across successive ticks", () => {
    useSequencerStore.getState().setBars(1); // 16 steps at 16n
    const player = new PatternPlayer();
    player.start();
    for (let i = 0; i < 16; i++) capturedStepCallback?.(i);
    expect(useSequencerStore.getState().currentStep).toBe(15);
    capturedStepCallback?.(16); // 17th tick wraps back to step 0
    expect(useSequencerStore.getState().currentStep).toBe(0);
  });

  it("sends Note Off and clears the visual press shortly after Note On", () => {
    useSequencerStore.getState().toggleStep(3, 0);
    const player = new PatternPlayer();
    player.start();
    capturedStepCallback?.(1);

    expect(mockPressPad).toHaveBeenCalledWith(3);
    expect(mockMidiOut.sendNoteOff).toHaveBeenCalledWith(3);
    expect(mockUnpressPad).toHaveBeenCalledWith(3);
  });

  it("does nothing for a step with no active pads", () => {
    const player = new PatternPlayer();
    player.start();
    capturedStepCallback?.(0);
    expect(mockEngine.trigger).not.toHaveBeenCalled();
    expect(mockMidiOut.sendNoteOn).not.toHaveBeenCalled();
  });
});
