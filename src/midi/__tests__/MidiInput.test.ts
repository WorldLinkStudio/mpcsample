import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MidiEvent, MidiStatus } from "../../types/mpc.types";
import { MidiInput } from "../MidiInput";

// ---------------------------------------------------------------------------
// Mock MIDI infrastructure
// ---------------------------------------------------------------------------

type MockInput = {
  name: string;
  onmidimessage: ((e: MIDIMessageEvent) => void) | null;
  /** Helper: fire a raw MIDI message at this input */
  fire(data: number[]): void;
};

type MockOutput = {
  name: string;
  send: ReturnType<typeof vi.fn>;
};

function makeMockOutput(name: string): MockOutput {
  return { name, send: vi.fn() };
}

function makeMockInput(name: string): MockInput {
  const inp: MockInput = {
    name,
    onmidimessage: null,
    fire(data: number[]) {
      if (inp.onmidimessage) {
        const event = {
          data: new Uint8Array(data),
        } as unknown as MIDIMessageEvent;
        inp.onmidimessage(event);
      }
    },
  };
  return inp;
}

type MockMIDIAccess = {
  inputs: Map<string, MockInput>;
  outputs: Map<string, MockOutput>;
  onstatechange: (() => void) | null;
};

function makeMockAccess(inputList: MockInput[], outputList: MockOutput[] = []): MockMIDIAccess {
  const inputs = new Map<string, MockInput>();
  inputList.forEach((inp, i) => {
    inputs.set(String(i), inp);
  });
  const outputs = new Map<string, MockOutput>();
  outputList.forEach((out, i) => {
    outputs.set(String(i), out);
  });
  return { inputs, outputs, onstatechange: null };
}

// Save / restore original navigator
const originalNavigator = globalThis.navigator;

function setMidiAccess(accessOrError: MockMIDIAccess | Error) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      requestMIDIAccess: (_opts: { sysex: boolean }) => {
        if (accessOrError instanceof Error) {
          return Promise.reject(accessOrError);
        }
        return Promise.resolve(accessOrError);
      },
    },
  });
}

function removeMidiFromNavigator() {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {},
  });
}

afterEach(() => {
  // Restore navigator
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: originalNavigator,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MidiInput — navigator.requestMIDIAccess missing", () => {
  it("emits 'unsupported' when Web MIDI API is absent", async () => {
    removeMidiFromNavigator();
    const statuses: MidiStatus[] = [];
    const midi = new MidiInput({
      onStatusChange: (s) => statuses.push(s),
    });
    await midi.start();
    expect(statuses).toContain("unsupported");
  });
});

describe("MidiInput — permission denied", () => {
  it("emits 'denied' when requestMIDIAccess rejects", async () => {
    setMidiAccess(new Error("Permission denied"));
    const statuses: MidiStatus[] = [];
    const midi = new MidiInput({
      onStatusChange: (s) => statuses.push(s),
    });
    await midi.start();
    expect(statuses).toContain("denied");
  });
});

describe("MidiInput — no devices", () => {
  it("emits 'no-devices' when access has zero inputs", async () => {
    const access = makeMockAccess([]);
    setMidiAccess(access);
    const statuses: MidiStatus[] = [];
    const midi = new MidiInput({
      onStatusChange: (s) => statuses.push(s),
    });
    await midi.start();
    expect(statuses).toContain("no-devices");
  });
});

