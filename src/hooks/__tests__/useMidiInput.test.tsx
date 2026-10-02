import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMPCStore } from "../../state/store";
import type { MidiEvent } from "../../types/mpc.types";
import { useMidiInput } from "../useMidiInput";

// ---------------------------------------------------------------------------
// Mock MidiInput class
// Vitest auto-hoists vi.mock() calls above imports, so the factory below
// runs before any module is evaluated.
// ---------------------------------------------------------------------------

const mockStart = vi.fn();
const mockStop = vi.fn();
let capturedHandlers: {
  onEvent?: (e: MidiEvent) => void;
  onStatusChange?: (s: string, name: string | null) => void;
} = {};

// Regular (non-arrow) factory required by vitest v4 for `new`-construction.
function MockMidiInputCtor(handlers: { onEvent?: unknown; onStatusChange?: unknown }) {
  capturedHandlers = (handlers ?? {}) as typeof capturedHandlers;
  return { start: mockStart, stop: mockStop };
}

vi.mock("../../midi/MidiInput", () => ({
  MidiInput: vi.fn(MockMidiInputCtor),
}));

// Import the mocked constructor so we can assert call count
// eslint-disable-next-line import/first
import { MidiInput } from "../../midi/MidiInput";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useMPCStore.setState({
    midiStatus: "idle",
    midiDeviceName: null,
    bankIdx: 0,
    pads: (() => {
      const p: Record<number, string> = {};
      for (let i = 0; i < 16; i++) p[i] = "armed";
      return p as Parameters<typeof useMPCStore.setState>[0]["pads"];
    })(),
    knobs: { k1: 0.5, k2: 0.5, k3: 0.5, mainVol: 0.8, dataEnc: 0 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers = {};
  resetStore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useMidiInput", () => {
  it("returns initial midiStatus from store ('idle')", () => {
    const { result } = renderHook(() => useMidiInput());
    expect(result.current.status).toBe("idle");
  });

  it("returns initial deviceName from store (null)", () => {
    const { result } = renderHook(() => useMidiInput());
    expect(result.current.deviceName).toBeNull();
  });

  it("start() invokes MidiInput.start()", async () => {
    mockStart.mockResolvedValue(undefined);
    const { result } = renderHook(() => useMidiInput());
    await act(async () => {
      await result.current.start();
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("stop() invokes MidiInput.stop()", () => {
    const { result } = renderHook(() => useMidiInput());
    act(() => {
      result.current.stop();
    });
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("unmount calls stop()", () => {
    const { unmount } = renderHook(() => useMidiInput());
    unmount();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("onEvent noteOn → store.triggerPad called with padIdx + velocity, fromHardware=true", () => {
    renderHook(() => useMidiInput());
    const triggerPad = vi.spyOn(useMPCStore.getState(), "triggerPad");
    act(() => {
      capturedHandlers.onEvent?.({ type: "noteOn", padIdx: 3, velocity: 0.8 });
    });
    // fromHardware=true so the store doesn't echo this trigger back out as MIDI.
    expect(triggerPad).toHaveBeenCalledWith(3, 0.8, undefined, true);
  });

  it("onEvent noteOn from a different bank (padIdx=20) → store.setBank(1) called to follow hardware", () => {
    renderHook(() => useMidiInput());
    const setBank = vi.spyOn(useMPCStore.getState(), "setBank");
    act(() => {
      capturedHandlers.onEvent?.({ type: "noteOn", padIdx: 20, velocity: 0.8 });
    });
    expect(setBank).toHaveBeenCalledWith(1);
  });

  it("onEvent noteOn from the already-active bank → store.setBank not called", () => {
    renderHook(() => useMidiInput());
    // Default bankIdx is 0; padIdx 3 belongs to bank 0.
    const setBank = vi.spyOn(useMPCStore.getState(), "setBank");
    act(() => {
      capturedHandlers.onEvent?.({ type: "noteOn", padIdx: 3, velocity: 0.8 });
    });
    expect(setBank).not.toHaveBeenCalled();
  });

  it("onEvent noteOff → store.releasePad called with padIdx, fromHardware=true", () => {
    renderHook(() => useMidiInput());
    const releasePad = vi.spyOn(useMPCStore.getState(), "releasePad");
    act(() => {
      capturedHandlers.onEvent?.({ type: "noteOff", padIdx: 5 });
    });
    expect(releasePad).toHaveBeenCalledWith(5, true);
  });

  it("onEvent cc controller=1 → store.setKnob('k1', value)", () => {
    renderHook(() => useMidiInput());
    const setKnob = vi.spyOn(useMPCStore.getState(), "setKnob");
    act(() => {
      capturedHandlers.onEvent?.({ type: "cc", controller: 1, value: 0.75 });
    });
    expect(setKnob).toHaveBeenCalledWith("k1", 0.75);
  });

  it("onEvent cc controller=2 → store.setKnob('k2', value)", () => {
    renderHook(() => useMidiInput());
    const setKnob = vi.spyOn(useMPCStore.getState(), "setKnob");
    act(() => {
      capturedHandlers.onEvent?.({ type: "cc", controller: 2, value: 0.5 });
    });
    expect(setKnob).toHaveBeenCalledWith("k2", 0.5);
  });

  it("onEvent cc controller=3 → store.setKnob('k3', value)", () => {
    renderHook(() => useMidiInput());
    const setKnob = vi.spyOn(useMPCStore.getState(), "setKnob");
    act(() => {
      capturedHandlers.onEvent?.({ type: "cc", controller: 3, value: 0.25 });
    });
    expect(setKnob).toHaveBeenCalledWith("k3", 0.25);
  });

  it("onEvent cc controller=4 (unmapped) → no store action", () => {
    renderHook(() => useMidiInput());
    const setKnob = vi.spyOn(useMPCStore.getState(), "setKnob");
    act(() => {
      capturedHandlers.onEvent?.({ type: "cc", controller: 4, value: 0.5 });
    });
    expect(setKnob).not.toHaveBeenCalled();
  });

  it("onStatusChange updates store midiStatus and deviceName", () => {
    renderHook(() => useMidiInput());
    act(() => {
      capturedHandlers.onStatusChange?.("connected", "My Device");
    });
    const state = useMPCStore.getState();
    expect(state.midiStatus).toBe("connected");
    expect(state.midiDeviceName).toBe("My Device");
  });

  it("status reflects store changes reactively", () => {
    const { result } = renderHook(() => useMidiInput());
    act(() => {
      useMPCStore.getState().setMidiStatus("searching", null);
    });
    expect(result.current.status).toBe("searching");
  });

  it("MidiInput constructor is called exactly once on mount", () => {
    renderHook(() => useMidiInput());
    expect(MidiInput).toHaveBeenCalledTimes(1);
  });

  it("registers the MidiInput instance as the store's midiOutRef on mount, clears it on unmount", () => {
    const setMidiOut = vi.spyOn(useMPCStore.getState(), "setMidiOut");
    const { unmount } = renderHook(() => useMidiInput());
    expect(setMidiOut).toHaveBeenCalledWith(expect.objectContaining({ start: mockStart }));

    unmount();
    expect(setMidiOut).toHaveBeenLastCalledWith(null);
  });
});
