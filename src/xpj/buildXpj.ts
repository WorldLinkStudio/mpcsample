/**
 * buildXpj.ts — TypeScript port of `make_xpj.py` / `reset_pads` / `assign_pad`.
 *
 * Pure function: takes a template, a `SampleKit`, and a map of file bytes,
 * and returns the encoded `.xpj` bytes + the sample files to include in the ZIP.
 *
 * Mirrors the Python reference writer exactly:
 *  1. structuredClone the template
 *  2. resetPads — overwrite all 128 instruments with a blank prototype
 *  3. For each populated pad: assignPad sets layersv[0] fields; build a
 *     sample entry for data.samples / track.samples
 *  4. De-dupe sample arrays by `path` (a sample file reused on multiple pads
 *     produces one entry each in data.samples and track.samples)
 *  5. Set track.name = kit.exportName; data.data.key = kit.key
 *  6. encodeXpj → gzipped bytes
 */

import type { SampleKit, SamplePad } from "../kits/kit.types";
import type { Pattern } from "../sequencer/sequencer.types";
import { injectSequencePattern } from "./buildSequence";
import { encodeXpj, floatTag, type XpjData } from "./codec";
import { floatNum } from "./jsonLossless";

type LayerVolume = {
  gainCoefficient: unknown;
  controlValue: unknown;
  law: unknown;
};

type SliceInfo = {
  Start: unknown;
  End: unknown;
  [key: string]: unknown;
};

type Layer = {
  sampleName: string;
  sampleFile: string;
  volume: LayerVolume;
  pan: unknown;
  coarseTune: unknown;
  fineTune: unknown;
  sampleStart?: unknown;
  sampleEnd?: unknown;
  sliceInfo?: SliceInfo;
  [key: string]: unknown;
};

type Instrument = {
  coarseTune: unknown;
  fineTune: unknown;
  lowNote: unknown;
  highNote: unknown;
  layersv: Layer[];
  [key: string]: unknown;
};

type SampleEntry = {
  version: number;
  name: string;
  path: string;
  loadImpl: number;
  metadata: {
    tempo: unknown;
    rootNote: number;
    tune: unknown;
    key: string;
  };
};

/** The output of `buildXpj` — ready to assemble into a ZIP archive. */
export type BuiltXpj = {
  /** Gzip-encoded `.xpj` file bytes. */
  xpjBytes: Uint8Array;
  /** Stem name for the exported project (`<projectName>.xpj`). */
  projectName: string;
  /**
   * Sample files to write into `<projectName>_[ProjectData]/`.
   * De-duplicated: one entry per unique `path`.
   */
  sampleFiles: Array<{ path: string; bytes: Uint8Array }>;
};

/**
 * Count the number of sample frames (per-channel samples) in a WAV byte buffer.
 *
 * Walks the RIFF chunk list to find `fmt ` (for the block align) and `data`
 * (for the audio size), then returns `dataSize / blockAlign`.
 *
 * The MPC's `sampleEnd` / `sliceInfo.End` are expressed in sample frames; a
 * value of 0 produces a zero-length playback region that never sounds, so a
 * correct frame count is essential for the exported pads to play.
 *
 * Returns 0 if the bytes are not a parseable WAV (e.g. test fixtures), in which
 * case the caller leaves the template's default `sampleEnd` untouched.
 */
export function wavFrameCount(bytes: Uint8Array): number {
  // Minimum: 12-byte RIFF/WAVE header + an 8-byte chunk header.
  if (bytes.byteLength < 20) return 0;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const ascii = (off: number): string =>
    String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);

  if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return 0;

  let blockAlign = 0;
  let dataSize = 0;

  // Walk chunks starting after the 12-byte RIFF/WAVE header.
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;

    if (chunkId === "fmt " && bodyStart + 16 <= bytes.byteLength) {
      // fmt body: [audioFormat u16][channels u16][sampleRate u32]
      //           [byteRate u32][blockAlign u16][bitsPerSample u16]
      blockAlign = view.getUint16(bodyStart + 12, true);
    } else if (chunkId === "data") {
      // Clamp to the actual buffer in case the header over-reports.
      dataSize = Math.min(chunkSize, bytes.byteLength - bodyStart);
    }

    // Chunks are word-aligned: an odd size is padded with one byte.
    offset = bodyStart + chunkSize + (chunkSize & 1);
  }

  if (blockAlign <= 0 || dataSize <= 0) return 0;
  return Math.floor(dataSize / blockAlign);
}

