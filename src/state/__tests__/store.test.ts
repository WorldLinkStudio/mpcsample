/* eslint-disable @typescript-eslint/no-empty-function, no-useless-computed-key */
// Empty no-op bodies are intentional for the AudioEngineLike spy mock; numeric
// computed keys ({ [12]: ... }) mirror global pad indices for fixture clarity.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleKit, SamplePad } from "../../kits/kit.types";
import type { AudioEngineLike, MidiOutputLike } from "../../types/mpc.types";
import { _cancelAllReleaseTimers, buildExportKit, useMPCStore } from "../store";

// ── Mock engine factory ────────────────────────────────────────────────────────
// Note: vi.fn(regularFunction) — NOT arrow functions — per the project's
// Vitest-4 pattern (arrow functions are not constructible).

function makeEngine(): AudioEngineLike {
  return {
    start: vi.fn(() => Promise.resolve()),
    trigger: vi.fn(() => {}),
    release: vi.fn(() => {}),
    setKit: vi.fn(() => {}),
    setKnob: vi.fn(() => {}),
    setMasterDb: vi.fn(() => {}),
    setBpm: vi.fn(() => {}),
    swapPadVoice: vi.fn(() => {}),
    getWaveform: vi.fn(() => null),
    getSpectrum: vi.fn(() => null),
    isReady: vi.fn(() => true),
    dispose: vi.fn(() => {}),
    loadKit: vi.fn(() => Promise.resolve()),
    setPadSample: vi.fn(() => {}),
    setPadTune: vi.fn(() => {}),
    setPadGain: vi.fn(() => {}),
    isPadLoading: vi.fn(() => false),
    prefetchAll: vi.fn(() => Promise.resolve()),
    registerImportedSample: vi.fn(() => Promise.resolve()),
  };
}

function makeMidiOut(): MidiOutputLike {
  return {
    hasOutput: vi.fn(() => true),
    sendNoteOn: vi.fn(() => {}),
    sendNoteOff: vi.fn(() => {}),
  };
}

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makePad(globalPadIdx: number, overrides: Partial<SamplePad> = {}): SamplePad {
  return {
    globalPadIdx,
    sampleId: `sample-${globalPadIdx}`,
    displayName: `Pad ${globalPadIdx}`,
    sampleName: `sample-${globalPadIdx}.wav`,
    fileName: `sample-${globalPadIdx}.wav`,
    url: `/kits/test/${globalPadIdx}.wav`,
    coarseTune: 0,
    fineTune: 0,
    gainCoefficient: 1.0,
    pan: 0.5,
    ...overrides,
  };
}

function makeKit(id: string, pads: SamplePad[], overrides: Partial<SampleKit> = {}): SampleKit {
  return {
    id,
    displayName: `Kit ${id}`,
    exportName: `Kit ${id}`,
    key: "C Minor",
    bpm: 114,
    pads,
    ...overrides,
  };
}

// ── Reset store before each test ───────────────────────────────────────────────

beforeEach(() => {
  _cancelAllReleaseTimers();
  useMPCStore.setState({
    isStarted: false,
    activeKit: null,
    activeKitId: "london-full",
    padMap: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [i, null])),
    userSamples: new Map(),
    bankIdx: 0,
    maxBank: 3,
    loadingPads: {},
    isExporting: false,
    exportProgress: null,
    engineRef: null,
    midiOutRef: null,
    bpm: 120,
    fader: 0.5,
    pads: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [i, "armed"])) as Record<
      number,
      "armed" | "press" | "idle"
    >,
  });
});

// ── loadKit ───────────────────────────────────────────────────────────────────

