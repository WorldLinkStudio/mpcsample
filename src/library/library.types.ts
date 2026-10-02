/**
 * library.types.ts — Renderer-side types for the Sample Browser.
 *
 * `LibraryEntry` / `LibraryProgressUpdate` are the shared IPC contract
 * (defined in `src/desktop/bridge.types.ts`); this file only adds renderer-only
 * derived shapes.
 */

import type { LibraryEntry } from "../desktop/bridge.types";

export type { LibraryEntry, LibraryProgressUpdate } from "../desktop/bridge.types";

/** The custom drag MIME type used when dragging a library row onto a pad. */
export const LIBRARY_DRAG_MIME = "application/x-mpc-library-sample";

/** Payload carried in a library-row drag, encoded as JSON via `setData`. */
export type LibraryDragPayload = {
  absPath: string;
  relPath: string;
  fileName: string;
};

export function isLibraryDragPayload(value: unknown): value is LibraryDragPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LibraryDragPayload).absPath === "string" &&
    typeof (value as LibraryDragPayload).fileName === "string"
  );
}

/** Build the `mpc-sample://` URL used for both preview playback and pad assignment. */
export function librarySampleUrl(absPath: string): string {
  return `mpc-sample://local/read?path=${encodeURIComponent(absPath)}`;
}

/** Derive the folder portion of a library entry's relPath for grouping/display. */
export function entryFolder(entry: Pick<LibraryEntry, "relPath" | "fileName">): string {
  const idx = entry.relPath.lastIndexOf("/");
  return idx === -1 ? "" : entry.relPath.slice(0, idx);
}
