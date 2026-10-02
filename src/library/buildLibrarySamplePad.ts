/**
 * buildLibrarySamplePad.ts — Turn a scanned library entry into a `SamplePad`.
 *
 * Mirrors `buildUserSamplePad` in `src/kits/importWav.ts`, but for
 * library-backed samples: instead of holding raw bytes in `userSamples`, the
 * pad's `url` points at the `mpc-sample://` protocol so the engine lazy-fetches
 * it exactly like a preset sample (see `SampleEngine.ensureBuffer`), and the
 * export pipeline (`buildProjectArtifacts`) resolves it the same way too.
 */

import type { GlobalPadIdx, SamplePad } from "../kits/kit.types";
import { librarySampleUrl } from "./library.types";

export type LibrarySourceEntry = {
  absPath: string;
  relPath: string;
  fileName: string;
};

/** Strip the extension from a filename for use as a display/export name. */
function stemOf(fileName: string): string {
  return fileName.replace(/\.(wav|aif|aiff)$/i, "");
}

export function buildLibrarySamplePad(
  globalPadIdx: GlobalPadIdx,
  entry: LibrarySourceEntry,
): SamplePad {
  const name = stemOf(entry.fileName);
  return {
    globalPadIdx,
    // Stable across sessions (same absolute path -> same id), and de-dupes
    // correctly in buildExportKit/exportKit's uniqueFiles-by-fileName map.
    sampleId: `lib:${entry.absPath}`,
    displayName: name,
    sampleName: name,
    fileName: entry.fileName,
    url: librarySampleUrl(entry.absPath),
    coarseTune: 0,
    fineTune: 0,
    gainCoefficient: 1,
    pan: 0.5,
  };
}