/**
 * Build a blank instrument prototype with empty sampleName / sampleFile.
 * Used by `resetPads` to stamp every slot before assigning populated pads.
 */
function makeBlankInstrument(): Instrument {
  return {
    coarseTune: 0,
    fineTune: 0,
    lowNote: 0,
    highNote: 127,
    layersv: [
      {
        sampleName: "",
        sampleFile: "",
        volume: {
          // Float-typed fields must serialise with a decimal point.
          gainCoefficient: floatNum(1),
          controlValue: floatNum(1),
          law: 0,
        },
        pan: floatNum(0.5),
        coarseTune: 0,
        fineTune: 0,
        pitch: 0,
      },
    ],
  };
}

/**
 * Replace every slot in `instruments` with a deep clone of a blank prototype.
 *
 * Port of `reset_pads` from `make_xpj.py`.  If the template already contains
 * a blank instrument (empty `sampleFile`), use it as prototype to preserve any
 * extra fields the firmware expects; otherwise fall back to `makeBlankInstrument`.
 */
export function resetPads(instruments: Instrument[]): void {
  // Find an existing blank to preserve extra template fields.
  const existingBlank = instruments.find(
    (inst) => inst.layersv.length > 0 && inst.layersv[0].sampleFile === "",
  );

  const prototype = structuredClone(existingBlank ?? makeBlankInstrument()) as Instrument;

  // Ensure prototype layer is cleared.
  for (const layer of prototype.layersv) {
    layer.sampleName = "";
    layer.sampleFile = "";
  }

  for (let i = 0; i < instruments.length; i++) {
    instruments[i] = structuredClone(prototype) as Instrument;
  }
}

/**
 * Write pad assignment into `instruments[globalPadIdx].layersv[0]`.
 *
 * Port of `assign_pad` from `make_xpj.py`, extended with per-pad
 * tune/volume/pan from the `SamplePad` descriptor.
 *
 * Note: `gainCoefficient`, `volume.controlValue`, `pan`, and `metadata.tempo`
 * are wrapped with `floatTag` so `serializeJson` emits them with a decimal
 * point, matching Python's `json.dumps` behaviour for float fields.
 *
 * @param sampleEndFrames - Sample length in frames (from `wavFrameCount`).
 *   When > 0 it is written to `sampleEnd` and `sliceInfo.End` so the pad plays
 *   the full sample; the template defaults these to 0, which the MPC treats as a
 *   zero-length (silent) region. When 0 (e.g. unparseable bytes) the template
 *   defaults are left untouched.
 */
export function assignPad(instruments: Instrument[], pad: SamplePad, sampleEndFrames = 0): void {
  const inst = instruments[pad.globalPadIdx];
  if (!inst) {
    throw new RangeError(
      `globalPadIdx ${pad.globalPadIdx} is out of range (instruments.length=${instruments.length})`,
    );
  }

  // Instrument-level tune fields.
  inst.coarseTune = pad.coarseTune;
  inst.fineTune = pad.fineTune;

  const layer = inst.layersv[0];
  if (!layer) {
    throw new Error(`Instrument at pad ${pad.globalPadIdx} has no layersv[0]`);
  }

  layer.sampleName = pad.sampleName;
  layer.sampleFile = pad.fileName;
  layer.coarseTune = pad.coarseTune;
  layer.fineTune = pad.fineTune;
  layer.volume = {
    gainCoefficient: floatTag(pad.gainCoefficient),
    controlValue: floatTag(pad.gainCoefficient),
    law: 0,
  };
  layer.pan = floatTag(pad.pan);

  // Playback region: start at 0, end at the sample's frame count. Without a
  // non-zero end the MPC loads the project but never sounds the pad.
  if (sampleEndFrames > 0) {
    const start = pad.sampleStart ?? 0;
    const end = pad.sampleEnd ?? sampleEndFrames;
    layer.sampleStart = start;
    layer.sampleEnd = end;
    if (layer.sliceInfo) {
      layer.sliceInfo.Start = start;
      layer.sliceInfo.End = end;
    }
  }
}

