/**
 * ipc.ts — IPC channel name constants and result type for the MPC Sample
 * Electron main ↔ renderer bridge.
 */

import type { DesktopError } from "../src/desktop/bridge.types";

export const CH = {
  getDefaultExportDir: "mpc:getDefaultExportDir",
  chooseExportDir: "mpc:chooseExportDir",
  chooseProjectDir: "mpc:chooseProjectDir",
  readProject: "mpc:readProject",
  writeProject: "mpc:writeProject",
  ejectVolume: "mpc:ejectVolume",
  openPath: "mpc:openPath",
  chooseLibraryDir: "mpc:chooseLibraryDir",
  scanLibrary: "mpc:scanLibrary",
  cancelLibraryScan: "mpc:cancelLibraryScan",
  getLibraryTags: "mpc:getLibraryTags",
  setSampleTags: "mpc:setSampleTags",
} as const;

/** Renderer-bound event (not request/response) carrying incremental scan progress. */
export const LIBRARY_PROGRESS_EVENT = "mpc:libraryProgress";

export type IpcResult<T> = { ok: true; result: T } | { ok: false; error: DesktopError };
