/**
 * StepSequencer.tsx — Step sequencer panel.
 *
 * v1 scope: live/MIDI-driven playback only (see the "Step Sequencer" plan) —
 * programs which pads fire on which beat-grid steps; playback is driven by
 * `PatternPlayer` via the existing hardware-style PLAY/STOP transport buttons
 * (`Transport.tsx`), wired in `useSequencer.ts`.
 *
 * Follows the same modal/focus-trap/Escape/`mpc:open-*` event convention as
 * `KitEditor.tsx` / `SampleBrowser.tsx`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../styles/sequencer.css";
import { BANK_LABELS, localToGlobal } from "../data/padLayout";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import { useReducedMotion } from "../hooks/useReducedMotion";
import {
  BEATS_PER_BAR,
  getPadSteps,
  MAX_BARS,
  MIN_BARS,
  STEPS_PER_BEAT,
  type Step,
  type StepResolution,
  totalSteps,
} from "../sequencer/sequencer.types";
import { useSequencerStore } from "../sequencer/sequencerStore";
import { useMPCStore } from "../state/store";
import type { PadIndex } from "../types/mpc.types";

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
}

const RESOLUTION_LABELS: Record<StepResolution, string> = {
  "8n": "1/8",
  "16n": "1/16",
  "32n": "1/32",
};

/** Scroll-to-adjust velocity increment and floor (a fully-silent active step isn't useful). */
const VELOCITY_STEP = 0.1;
const MIN_VELOCITY = 0.1;

