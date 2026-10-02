/**
 * buildSequence.test.ts — Unit tests for native `.xpj` sequence export.
 *
 * Test coverage:
 *  - hasActiveSteps: true/false detection
 *  - injectSequencePattern: tick math for each resolution (8n/16n/32n)
 *  - injectSequencePattern: note.note = padIdx + 36
 *  - injectSequencePattern: clip ends up keyed under the renamed track, not the original
 *  - injectSequencePattern: empty pattern leaves sequences untouched
 *  - injectSequencePattern: multi-pad multi-step patterns produce events sorted by time
 *  - buildXpj: end-to-end wiring (pattern flows through to the real template)
 */

import { describe, expect, it } from "vitest";
import type { SampleKit, SamplePad } from "../../kits/kit.types";
import { createEmptyPattern } from "../../sequencer/sequencer.types";
import { hasActiveSteps, injectSequencePattern } from "../buildSequence";
import { buildXpj } from "../buildXpj";
import { decodeXpj, loadTemplate } from "../codec";
import { isRawNum } from "../jsonLossless";

function numOf(v: unknown): number {
  return isRawNum(v) ? Number((v as { __raw__: string }).__raw__) : (v as number);
}

function makePad(globalPadIdx: number, fileName: string): SamplePad {
  return {
    globalPadIdx,
    sampleId: `sample-${globalPadIdx}`,
    displayName: `Pad ${globalPadIdx}`,
    sampleName: fileName.replace(/\.wav$/, ""),
    fileName,
    url: null,
    coarseTune: 0,
    fineTune: 0,
    gainCoefficient: 1.0,
    pan: 0.5,
  };
}

function makeKit(pads: SamplePad[], overrides: Partial<SampleKit> = {}): SampleKit {
  return {
    id: "test-kit",
    displayName: "Test Kit",
    exportName: "TestKit",
    key: "C Minor",
    bpm: 114,
    pads,
    ...overrides,
  };
}

function makeBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`WAV:${label}`);
}

type ClipMapEntry = { key: unknown; value: Record<string, unknown> };
type SequenceEntry = { key: unknown; value: Record<string, unknown> };
type NoteEvent = {
  time: unknown;
  note?: { note: unknown; velocity: unknown; length: unknown };
};

function getSequences(data: Record<string, unknown>): SequenceEntry[] {
  return data.sequences as SequenceEntry[];
}

function getTargetClip(data: Record<string, unknown>, trackName: string): ClipMapEntry {
  const seq = getSequences(data).find((s) => numOf(s.key) === 0);
  if (!seq) throw new Error("sequence slot 0 not found");
  const clipEntries = (seq.value.trackClipMaps as ClipMapEntry[][])[0];
  const clip = clipEntries.find((e) => e.key === trackName);
  if (!clip) throw new Error(`clip for track "${trackName}" not found`);
  return clip;
}

function getEvents(data: Record<string, unknown>, trackName: string): NoteEvent[] {
  const clip = getTargetClip(data, trackName);
  return (clip.value.eventList as { events: NoteEvent[] }).events;
}

// ---------------------------------------------------------------------------
// hasActiveSteps
// ---------------------------------------------------------------------------