describe("loadKit", () => {
  it("sets activeKit and activeKitId", () => {
    const kit = makeKit("test-kit", [makePad(0)]);
    useMPCStore.getState().loadKit(kit);
    expect(useMPCStore.getState().activeKit).toBe(kit);
    expect(useMPCStore.getState().activeKitId).toBe("test-kit");
  });

  it("builds padMap from kit.pads — populated pads appear at their globalPadIdx", () => {
    const pad0 = makePad(0);
    const pad5 = makePad(5);
    const pad15 = makePad(15);
    const kit = makeKit("test-kit", [pad0, pad5, pad15]);
    useMPCStore.getState().loadKit(kit);
    const { padMap } = useMPCStore.getState();
    expect(padMap[0]).toEqual(pad0);
    expect(padMap[5]).toEqual(pad5);
    expect(padMap[15]).toEqual(pad15);
  });

  it("sets unpopulated pads to null in padMap", () => {
    const kit = makeKit("test-kit", [makePad(0)]);
    useMPCStore.getState().loadKit(kit);
    const { padMap } = useMPCStore.getState();
    expect(padMap[1]).toBeNull();
    expect(padMap[127]).toBeNull();
  });

  it("builds a full 128-entry padMap", () => {
    const kit = makeKit("test-kit", [makePad(0)]);
    useMPCStore.getState().loadKit(kit);
    const { padMap } = useMPCStore.getState();
    expect(Object.keys(padMap)).toHaveLength(128);
  });

  it("sets maxBank to 3 (minimum) for a kit with only bank-A pads", () => {
    const kit = makeKit("test-kit", [makePad(0), makePad(15)]);
    useMPCStore.getState().loadKit(kit);
    expect(useMPCStore.getState().maxBank).toBe(3);
  });

  it("sets maxBank to 4 when kit has a bank-E pad (globalPadIdx=64)", () => {
    const kit = makeKit("test-kit", [makePad(0), makePad(64)]);
    useMPCStore.getState().loadKit(kit);
    // bank 4 = idx 64..79 (E)
    expect(useMPCStore.getState().maxBank).toBe(4);
  });

  it("sets maxBank to 7 when kit has a bank-H pad (globalPadIdx=127)", () => {
    const kit = makeKit("test-kit", [makePad(0), makePad(127)]);
    useMPCStore.getState().loadKit(kit);
    expect(useMPCStore.getState().maxBank).toBe(7);
  });

  it("preserves bankIdx on kit load (banks E-H always navigable)", () => {
    useMPCStore.setState({ bankIdx: 5 });
    const kit = makeKit("test-kit", [makePad(0)]);
    useMPCStore.getState().loadKit(kit);
    expect(useMPCStore.getState().bankIdx).toBe(5);
  });

  it("does NOT call engineRef.loadKit (handled by useAudioEngine subscription)", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    const kit = makeKit("test-kit", [makePad(0)]);
    useMPCStore.getState().loadKit(kit);
    expect(engine.loadKit).not.toHaveBeenCalled();
  });
});

// ── setActiveKitId ─────────────────────────────────────────────────────────────

describe("setActiveKitId", () => {
  it("updates activeKitId without changing activeKit", () => {
    useMPCStore.getState().setActiveKitId("london-deluxe");
    expect(useMPCStore.getState().activeKitId).toBe("london-deluxe");
    expect(useMPCStore.getState().activeKit).toBeNull();
  });
});

// ── setBank / cycleBank ────────────────────────────────────────────────────────

describe("setBank", () => {
  it("sets bankIdx to the given value", () => {
    useMPCStore.setState({ maxBank: 3 });
    useMPCStore.getState().setBank(2);
    expect(useMPCStore.getState().bankIdx).toBe(2);
  });

  it("clamps bankIdx to 0 (minimum)", () => {
    useMPCStore.getState().setBank(-1);
    expect(useMPCStore.getState().bankIdx).toBe(0);
  });

  it("clamps bankIdx to 7 (maximum — all 8 banks always navigable)", () => {
    useMPCStore.getState().setBank(10);
    expect(useMPCStore.getState().bankIdx).toBe(7);
  });

  it("allows up to maxBank=7", () => {
    useMPCStore.setState({ maxBank: 7 });
    useMPCStore.getState().setBank(7);
    expect(useMPCStore.getState().bankIdx).toBe(7);
  });
});

describe("cycleBank", () => {
  it("increments bankIdx by 1", () => {
    useMPCStore.setState({ bankIdx: 0, maxBank: 3 });
    useMPCStore.getState().cycleBank();
    expect(useMPCStore.getState().bankIdx).toBe(1);
  });

  it("advances past maxBank=3 (no longer wraps there — wraps at 8)", () => {
    useMPCStore.setState({ bankIdx: 3, maxBank: 3 });
    useMPCStore.getState().cycleBank();
    expect(useMPCStore.getState().bankIdx).toBe(4);
  });

  it("wraps back to 0 only after bank H (idx 7)", () => {
    useMPCStore.setState({ bankIdx: 7, maxBank: 3 });
    useMPCStore.getState().cycleBank();
    expect(useMPCStore.getState().bankIdx).toBe(0);
  });

  it("cycles through all banks when maxBank=7", () => {
    useMPCStore.setState({ bankIdx: 6, maxBank: 7 });
    useMPCStore.getState().cycleBank();
    expect(useMPCStore.getState().bankIdx).toBe(7);
    useMPCStore.getState().cycleBank();
    expect(useMPCStore.getState().bankIdx).toBe(0);
  });
});

