import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { buildUserSamplePad, importWavFile } from "../kits/importWav";
import type { GlobalPadIdx, SamplePad } from "../kits/kit.types";
import { buildLibrarySamplePad } from "../library/buildLibrarySamplePad";
import { isLibraryDragPayload, LIBRARY_DRAG_MIME } from "../library/library.types";
import { useMPCStore } from "../state/store";
import type { PadDefinition } from "../types/mpc.types";

type PadProps = {
  /** Local pad definition (geometry, label, key) for the 4×4 layout. */
  definition: PadDefinition;
  /**
   * Global pad index (0..127) = bankIdx*16 + localIdx.
   * Used for store lookups and event dispatch.
   */
  globalIdx: GlobalPadIdx;
  /**
   * Assigned sample for this pad slot, or `null` if unpopulated.
   * When provided, `sample.displayName` replaces the static layout label.
   */
  sample?: SamplePad | null;
  /**
   * `true` while the sample buffer for this pad is being fetched/decoded.
   * Adds a subtle loading indicator and `aria-busy` attribute.
   */
  loading?: boolean;
  className?: string;
};

// Auto-dismiss delay for inline drop errors (ms).
const DROP_ERROR_DISMISS_MS = 4000;

// Minimum pointer travel (px) before a press becomes a drag-to-swap gesture.
// Below this threshold the press is treated as a normal tap (plays the pad).
const DRAG_THRESHOLD_PX = 10;

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  // Becomes true once the pointer travels past DRAG_THRESHOLD_PX.
  dragging: boolean;
};

