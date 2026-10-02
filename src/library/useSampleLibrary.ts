/**
 * useSampleLibrary.ts — Hook wiring the Sample Browser UI to the desktop
 * bridge's library IPC methods + the dedicated `libraryStore`.
 */

import { useCallback, useEffect, useRef } from "react";
import { desktop, isDesktop } from "../desktop/bridge";
import type { LibraryEntry } from "../desktop/bridge.types";
import { useLibraryStore } from "./libraryStore";

/** How often buffered decode results are merged into the store. */
const PROGRESS_FLUSH_MS = 250;

type UseSampleLibraryResult = {
  /** Open a native folder picker and scan the chosen directory. No-op outside Electron. */
  chooseFolder: () => Promise<void>;
  /** Re-scan the current root directory (fast if the cache is warm). */
  rescan: () => Promise<void>;
  /** Replace one sample's manual tags — updates local state immediately and persists in the background. */
  setTags: (relPath: string, tags: string[]) => void;
};

export function useSampleLibrary(): UseSampleLibraryResult {
  // Subscribe once to keep progress events flowing for the life of the panel,
  // independent of whether it's currently mounted/open.
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    // Progress arrives once per decoded file (tens of thousands for a big
    // library) — buffer it and apply in one store update per flush so the
    // entry list isn't rebuilt per file.
    const pending = new Map<string, Partial<LibraryEntry>>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (pending.size === 0) return;
      const batch = new Map(pending);
      pending.clear();
      useLibraryStore.getState().patchEntries(batch);
    };
    unsubscribeRef.current = desktop().onLibraryProgress((update) => {
      if (update.done) {
        if (timer) clearTimeout(timer);
        flush();
        useLibraryStore.getState().setScanStatus("ready");
        return;
      }
      pending.set(update.relPath, update.meta);
      if (!timer) timer = setTimeout(flush, PROGRESS_FLUSH_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, []);

  const scan = useCallback(async (rootDir: string): Promise<void> => {
    const store = useLibraryStore.getState();
    store.setRootDir(rootDir);
    store.setScanStatus("scanning");
    store.setError(null);
    try {
      const [entries, tags] = await Promise.all([
        desktop().scanLibrary(rootDir),
        desktop().getLibraryTags(rootDir),
      ]);
      useLibraryStore.getState().setEntries(entries);
      useLibraryStore.getState().setManualTags(tags);
      // If every file was already cached, no progress events will ever fire —
      // fall back to "ready" once nothing is left pending.
      if (useLibraryStore.getState().pendingDecodeCount === 0) {
        useLibraryStore.getState().setScanStatus("ready");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to scan the library folder.";
      useLibraryStore.getState().setError(message);
      useLibraryStore.getState().setScanStatus("error");
    }
  }, []);

  const chooseFolder = useCallback(async (): Promise<void> => {
    if (!isDesktop()) return;
    const dir = await desktop().chooseLibraryDir();
    if (dir === null) return;
    await scan(dir);
  }, [scan]);

  const rescan = useCallback(async (): Promise<void> => {
    if (!isDesktop()) return;
    const rootDir = useLibraryStore.getState().rootDir;
    if (rootDir === null) return;
    await scan(rootDir);
  }, [scan]);

  const setTags = useCallback((relPath: string, tags: string[]): void => {
    useLibraryStore.getState().setTagsForEntry(relPath, tags);
    const rootDir = useLibraryStore.getState().rootDir;
    if (rootDir === null || !isDesktop()) return;
    void desktop()
      .setSampleTags(rootDir, relPath, tags)
      .catch((err) => {
        console.warn("Failed to persist sample tags", err);
      });
  }, []);

  return { chooseFolder, rescan, setTags };
}
