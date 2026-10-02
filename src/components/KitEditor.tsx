/**
 * KitEditor.tsx — Kit customization panel.
 *
 * Opened by dispatching window event `mpc:open-editor`.
 * Sections: kit picker, kit rename, pad bank grid, inline pad editor
 * (name / tune / gain / move / WAV drag-drop).
 *
 * Mirror TweaksPanel's modal / focus-trap / Escape / focus-restore pattern.
 */

import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import "../styles/editor.css";
import { BANK_LABELS, localToGlobal } from "../data/padLayout";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { buildUserSamplePad, importWavFile } from "../kits/importWav";
import type { GlobalPadIdx } from "../kits/kit.types";
import { buildLibrarySamplePad } from "../library/buildLibrarySamplePad";
import { isLibraryDragPayload, LIBRARY_DRAG_MIME } from "../library/library.types";
import { useMPCStore } from "../state/store";

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
}

// Row 0 (top) = local 13–16 (indices 12–15)
// Row 3 (bot) = local  1– 4 (indices  0– 3)
const PAD_ROWS: ReadonlyArray<ReadonlyArray<number>> = [
  [12, 13, 14, 15],
  [8, 9, 10, 11],
  [4, 5, 6, 7],
  [0, 1, 2, 3],
];

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Parse a user-typed pad target (1-based displayed pad number, 1..128) to
 *  a 0-based GlobalPadIdx, or return null on invalid input. */
function parseTargetPad(raw: string): GlobalPadIdx | null {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || n > 128) return null;
  return (n - 1) as GlobalPadIdx;
}