export function Pad({
  definition,
  globalIdx,
  sample = null,
  loading = false,
  className,
}: PadProps) {
  const state = useMPCStore((s) => s.pads[globalIdx]);
  const triggerPad = useMPCStore((s) => s.triggerPad);
  const releasePad = useMPCStore((s) => s.releasePad);
  // swapPad exchanges two pad slots in the padMap (and the live audio engine).
  // globalPadIdx is updated on each swapped pad, so the export reflects the swap.
  const swapPad = useMPCStore((s) => s.swapPad);
  const registerUserSample = useMPCStore((s) => s.registerUserSample);
  const setPadSample = useMPCStore((s) => s.setPadSample);

  // useReducedMotion — CSS handles the transition:none override via media query;
  // we query it here so tests can verify the hook was invoked.
  useReducedMotion();

  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDragging) return;
    document.body.classList.add("is-pad-dragging");
    return () => document.body.classList.remove("is-pad-dragging");
  }, [isDragging]);
  // Timer reference so we can clear a pending dismiss on unmount / new error.
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Active pointer drag state; null when no drag is in progress.
  const dragRef = useRef<DragState | null>(null);
  // The pad element currently highlighted as a potential swap target.
  const swapTargetRef = useRef<Element | null>(null);

  const clearSwapTarget = useCallback(() => {
    swapTargetRef.current?.classList.remove("pad--swap-target");
    swapTargetRef.current = null;
  }, []);

  const clearDropError = useCallback(() => {
    if (errorTimerRef.current !== null) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setDropError(null);
  }, []);

  const showDropError = useCallback(
    (message: string) => {
      clearDropError();
      setDropError(message);
      errorTimerRef.current = setTimeout(() => {
        setDropError(null);
        errorTimerRef.current = null;
      }, DROP_ERROR_DISMISS_MS);
    },
    [clearDropError],
  );

  const stateClass = state === "press" ? "is-press" : state === "armed" ? "is-armed" : "";
  const loadingClass = loading ? "is-loading" : "";
  const dropClass = isDragOver ? "pad--drop-target" : "";
  const draggingClass = isDragging ? "pad--dragging" : "";
  const padClass = ["pad", stateClass, loadingClass, dropClass, draggingClass, className]
    .filter(Boolean)
    .join(" ");

  const paddedNum = String(definition.num).padStart(2, "0");

  // Sample name takes priority over the static layout label.
  const capLabel = sample?.displayName ?? definition.label;

  // Accessible label: pad number + bank-relative position + sample name.
  const ariaLabel = sample
    ? `Pad ${definition.num} — ${sample.displayName}`
    : `Pad ${definition.num} — ${definition.label}`;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const vel = e.pressure > 0 ? e.pressure : 0.9;
      // Playback fires immediately on press — this is intentional. Even when a
      // drag follows, the brief sound confirms which pad you grabbed.
      triggerPad(globalIdx, vel);
      e.currentTarget.setPointerCapture?.(e.pointerId);
      // Record drag origin so handlePointerMove can detect a drag gesture.
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
      };
    },
    [globalIdx, triggerPad],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;

      // Only transition to drag state once the threshold is crossed.
      if (!drag.dragging) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD_PX) return;
        drag.dragging = true;
        setIsDragging(true);
      }

      setDragPos({ x: e.clientX, y: e.clientY });

      // Find the pad under the pointer. setPointerCapture routes all events to
      // the origin element, so elementFromPoint gives the real hit-tested target.
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const padEl = el?.closest("[data-pad-idx]") ?? null;
      const rawIdx = padEl?.getAttribute("data-pad-idx");
      const targetIdx = rawIdx != null ? parseInt(rawIdx, 10) : NaN;
      // Don't highlight the source pad as a drop target.
      const validTarget = !Number.isNaN(targetIdx) && targetIdx !== globalIdx ? padEl : null;

      if (validTarget !== swapTargetRef.current) {
        clearSwapTarget();
        if (validTarget) {
          validTarget.classList.add("pad--swap-target");
          swapTargetRef.current = validTarget;
        }
      }
    },
    [globalIdx, clearSwapTarget],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      releasePad(globalIdx);
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }

      const drag = dragRef.current;
      if (drag?.dragging) {
        // Resolve the drop target from the final pointer position.
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const padEl = el?.closest("[data-pad-idx]");
        const rawIdx = padEl?.getAttribute("data-pad-idx");
        const targetIdx = rawIdx != null ? parseInt(rawIdx, 10) : NaN;
        if (
          !Number.isNaN(targetIdx) &&
          targetIdx >= 0 &&
          targetIdx <= 127 &&
          targetIdx !== globalIdx
        ) {
          swapPad(globalIdx, targetIdx as GlobalPadIdx);
        }
      }

      clearSwapTarget();
      dragRef.current = null;
      setIsDragging(false);
      setDragPos(null);
    },
    [globalIdx, releasePad, swapPad, clearSwapTarget],
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      releasePad(globalIdx);
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }
      clearSwapTarget();
      dragRef.current = null;
      setIsDragging(false);
      setDragPos(null);
    },
    [globalIdx, releasePad, clearSwapTarget],
  );

  const handlePointerLeave = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      // During an active drag, pointer capture keeps events flowing to this
      // element — let the drag continue and resolve on pointerUp/pointerCancel.
      if (dragRef.current?.dragging) {
        // Release the auditory press state but keep capture for swap tracking.
        releasePad(globalIdx);
        return;
      }
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        releasePad(globalIdx);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        dragRef.current = null;
        setIsDragging(false);
      }
    },
    [globalIdx, releasePad],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.repeat) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        triggerPad(globalIdx, 0.9);
      }
    },
    [globalIdx, triggerPad],
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === " " || e.key === "Enter") {
        releasePad(globalIdx);
      }
    },
    [globalIdx, releasePad],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLButtonElement>) => {
    // Respond to OS file drags and internal Sample Browser drags; ignore
    // other internal element drags (e.g. pad-to-pad pointer drags).
    if (
      e.dataTransfer.types.includes("Files") ||
      e.dataTransfer.types.includes(LIBRARY_DRAG_MIME)
    ) {
      e.preventDefault();
      setIsDragOver(true);
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLButtonElement>) => {
    if (
      e.dataTransfer.types.includes("Files") ||
      e.dataTransfer.types.includes(LIBRARY_DRAG_MIME)
    ) {
      e.preventDefault();
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLButtonElement>) => {
      e.preventDefault();
      setIsDragOver(false);

      const files = Array.from(e.dataTransfer.files);

      if (files.length === 0) {
        // Not an OS file drop — check for a Sample Browser internal drag.
        // getData() must be read synchronously within the drop handler.
        const raw =
          typeof e.dataTransfer.getData === "function"
            ? e.dataTransfer.getData(LIBRARY_DRAG_MIME)
            : "";
        if (!raw) return;
        try {
          const payload: unknown = JSON.parse(raw);
          if (!isLibraryDragPayload(payload)) return;
          setPadSample(globalIdx, buildLibrarySamplePad(globalIdx, payload));
          clearDropError();
        } catch (err) {
          showDropError(err instanceof Error ? err.message : "Failed to assign library sample.");
        }
        return;
      }

      // Capture mutable store refs at drop time so async continuation uses
      // the engine that is live when the drop fires (not a stale closure).
      const engineRef = useMPCStore.getState().engineRef;

      void (async () => {
        let firstError: string | null = null;
        await Promise.all(
          files.map(async (file, i) => {
            const targetIdx = (globalIdx + i) as typeof globalIdx;
            if (targetIdx > 127) return;
            try {
              const imported = await importWavFile(file);
              if (targetIdx === globalIdx) {
                registerUserSample(imported.sampleId, imported.bytes);
                await engineRef?.registerImportedSample?.(imported.sampleId, imported.bytes);
                setPadSample(globalIdx, buildUserSamplePad(globalIdx, imported));
              } else {
                useMPCStore.getState().registerUserSample(imported.sampleId, imported.bytes);
                await engineRef?.registerImportedSample?.(imported.sampleId, imported.bytes);
                useMPCStore
                  .getState()
                  .setPadSample(targetIdx, buildUserSamplePad(targetIdx, imported));
              }
            } catch (err) {
              if (firstError === null) {
                firstError = err instanceof Error ? err.message : "Failed to load sample.";
              }
            }
          }),
        );
        if (firstError !== null) {
          showDropError(firstError);
        } else {
          clearDropError();
        }
      })();
    },
    [globalIdx, registerUserSample, setPadSample, clearDropError, showDropError],
  );

  return (
    <>
      <button
        type="button"
        className={padClass}
        data-pad-idx={globalIdx}
        aria-label={ariaLabel}
        aria-pressed={state === "press"}
        aria-busy={loading || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className="pad-num">{paddedNum}</span>
        {loading && (
          <span className="pad-loading" aria-hidden="true">
            ·
          </span>
        )}
        <span className="pad-cap">{capLabel}</span>
        {dropError && (
          <span className="pad-drop-error" role="alert">
            {dropError}
          </span>
        )}
      </button>
      {isDragging &&
        dragPos &&
        createPortal(
          <div
            className="pad-drag-ghost"
            style={{ left: dragPos.x, top: dragPos.y }}
            aria-hidden="true"
          >
            <svg
              className="pad-drag-ghost-icon"
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M1 4.5h9.5M9 2.5l2 2-2 2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M13 9.5H3.5M5.5 7.5l-2 2 2 2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="pad-drag-ghost-num">{paddedNum}</span>
            <span className="pad-drag-ghost-label">{capLabel}</span>
          </div>,
          document.body,
        )}
    </>
  );
}
