/**
 * SampleBrowser.tsx — Sample Library browser panel (desktop-only).
 *
 * Lets the user point at a large local sample folder, browse/search/preview
 * instantly, and drag a row onto any pad in the main grid or KitEditor's
 * mini-grid to assign it (see `library/buildLibrarySamplePad.ts`). The scan
 * and any waveform/duration decoding happen in the Electron main process
 * (`electron/sampleLibrary.ts`) — this component only ever touches the file
 * list + incremental progress events, so it never blocks on a big library.
 *
 * Follows the same modal/focus-trap/Escape/`mpc:open-*` event convention as
 * `KitEditor.tsx`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../styles/library.css";
import type { LibraryEntry } from "../desktop/bridge.types";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { deriveAutoTags, derivePackName, effectiveTags } from "../library/autoTags";
import { entryFolder, LIBRARY_DRAG_MIME, librarySampleUrl } from "../library/library.types";
import { useLibraryStore } from "../library/libraryStore";
import { useSampleLibrary } from "../library/useSampleLibrary";

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
}

const ROW_HEIGHT = 58;
const OVERSCAN = 6;
const LIST_HEIGHT = 420;

function formatDuration(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec <= 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Draws a min/max peaks array into a small canvas. Re-draws only when peaks change. */
function WaveformThumbnail({ peaks }: { peaks: number[] | null | undefined }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    if (!peaks || peaks.length === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(0, height / 2 - 1, width, 2);
      return;
    }

    const numPoints = peaks.length / 2;
    const mid = height / 2;
    ctx.fillStyle = "#2cc8f7";
    for (let i = 0; i < numPoints; i++) {
      const min = peaks[i * 2];
      const max = peaks[i * 2 + 1];
      const x = (i / numPoints) * width;
      const yTop = mid - max * mid;
      const yBottom = mid - min * mid;
      ctx.fillRect(x, yTop, Math.max(1, width / numPoints), Math.max(1, yBottom - yTop));
    }
  }, [peaks]);

  return <canvas ref={canvasRef} width={72} height={24} className="sb-waveform" />;
}

type RowProps = {
  entry: LibraryEntry;
  tags: string[];
  isPlaying: boolean;
  isEditingTags: boolean;
  onTogglePlay: (entry: LibraryEntry) => void;
  onEditTags: (entry: LibraryEntry) => void;
};