// ── setPadSample ──────────────────────────────────────────────────────────────

describe("setPadSample", () => {
  it("places the pad in padMap at the given index", () => {
    const pad = makePad(3);
    useMPCStore.getState().setPadSample(3, pad);
    expect(useMPCStore.getState().padMap[3]).toEqual(pad);
  });

  it("clears the pad when null is passed", () => {
    const pad = makePad(3);
    useMPCStore.getState().setPadSample(3, pad);
    useMPCStore.getState().setPadSample(3, null);
    expect(useMPCStore.getState().padMap[3]).toBeNull();
  });

  it("calls engineRef.setPadSample with the pad", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    const pad = makePad(3);
    useMPCStore.getState().setPadSample(3, pad);
    expect(engine.setPadSample).toHaveBeenCalledWith(3, pad);
  });

  it("calls engineRef.setPadSample with null to clear", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    useMPCStore.getState().setPadSample(5, null);
    expect(engine.setPadSample).toHaveBeenCalledWith(5, null);
  });

  it("does not call engine when no engineRef", () => {
    useMPCStore.setState({ engineRef: null });
    expect(() => useMPCStore.getState().setPadSample(0, makePad(0))).not.toThrow();
  });
});

// ── movePadSample ─────────────────────────────────────────────────────────────

describe("movePadSample", () => {
  it("moves the pad from source to destination", () => {
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().movePadSample(0, 5);
    const { padMap } = useMPCStore.getState();
    expect(padMap[0]).toBeNull();
    expect(padMap[5]).not.toBeNull();
  });

  it("updates the moved pad's globalPadIdx to the destination index", () => {
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().movePadSample(0, 5);
    expect(useMPCStore.getState().padMap[5]?.globalPadIdx).toBe(5);
  });

  it("calls engine.setPadSample to clear source and set destination", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().movePadSample(0, 5);
    expect(engine.setPadSample).toHaveBeenCalledWith(0, null);
    expect(engine.setPadSample).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ globalPadIdx: 5 }),
    );
  });

  it("move from an empty slot sets destination to null", () => {
    useMPCStore.getState().movePadSample(1, 5);
    expect(useMPCStore.getState().padMap[5]).toBeNull();
    expect(useMPCStore.getState().padMap[1]).toBeNull();
  });
});

// ── swapPad ───────────────────────────────────────────────────────────────────

describe("swapPad", () => {
  it("swaps the two pads in padMap", () => {
    const padA = makePad(0);
    const padB = makePad(1);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: padA, 1: padB },
    });
    useMPCStore.getState().swapPad(0, 1);
    const { padMap } = useMPCStore.getState();
    expect(padMap[0]?.sampleId).toBe(padB.sampleId);
    expect(padMap[1]?.sampleId).toBe(padA.sampleId);
  });

  it("updates globalPadIdx on each swapped pad", () => {
    const padA = makePad(0);
    const padB = makePad(16);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: padA, 16: padB },
    });
    useMPCStore.getState().swapPad(0, 16);
    const { padMap } = useMPCStore.getState();
    expect(padMap[0]?.globalPadIdx).toBe(0);
    expect(padMap[16]?.globalPadIdx).toBe(16);
  });

  it("calls engine.swapPadVoice", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    useMPCStore.getState().swapPad(0, 1);
    expect(engine.swapPadVoice).toHaveBeenCalledWith(0, 1);
  });

  it("swap with empty slot sets one side to null", () => {
    const padA = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: padA, 5: null },
    });
    useMPCStore.getState().swapPad(0, 5);
    expect(useMPCStore.getState().padMap[0]).toBeNull();
    expect(useMPCStore.getState().padMap[5]?.sampleId).toBe(padA.sampleId);
  });

  it("swap is reflected in buildExportKit — pads land at their new globalPadIdx", () => {
    // Verify the full chain: swapPad updates padMap → buildExportKit reads padMap
    // → the exported pads carry the swapped globalPadIdx values.
    const padA = makePad(0, { fileName: "kick.wav", sampleId: "kick" });
    const padB = makePad(5, { fileName: "snare.wav", sampleId: "snare" });
    const kit = makeKit("test", [padA, padB]);

    const padMap = { ...useMPCStore.getState().padMap, 0: padA, 5: padB };
    useMPCStore.setState({ padMap, activeKit: kit });

    useMPCStore.getState().swapPad(0, 5);

    const { padMap: swappedMap, activeKit } = useMPCStore.getState();
    const exported = buildExportKit(activeKit, swappedMap);

    expect(exported).not.toBeNull();
    // After swap: slot 0 holds what was pad B; slot 5 holds what was pad A.
    const at0 = exported!.pads.find((p) => p.globalPadIdx === 0);
    const at5 = exported!.pads.find((p) => p.globalPadIdx === 5);
    expect(at0?.sampleId).toBe("snare");
    expect(at5?.sampleId).toBe("kick");
    expect(at0?.fileName).toBe("snare.wav");
    expect(at5?.fileName).toBe("kick.wav");
  });
});

