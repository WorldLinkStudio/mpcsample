/**
 * buildSequence.ts — Injects a step-sequencer `Pattern` into an `.xpj`'s
 * native sequence data.
 *
 * Reverse-engineered from a real recorded `.xpj` project (see the "Native
 * `.xpj` sequence export" plan): sequence note events do NOT live in the
 * always-empty `sequences[].value.seqEventList` — they live per-track, at
 * `sequences[].value.trackClipMaps[0][entryIdx].value.eventList.events`,
 * where `trackClipMaps[0]` is a `{key: <trackName>, value: <clip>}` array
 * with one entry per track in the project.
 *
 * Every number in a template parsed via `parseLossless` (see `codec.ts`) is
 * tagged as a `RawNum` (`{__raw__: "<lexeme>"}`), including plain integers —
 * `numOf` unwraps these for arithmetic; `floatTag` re-wraps values that must
 * round-trip with a decimal point (the firmware requires this for float
 * fields such as note velocity and BPM).
 */

import type { Pattern, StepResolution } from "../sequencer/sequencer.types";
import { STEPS_PER_BEAT } from "../sequencer/sequencer.types";
import type { XpjData } from "./codec";
import { floatTag } from "./codec";
import { isRawNum } from "./jsonLossless";

const BEATS_PER_BAR = 4;
/** Reserved sequence slot for the exported step-sequencer pattern. */
const TARGET_SEQUENCE_KEY = 0;

function numOf(v: unknown): number {
  return isRawNum(v) ? Number(v.__raw__) : (v as number);
}

/** True if any pad in the pattern has at least one active step. */
export function hasActiveSteps(pattern: Pattern): boolean {
  return Object.values(pattern.steps).some((steps) => steps.some((s) => s.active));
}

type ClipMapEntry = { key: unknown; value: Record<string, unknown> };
type SequenceEntry = { key: unknown; value: Record<string, unknown> };
type NoteEvent = {
  time: unknown;
  type: unknown;
  note?: { note: unknown; velocity: unknown; length: unknown; [key: string]: unknown };
  [key: string]: unknown;
};

/** Find the first `type === 3` (Note) event anywhere in a sequence's clips — used as a field-complete prototype. */
function findNoteEventPrototype(sequences: SequenceEntry[]): NoteEvent | undefined {
  for (const seq of sequences) {
    const trackClipMaps = seq.value.trackClipMaps as ClipMapEntry[][] | undefined;
    for (const clip of trackClipMaps?.[0] ?? []) {
      const events = (clip.value.eventList as { events?: NoteEvent[] } | undefined)?.events;
      const found = events?.find((e) => numOf(e.type) === 3 && e.note);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Mutate `data.data` in place, writing `pattern` into sequence slot
 * `TARGET_SEQUENCE_KEY`'s clip for the track named `newTrackName`.
 *
 * `originalTrackName` is the track's name as it appears in the *template*
 * (before `buildXpj` renames it to the user's export name) — the clip
 * prototype must be looked up under that name, since that's what the
 * template's `trackClipMaps` keys are still set to at this point.
 *
 * No-op (leaves the template's sequences untouched) if the pattern has no
 * active steps, or if the expected template shape isn't found.
 */
export function injectSequencePattern(
  data: XpjData,
  pattern: Pattern,
  originalTrackName: string,
  newTrackName: string,
  bpm: number,
): void {
  if (!hasActiveSteps(pattern)) return;

  const dataRoot = data.data as Record<string, unknown>;
  const sequences = dataRoot.sequences as SequenceEntry[] | undefined;
  if (!sequences || sequences.length === 0) return;

  const targetIdx = sequences.findIndex((s) => numOf(s.key) === TARGET_SEQUENCE_KEY);
  const sourceEntry = sequences[targetIdx >= 0 ? targetIdx : 0];
  const seqValue = structuredClone(sourceEntry.value);

  const timeSignatures = (
    seqValue.timeSignatureTrack as { timeSignatures: Array<{ beatLength: unknown }> }
  ).timeSignatures;
  const beatLength = numOf(timeSignatures[0].beatLength);
  const ticksPerStep = beatLength / STEPS_PER_BEAT[pattern.resolution as StepResolution];
  const lengthPulses = pattern.bars * BEATS_PER_BAR * beatLength;

  seqValue.name = "Step Sequencer";
  seqValue.bpm = floatTag(bpm);
  seqValue.lengthBars = pattern.bars;
  seqValue.loopStartBar = 0;
  seqValue.loopEndBar = pattern.bars;
  seqValue.lengthPulses = lengthPulses;
  seqValue.loopStartPulses = 0;
  seqValue.loopEndPulses = lengthPulses;

  const trackClipMaps = seqValue.trackClipMaps as ClipMapEntry[][];
  const clipEntries = trackClipMaps[0];
  const clipIdx = clipEntries.findIndex((e) => e.key === originalTrackName);
  if (clipIdx < 0) return;

  const clip = structuredClone(clipEntries[clipIdx]);
  clip.key = newTrackName;
  clip.value.name = newTrackName;
  clip.value.startPulses = 0;
  clip.value.endPulses = lengthPulses;
  clip.value.loopStartPulses = 0;
  clip.value.loopEndPulses = lengthPulses;

  const eventPrototype = findNoteEventPrototype(sequences);
  if (!eventPrototype) return;

  const events: NoteEvent[] = [];
  for (const [padIdxStr, steps] of Object.entries(pattern.steps)) {
    const padIdx = Number(padIdxStr);
    steps.forEach((step, stepIndex) => {
      if (!step.active) return;
      const event = structuredClone(eventPrototype);
      event.time = stepIndex * ticksPerStep;
      // biome-ignore lint/style/noNonNullAssertion: eventPrototype was matched on `e.note` being truthy
      event.note!.note = padIdx + 36;
      // biome-ignore lint/style/noNonNullAssertion: see above
      event.note!.velocity = floatTag(step.velocity);
      // biome-ignore lint/style/noNonNullAssertion: see above
      event.note!.length = Math.max(1, Math.round(ticksPerStep) - 1);
      events.push(event);
    });
  }
  events.sort((a, b) => numOf(a.time) - numOf(b.time));

  const eventList = clip.value.eventList as { events: NoteEvent[] };
  eventList.events = events;

  clipEntries[clipIdx] = clip;
  sequences[targetIdx >= 0 ? targetIdx : 0] = { key: TARGET_SEQUENCE_KEY, value: seqValue };
}