function LibraryRow({ entry, tags, isPlaying, isEditingTags, onTogglePlay, onEditTags }: RowProps) {
  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData(
        LIBRARY_DRAG_MIME,
        JSON.stringify({
          absPath: entry.absPath,
          relPath: entry.relPath,
          fileName: entry.fileName,
        }),
      );
    },
    [entry],
  );

  const pending = entry.durationSec === undefined;

  return (
    <div
      className={`sb-row${isPlaying ? " playing" : ""}${isEditingTags ? " editing" : ""}`}
      style={{ height: ROW_HEIGHT }}
      draggable
      onDragStart={handleDragStart}
      role="listitem"
    >
      <button
        type="button"
        className="sb-play-btn"
        aria-label={isPlaying ? `Stop preview of ${entry.fileName}` : `Preview ${entry.fileName}`}
        onClick={() => onTogglePlay(entry)}
      >
        {isPlaying ? "■" : "▶"}
      </button>
      <div className="sb-row-main">
        <div className="sb-row-top">
          <span className="sb-row-name" title={entry.relPath}>
            {entry.fileName}
          </span>
          <WaveformThumbnail peaks={pending ? null : entry.peaks} />
          <span className="sb-row-duration">
            {pending ? "…" : formatDuration(entry.durationSec)}
          </span>
        </div>
        <div className="sb-row-bottom">
          <span className="sb-row-folder">{entryFolder(entry) || "/"}</span>
          {tags.length > 0 && (
            <span className="sb-row-tags">
              {tags.map((t) => (
                <span key={t} className="sb-tag-chip">
                  {t}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        className="sb-tag-edit-btn"
        aria-label={`Edit tags for ${entry.fileName}`}
        aria-pressed={isEditingTags}
        onClick={() => onEditTags(entry)}
      >
        #
      </button>
    </div>
  );
}

export function SampleBrowser() {
  const [open, setOpen] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [playingPath, setPlayingPath] = useState<string | null>(null);
  const [editingRelPath, setEditingRelPath] = useState<string | null>(null);
  const [newTagText, setNewTagText] = useState("");

  const prefersReducedMotion = useReducedMotion();
  const { chooseFolder, rescan, setTags } = useSampleLibrary();

  const rootDir = useLibraryStore((s) => s.rootDir);
  const entries = useLibraryStore((s) => s.entries);
  const scanStatus = useLibraryStore((s) => s.scanStatus);
  const pendingDecodeCount = useLibraryStore((s) => s.pendingDecodeCount);
  const filterText = useLibraryStore((s) => s.filterText);
  const setFilterText = useLibraryStore((s) => s.setFilterText);
  const manualTags = useLibraryStore((s) => s.manualTags);
  const packFilter = useLibraryStore((s) => s.packFilter);
  const setPackFilter = useLibraryStore((s) => s.setPackFilter);
  const tagFilter = useLibraryStore((s) => s.tagFilter);
  const setTagFilter = useLibraryStore((s) => s.setTagFilter);
  const error = useLibraryStore((s) => s.error);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const handler = () => {
      setOpen((prev) => {
        if (!prev) lastFocusRef.current = document.activeElement as HTMLElement;
        return !prev;
      });
    };
    window.addEventListener("mpc:open-library", handler);
    return () => window.removeEventListener("mpc:open-library", handler);
  }, []);

  useEffect(() => {
    if (open) {
      const id = setTimeout(() => closeBtnRef.current?.focus(), prefersReducedMotion ? 0 : 220);
      return () => clearTimeout(id);
    }
    lastFocusRef.current?.focus();
    return undefined;
  }, [open, prefersReducedMotion]);

  // Stop preview playback whenever the panel closes.
  useEffect(() => {
    if (!open) {
      audioRef.current?.pause();
      setPlayingPath(null);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  const closePanel = useCallback(() => setOpen(false), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePanel();
        return;
      }
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = getFocusableElements(panel);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [closePanel],
  );

  const handleTogglePlay = useCallback(
    (entry: LibraryEntry) => {
      let audio = audioRef.current;
      if (!audio) {
        audio = new Audio();
        audioRef.current = audio;
        audio.addEventListener("ended", () => setPlayingPath(null));
        audio.addEventListener("error", () => {
          console.error("Sample Browser: preview failed to load", audio?.currentSrc, audio?.error);
          setPlayingPath(null);
        });
      }
      if (playingPath === entry.absPath) {
        audio.pause();
        setPlayingPath(null);
        return;
      }
      audio.src = librarySampleUrl(entry.absPath);
      void audio.play().catch((err) => {
        console.error("Sample Browser: preview play() rejected", entry.absPath, err);
        setPlayingPath(null);
      });
      setPlayingPath(entry.absPath);
    },
    [playingPath],
  );

  const tagsByPath = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of entries) {
      map.set(e.relPath, effectiveTags(e, manualTags[e.relPath]));
    }
    return map;
  }, [entries, manualTags]);

  const packs = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      const pack = derivePackName(e);
      if (pack) set.add(pack);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const tags of tagsByPath.values()) {
      for (const t of tags) set.add(t);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [tagsByPath]);

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return entries.filter((e) => {
      if (packFilter !== null && derivePackName(e) !== packFilter) return false;
      const tags = tagsByPath.get(e.relPath) ?? [];
      if (tagFilter !== null && !tags.includes(tagFilter)) return false;
      if (!q) return true;
      return (
        e.fileName.toLowerCase().includes(q) ||
        e.relPath.toLowerCase().includes(q) ||
        tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [entries, filterText, packFilter, tagFilter, tagsByPath]);

  const editingEntry = useMemo(
    () =>
      editingRelPath === null ? null : (entries.find((e) => e.relPath === editingRelPath) ?? null),
    [entries, editingRelPath],
  );

  const handleOpenTagEditor = useCallback((entry: LibraryEntry) => {
    setEditingRelPath((prev) => (prev === entry.relPath ? null : entry.relPath));
    setNewTagText("");
  }, []);

  const handleRemoveManualTag = useCallback(
    (relPath: string, tag: string) => {
      const current = manualTags[relPath] ?? [];
      setTags(
        relPath,
        current.filter((t) => t !== tag),
      );
    },
    [manualTags, setTags],
  );

  const handleAddTags = useCallback(() => {
    if (editingRelPath === null) return;
    const auto = editingEntry ? deriveAutoTags(editingEntry) : [];
    const current = manualTags[editingRelPath] ?? [];
    const existing = new Set([...auto, ...current].map((t) => t.toLowerCase()));
    const additions = newTagText
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !existing.has(t.toLowerCase()));
    if (additions.length === 0) {
      setNewTagText("");
      return;
    }
    setTags(editingRelPath, [...current, ...additions]);
    setNewTagText("");
  }, [editingRelPath, editingEntry, manualTags, newTagText, setTags]);

  const totalHeight = filtered.length * ROW_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(LIST_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const endIdx = Math.min(filtered.length, startIdx + visibleCount);
  const visibleRows = filtered.slice(startIdx, endIdx);

  const handleScroll = useCallback(() => {
    if (listRef.current) setScrollTop(listRef.current.scrollTop);
  }, []);

  const statusLabel =
    scanStatus === "scanning" || (scanStatus === "ready" && pendingDecodeCount > 0)
      ? `Decoding… ${entries.length - pendingDecodeCount}/${entries.length}`
      : scanStatus === "ready"
        ? `${entries.length} sample${entries.length === 1 ? "" : "s"}`
        : scanStatus === "error"
          ? "Scan failed"
          : "No folder chosen";

  const drag = useDraggablePanel(panelRef);
  const panelClass = `sample-browser${open ? " open" : ""}${drag.className}`;
  const style: React.CSSProperties = {
    ...(prefersReducedMotion ? { transition: "none" } : {}),
    ...drag.style,
  };

  return (
    <div
      ref={panelRef}
      className={panelClass}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sample-browser-heading"
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      <header {...drag.headerProps}>
        <h3 id="sample-browser-heading">SAMPLE LIBRARY</h3>
        <button
          ref={closeBtnRef}
          type="button"
          aria-label="Close sample library"
          onClick={closePanel}
        >
          ×
        </button>
      </header>

      <div className="sb-section">
        <div className="sb-folder-row">
          <button type="button" className="sb-folder-btn" onClick={() => void chooseFolder()}>
            Choose Folder…
          </button>
          {rootDir && (
            <button
              type="button"
              className="sb-folder-btn secondary"
              onClick={() => void rescan()}
              disabled={scanStatus === "scanning"}
              aria-label="Rescan the current library folder"
            >
              Rescan
            </button>
          )}
        </div>
        {rootDir && (
          <p className="sb-root-path" title={rootDir}>
            {rootDir}
          </p>
        )}
        <p className="sb-status" aria-live="polite">
          {statusLabel}
        </p>
        {error && (
          <p className="sb-error" role="alert">
            {error}
          </p>
        )}
      </div>

      {rootDir && (
        <div className="sb-section">
          <input
            type="text"
            className="sb-search"
            placeholder="Filter by name or tag…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            aria-label="Filter sample library"
          />

          <div className="sb-facet-row">
            <select
              className="sb-facet-select"
              value={packFilter ?? ""}
              onChange={(e) => setPackFilter(e.target.value || null)}
              aria-label="Filter by pack"
            >
              <option value="">All Packs</option>
              {packs.map((pack) => (
                <option key={pack} value={pack}>
                  {pack}
                </option>
              ))}
            </select>
            <select
              className="sb-facet-select"
              value={tagFilter ?? ""}
              onChange={(e) => setTagFilter(e.target.value || null)}
              aria-label="Filter by tag"
            >
              <option value="">All Tags</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </div>

          <div
            ref={listRef}
            className="sb-list"
            style={{ height: LIST_HEIGHT }}
            onScroll={handleScroll}
            role="list"
            aria-label="Sample library results"
          >
            <div style={{ height: totalHeight, position: "relative" }}>
              {visibleRows.map((entry, i) => (
                <div
                  key={entry.relPath}
                  style={{
                    position: "absolute",
                    top: (startIdx + i) * ROW_HEIGHT,
                    left: 0,
                    right: 0,
                  }}
                >
                  <LibraryRow
                    entry={entry}
                    tags={tagsByPath.get(entry.relPath) ?? []}
                    isPlaying={playingPath === entry.absPath}
                    isEditingTags={editingRelPath === entry.relPath}
                    onTogglePlay={handleTogglePlay}
                    onEditTags={handleOpenTagEditor}
                  />
                </div>
              ))}
            </div>
          </div>

          {filtered.length === 0 && entries.length > 0 && (
            <p className="sb-hint">No samples match the current filters.</p>
          )}

          {editingEntry && (
            <div
              className="sb-tag-editor"
              role="region"
              aria-label={`Editing tags for ${editingEntry.fileName}`}
            >
              <div className="sb-tag-editor-title">Tags — {editingEntry.fileName}</div>
              <div className="sb-tag-editor-chips">
                {deriveAutoTags(editingEntry).map((tag) => (
                  <span
                    key={`auto-${tag}`}
                    className="sb-tag-chip auto"
                    title="Auto-suggested from folder/filename"
                  >
                    {tag}
                  </span>
                ))}
                {(manualTags[editingEntry.relPath] ?? []).map((tag) => (
                  <span key={`manual-${tag}`} className="sb-tag-chip manual">
                    {tag}
                    <button
                      type="button"
                      className="sb-tag-remove"
                      aria-label={`Remove tag ${tag}`}
                      onClick={() => handleRemoveManualTag(editingEntry.relPath, tag)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="sb-tag-add-row">
                <input
                  type="text"
                  className="sb-tag-input"
                  placeholder="Add tag(s), comma-separated…"
                  value={newTagText}
                  onChange={(e) => setNewTagText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddTags();
                    }
                  }}
                  aria-label="New tag text"
                />
                <button type="button" className="sb-folder-btn secondary" onClick={handleAddTags}>
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {!rootDir && (
        <div className="sb-section">
          <p className="sb-hint">
            Choose a folder to browse its samples. Duration and waveforms fill in progressively —
            you can start dragging samples onto pads right away.
          </p>
        </div>
      )}

      <div className="sb-section">
        <p className="sb-hint" style={{ margin: 0 }}>
          Drag any row onto a pad to assign it. Click ▶ to preview.
        </p>
      </div>
    </div>
  );
}
