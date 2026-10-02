/**
 * exportKit.ts — Orchestrates resolving sample bytes, building the XPJ project,
 * assembling a ZIP archive, and triggering a browser download.
 *
 * Exported API:
 *   buildProjectArtifacts(kit, userSamples, opts?) → Promise<ProjectArtifacts>
 *   exportKitToZip(kit, userSamples, opts?) → Promise<ExportResult>
 *   triggerDownload(result) → void
 */

import { type AsyncZipOptions, zip } from "fflate";
import type { SampleKit } from "../kits/kit.types";
import type { Pattern } from "../sequencer/sequencer.types";
import { buildXpj } from "./buildXpj";
import { loadTemplate } from "./codec";

export type ExportProgress = {
  phase: "fetching" | "building" | "zipping" | "done";
  loaded: number;
  total: number;
};

export type ExportResult = {
  fileName: string;
  blob: Blob;
};

/**
 * The resolved project artifacts — the XPJ bytes and the per-sample WAV files
 * — before any ZIP compression or disk write. Used by both `exportKitToZip`
 * (browser ZIP path) and `exportKitToDisk` (Electron direct-write path).
 */
export type ProjectArtifacts = {
  projectName: string;
  xpjBytes: Uint8Array;
  sampleFiles: { path: string; bytes: Uint8Array }[];
};

/** Maximum number of simultaneous fetch requests. */
const FETCH_CONCURRENCY = 6;

/**
 * Run an async iterator over `items`, capping concurrent in-flight tasks at
 * `limit`. Returns when all tasks have resolved; if any rejects, the error
 * propagates immediately.
 */
async function limitedConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  let active = 0;
  let head = 0;

  return new Promise<void>((resolve, reject) => {
    function tryNext(): void {
      while (active < limit && head < queue.length) {
        const item = queue[head++];
        active++;
        fn(item).then(
          /* eslint-disable-next-line no-loop-func */
          () => {
            active--;
            if (head >= queue.length && active === 0) {
              resolve();
            } else {
              tryNext();
            }
          },
          (err: unknown) => reject(err),
        );
      }
    }
    tryNext();
    if (queue.length === 0) resolve();
  });
}

/**
 * Wrap fflate's callback-based `zip` in a Promise.
 */
