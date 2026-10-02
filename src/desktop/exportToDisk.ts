/**
 * exportToDisk.ts — Electron-only export path.
 *
 * Resolves sample bytes and builds the Akai project via `buildProjectArtifacts`,
 * then writes the unzipped `.xpj` + `_[ProjectData]/*.wav` directly to disk via
 * the `mpcDesktop` IPC bridge.
 *
 * Default destination: `MPC-Sample/Projects` on the mounted SD card (any volume name).
 * Fallback: native directory picker if the SD card is not mounted.
 * If the picker is cancelled, throws an `AbortError`.
 *
 * EEXIST handling: if the project already exists on disk and `onNeedOverwrite`
 * is provided, the callback is awaited. If it resolves `true`, the write is
 * retried with `overwrite: true`. If it resolves `false` (or no callback is
 * provided), the error propagates to the caller.
 *
 * ENOENT handling: a clear Error is thrown so the caller can show a helpful
 * message (e.g. "SD card not found").
 *
 * Exported API:
 *   exportKitToDisk(kit, userSamples, opts?) → Promise<WriteProjectResult>
 */

import type { SampleKit } from "../kits/kit.types";
import type { Pattern } from "../sequencer/sequencer.types";
import { buildProjectArtifacts, type ExportProgress } from "../xpj/exportKit";
import { desktop } from "./bridge";
import type { WriteProjectResult } from "./bridge.types";

type ExportToDiskOpts = {
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
  /**
   * Called when the target project already exists on disk (EEXIST).
   * Return `true` to overwrite, `false` (or throw) to abort.
   * If omitted, EEXIST errors propagate unchanged.
   */
  onNeedOverwrite?: (projectName: string) => Promise<boolean>;
  pattern?: Pattern;
};

function hasCode(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

/**
 * Build the Akai project artifacts and write them unzipped to the MPC SD card
 * (or a user-chosen folder) via the Electron IPC bridge.
 *
 * Must only be called when `isDesktop()` is true.
 *
 * @throws {DOMException} AbortError if the directory picker is cancelled or
 *   the signal is aborted.
 * @throws {Error} If the SD card path cannot be found (ENOENT) or any other
 *   IPC error occurs.
 */
export async function exportKitToDisk(
  kit: SampleKit,
  userSamples: Map<string, Uint8Array>,
  opts: ExportToDiskOpts = {},
): Promise<WriteProjectResult> {
  const { signal, onProgress, onNeedOverwrite, pattern } = opts;

  // ── Build artifacts (fetching + building phases) ─────────────────────────
  const built = await buildProjectArtifacts(kit, userSamples, { signal, onProgress, pattern });

  // ── Resolve destination directory ─────────────────────────────────────────
  const def = await desktop().getDefaultExportDir();
  let destDir: string;

  if (def.exists) {
    destDir = def.path;
  } else {
    const chosen = await desktop().chooseExportDir();
    if (!chosen) {
      throw new DOMException("Export cancelled", "AbortError");
    }
    destDir = chosen;
  }

  // ── Write to disk (first attempt) ─────────────────────────────────────────
  try {
    const result = await desktop().writeProject({
      projectName: built.projectName,
      xpjBytes: built.xpjBytes,
      sampleFiles: built.sampleFiles,
      destDir,
    });

    onProgress?.({
      phase: "done",
      loaded: built.sampleFiles.length,
      total: built.sampleFiles.length,
    });
    return result;
  } catch (err: unknown) {
    if (hasCode(err) && err.code === "EEXIST") {
      // ── Project already exists: ask the caller ──────────────────────────
      if (onNeedOverwrite) {
        const shouldOverwrite = await onNeedOverwrite(built.projectName);
        if (shouldOverwrite) {
          const result = await desktop().writeProject({
            projectName: built.projectName,
            xpjBytes: built.xpjBytes,
            sampleFiles: built.sampleFiles,
            destDir,
            overwrite: true,
          });
          onProgress?.({
            phase: "done",
            loaded: built.sampleFiles.length,
            total: built.sampleFiles.length,
          });
          return result;
        }
        // User declined overwrite — treat as a soft cancel.
        throw new DOMException("Export cancelled", "AbortError");
      }
      // No overwrite callback: re-throw the original error.
      throw err;
    }

    if (hasCode(err) && err.code === "ENOENT") {
      throw new Error(
        `Export destination not found: "${destDir}". ` +
          `Ensure the MPC SD card is mounted or choose a different folder.`,
      );
    }

    // Any other error (EACCES, EUNKNOWN, …): propagate with its message.
    throw err instanceof Error ? err : new Error(String(err));
  }
}
