/**
 * bridge.types.ts — The `window.mpcDesktop` IPC contract.
 *
 * This is the hard contract shared between the Electron preload script
 * (`electron/preload.ts`) and the renderer. The preload exposes an object
 * implementing `MpcDesktop`; the renderer consumes it via `./bridge`.
 *
 * Binary payloads (`Uint8Array`) cross the IPC + contextBridge boundary via the
 * structured-clone algorithm — no base64 encoding is required. Only plain-data
 * async functions are exposed (no class instances, Blobs, or callbacks with
 * non-cloneable args).
 */

/** One sample file to write into the `<projectName>_[ProjectData]` folder. */
export type DesktopSampleFile = {
  /** Filename only (no directory), e.g. "808Kick (1).wav". Matches buildXpj `sampleFiles[].path`. */
  path: string;
  /** Raw WAV bytes. Crosses IPC via structured clone. */
  bytes: Uint8Array;
};

/** Arguments for {@link MpcDesktop.writeProject}. */
export type WriteProjectArgs = {
  /** Project base name WITHOUT extension, e.g. "London Full". */
  projectName: string;
  /** Encoded `.xpj` bytes from `buildXpj`. */
  xpjBytes: Uint8Array;
  /** WAV files to place in `<projectName>_[ProjectData]/`. */
  sampleFiles: DesktopSampleFile[];
  /**
   * Absolute destination directory the project is written INTO. If omitted,
   * main resolves the default export dir; if that does not exist it shows a
   * directory picker. If the user cancels, `writeProject` rejects with
   * `code: "CANCELLED"`.
   */
  destDir?: string;
  /** If false (default), reject when target files already exist (`code: "EEXIST"`). */
  overwrite?: boolean;
};

/** Result of a successful {@link MpcDesktop.writeProject}. */
export type WriteProjectResult = {
  /** Absolute path of the written `.xpj` file. */
  written: string;
  /** Absolute path of the `_[ProjectData]` folder. */
  dataDir: string;
  /** Number of WAVs written. */
  sampleCount: number;
};

/** Result of {@link MpcDesktop.getDefaultExportDir}. */
export type DefaultExportDir = {
  /** e.g. "/Volumes/MPC-SD/MPC-Sample/Projects" */
  path: string;
  /** Whether that directory currently exists (SD card mounted). */
  exists: boolean;
};

/** A project read from disk by {@link MpcDesktop.readProject}. */
export type LoadedProject = {
  /** Absolute directory the project was read from. */
  dir: string;
  /** Raw `.xpj` bytes (gzipped Akai project), to be parsed with `parseXpjToKit`. */
  xpjBytes: Uint8Array;
  /** Contents of the sibling `_[ProjectData]` folder. */
  samples: { fileName: string; bytes: Uint8Array }[];
};

/** Plain filesystem facts about one audio file found under a scanned library root. */
export type LibraryFileStat = {
  /** Path relative to the scanned root, forward-slash separated. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** File name only, e.g. "Kick 808.wav". */
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
};

/** Decoded audio metadata for a library file — arrives asynchronously after the initial scan. */
export type LibrarySampleMeta = {
  durationSec: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  /** Interleaved [min, max] pairs per bucket, or `null` if not (yet) computed. */
  peaks: number[] | null;
};

/** One row in the Sample Browser: file facts plus whatever decoded meta is available so far. */
export type LibraryEntry = LibraryFileStat & Partial<LibrarySampleMeta>;

/**
 * Incremental update pushed from main → renderer while a library scan's
 * background decode pool works through cache-miss files.
 *
 * `done: true` marks the end of the scan (no `relPath`/`meta` on that event).
 */
export type LibraryProgressUpdate =
  | { done: false; relPath: string; meta: LibrarySampleMeta }
  | { done: true };

/**
 * Manually-added/removed tags for a scanned root, keyed by relPath.
 * Deliberately separate from decoded metadata — user edits, not derived file
 * facts, so they survive a rescan even when a file's decoded peaks change.
 */
export type LibraryTags = Record<string, string[]>;

/** Error codes a rejected desktop promise can carry on `.code`. */
export type DesktopErrorCode =
  | "CANCELLED" // user cancelled a dialog
  | "EEXIST" // target already exists and overwrite was not set
  | "ENOENT" // destination directory missing (e.g. SD card not mounted)
  | "EACCES" // permission denied
  | "ENOXPJ" // chosen directory contains no .xpj
  | "EUNKNOWN"; // anything else

/** Serialized error shape carried across IPC. */
export type DesktopError = {
  code: DesktopErrorCode;
  message: string;
};

/**
 * The API surface exposed on `window.mpcDesktop` under Electron.
 * Undefined in the browser / dev-server / test environments.
 */
export type MpcDesktop = {
  /** Always literally `true` when injected. Feature-detect via `isDesktop()`. */
  readonly isElectron: true;
  /** Version strings for diagnostics/UI. */
  readonly versions: { app: string; electron: string; chrome: string };
  /** Resolve the default export directory and whether it currently exists. */
  getDefaultExportDir(): Promise<DefaultExportDir>;
  /** Open a native directory picker for the export destination. Returns null if cancelled. */
  chooseExportDir(): Promise<string | null>;
  /** Open a native directory picker for "load existing project". Returns null if cancelled. */
  chooseProjectDir(): Promise<string | null>;
  /** Read a project from `dir`: locate its `.xpj` and read the sibling `_[ProjectData]` WAVs. */
  readProject(dir: string): Promise<LoadedProject>;
  /** Write the project to disk; resolves with final paths, rejects with a {@link DesktopError}. */
  writeProject(args: WriteProjectArgs): Promise<WriteProjectResult>;
  /** Safely eject the MPC SD card (macOS: `diskutil eject /Volumes/MPC-SD`). */
  ejectVolume(): Promise<void>;
  /** Open a directory or file in the system file manager (Finder on macOS). */
  openPath(dir: string): Promise<void>;

  /** Open a native directory picker for choosing a sample library folder. Returns null if cancelled. */
  chooseLibraryDir(): Promise<string | null>;
  /**
   * Scan `rootDir` for audio files. Resolves quickly with the full file list
   * (cached metadata already merged in where available); files needing
   * decode are then reported incrementally via {@link onLibraryProgress}.
   */
  scanLibrary(rootDir: string): Promise<LibraryEntry[]>;
  /** Stop any in-flight background decode work for the current scan. */
  cancelLibraryScan(): Promise<void>;
  /**
   * Subscribe to incremental decode results for the most recent `scanLibrary`
   * call. Returns an unsubscribe function.
   */
  onLibraryProgress(cb: (update: LibraryProgressUpdate) => void): () => void;
  /** Read all manually-added tags for `rootDir`, keyed by relPath. */
  getLibraryTags(rootDir: string): Promise<LibraryTags>;
  /** Replace the manual tag list for one sample and persist it. */
  setSampleTags(rootDir: string, relPath: string, tags: string[]): Promise<void>;
};

declare global {
  interface Window {
    /** Present only under Electron; undefined in browser/dev-server/tests. */
    mpcDesktop?: MpcDesktop;
  }
}