/**
 * Build a `data.samples` / `track.samples` entry for a pad.
 *
 * Port of `make_sample_entry` from `make_xpj.py`, extended with kit BPM/key.
 */
export function makeSampleEntry(pad: SamplePad, kit: Pick<SampleKit, "bpm" | "key">): SampleEntry {
  return {
    version: 1,
    name: pad.sampleName,
    path: pad.fileName,
    loadImpl: 1,
    metadata: {
      tempo: floatTag(kit.bpm),
      rootNote: 60,
      tune: floatTag(0),
      key: kit.key,
    },
  };
}

/**
 * Build a complete `.xpj` project from a template, a `SampleKit`, and raw
 * WAV bytes for each populated pad.
 *
 * @param template - A deep-cloneable `XpjData` object (typically from
 *   `loadTemplate()`).  The function always clones it internally.
 * @param kit - The `SampleKit` describing pad assignments, tuning, and metadata.
 * @param padBytes - A map from `SamplePad.fileName` to raw WAV bytes.  Every
 *   populated pad's `fileName` must have an entry; missing entries throw.
 *
 * @throws {Error} If any `pad.fileName` is absent from `padBytes`.
 * @throws {RangeError} If any `pad.globalPadIdx` is outside 0–127.
 *
 * @param pattern - Optional step-sequencer pattern. When it has at least one
 *   active step, it's written into the project's native sequence data (see
 *   `injectSequencePattern` in `./buildSequence.ts`) so it shows up as a real,
 *   editable sequence on the hardware — not just an in-app playback aid.
 */
export function buildXpj(
  template: XpjData,
  kit: SampleKit,
  padBytes: Map<string, Uint8Array>,
  pattern?: Pattern,
): BuiltXpj {
  const data = structuredClone(template) as XpjData;

  // Navigate to instruments array.
  const dataRoot = data.data as Record<string, unknown>;
  const tracks = dataRoot.tracks as Array<Record<string, unknown>>;
  const track = tracks[0];
  const program = track.program as Record<string, unknown>;
  const drum = program.drum as Record<string, unknown>;
  const instruments = drum.instruments as Instrument[];

  // Step 1: Reset all pads to blank.
  resetPads(instruments);

  // Step 2: Assign populated pads + collect sample entries (de-duped by path).
  const samplesByPath = new Map<string, SampleEntry>();
  const sortedPads = [...kit.pads].sort((a, b) => a.globalPadIdx - b.globalPadIdx);

  for (const pad of sortedPads) {
    // Frame count drives the pad's playback end; derived from the WAV bytes.
    const fileBytes = padBytes.get(pad.fileName);
    const sampleEndFrames = fileBytes ? wavFrameCount(fileBytes) : 0;
    assignPad(instruments, pad, sampleEndFrames);

    if (!samplesByPath.has(pad.fileName)) {
      samplesByPath.set(pad.fileName, makeSampleEntry(pad, kit));
    }
  }

  const sampleList = Array.from(samplesByPath.values());

  // Step 3: Set data.samples + track.samples.
  dataRoot.samples = sampleList;
  track.samples = sampleList;

  // Step 4: Set track name and project key.
  const originalTrackName = track.name as string;
  track.name = kit.exportName;
  dataRoot.key = kit.key;

  if (pattern) {
    injectSequencePattern(data, pattern, originalTrackName, kit.exportName, kit.bpm);
  }

  // Step 5: Collect sample file bytes (de-duped by path, same order as sampleList).
  const sampleFiles: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const entry of sampleList) {
    const fileBytes = padBytes.get(entry.path);
    if (!fileBytes) {
      throw new Error(
        `Missing bytes for sample file "${entry.path}". Ensure padBytes contains an entry for every populated pad.`,
      );
    }
    sampleFiles.push({ path: entry.path, bytes: fileBytes });
  }

  // Step 6: Encode.
  const xpjBytes = encodeXpj(data);

  return {
    xpjBytes,
    projectName: kit.exportName,
    sampleFiles,
  };
}