// ── setPadTune ────────────────────────────────────────────────────────────────

describe("setPadTune", () => {
  it("updates coarseTune and fineTune on the pad", () => {
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().setPadTune(0, 12, 50);
    const updated = useMPCStore.getState().padMap[0];
    expect(updated?.coarseTune).toBe(12);
    expect(updated?.fineTune).toBe(50);
  });

  it("clamps coarseTune to [-36, 36]", () => {
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().setPadTune(0, 100, 0);
    expect(useMPCStore.getState().padMap[0]?.coarseTune).toBe(36);
    useMPCStore.getState().setPadTune(0, -100, 0);
    expect(useMPCStore.getState().padMap[0]?.coarseTune).toBe(-36);
  });

  it("clamps fineTune to [-100, 100]", () => {
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().setPadTune(0, 0, 200);
    expect(useMPCStore.getState().padMap[0]?.fineTune).toBe(100);
    useMPCStore.getState().setPadTune(0, 0, -200);
    expect(useMPCStore.getState().padMap[0]?.fineTune).toBe(-100);
  });

  it("rounds float inputs to integers", () => {
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().setPadTune(0, 3.7, 50.3);
    expect(useMPCStore.getState().padMap[0]?.coarseTune).toBe(4);
    expect(useMPCStore.getState().padMap[0]?.fineTune).toBe(50);
  });

  it("calls engine.setPadTune with clamped values", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().setPadTune(0, 12, 50);
    expect(engine.setPadTune).toHaveBeenCalledWith(0, 12, 50);
  });

  it("is a no-op when pad is null", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    useMPCStore.getState().setPadTune(99, 12, 50);
    expect(engine.setPadTune).not.toHaveBeenCalled();
  });
});

// ── setPadGain ────────────────────────────────────────────────────────────────

describe("setPadGain", () => {
  it("updates gainCoefficient on the pad", () => {
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().setPadGain(0, 0.5);
    expect(useMPCStore.getState().padMap[0]?.gainCoefficient).toBe(0.5);
  });

  it("clamps gainCoefficient to >= 0", () => {
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().setPadGain(0, -0.5);
    expect(useMPCStore.getState().padMap[0]?.gainCoefficient).toBe(0);
  });

  it("allows values > 1 (amplification)", () => {
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().setPadGain(0, 2.0);
    expect(useMPCStore.getState().padMap[0]?.gainCoefficient).toBe(2.0);
  });

  it("calls engine.setPadGain with the clamped value", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().setPadGain(0, 0.8);
    expect(engine.setPadGain).toHaveBeenCalledWith(0, 0.8);
  });

  it("is a no-op when pad is null", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    useMPCStore.getState().setPadGain(99, 0.5);
    expect(engine.setPadGain).not.toHaveBeenCalled();
  });
});

// ── setKitName ────────────────────────────────────────────────────────────────

describe("setKitName", () => {
  it("updates displayName and exportName on activeKit", () => {
    const kit = makeKit("test-kit", []);
    useMPCStore.setState({ activeKit: kit });
    useMPCStore.getState().setKitName("My Custom Kit");
    const updated = useMPCStore.getState().activeKit;
    expect(updated?.displayName).toBe("My Custom Kit");
    expect(updated?.exportName).toBe("My Custom Kit");
  });

  it("creates an immutable clone of activeKit", () => {
    const kit = makeKit("test-kit", []);
    useMPCStore.setState({ activeKit: kit });
    useMPCStore.getState().setKitName("Renamed");
    expect(useMPCStore.getState().activeKit).not.toBe(kit);
  });

  it("is a no-op when activeKit is null", () => {
    useMPCStore.setState({ activeKit: null });
    expect(() => useMPCStore.getState().setKitName("X")).not.toThrow();
  });
});