function zipAsync(files: Parameters<typeof zip>[0], opts: AsyncZipOptions): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    zip(files, opts, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

/**
 * Resolve sample bytes (fetching presets / reading user-imports) and build the
 * Akai `.xpj` project data. Returns the raw bytes ready for either ZIP
 * compression or direct disk write.
 *
 * Reports phases "fetching" and "building" via `opts.onProgress`.
 *
 * @throws {Error} If the kit has no populated pads ("empty kit").
 * @throws {Error} If a user-imported sample's bytes are missing from `userSamples`.
 * @throws {DOMException} If `opts.signal` is aborted mid-fetch (AbortError).
 */
export async function buildProjectArtifacts(
  kit: SampleKit,
  userSamples: Map<string, Uint8Array>,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: ExportProgress) => void;
    pattern?: Pattern;
  } = {},
): Promise<ProjectArtifacts> {
  const { signal, onProgress, pattern } = opts;

  // ── Validation ───────────────────────────────────────────────────────────
  if (kit.pads.length === 0) {
    throw new Error("empty kit: no populated pads to export.");
  }

  // ── Phase: fetching ───────────────────────────────────────────────────────
  // Build a de-duped list of unique fileNames to fetch.
  const uniqueFiles = new Map<string, { fileName: string; url: string | null; sampleId: string }>();
  for (const pad of kit.pads) {
    if (!uniqueFiles.has(pad.fileName)) {
      uniqueFiles.set(pad.fileName, {
        fileName: pad.fileName,
        url: pad.url,
        sampleId: pad.sampleId,
      });
    }
  }

  const fileList = Array.from(uniqueFiles.values());
  const total = fileList.length;
  let loaded = 0;

  onProgress?.({ phase: "fetching", loaded: 0, total });

  const padBytes = new Map<string, Uint8Array>();

  await limitedConcurrency(fileList, FETCH_CONCURRENCY, async (entry) => {
    // Check abort before starting each fetch.
    if (signal?.aborted) {
      throw new DOMException("Export aborted", "AbortError");
    }

    if (entry.url === null) {
      // User-imported sample: retrieve bytes from userSamples map.
      const bytes = userSamples.get(entry.sampleId);
      if (!bytes) {
        throw new Error(
          `Missing bytes for user-imported sample "${entry.fileName}" (sampleId="${entry.sampleId}"). ` +
            `Ensure the sample was imported before exporting.`,
        );
      }
      // Wrap in a new Uint8Array to ensure it is in the current module's realm
      // (avoids cross-realm instanceof failures in fflate's zip flattener).
      padBytes.set(entry.fileName, new Uint8Array(bytes));
    } else {
      // Preset sample: fetch from the URL.
      const response = await fetch(entry.url, { signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch sample "${entry.fileName}" (HTTP ${response.status}).`);
      }
      const buffer = await response.arrayBuffer();
      padBytes.set(entry.fileName, new Uint8Array(buffer));
    }

    loaded++;
    onProgress?.({ phase: "fetching", loaded, total });
  });

  // ── Phase: building ───────────────────────────────────────────────────────
  if (signal?.aborted) {
    throw new DOMException("Export aborted", "AbortError");
  }

  onProgress?.({ phase: "building", loaded: total, total });

  const built = buildXpj(await loadTemplate(), kit, padBytes, pattern);

  return {
    projectName: built.projectName,
    xpjBytes: built.xpjBytes,
    sampleFiles: built.sampleFiles,
  };
}

/**
 * Export a `SampleKit` to a downloadable `.zip` archive.
 *
 * The ZIP contains:
 *   `<projectName>.xpj`                         — gzipped Akai project file
 *   `<projectName>_[ProjectData]/<fileName>`     — WAV sample files
 *
 * @throws {Error} If the kit has no populated pads ("empty kit").
 * @throws {Error} If a user-imported sample's bytes are missing from `userSamples`.
 * @throws {Error} If `opts.signal` is aborted mid-fetch (AbortError).
 */
export async function exportKitToZip(
  kit: SampleKit,
  userSamples: Map<string, Uint8Array>,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: ExportProgress) => void;
    pattern?: Pattern;
  } = {},
): Promise<ExportResult> {
  const { signal, onProgress, pattern } = opts;

  const built = await buildProjectArtifacts(kit, userSamples, { signal, onProgress, pattern });

  // ── Phase: zipping ────────────────────────────────────────────────────────
  if (signal?.aborted) {
    throw new DOMException("Export aborted", "AbortError");
  }

  onProgress?.({
    phase: "zipping",
    loaded: built.sampleFiles.length,
    total: built.sampleFiles.length,
  });

  const projectDataFolder = `${built.projectName}_[ProjectData]`;

  // Assemble ZIP entries — paths MUST exactly match sampleFile values.
  // Wrap all byte arrays in `new Uint8Array()` to guarantee they pass
  // fflate's `instanceof Uint8Array` check across module realm boundaries
  // (relevant in jsdom test environments where globals may differ).
  const zipEntries: Record<string, Uint8Array> = {
    [`${built.projectName}.xpj`]: new Uint8Array(built.xpjBytes),
  };

  for (const file of built.sampleFiles) {
    // Preserve exact path including spaces, parens, apostrophes.
    zipEntries[`${projectDataFolder}/${file.path}`] = new Uint8Array(file.bytes);
  }

  const zipBytes = await zipAsync(zipEntries, { level: 6 });

  onProgress?.({
    phase: "done",
    loaded: built.sampleFiles.length,
    total: built.sampleFiles.length,
  });

  return {
    fileName: `${built.projectName}.zip`,
    // Wrap in a fresh Uint8Array to guarantee ArrayBuffer backing (fflate returns
    // Uint8Array<ArrayBufferLike> which TypeScript 5.x rejects as BlobPart).
    blob: new Blob([new Uint8Array(zipBytes)], { type: "application/zip" }),
  };
}

/**
 * Trigger a browser download for the given `ExportResult`.
 *
 * Creates a temporary object URL, clicks a hidden anchor, and revokes the URL
 * after a short delay to allow the browser to start the download.
 */
export function triggerDownload(result: ExportResult): void {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke after a brief delay to ensure the browser picks up the URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