describe("hasActiveSteps", () => {
  it("returns false for a freshly created empty pattern", () => {
    expect(hasActiveSteps(createEmptyPattern())).toBe(false);
  });

  it("returns true once any step is active", () => {
    const pattern = createEmptyPattern(1, "16n");
    pattern.steps[0] = Array.from({ length: 16 }, (_, i) => ({ active: i === 0, velocity: 0.9 }));
    expect(hasActiveSteps(pattern)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// injectSequencePattern (via buildXpj, exercising the real template)
// ---------------------------------------------------------------------------

describe("injectSequencePattern", () => {
  it("leaves sequences untouched for an empty pattern", async () => {
    const kit = makeKit([makePad(0, "kick.wav")]);
    const bytes = new Map([["kick.wav", makeBytes("kick")]]);
    const tmpl = await loadTemplate();

    const withoutPattern = buildXpj(tmpl, kit, bytes);
    const withEmptyPattern = buildXpj(tmpl, kit, bytes, createEmptyPattern());

    const { data: d1 } = decodeXpj(withoutPattern.xpjBytes);
    const { data: d2 } = decodeXpj(withEmptyPattern.xpjBytes);
    expect(d2.data.sequences).toEqual(d1.data.sequences);
  });

  it("writes note events keyed under the renamed track, not the original template name", async () => {
    const kit = makeKit([makePad(0, "kick.wav")], { exportName: "MyBeat" });
    const bytes = new Map([["kick.wav", makeBytes("kick")]]);
    const tmpl = await loadTemplate();

    const pattern = createEmptyPattern(1, "16n");
    pattern.steps[0] = Array.from({ length: 16 }, (_, i) => ({ active: i === 0, velocity: 0.9 }));

    const built = buildXpj(tmpl, kit, bytes, pattern);
    const { data } = decodeXpj(built.xpjBytes);

    // The renamed track's clip has our event.
    const events = getEvents(data.data, "MyBeat");
    expect(events).toHaveLength(1);

    // No clip remains keyed under the template's original track name.
    const seq = getSequences(data.data).find((s) => numOf(s.key) === 0);
    const clipEntries = (seq?.value.trackClipMaps as ClipMapEntry[][])[0];
    expect(clipEntries.some((e) => e.key === "Drum 001")).toBe(false);
  });

  it("maps padIdx to note = padIdx + 36", async () => {
    const kit = makeKit([makePad(32, "clap.wav")]);
    const bytes = new Map([["clap.wav", makeBytes("clap")]]);
    const tmpl = await loadTemplate();

    const pattern = createEmptyPattern(1, "16n");
    pattern.steps[32] = Array.from({ length: 16 }, (_, i) => ({ active: i === 0, velocity: 1 }));

    const built = buildXpj(tmpl, kit, bytes, pattern);
    const { data } = decodeXpj(built.xpjBytes);
    const events = getEvents(data.data, kit.exportName);

    expect(events).toHaveLength(1);
    expect(numOf(events[0].note?.note)).toBe(68); // 32 + 36
  });

  it.each([
    ["8n", 480],
    ["16n", 240],
    ["32n", 120],
  ] as const)("computes tick spacing for resolution %s (%d ticks/step)", async (resolution, ticksPerStep) => {
    const kit = makeKit([makePad(0, "kick.wav")]);
    const bytes = new Map([["kick.wav", makeBytes("kick")]]);
    const tmpl = await loadTemplate();

    const pattern = createEmptyPattern(1, resolution);
    const total = pattern.steps[0]?.length ?? 4 * (960 / ticksPerStep);
    pattern.steps[0] = Array.from({ length: total }, (_, i) => ({
      active: i === 0 || i === 1,
      velocity: 0.9,
    }));

    const built = buildXpj(tmpl, kit, bytes, pattern);
    const { data } = decodeXpj(built.xpjBytes);
    const events = getEvents(data.data, kit.exportName);

    expect(events).toHaveLength(2);
    expect(numOf(events[0].time)).toBe(0);
    expect(numOf(events[1].time)).toBe(ticksPerStep);
  });

  it("produces events sorted by time across multiple pads", async () => {
    const kit = makeKit([makePad(0, "kick.wav"), makePad(1, "snare.wav")]);
    const bytes = new Map([
      ["kick.wav", makeBytes("kick")],
      ["snare.wav", makeBytes("snare")],
    ]);
    const tmpl = await loadTemplate();

    const pattern = createEmptyPattern(1, "16n");
    // Pad 1 (snare) fires earlier in the pattern than pad 0 (kick), to prove
    // sort order isn't just insertion order.
    pattern.steps[1] = Array.from({ length: 16 }, (_, i) => ({ active: i === 0, velocity: 0.9 }));
    pattern.steps[0] = Array.from({ length: 16 }, (_, i) => ({ active: i === 4, velocity: 0.9 }));

    const built = buildXpj(tmpl, kit, bytes, pattern);
    const { data } = decodeXpj(built.xpjBytes);
    const events = getEvents(data.data, kit.exportName);

    expect(events).toHaveLength(2);
    expect(numOf(events[0].note?.note)).toBe(37); // pad 1, earlier in time
    expect(numOf(events[1].note?.note)).toBe(36); // pad 0, later in time
    expect(numOf(events[0].time)).toBeLessThan(numOf(events[1].time));
  });

  it("carries per-step velocity through to note.velocity", async () => {
    const kit = makeKit([makePad(0, "kick.wav")]);
    const bytes = new Map([["kick.wav", makeBytes("kick")]]);
    const tmpl = await loadTemplate();

    const pattern = createEmptyPattern(1, "16n");
    pattern.steps[0] = Array.from({ length: 16 }, (_, i) => ({
      active: i === 0,
      velocity: 0.42,
    }));

    const built = buildXpj(tmpl, kit, bytes, pattern);
    const { data } = decodeXpj(built.xpjBytes);
    const events = getEvents(data.data, kit.exportName);

    expect(numOf(events[0].note?.velocity)).toBeCloseTo(0.42);
  });

  it("round-trips through decodeXpj without throwing when a pattern is included", async () => {
    const kit = makeKit([makePad(0, "kick.wav")]);
    const bytes = new Map([["kick.wav", makeBytes("kick")]]);
    const tmpl = await loadTemplate();

    const pattern = createEmptyPattern(2, "16n");
    pattern.steps[0] = Array.from({ length: 32 }, (_, i) => ({
      active: i % 4 === 0,
      velocity: 0.9,
    }));

    const built = buildXpj(tmpl, kit, bytes, pattern);
    expect(() => decodeXpj(built.xpjBytes)).not.toThrow();
  });

  it("is a no-op when called directly with an empty pattern", async () => {
    const tmpl = await loadTemplate();
    const before = JSON.stringify(tmpl.data);
    injectSequencePattern(tmpl, createEmptyPattern(), "Drum 001", "Renamed", 120);
    expect(JSON.stringify(tmpl.data)).toBe(before);
  });
});