// ── setPadName ────────────────────────────────────────────────────────────────

describe("setPadName", () => {
  it("updates displayName on the pad", () => {
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().setPadName(0, "Kick");
    expect(useMPCStore.getState().padMap[0]?.displayName).toBe("Kick");
  });

  it("also updates sampleName so renames appear in the .xpj export", () => {
    const pad = makePad(0);
    useMPCStore.setState({
      padMap: { ...useMPCStore.getState().padMap, 0: pad },
    });
    useMPCStore.getState().setPadName(0, "Snare");
    expect(useMPCStore.getState().padMap[0]?.sampleName).toBe("Snare");
  });

  it("is a no-op when pad is null", () => {
    expect(() => useMPCStore.getState().setPadName(99, "X")).not.toThrow();
  });
});

// ── registerUserSample ────────────────────────────────────────────────────────

describe("registerUserSample", () => {
  it("stores bytes in the userSamples map", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    useMPCStore.getState().registerUserSample("my-sample-id", bytes);
    expect(useMPCStore.getState().userSamples.get("my-sample-id")).toBe(bytes);
  });

  it("creates a new Map reference for React change detection", () => {
    const before = useMPCStore.getState().userSamples;
    useMPCStore.getState().registerUserSample("x", new Uint8Array());
    const after = useMPCStore.getState().userSamples;
    expect(after).not.toBe(before);
  });

  it("accumulates multiple samples", () => {
    useMPCStore.getState().registerUserSample("a", new Uint8Array([1]));
    useMPCStore.getState().registerUserSample("b", new Uint8Array([2]));
    expect(useMPCStore.getState().userSamples.size).toBe(2);
  });
});

// ── Export / loading state setters ────────────────────────────────────────────

describe("setExporting", () => {
  it("sets isExporting to true", () => {
    useMPCStore.getState().setExporting(true);
    expect(useMPCStore.getState().isExporting).toBe(true);
  });

  it("sets isExporting to false", () => {
    useMPCStore.getState().setExporting(true);
    useMPCStore.getState().setExporting(false);
    expect(useMPCStore.getState().isExporting).toBe(false);
  });
});

describe("setExportProgress", () => {
  it("stores the progress object", () => {
    useMPCStore.getState().setExportProgress({ loaded: 5, total: 10 });
    expect(useMPCStore.getState().exportProgress).toEqual({ loaded: 5, total: 10 });
  });

  it("clears progress when null is passed", () => {
    useMPCStore.getState().setExportProgress({ loaded: 1, total: 1 });
    useMPCStore.getState().setExportProgress(null);
    expect(useMPCStore.getState().exportProgress).toBeNull();
  });
});

describe("setPadLoading", () => {
  it("marks a pad as loading", () => {
    useMPCStore.getState().setPadLoading(3, true);
    expect(useMPCStore.getState().loadingPads[3]).toBe(true);
  });

  it("removes the pad from loadingPads when set to false", () => {
    useMPCStore.getState().setPadLoading(3, true);
    useMPCStore.getState().setPadLoading(3, false);
    expect(useMPCStore.getState().loadingPads[3]).toBeUndefined();
  });
});

// ── triggerPad ────────────────────────────────────────────────────────────────

describe("triggerPad", () => {
  it("sets pad visual state to 'press'", () => {
    useMPCStore.getState().triggerPad(0);
    expect(useMPCStore.getState().pads[0]).toBe("press");
  });

  it("calls engine.trigger with idx and velocity", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    useMPCStore.getState().triggerPad(3, 0.75);
    expect(engine.trigger).toHaveBeenCalledWith(3, 0.75, undefined);
  });

  it("forwards optional time to engine.trigger", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    useMPCStore.getState().triggerPad(0, 0.85, 2.5);
    expect(engine.trigger).toHaveBeenCalledWith(0, 0.85, 2.5);
  });

  it("works without a time parameter (backwards compatible)", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    useMPCStore.getState().triggerPad(0, 0.85);
    expect(engine.trigger).toHaveBeenCalledWith(0, 0.85, undefined);
  });

  it("uses default velocity 0.9 when omitted", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    useMPCStore.getState().triggerPad(0);
    expect(engine.trigger).toHaveBeenCalledWith(0, 0.9, undefined);
  });

  it("sends a MIDI Note On via midiOutRef by default", () => {
    const midiOut = makeMidiOut();
    useMPCStore.setState({ midiOutRef: midiOut });
    useMPCStore.getState().triggerPad(4, 0.6);
    expect(midiOut.sendNoteOn).toHaveBeenCalledWith(4, 0.6);
  });

  it("does NOT send MIDI out when fromHardware=true (avoids echoing back to the device)", () => {
    const midiOut = makeMidiOut();
    useMPCStore.setState({ midiOutRef: midiOut });
    useMPCStore.getState().triggerPad(4, 0.6, undefined, true);
    expect(midiOut.sendNoteOn).not.toHaveBeenCalled();
  });

  it("works without a registered midiOutRef (no-op, no throw)", () => {
    useMPCStore.setState({ midiOutRef: null });
    expect(() => useMPCStore.getState().triggerPad(0)).not.toThrow();
  });
});

