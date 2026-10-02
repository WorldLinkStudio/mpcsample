/**
 * preload.ts — Electron preload for MPC Sample.
 *
 * Exposes `window.mpcDesktop` (typed as {@link MpcDesktop}) via contextBridge.
 * Every method invokes the corresponding IPC channel and unwraps the
 * `IpcResult<T>` discriminated union: on `ok: false` it throws a typed Error
 * with the `.code` property from the main-process error, so renderers can
 * `catch (e) { if (e.code === "CANCELLED") ... }`.
 *
 * Binary payloads (`Uint8Array`) cross the contextBridge boundary via the
 * structured-clone algorithm — no base64 encoding required.
 */

import { contextBridge, ipcRenderer } from "electron";

import type {
  DefaultExportDir,
  DesktopError,
  LibraryEntry,
  LibraryProgressUpdate,
  LibraryTags,
  LoadedProject,
  MpcDesktop,
  WriteProjectArgs,
  WriteProjectResult,
} from "../src/desktop/bridge.types";
import type { IpcResult } from "./ipc";
import { CH, LIBRARY_PROGRESS_EVENT } from "./ipc";

/** Unwrap an IpcResult — throws a typed Error on `ok: false`. */
async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const res = await promise;
  if (!res.ok) {
    const { code, message } = res.error as DesktopError;
    throw Object.assign(new Error(message), { code });
  }
  return res.result;
}

const mpcDesktop: MpcDesktop = {
  isElectron: true,

  versions: {
    app: (process.env.npm_package_version as string | undefined) ?? "",
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },

  getDefaultExportDir(): Promise<DefaultExportDir> {
    return unwrap<DefaultExportDir>(
      ipcRenderer.invoke(CH.getDefaultExportDir) as Promise<IpcResult<DefaultExportDir>>,
    );
  },

  chooseExportDir(): Promise<string | null> {
    return unwrap<string | null>(
      ipcRenderer.invoke(CH.chooseExportDir) as Promise<IpcResult<string | null>>,
    );
  },

  chooseProjectDir(): Promise<string | null> {
    return unwrap<string | null>(
      ipcRenderer.invoke(CH.chooseProjectDir) as Promise<IpcResult<string | null>>,
    );
  },

  readProject(dir: string): Promise<LoadedProject> {
    return unwrap<LoadedProject>(
      ipcRenderer.invoke(CH.readProject, dir) as Promise<IpcResult<LoadedProject>>,
    );
  },

  writeProject(args: WriteProjectArgs): Promise<WriteProjectResult> {
    return unwrap<WriteProjectResult>(
      ipcRenderer.invoke(CH.writeProject, args) as Promise<IpcResult<WriteProjectResult>>,
    );
  },

  ejectVolume(): Promise<void> {
    return unwrap<void>(ipcRenderer.invoke(CH.ejectVolume) as Promise<IpcResult<void>>);
  },

  openPath(dir: string): Promise<void> {
    return unwrap<void>(ipcRenderer.invoke(CH.openPath, dir) as Promise<IpcResult<void>>);
  },

  chooseLibraryDir(): Promise<string | null> {
    return unwrap<string | null>(
      ipcRenderer.invoke(CH.chooseLibraryDir) as Promise<IpcResult<string | null>>,
    );
  },

  scanLibrary(rootDir: string): Promise<LibraryEntry[]> {
    return unwrap<LibraryEntry[]>(
      ipcRenderer.invoke(CH.scanLibrary, rootDir) as Promise<IpcResult<LibraryEntry[]>>,
    );
  },

  cancelLibraryScan(): Promise<void> {
    return unwrap<void>(ipcRenderer.invoke(CH.cancelLibraryScan) as Promise<IpcResult<void>>);
  },

  onLibraryProgress(cb: (update: LibraryProgressUpdate) => void): () => void {
    const listener = (_event: unknown, update: LibraryProgressUpdate) => cb(update);
    ipcRenderer.on(LIBRARY_PROGRESS_EVENT, listener);
    return () => ipcRenderer.removeListener(LIBRARY_PROGRESS_EVENT, listener);
  },

  getLibraryTags(rootDir: string): Promise<LibraryTags> {
    return unwrap<LibraryTags>(
      ipcRenderer.invoke(CH.getLibraryTags, rootDir) as Promise<IpcResult<LibraryTags>>,
    );
  },

  setSampleTags(rootDir: string, relPath: string, tags: string[]): Promise<void> {
    return unwrap<void>(
      ipcRenderer.invoke(CH.setSampleTags, rootDir, relPath, tags) as Promise<IpcResult<void>>,
    );
  },
};

contextBridge.exposeInMainWorld("mpcDesktop", mpcDesktop);
