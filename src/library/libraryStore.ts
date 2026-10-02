/**
 * libraryStore.ts — Dedicated Zustand store for the Sample Browser.
 *
 * Kept separate from `useMPCStore` (src/state/store.ts) deliberately: this
 * store is about *browsing the filesystem*, not about pad/kit state, and the
 * two have no overlapping concerns beyond "the browser writes into padMap".
 */

import { create } from "zustand";
import type { LibraryEntry } from "../desktop/bridge.types";

export type ScanStatus = "idle" | "scanning" | "ready" | "error";

type LibraryState = {
  rootDir: string | null;
  entries: LibraryEntry[];
  scanStatus: ScanStatus;
  /** Count of entries still awaiting decoded metadata (duration/peaks). */
  pendingDecodeCount: number;
  filterText: string;
  error: string | null;
  /** Manually-added tags per sample, keyed by relPath. Persisted via desktop().setSampleTags. */
  manualTags: Record<string, string[]>;
  /** Selected pack facet, or null for "all packs". */
  packFilter: string | null;
  /** Selected tag facet (auto + manual), or null for "all tags". */
  tagFilter: string | null;
};

type LibraryActions = {
  setRootDir: (dir: string | null) => void;
  setScanStatus: (status: ScanStatus) => void;
  setEntries: (entries: LibraryEntry[]) => void;
  /** Merge decoded metadata into the entry matching `relPath`. */
  patchEntry: (relPath: string, meta: Partial<LibraryEntry>) => void;
  /** Merge many decoded-metadata updates in one pass (one state change, O(entries)). */
  patchEntries: (updates: Map<string, Partial<LibraryEntry>>) => void;
  setFilterText: (text: string) => void;
  setError: (message: string | null) => void;
  setManualTags: (tags: Record<string, string[]>) => void;
  /** Update one sample's manual tags in local state (persistence happens separately via IPC). */
  setTagsForEntry: (relPath: string, tags: string[]) => void;
  setPackFilter: (pack: string | null) => void;
  setTagFilter: (tag: string | null) => void;
  reset: () => void;
};

const initialState: LibraryState = {
  rootDir: null,
  entries: [],
  scanStatus: "idle",
  pendingDecodeCount: 0,
  filterText: "",
  error: null,
  manualTags: {},
  packFilter: null,
  tagFilter: null,
};

/**
 * A file the scanner decoded but couldn't parse as audio (corrupt/not really a
 * WAV/AIFF): decoding finished, yet there's no sample rate. Skipped files that
 * are merely too large for peaks still report a real sample rate, so they stay.
 */
function isUnreadable(e: LibraryEntry): boolean {
  return e.peaks !== undefined && e.sampleRate === 0;
}

export const useLibraryStore = create<LibraryState & LibraryActions>((set) => ({
  ...initialState,

  setRootDir: (dir) => set({ rootDir: dir }),

  setScanStatus: (status) => set({ scanStatus: status }),

  setEntries: (allEntries) => {
    const entries = allEntries.filter((e) => !isUnreadable(e));
    set({
      entries,
      pendingDecodeCount: entries.filter((e) => e.peaks === undefined).length,
    });
  },

  patchEntry: (relPath, meta) =>
    set((state) => {
      let changed = false;
      const entries = state.entries.map((e) => {
        if (e.relPath !== relPath) return e;
        changed = true;
        return { ...e, ...meta };
      });
      if (!changed) return state;
      return {
        entries: entries.filter((e) => !isUnreadable(e)),
        pendingDecodeCount: Math.max(0, state.pendingDecodeCount - 1),
      };
    }),

  patchEntries: (updates) =>
    set((state) => {
      let patched = 0;
      const entries: LibraryEntry[] = [];
      for (const e of state.entries) {
        const meta = updates.get(e.relPath);
        if (!meta) {
          entries.push(e);
          continue;
        }
        patched++;
        const next = { ...e, ...meta };
        if (!isUnreadable(next)) entries.push(next);
      }
      if (patched === 0) return state;
      return {
        entries,
        pendingDecodeCount: Math.max(0, state.pendingDecodeCount - patched),
      };
    }),

  setFilterText: (text) => set({ filterText: text }),

  setError: (message) => set({ error: message }),

  setManualTags: (tags) => set({ manualTags: tags }),

  setTagsForEntry: (relPath, tags) =>
    set((state) => {
      const next = { ...state.manualTags };
      if (tags.length === 0) {
        delete next[relPath];
      } else {
        next[relPath] = tags;
      }
      return { manualTags: next };
    }),

  setPackFilter: (pack) => set({ packFilter: pack }),

  setTagFilter: (tag) => set({ tagFilter: tag }),

  reset: () => set(initialState),
}));