describe("MidiInput — connected", () => {
  let access: MockMIDIAccess;
  let inputA: MockInput;
  let midi: MidiInput;
  const statuses: Array<[MidiStatus, string | null]> = [];
  const events: MidiEvent[] = [];

  beforeEach(async () => {
    inputA = makeMockInput("APC-Key 25");
    access = makeMockAccess([inputA]);
    setMidiAccess(access);
    statuses.length = 0;
    events.length = 0;
    midi = new MidiInput({
      onStatusChange: (s, name) => statuses.push([s, name]),
      onEvent: (e) => events.push(e),
    });
    await midi.start();
  });

  afterEach(() => {
    midi.stop();
  });

  it("emits 'connected' with device name", () => {
    const last = statuses[statuses.length - 1];
    expect(last[0]).toBe("connected");
    expect(last[1]).toBe("APC-Key 25");
  });

  it("binds onmidimessage to the input", () => {
    expect(inputA.onmidimessage).toBeTypeOf("function");
  });

  // ---- Note On -------------------------------------------------------
  it("Note On 0x90 note=36 vel=100 → noteOn padIdx=0 velocity=100/127", () => {
    inputA.fire([0x90, 36, 100]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "noteOn",
      padIdx: 0,
      velocity: 100 / 127,
    });
  });

  it("Note On note=51 vel=127 → noteOn padIdx=15", () => {
    inputA.fire([0x90, 51, 127]);
    expect(events[0]).toMatchObject({ type: "noteOn", padIdx: 15 });
  });

  it("Note On note=37 vel=64 → noteOn padIdx=1 velocity=64/127", () => {
    inputA.fire([0x90, 37, 64]);
    expect(events[0]).toMatchObject({
      type: "noteOn",
      padIdx: 1,
      velocity: 64 / 127,
    });
  });

  // ---- Note On vel=0 (running-status note-off) -----------------------
  it("Note On note=36 vel=0 → noteOff padIdx=0", () => {
    inputA.fire([0x90, 36, 0]);
    expect(events[0]).toEqual({ type: "noteOff", padIdx: 0 });
  });

  it("Note On note=37 vel=0 → noteOff padIdx=1", () => {
    inputA.fire([0x90, 37, 0]);
    expect(events[0]).toEqual({ type: "noteOff", padIdx: 1 });
  });

  // ---- Note Off 0x80 -------------------------------------------------
  it("Note Off 0x80 note=36 → noteOff padIdx=0", () => {
    inputA.fire([0x80, 36, 0]);
    expect(events[0]).toEqual({ type: "noteOff", padIdx: 0 });
  });

  it("Note Off 0x80 note=51 → noteOff padIdx=15", () => {
    inputA.fire([0x80, 51, 64]);
    expect(events[0]).toEqual({ type: "noteOff", padIdx: 15 });
  });

  // ---- CC 0xb0 -------------------------------------------------------
  it("CC 0xb0 controller=2 value=64 → cc {controller:2, value:64/127}", () => {
    inputA.fire([0xb0, 2, 64]);
    expect(events[0]).toEqual({ type: "cc", controller: 2, value: 64 / 127 });
  });

  it("CC controller=1 value=0 → cc {controller:1, value:0}", () => {
    inputA.fire([0xb0, 1, 0]);
    expect(events[0]).toEqual({ type: "cc", controller: 1, value: 0 });
  });

  it("CC controller=127 value=127 → cc {controller:127, value:1}", () => {
    inputA.fire([0xb0, 127, 127]);
    expect(events[0]).toMatchObject({ type: "cc", controller: 127, value: 1 });
  });

  // ---- Below-range notes (no event) -----------------------------------
  it("Note On note=35 (below range) → no event emitted", () => {
    inputA.fire([0x90, 35, 100]);
    expect(events).toHaveLength(0);
  });

  it("Note Off note=35 (below range) → no event emitted", () => {
    inputA.fire([0x80, 35, 0]);
    expect(events).toHaveLength(0);
  });

  // ---- Higher banks (verified against real MPC Sample hardware): the
  // note number is shifted by 16 per physical bank, so note=52 is Bank B's
  // first pad (global index 16), not "out of range". ----------------------
  it("Note On note=52 (Bank B pad 1) → noteOn padIdx=16", () => {
    inputA.fire([0x90, 52, 100]);
    expect(events).toEqual([{ type: "noteOn", padIdx: 16, velocity: 100 / 127 }]);
  });

  it("Note On note=127 (max MIDI note, Bank F pad 12) → noteOn padIdx=91", () => {
    inputA.fire([0x90, 127, 100]);
    expect(events).toEqual([{ type: "noteOn", padIdx: 91, velocity: 100 / 127 }]);
  });

  // ---- Malformed message (length < 2) --------------------------------
  it("1-byte message (malformed) → no event emitted", () => {
    const e = { data: new Uint8Array([0x90]) } as unknown as MIDIMessageEvent;
    // Access the private parseMessage via the bound handler
    inputA.onmidimessage?.(e);
    expect(events).toHaveLength(0);
  });

  it("null data → no event emitted", () => {
    const e = { data: null } as unknown as MIDIMessageEvent;
    inputA.onmidimessage?.(e);
    expect(events).toHaveLength(0);
  });
});

describe("MidiInput — stop()", () => {
  it("clears onmidimessage and emits 'idle'", async () => {
    const inputA = makeMockInput("Launchpad");
    const access = makeMockAccess([inputA]);
    setMidiAccess(access);
    const statuses: MidiStatus[] = [];
    const midi = new MidiInput({
      onStatusChange: (s) => statuses.push(s),
    });
    await midi.start();
    expect(inputA.onmidimessage).not.toBeNull();
    midi.stop();
    expect(inputA.onmidimessage).toBeNull();
    expect(statuses[statuses.length - 1]).toBe("idle");
  });

  it("stop() on an already-stopped instance is a no-op", () => {
    const midi = new MidiInput();
    expect(() => midi.stop()).not.toThrow();
  });
});

describe("MidiInput — setHandlers()", () => {
  it("replaces handlers after construction", async () => {
    const inputA = makeMockInput("Pad");
    const access = makeMockAccess([inputA]);
    setMidiAccess(access);
    const events1: MidiEvent[] = [];
    const events2: MidiEvent[] = [];
    const midi = new MidiInput({ onEvent: (e) => events1.push(e) });
    await midi.start();
    inputA.fire([0x90, 36, 100]);
    expect(events1).toHaveLength(1);
    midi.setHandlers({ onEvent: (e) => events2.push(e) });
    inputA.fire([0x90, 36, 100]);
    expect(events1).toHaveLength(1); // unchanged
    expect(events2).toHaveLength(1); // new handler fired
  });
});

