/**
 * sampleLibrary.ts — Pure Node sample-library scanning + metadata/peak decode
 * for the MPC Sample desktop app's Sample Browser.
 *
 * NO `electron` imports — safe to unit test in isolation (node env), mirroring
 * `fsops.ts` / `paths.ts`.
 *
 * Design goals (see the "Sample Library Browser" plan):
 * - Enumerating a library never decodes audio — it's just `fs.stat` data, so
 *   even a huge folder tree returns near-instantly.
 * - Per-file metadata (duration/rate/channels) is read from the format header
 *   only (a few dozen bytes), not a full decode.
 * - Waveform peaks are computed by decimating PCM samples read directly from
 *   the file — no `AudioContext.decodeAudioData`, no full-file buffering for
 *   large files (peaks are skipped above `MAX_PEAKS_FILE_BYTES`).
 * - A disk cache (keyed by relPath + size + mtime) lets a repeat scan of an
 *   unchanged library skip decoding entirely.
 */

import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Extensions the app can actually load onto an MPC pad (matches importWav.ts). */
const AUDIO_EXTENSIONS = new Set([".wav", ".aif", ".aiff"]);

/** Skip peak computation above this size — still browsable/playable/exportable. */
const MAX_PEAKS_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Number of min/max buckets in a computed waveform. The browser thumbnail is
 * only 72px wide, so more points are wasted — and at 25k samples the old 600
 * points produced a ~500 MB cache file that exceeded V8's max string length.
 */
const DEFAULT_NUM_PEAK_POINTS = 72;

/** Plain filesystem facts about one audio file — cheap to obtain (a single `stat`). */
export type LibraryFileStat = {
  /** Path relative to the scanned root, using forward slashes. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** File name only, e.g. "Kick 808.wav". */
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
};

/** Decoded audio metadata — the "expensive" part, computed off the main thread's blocking path. */
export type LibrarySampleMeta = {
  durationSec: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  /** Interleaved [min, max] pairs per bucket, length = 2 * numPoints. `null` if skipped (huge file) or undecodable. */
  peaks: number[] | null;
};

/** A fully resolved library row: file facts + (once available) decoded meta. */
export type LibraryEntry = LibraryFileStat & Partial<LibrarySampleMeta>;

type CacheEntry = LibraryFileStat & LibrarySampleMeta;

export type LibraryCache = {
  rootDir: string;
  scannedAt: number;
  files: Record<string, CacheEntry>;
};

/**
 * Recursively walk `rootDir`, collecting stat facts for every audio file
 * (`.wav` / `.aif` / `.aiff`). Pure `fs.promises` I/O — never blocks the event
 * loop for more than one directory's worth of work at a time.
 */