// ── pressPad / unpressPad ─────────────────────────────────────────────────────

describe("pressPad / unpressPad", () => {
  it("pressPad sets the pad visual state to 'press'", () => {
    useMPCStore.getState().pressPad(7);
    expect(useMPCStore.getState().pads[7]).toBe("press");
  });

  it("pressPad does NOT call engine.trigger (visual-only)", () => {
    const engine = makeEngine();
    useMPCStore.setState({ engineRef: engine });
    useMPCStore.getState().pressPad(2);
    expect(engine.trigger).not.toHaveBeenCalled();
  });

  it("unpressPad sets the pad visual state to 'armed'", () => {
    useMPCStore.getState().pressPad(5);
    useMPCStore.getState().unpressPad(5);
    expect(useMPCStore.getState().pads[5]).toBe("armed");
  });
});

// ── releasePad ────────────────────────────────────────────────────────────────

describe("releasePad", () => {
  it("resets pad state to 'armed' after the release delay", async () => {
    vi.useFakeTimers();
    useMPCStore.getState().triggerPad(0);
    expect(useMPCStore.getState().pads[0]).toBe("press");
    useMPCStore.getState().releasePad(0);
    await vi.runAllTimersAsync();
    expect(useMPCStore.getState().pads[0]).toBe("armed");
    vi.useRealTimers();
  });

  it("sends a MIDI Note Off via midiOutRef by default", () => {
    const midiOut = makeMidiOut();
    useMPCStore.setState({ midiOutRef: midiOut });
    useMPCStore.getState().releasePad(4);
    expect(midiOut.sendNoteOff).toHaveBeenCalledWith(4);
  });

  it("does NOT send MIDI out when fromHardware=true", () => {
    const midiOut = makeMidiOut();
    useMPCStore.setState({ midiOutRef: midiOut });
    useMPCStore.getState().releasePad(4, true);
    expect(midiOut.sendNoteOff).not.toHaveBeenCalled();
  });
});

// ── setVisualizerMode ─────────────────────────────────────────────────────────

describe("setVisualizerMode", () => {
  it("sets visualizerMode to 'oscilloscope'", () => {
    useMPCStore.getState().setVisualizerMode("oscilloscope");
    expect(useMPCStore.getState().visualizerMode).toBe("oscilloscope");
  });

  it("sets visualizerMode back to 'fft'", () => {
    useMPCStore.getState().setVisualizerMode("oscilloscope");
    useMPCStore.getState().setVisualizerMode("fft");
    expect(useMPCStore.getState().visualizerMode).toBe("fft");
  });
});

// ── setHudVisible ────────────────────────────────────────────────────────────

describe("setHudVisible", () => {
  it("defaults to true", () => {
    expect(useMPCStore.getState().hudVisible).toBe(true);
  });

  it("sets hudVisible to false", () => {
    useMPCStore.getState().setHudVisible(false);
    expect(useMPCStore.getState().hudVisible).toBe(false);
  });

  it("sets hudVisible back to true", () => {
    useMPCStore.getState().setHudVisible(false);
    useMPCStore.getState().setHudVisible(true);
    expect(useMPCStore.getState().hudVisible).toBe(true);
  });

  it("does not clobber other persisted-setting fields when set", () => {
    useMPCStore.getState().setVisualizerMode("fft");
    useMPCStore.getState().setHudVisible(false);
    expect(useMPCStore.getState().visualizerMode).toBe("fft");
  });

  it("is not clobbered by other persisted-setting setters", () => {
    useMPCStore.getState().setHudVisible(false);
    useMPCStore.getState().setVisualizerMode("oscilloscope");
    expect(useMPCStore.getState().hudVisible).toBe(false);
  });
});