describe("MidiInput — searching status", () => {
  it("emits 'searching' before the access promise resolves", async () => {
    let resolveAccess!: (a: MockMIDIAccess) => void;
    const pending = new Promise<MockMIDIAccess>((res) => {
      resolveAccess = res;
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: { requestMIDIAccess: () => pending },
    });
    const statuses: MidiStatus[] = [];
    const midi = new MidiInput({ onStatusChange: (s) => statuses.push(s) });
    const startPromise = midi.start();
    // Before resolving, we should have 'searching'
    expect(statuses).toContain("searching");
    // Now resolve
    resolveAccess(makeMockAccess([makeMockInput("X")]));
    await startPromise;
    expect(statuses).toContain("connected");
  });
});

describe("MidiInput — onstatechange hot-plug", () => {
  it("re-evaluates inputs when onstatechange fires", async () => {
    const access = makeMockAccess([]); // start with no devices
    setMidiAccess(access);
    const statuses: MidiStatus[] = [];
    const midi = new MidiInput({ onStatusChange: (s) => statuses.push(s) });
    await midi.start();
    expect(statuses).toContain("no-devices");
    // Hot-plug: add an input and fire statechange
    const newInput = makeMockInput("Hot Device");
    access.inputs.set("0", newInput);
    access.onstatechange?.();
    expect(statuses[statuses.length - 1]).toBe("connected");
  });
});

describe("MidiInput — MIDI output (MidiOutputLike)", () => {
  it("hasOutput() is false with no output ports, true once one is present", async () => {
    const noOutputAccess = makeMockAccess([makeMockInput("In")]);
    setMidiAccess(noOutputAccess);
    const midiNoOut = new MidiInput();
    await midiNoOut.start();
    expect(midiNoOut.hasOutput()).toBe(false);

    const outputAccess = makeMockAccess([makeMockInput("In")], [makeMockOutput("Out")]);
    setMidiAccess(outputAccess);
    const midiWithOut = new MidiInput();
    await midiWithOut.start();
    expect(midiWithOut.hasOutput()).toBe(true);
  });

  it("sendNoteOn sends a Note On (0x90) with the note derived from padIdx + 36", async () => {
    const out = makeMockOutput("Out");
    setMidiAccess(makeMockAccess([makeMockInput("In")], [out]));
    const midi = new MidiInput();
    await midi.start();

    midi.sendNoteOn(16, 0.5); // Bank B pad 1 → note 52
    expect(out.send).toHaveBeenCalledWith([0x90, 52, Math.round(0.5 * 127)]);
  });

  it("sendNoteOff sends a Note Off (0x80) with velocity 0", async () => {
    const out = makeMockOutput("Out");
    setMidiAccess(makeMockAccess([makeMockInput("In")], [out]));
    const midi = new MidiInput();
    await midi.start();

    midi.sendNoteOff(0); // Bank A pad 1 → note 36
    expect(out.send).toHaveBeenCalledWith([0x80, 36, 0]);
  });

  it("sends to every connected output port", async () => {
    const outA = makeMockOutput("A");
    const outB = makeMockOutput("B");
    setMidiAccess(makeMockAccess([makeMockInput("In")], [outA, outB]));
    const midi = new MidiInput();
    await midi.start();

    midi.sendNoteOn(0, 1);
    expect(outA.send).toHaveBeenCalledOnce();
    expect(outB.send).toHaveBeenCalledOnce();
  });

  it("does not send a note that can't be represented (padIdx too high)", async () => {
    const out = makeMockOutput("Out");
    setMidiAccess(makeMockAccess([makeMockInput("In")], [out]));
    const midi = new MidiInput();
    await midi.start();

    midi.sendNoteOn(127, 1); // note = 127 + 36 = 163, out of MIDI's 0-127 range
    expect(out.send).not.toHaveBeenCalled();
  });

  it("clears outputs on stop() — hasOutput() becomes false", async () => {
    const out = makeMockOutput("Out");
    setMidiAccess(makeMockAccess([makeMockInput("In")], [out]));
    const midi = new MidiInput();
    await midi.start();
    expect(midi.hasOutput()).toBe(true);

    midi.stop();
    expect(midi.hasOutput()).toBe(false);
  });

  it("sendNoteOn/sendNoteOff are no-ops (don't throw) with no output connected", async () => {
    setMidiAccess(makeMockAccess([makeMockInput("In")]));
    const midi = new MidiInput();
    await midi.start();
    expect(() => midi.sendNoteOn(0, 1)).not.toThrow();
    expect(() => midi.sendNoteOff(0)).not.toThrow();
  });
});