export async function scanDirectory(rootDir: string): Promise<LibraryFileStat[]> {
  const results: LibraryFileStat[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied / vanished mid-scan — skip silently
    }

    for (const entry of entries) {
      // Skip hidden/system dirs and files (., .., .DS_Store, etc).
      if (entry.name.startsWith(".")) continue;

      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) continue;

      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }

      results.push({
        relPath: path.relative(rootDir, absPath).split(path.sep).join("/"),
        absPath,
        fileName: entry.name,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  await walk(rootDir);
  return results;
}

/** Read a JSON cache file. Returns `null` if missing/corrupt (treated as a cold cache). */
export async function readCacheFile(cacheFilePath: string): Promise<LibraryCache | null> {
  try {
    const raw = await fs.readFile(cacheFilePath, "utf-8");
    const parsed = JSON.parse(raw) as LibraryCache;
    if (!parsed || typeof parsed !== "object" || typeof parsed.files !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write the JSON cache file, creating its parent directory if needed. */
export async function writeCacheFile(cacheFilePath: string, cache: LibraryCache): Promise<void> {
  await fs.mkdir(path.dirname(cacheFilePath), { recursive: true });
  await fs.writeFile(cacheFilePath, JSON.stringify(cache), "utf-8");
}

/**
 * Split freshly-scanned file stats into ones whose metadata is already cached
 * (unchanged size + mtime) and ones that still need decoding.
 */
export function diffAgainstCache(
  files: LibraryFileStat[],
  cache: LibraryCache | null,
): { cached: LibraryEntry[]; toDecode: LibraryFileStat[] } {
  const cached: LibraryEntry[] = [];
  const toDecode: LibraryFileStat[] = [];

  for (const file of files) {
    const hit = cache?.files[file.relPath];
    // Peaks of a different length come from an older, larger format — re-decode.
    const peaksCurrent = !hit?.peaks || hit.peaks.length === DEFAULT_NUM_PEAK_POINTS * 2;
    if (hit && peaksCurrent && hit.sizeBytes === file.sizeBytes && hit.mtimeMs === file.mtimeMs) {
      cached.push({ ...file, ...hit });
    } else {
      toDecode.push(file);
    }
  }

  return { cached, toDecode };
}

/**
 * Manually-added/removed tags for one scanned root, keyed by relPath.
 *
 * Deliberately separate from `LibraryCache`: tags are user edits, not derived
 * file facts, so they must survive a rescan even when a file's decoded peaks
 * change (or the cache is dropped entirely).
 */
export type LibraryTags = Record<string, string[]>;

/** Read a JSON tags file. Returns `{}` if missing/corrupt (treated as no manual tags yet). */
export async function readTagsFile(tagsFilePath: string): Promise<LibraryTags> {
  try {
    const raw = await fs.readFile(tagsFilePath, "utf-8");
    const parsed = JSON.parse(raw) as LibraryTags;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

/** Write the JSON tags file, creating its parent directory if needed. */
export async function writeTagsFile(tagsFilePath: string, tags: LibraryTags): Promise<void> {
  await fs.mkdir(path.dirname(tagsFilePath), { recursive: true });
  await fs.writeFile(tagsFilePath, JSON.stringify(tags), "utf-8");
}

// ── Format-specific header + PCM decode ─────────────────────────────────────

export type PcmFormat = {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  /** true = IEEE float samples, false = signed/unsigned integer PCM. */ isFloat: boolean;
  /** Byte offset (from file start) where PCM sample data begins. */ dataStart: number;
  /** Byte length of the PCM sample data. */ dataLength: number;
  /** true = big-endian (AIFF), false = little-endian (WAV). */ bigEndian: boolean;
};

async function readExact(fh: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** Parse an 80-bit IEEE extended float (AIFF sample rate encoding), big-endian. */
function readIeeeExtended(buf: Buffer, offset: number): number {
  const expon = ((buf[offset] & 0x7f) << 8) | buf[offset + 1];
  const hi = buf.readUInt32BE(offset + 2);
  const lo = buf.readUInt32BE(offset + 6);
  if (expon === 0 && hi === 0 && lo === 0) return 0;
  const sign = buf[offset] & 0x80 ? -1 : 1;
  const exponent = expon - 16383 - 63;
  const mantissa = hi * 2 ** 32 + lo;
  return sign * mantissa * 2 ** exponent;
}

/** Walk a WAV (RIFF/WAVE) file's chunks to locate `fmt ` and `data`. */
async function parseWavFormat(fh: FileHandle, fileSize: number): Promise<PcmFormat | null> {
  const riffHeader = await readExact(fh, 12, 0);
  if (
    riffHeader.toString("ascii", 0, 4) !== "RIFF" ||
    riffHeader.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }

  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitDepth: number; isFloat: boolean } | null =
    null;
  let dataStart: number | null = null;
  let dataLength = 0;

  while (offset + 8 <= fileSize) {
    const chunkHeader = await readExact(fh, 8, offset);
    if (chunkHeader.length < 8) break;
    const chunkId = chunkHeader.toString("ascii", 0, 4);
    const chunkSize = chunkHeader.readUInt32LE(4);
    const bodyStart = offset + 8;

    if (chunkId === "fmt ") {
      const body = await readExact(fh, Math.min(chunkSize, 16), bodyStart);
      if (body.length >= 16) {
        const audioFormat = body.readUInt16LE(0);
        fmt = {
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          bitDepth: body.readUInt16LE(14),
          isFloat: audioFormat === 3,
        };
      }
    } else if (chunkId === "data") {
      dataStart = bodyStart;
      dataLength = Math.min(chunkSize, Math.max(0, fileSize - bodyStart));
    }

    if (fmt && dataStart !== null) break;
    // Chunks are padded to even byte boundaries.
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt || dataStart === null) return null;
  return { ...fmt, dataStart, dataLength, bigEndian: false };
}

/** Walk an AIFF (FORM/AIFF or AIFC) file's chunks to locate `COMM` and `SSND`. */
async function parseAiffFormat(fh: FileHandle, fileSize: number): Promise<PcmFormat | null> {
  const formHeader = await readExact(fh, 12, 0);
  if (
    formHeader.toString("ascii", 0, 4) !== "FORM" ||
    (formHeader.toString("ascii", 8, 12) !== "AIFF" &&
      formHeader.toString("ascii", 8, 12) !== "AIFC")
  ) {
    return null;
  }

  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitDepth: number } | null = null;
  let dataStart: number | null = null;
  let dataLength = 0;

  while (offset + 8 <= fileSize) {
    const chunkHeader = await readExact(fh, 8, offset);
    if (chunkHeader.length < 8) break;
    const chunkId = chunkHeader.toString("ascii", 0, 4);
    const chunkSize = chunkHeader.readUInt32BE(4);
    const bodyStart = offset + 8;

    if (chunkId === "COMM") {
      const body = await readExact(fh, Math.min(chunkSize, 18), bodyStart);
      if (body.length >= 18) {
        fmt = {
          channels: body.readUInt16BE(0),
          bitDepth: body.readUInt16BE(6),
          sampleRate: Math.round(readIeeeExtended(body, 8)),
        };
      }
    } else if (chunkId === "SSND") {
      const ssndPrefix = await readExact(fh, 8, bodyStart);
      const soundOffset = ssndPrefix.length >= 4 ? ssndPrefix.readUInt32BE(0) : 0;
      dataStart = bodyStart + 8 + soundOffset;
      dataLength = Math.max(0, Math.min(chunkSize - 8 - soundOffset, fileSize - dataStart));
    }

    if (fmt && dataStart !== null) break;
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt || dataStart === null) return null;
  // AIFF/AIFC (uncompressed 'NONE' variant) PCM is big-endian.
  return { ...fmt, isFloat: false, dataStart, dataLength, bigEndian: true };
}

/**
 * Parse a WAV/AIFF file's format chunk and locate its audio-data byte range.
 * Exported so `electron/main.ts` can clamp the `mpc-sample://` protocol's
 * served byte range to the header-declared `data`/`SSND` boundary — some
 * files (notably FL Studio exports) append a trailing `LIST`/`INFO` metadata
 * chunk *after* the audio data, and serving those extra bytes to a media
 * element makes some decoders reject the whole file as corrupt.
 */
export async function parseAudioFormat(
  absPath: string,
  fileSize: number,
): Promise<PcmFormat | null> {
  const fh = await fs.open(absPath, "r");
  try {
    const magic = await readExact(fh, 4, 0);
    const tag = magic.toString("ascii");
    if (tag === "RIFF") return await parseWavFormat(fh, fileSize);
    if (tag === "FORM") return await parseAiffFormat(fh, fileSize);
    return null;
  } finally {
    await fh.close();
  }
}

/** Read one PCM sample (channel-0 only, for peak purposes) at `byteOffset`. */
function readSample(buf: Buffer, byteOffset: number, format: PcmFormat): number {
  const { bitDepth, isFloat, bigEndian } = format;
  if (isFloat && bitDepth === 32) {
    return bigEndian ? buf.readFloatBE(byteOffset) : buf.readFloatLE(byteOffset);
  }
  if (isFloat && bitDepth === 64) {
    return bigEndian ? buf.readDoubleBE(byteOffset) : buf.readDoubleLE(byteOffset);
  }
  switch (bitDepth) {
    case 8:
      // WAV 8-bit PCM is unsigned; AIFF 8-bit is signed.
      return bigEndian ? buf.readInt8(byteOffset) / 128 : (buf.readUInt8(byteOffset) - 128) / 128;
    case 16:
      return (bigEndian ? buf.readInt16BE(byteOffset) : buf.readInt16LE(byteOffset)) / 32768;
    case 24: {
      const b0 = buf[byteOffset];
      const b1 = buf[byteOffset + 1];
      const b2 = buf[byteOffset + 2];
      const raw = bigEndian ? (b0 << 16) | (b1 << 8) | b2 : (b2 << 16) | (b1 << 8) | b0;
      const signed = raw & 0x800000 ? raw - 0x1000000 : raw;
      return signed / 8388608;
    }
    case 32:
      return (bigEndian ? buf.readInt32BE(byteOffset) : buf.readInt32LE(byteOffset)) / 2147483648;
    default:
      return 0;
  }
}

/**
 * Compute decimated min/max waveform peaks for channel 0, streaming the PCM
 * data chunk in fixed-size blocks so large files never load fully into memory.
 */
async function computePeaks(
  absPath: string,
  format: PcmFormat,
  numPoints: number,
): Promise<number[]> {
  const bytesPerSample = format.bitDepth / 8;
  const frameSize = bytesPerSample * format.channels;
  const totalFrames = frameSize > 0 ? Math.floor(format.dataLength / frameSize) : 0;
  const peaks = new Array<number>(numPoints * 2).fill(0);
  if (totalFrames === 0) return peaks;

  const effectivePoints = Math.min(numPoints, totalFrames);
  const READ_FRAMES = 8192;

  // Bucket boundaries are computed from exact frame-index fractions (not a
  // fixed "frames per bucket" stride) so every bucket up to `effectivePoints`
  // gets at least one frame — a fixed stride under-fills the last buckets
  // whenever totalFrames isn't a clean multiple of numPoints.
  const bucketForFrame = (frameIdx: number): number =>
    Math.min(effectivePoints - 1, Math.floor((frameIdx * effectivePoints) / totalFrames));

  const fh = await fs.open(absPath, "r");
  try {
    let frameIdx = 0;
    let currentBucket = 0;
    let bucketMin = Infinity;
    let bucketMax = -Infinity;
    let lastFilledBucket = -1;

    let position = format.dataStart;

    const flush = (bucketIdx: number): void => {
      if (bucketMin === Infinity) return; // bucket saw no frames
      peaks[bucketIdx * 2] = Math.round(bucketMin * 1000) / 1000;
      peaks[bucketIdx * 2 + 1] = Math.round(bucketMax * 1000) / 1000;
      lastFilledBucket = bucketIdx;
      bucketMin = Infinity;
      bucketMax = -Infinity;
    };

    while (frameIdx < totalFrames) {
      const framesToRead = Math.min(READ_FRAMES, totalFrames - frameIdx);
      const buf = Buffer.alloc(framesToRead * frameSize);
      const { bytesRead } = await fh.read(buf, 0, buf.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;

      const framesInBuf = Math.floor(bytesRead / frameSize);
      for (let i = 0; i < framesInBuf; i++) {
        const targetBucket = bucketForFrame(frameIdx);
        if (targetBucket !== currentBucket) {
          flush(currentBucket);
          currentBucket = targetBucket;
        }
        const sample = readSample(buf, i * frameSize, format);
        if (sample < bucketMin) bucketMin = sample;
        if (sample > bucketMax) bucketMax = sample;
        frameIdx++;
      }

      // Yield to the event loop between blocks so a very long file never
      // monopolizes the main process for more than a few ms at a time.
      await new Promise((resolve) => setImmediate(resolve));
    }
    flush(currentBucket);

    // Extend the last real bucket's value into any trailing unfilled buckets
    // (only possible when totalFrames < numPoints) so the thumbnail doesn't
    // show a misleading flat-zero tail.
    for (let b = lastFilledBucket + 1; b < numPoints; b++) {
      peaks[b * 2] = lastFilledBucket >= 0 ? peaks[lastFilledBucket * 2] : 0;
      peaks[b * 2 + 1] = lastFilledBucket >= 0 ? peaks[lastFilledBucket * 2 + 1] : 0;
    }
  } finally {
    await fh.close();
  }

  return peaks;
}

/**
 * Decode one file's metadata: duration/rate/channels/bitDepth always;
 * peaks unless the file is larger than `MAX_PEAKS_FILE_BYTES` or the format
 * can't be parsed (in which case a best-effort fallback with `peaks: null`
 * is returned rather than throwing — a browsable-but-waveform-less row is
 * better than losing the file from the list entirely).
 */
export async function decodeSampleMeta(
  file: LibraryFileStat,
  numPoints: number = DEFAULT_NUM_PEAK_POINTS,
): Promise<LibrarySampleMeta> {
  try {
    const format = await parseAudioFormat(file.absPath, file.sizeBytes);
    if (!format) {
      return { durationSec: 0, sampleRate: 0, channels: 0, bitDepth: 0, peaks: null };
    }

    const bytesPerFrame = (format.bitDepth / 8) * Math.max(1, format.channels);
    const durationSec =
      bytesPerFrame > 0 && format.sampleRate > 0
        ? format.dataLength / bytesPerFrame / format.sampleRate
        : 0;

    const peaks =
      file.sizeBytes <= MAX_PEAKS_FILE_BYTES
        ? await computePeaks(file.absPath, format, numPoints)
        : null;

    return {
      durationSec,
      sampleRate: format.sampleRate,
      channels: format.channels,
      bitDepth: format.bitDepth,
      peaks,
    };
  } catch {
    return { durationSec: 0, sampleRate: 0, channels: 0, bitDepth: 0, peaks: null };
  }
}

export { DEFAULT_NUM_PEAK_POINTS, MAX_PEAKS_FILE_BYTES };