export function KitEditor() {
  const [open, setOpen] = useState(false);
  const [selectedPad, setSelectedPad] = useState<GlobalPadIdx | null>(null);
  const [dragOverPad, setDragOverPad] = useState<GlobalPadIdx | null>(null);
  const [dropError, setDropError] = useState<string>("");
  const [moveTarget, setMoveTarget] = useState<string>("");
  const [swapTarget, setSwapTarget] = useState<string>("");

  const prefersReducedMotion = useReducedMotion();

  const activeKit = useMPCStore((s) => s.activeKit);
  const padMap = useMPCStore((s) => s.padMap);
  const bankIdx = useMPCStore((s) => s.bankIdx);
  const setBank = useMPCStore((s) => s.setBank);
  const setKitName = useMPCStore((s) => s.setKitName);
  const setPadName = useMPCStore((s) => s.setPadName);
  const setPadTune = useMPCStore((s) => s.setPadTune);
  const setPadGain = useMPCStore((s) => s.setPadGain);
  const movePadSample = useMPCStore((s) => s.movePadSample);
  const swapPad = useMPCStore((s) => s.swapPad);
  const registerUserSample = useMPCStore((s) => s.registerUserSample);
  const setPadSample = useMPCStore((s) => s.setPadSample);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  const selectedPadData = selectedPad !== null ? padMap[selectedPad] : null;
  const visibleBanks = BANK_LABELS;

  useEffect(() => {
    const handler = () => {
      setOpen((prev) => {
        if (!prev) lastFocusRef.current = document.activeElement as HTMLElement;
        return !prev;
      });
    };
    window.addEventListener("mpc:open-editor", handler);
    return () => window.removeEventListener("mpc:open-editor", handler);
  }, []);

  // Focus management on open/close
  useEffect(() => {
    if (open) {
      const id = setTimeout(
        () => {
          closeBtnRef.current?.focus();
        },
        prefersReducedMotion ? 0 : 220,
      );
      return () => clearTimeout(id);
    } else {
      lastFocusRef.current?.focus();
    }
    return undefined;
  }, [open, prefersReducedMotion]);

  const closePanel = useCallback(() => {
    setOpen(false);
    setSelectedPad(null);
    setDropError("");
    setMoveTarget("");
    setSwapTarget("");
  }, []);

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
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [closePanel],
  );

  const handleKitNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setKitName(e.target.value);
    },
    [setKitName],
  );

  const handlePadNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (selectedPad === null) return;
      setPadName(selectedPad, e.target.value);
    },
    [selectedPad, setPadName],
  );

  const handleCoarseChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (selectedPad === null || !selectedPadData) return;
      const coarse = clamp(Number(e.target.value), -36, 36);
      setPadTune(selectedPad, coarse, selectedPadData.fineTune);
    },
    [selectedPad, selectedPadData, setPadTune],
  );

  const handleFineChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (selectedPad === null || !selectedPadData) return;
      const fine = clamp(Number(e.target.value), -100, 100);
      setPadTune(selectedPad, selectedPadData.coarseTune, fine);
    },
    [selectedPad, selectedPadData, setPadTune],
  );

  const handleGainChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (selectedPad === null) return;
      // Slider is 0..200 (representing 0..2 gainCoefficient).
      const gain = clamp(Number(e.target.value) / 100, 0, 2);
      setPadGain(selectedPad, gain);
    },
    [selectedPad, setPadGain],
  );

  const handleMove = useCallback(() => {
    if (selectedPad === null) return;
    const target = parseTargetPad(moveTarget);
    if (target === null) return;
    movePadSample(selectedPad, target);
    setSelectedPad(target);
    setMoveTarget("");
  }, [selectedPad, moveTarget, movePadSample]);

  const handleSwap = useCallback(() => {
    if (selectedPad === null) return;
    const target = parseTargetPad(swapTarget);
    if (target === null) return;
    swapPad(selectedPad, target);
    setSwapTarget("");
    // Keep selection on current pad (content swapped).
  }, [selectedPad, swapTarget, swapPad]);

  const handleDragOver = useCallback((e: DragEvent<HTMLButtonElement>, globalIdx: GlobalPadIdx) => {
    const hasWav =
      Array.from(e.dataTransfer.items).some(
        (item) =>
          item.kind === "file" &&
          (item.type === "audio/wav" ||
            item.type === "audio/x-wav" ||
            item.type === "audio/wave" ||
            item.type === ""),
      ) || Array.from(e.dataTransfer.files).some((f) => /\.wav$/i.test(f.name));
    if (hasWav || e.dataTransfer.items.length > 0) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragOverPad(globalIdx);
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverPad(null);
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLButtonElement>, globalIdx: GlobalPadIdx) => {
      e.preventDefault();
      setDragOverPad(null);
      setDropError("");

      const file = e.dataTransfer.files[0];
      if (!file) {
        // Not an OS file drop — check for a Sample Browser internal drag.
        const raw = e.dataTransfer.getData(LIBRARY_DRAG_MIME);
        if (!raw) return;
        try {
          const payload: unknown = JSON.parse(raw);
          if (!isLibraryDragPayload(payload)) return;
          setPadSample(globalIdx, buildLibrarySamplePad(globalIdx, payload));
          setSelectedPad(globalIdx);
        } catch (err) {
          setDropError(err instanceof Error ? err.message : "Failed to assign library sample.");
        }
        return;
      }

      try {
        const imported = await importWavFile(file);
        registerUserSample(imported.sampleId, imported.bytes);
        setPadSample(globalIdx, buildUserSamplePad(globalIdx, imported));
        setSelectedPad(globalIdx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to import file.";
        setDropError(msg);
      }
    },
    [registerUserSample, setPadSample],
  );

  const panelClass = `kit-editor${open ? " open" : ""}`;

  const style: React.CSSProperties = prefersReducedMotion ? { transition: "none" } : {};

  return (
    <div
      ref={panelRef}
      className={panelClass}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-labelledby="kit-editor-heading"
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ── Header ── */}
      <header>
        <h3 id="kit-editor-heading">EDIT KIT</h3>
        <button ref={closeBtnRef} type="button" aria-label="Close kit editor" onClick={closePanel}>
          ×
        </button>
      </header>

      {/* ── Kit Name ── */}
      <div className="ke-section">
        <label className="ke-section-label" htmlFor="ke-kit-name">
          Kit Name
        </label>
        <input
          id="ke-kit-name"
          type="text"
          className="ke-input"
          value={activeKit?.displayName ?? ""}
          onChange={handleKitNameChange}
          aria-label="Kit name"
          disabled={!activeKit}
          placeholder={activeKit ? undefined : "No kit loaded"}
          maxLength={64}
        />
      </div>

      {/* ── Pad Editor ── */}
      <div className="ke-section">
        <span className="ke-section-label" id="ke-pad-editor-label">
          Pads — Bank {BANK_LABELS[bankIdx] ?? "A"}
        </span>

        {/* Bank selector */}
        <div className="ke-bank-row" role="group" aria-label="Bank selector">
          {visibleBanks.map((label, i) => (
            <button
              key={label}
              type="button"
              className={`ke-bank-btn${i === bankIdx ? " active" : ""}`}
              aria-pressed={i === bankIdx}
              aria-label={`Bank ${label}`}
              onClick={() => {
                setBank(i);
                setSelectedPad(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 4×4 pad grid */}
        <div className="ke-pad-grid" role="group" aria-labelledby="ke-pad-editor-label">
          {PAD_ROWS.flat().map((localIdx) => {
            const globalIdx = localToGlobal(bankIdx, localIdx) as GlobalPadIdx;
            const pad = padMap[globalIdx];
            const localNum = localIdx + 1; // 1-based within bank for display
            const globalNum = globalIdx + 1; // 1-based global for aria
            const isSelected = selectedPad === globalIdx;
            const isDragOver = dragOverPad === globalIdx;

            return (
              <button
                key={globalIdx}
                type="button"
                className={[
                  "ke-pad-cell",
                  isSelected ? "selected" : "",
                  isDragOver ? "drag-over" : "",
                  !pad ? "empty" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-pressed={isSelected}
                aria-label={
                  pad
                    ? `Pad ${globalNum}, ${pad.displayName}, ${isSelected ? "selected" : "select"}`
                    : `Pad ${globalNum}, empty`
                }
                onClick={() => setSelectedPad(isSelected ? null : globalIdx)}
                onDragOver={(e) => handleDragOver(e, globalIdx)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, globalIdx)}
              >
                <span className="ke-pad-num">{localNum}</span>
                <span className="ke-pad-name">{pad?.displayName ?? "—"}</span>
                {isDragOver && (
                  <span className="ke-drop-hint" aria-hidden="true">
                    +
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Drop error (aria-live for screen readers) */}
        {dropError && (
          <div className="ke-error" role="alert" aria-live="assertive" data-testid="ke-drop-error">
            {dropError}
          </div>
        )}

        {/* Inline pad editor */}
        {selectedPad !== null && (
          <div
            className="ke-pad-editor"
            role="region"
            aria-label={`Editing pad ${selectedPad + 1}${selectedPadData ? `: ${selectedPadData.displayName}` : ""}`}
          >
            <div className="ke-pad-editor-title">
              Pad {selectedPad + 1}
              {selectedPadData ? ` — ${selectedPadData.displayName}` : " (empty)"}
            </div>

            {/* Pad name */}
            {selectedPadData && (
              <>
                <div className="ke-field">
                  <label htmlFor="ke-pad-name">Pad Name</label>
                  <input
                    id="ke-pad-name"
                    type="text"
                    className="ke-input"
                    value={selectedPadData.displayName}
                    onChange={handlePadNameChange}
                    aria-label="Pad display name"
                    maxLength={64}
                  />
                </div>

                {/* Coarse tune */}
                <div className="ke-field">
                  <label htmlFor="ke-coarse">Coarse Tune (semitones)</label>
                  <div className="ke-slider-row">
                    <input
                      id="ke-coarse"
                      type="range"
                      min={-36}
                      max={36}
                      step={1}
                      value={selectedPadData.coarseTune}
                      onChange={handleCoarseChange}
                      aria-label="Coarse tune in semitones"
                      aria-valuetext={`${selectedPadData.coarseTune} semitones`}
                    />
                    <span className="ke-slider-val">
                      {selectedPadData.coarseTune > 0
                        ? `+${selectedPadData.coarseTune}`
                        : selectedPadData.coarseTune}
                    </span>
                  </div>
                </div>

                {/* Fine tune */}
                <div className="ke-field">
                  <label htmlFor="ke-fine">Fine Tune (cents)</label>
                  <div className="ke-slider-row">
                    <input
                      id="ke-fine"
                      type="range"
                      min={-100}
                      max={100}
                      step={1}
                      value={selectedPadData.fineTune}
                      onChange={handleFineChange}
                      aria-label="Fine tune in cents"
                      aria-valuetext={`${selectedPadData.fineTune} cents`}
                    />
                    <span className="ke-slider-val">
                      {selectedPadData.fineTune > 0
                        ? `+${selectedPadData.fineTune}`
                        : selectedPadData.fineTune}
                    </span>
                  </div>
                </div>

                {/* Volume */}
                <div className="ke-field">
                  <label htmlFor="ke-gain">Volume</label>
                  <div className="ke-slider-row">
                    <input
                      id="ke-gain"
                      type="range"
                      min={0}
                      max={200}
                      step={1}
                      value={Math.round(selectedPadData.gainCoefficient * 100)}
                      onChange={handleGainChange}
                      aria-label="Pad volume"
                      aria-valuetext={`${Math.round(selectedPadData.gainCoefficient * 100)}%`}
                    />
                    <span className="ke-slider-val">
                      {Math.round(selectedPadData.gainCoefficient * 100)}%
                    </span>
                  </div>
                </div>

                {/* Effects rack */}
                <div className="ke-field">
                  <button
                    type="button"
                    className="ke-move-btn"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("mpc:open-effects", { detail: { padIdx: selectedPad } }),
                      )
                    }
                  >
                    Effects…
                  </button>
                </div>

                {/* Move */}
                <div className="ke-field">
                  <label htmlFor="ke-move-target">Move to pad (global 1–128)</label>
                  <div className="ke-move-row">
                    <input
                      id="ke-move-target"
                      type="number"
                      className="ke-move-input"
                      value={moveTarget}
                      onChange={(e) => setMoveTarget(e.target.value)}
                      aria-label="Target pad for move (1 to 128)"
                      min={1}
                      max={128}
                      placeholder="—"
                    />
                    <button
                      type="button"
                      className="ke-move-btn"
                      onClick={handleMove}
                      disabled={!moveTarget || parseTargetPad(moveTarget) === null}
                      aria-label={`Move pad ${selectedPad + 1} to pad ${moveTarget || "?"}`}
                    >
                      Move
                    </button>
                    <input
                      id="ke-swap-target"
                      type="number"
                      className="ke-move-input"
                      value={swapTarget}
                      onChange={(e) => setSwapTarget(e.target.value)}
                      aria-label="Target pad for swap (1 to 128)"
                      min={1}
                      max={128}
                      placeholder="—"
                    />
                    <button
                      type="button"
                      className="ke-move-btn"
                      onClick={handleSwap}
                      disabled={!swapTarget || parseTargetPad(swapTarget) === null}
                      aria-label={`Swap pad ${selectedPad + 1} with pad ${swapTarget || "?"}`}
                    >
                      Swap
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* WAV drop hint on empty pad */}
            <div className="ke-hint">Drop a .wav file onto any pad cell to assign it.</div>
          </div>
        )}

        {/* Global drop hint when no pad selected */}
        {selectedPad === null && (
          <p className="ke-hint" style={{ marginTop: 8 }}>
            Select a pad to edit tune, volume, and name. Drop a .wav file onto a pad cell to import.
          </p>
        )}
      </div>

      {/* ── Export hint ── */}
      <div className="ke-section">
        <p className="ke-hint" style={{ margin: 0 }}>
          Use the EXPORT button to download a .xpj ZIP for your Akai MPC.
        </p>
      </div>
    </div>
  );
}