export function StepSequencer() {
  const [open, setOpen] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  const pattern = useSequencerStore((s) => s.pattern);
  const isPlaying = useSequencerStore((s) => s.isPlaying);
  const currentStep = useSequencerStore((s) => s.currentStep);
  const toggleStep = useSequencerStore((s) => s.toggleStep);
  const setStepVelocity = useSequencerStore((s) => s.setStepVelocity);
  const setBars = useSequencerStore((s) => s.setBars);
  const setResolution = useSequencerStore((s) => s.setResolution);
  const clearPattern = useSequencerStore((s) => s.clearPattern);

  const bankIdx = useMPCStore((s) => s.bankIdx);
  const padMap = useMPCStore((s) => s.padMap);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const handler = () => {
      setOpen((prev) => {
        if (!prev) lastFocusRef.current = document.activeElement as HTMLElement;
        return !prev;
      });
    };
    window.addEventListener("mpc:open-sequencer", handler);
    return () => window.removeEventListener("mpc:open-sequencer", handler);
  }, []);

  useEffect(() => {
    if (open) {
      const id = setTimeout(() => closeBtnRef.current?.focus(), prefersReducedMotion ? 0 : 220);
      return () => clearTimeout(id);
    }
    lastFocusRef.current?.focus();
    return undefined;
  }, [open, prefersReducedMotion]);

  const closePanel = useCallback(() => setOpen(false), []);

  /**
   * Toggle a step; when it's turning ON, also trigger the pad so the user
   * hears what they just programmed (matches how hardware step sequencers
   * give audio feedback while building a pattern). Goes through
   * `store.triggerPad`/`releasePad` (not the engine directly) so it also
   * echoes to MIDI-out for a connected MPC, same as any other UI-driven hit.
   */
  const handleToggleStep = useCallback(
    (padIdx: PadIndex, stepIndex: number, wasActive: boolean, velocity: number) => {
      toggleStep(padIdx, stepIndex);
      if (!wasActive) {
        const store = useMPCStore.getState();
        store.triggerPad(padIdx, velocity);
        store.releasePad(padIdx);
      }
    },
    [toggleStep],
  );

  /** Scroll up/down on an active step to raise/lower its velocity. Inactive steps ignore the wheel. */
  const handleStepWheel = useCallback(
    (
      e: React.WheelEvent<HTMLButtonElement>,
      padIdx: PadIndex,
      stepIndex: number,
      step: Step | undefined,
    ) => {
      if (!step?.active) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? VELOCITY_STEP : -VELOCITY_STEP;
      const next =
        Math.round(Math.max(MIN_VELOCITY, Math.min(1, step.velocity + delta)) * 100) / 100;
      setStepVelocity(padIdx, stepIndex, next);
    },
    [setStepVelocity],
  );

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

  const steps = totalSteps(pattern.bars, pattern.resolution);
  const stepsPerBeat = STEPS_PER_BEAT[pattern.resolution];

  const rows = useMemo(
    () =>
      Array.from({ length: 16 }, (_, localIdx) => {
        const globalIdx = localToGlobal(bankIdx, localIdx) as PadIndex;
        return {
          globalIdx,
          localNum: localIdx + 1,
          label: padMap[globalIdx]?.displayName ?? `Pad ${localIdx + 1}`,
        };
      }),
    [bankIdx, padMap],
  );

  const drag = useDraggablePanel(panelRef);
  const panelClass = `step-sequencer${open ? " open" : ""}${drag.className}`;
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
      aria-labelledby="step-sequencer-heading"
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      <header {...drag.headerProps}>
        <h3 id="step-sequencer-heading">STEP SEQUENCER</h3>
        <button
          ref={closeBtnRef}
          type="button"
          aria-label="Close step sequencer"
          onClick={closePanel}
        >
          ×
        </button>
      </header>

      <div className="seq-section">
        <div className="seq-controls-row">
          <label className="seq-field">
            <span>Bars</span>
            <input
              type="number"
              min={MIN_BARS}
              max={MAX_BARS}
              value={pattern.bars}
              onChange={(e) => setBars(Number(e.target.value))}
              aria-label="Number of bars"
            />
          </label>
          <label className="seq-field">
            <span>Resolution</span>
            <select
              value={pattern.resolution}
              onChange={(e) => setResolution(e.target.value as StepResolution)}
              aria-label="Step resolution"
            >
              {(Object.keys(RESOLUTION_LABELS) as StepResolution[]).map((res) => (
                <option key={res} value={res}>
                  {RESOLUTION_LABELS[res]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="seq-clear-btn" onClick={clearPattern}>
            Clear
          </button>
        </div>
        <p className="seq-hint">
          Bank {BANK_LABELS[bankIdx] ?? "A"} · {isPlaying ? "Playing" : "Stopped"} — use the
          hardware-style PLAY/STOP buttons to run the pattern. Scroll on an active step to adjust
          its velocity.
        </p>
      </div>

      <div className="seq-section seq-grid-section">
        <div className="seq-grid-scroll">
          <div className="seq-grid" role="group" aria-label="Step sequencer grid">
            {rows.map((row) => {
              const padSteps = getPadSteps(pattern, row.globalIdx);
              return (
                <div className="seq-row" key={row.globalIdx}>
                  <span className="seq-row-label" title={row.label}>
                    {row.localNum}. {row.label}
                  </span>
                  <div className="seq-row-cells">
                    {Array.from({ length: steps }, (_, stepIdx) => {
                      const step = padSteps[stepIdx];
                      const isBeatStart = stepIdx % stepsPerBeat === 0;
                      const isBarStart = stepIdx % (stepsPerBeat * BEATS_PER_BAR) === 0;
                      const isCurrent = isPlaying && currentStep === stepIdx;
                      return (
                        <button
                          // biome-ignore lint/suspicious/noArrayIndexKey: step position is stable — steps are never reordered/filtered, only resized (handled by sequencerStore's resize logic).
                          key={`${row.globalIdx}-${stepIdx}`}
                          type="button"
                          className={[
                            "seq-cell",
                            step?.active ? "active" : "",
                            isBeatStart ? "beat-start" : "",
                            isBarStart ? "bar-start" : "",
                            isCurrent ? "current" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          style={step?.active ? { opacity: 0.4 + step.velocity * 0.6 } : undefined}
                          aria-label={
                            step?.active
                              ? `${row.label}, step ${stepIdx + 1}, on, velocity ${Math.round(step.velocity * 100)}%`
                              : `${row.label}, step ${stepIdx + 1}, off`
                          }
                          aria-pressed={step?.active ?? false}
                          onClick={() =>
                            handleToggleStep(
                              row.globalIdx,
                              stepIdx,
                              step?.active ?? false,
                              step?.velocity ?? 0.9,
                            )
                          }
                          onWheel={(e) => handleStepWheel(e, row.globalIdx, stepIdx, step)}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
