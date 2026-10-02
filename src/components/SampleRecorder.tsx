/**
 * SampleRecorder.tsx — Record a sample from system/app audio (a browser tab,
 * VLC, Plex, ...) with no virtual audio cable — see `src/audio/SampleRecorder.ts`
 * for the capture engine and why this works via macOS's native picker.
 *
 * Follows the same modal/focus-trap/Escape/`mpc:open-*`/draggable-panel
 * convention as `KitEditor.tsx` / `SampleBrowser.tsx` / `StepSequencer.tsx`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../styles/recorder.css";
import * as Tone from "tone";
import { encodeWavPCM16 } from "../audio/encodeWav";
import { SampleRecorder as RecorderEngine } from "../audio/SampleRecorder";
import { BANK_LABELS, localToGlobal } from "../data/padLayout";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { sanitizeFileName } from "../kits/importWav";
import type { GlobalPadIdx, SamplePad } from "../kits/kit.types";
import { useMPCStore } from "../state/store";
import type { PadIndex } from "../types/mpc.types";

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
}

/** Draws a min/max peaks array into a small canvas — mirrors SampleBrowser's WaveformThumbnail. */
function WaveformPreview({ buffer }: { buffer: AudioBuffer | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    if (!buffer) return;

    const data = buffer.getChannelData(0);
    const numPoints = Math.min(width, 300);
    const bucketSize = Math.max(1, Math.floor(data.length / numPoints));
    const mid = height / 2;

    ctx.strokeStyle = "#2cc8f7";
    ctx.beginPath();
    for (let i = 0; i < numPoints; i++) {
      let min = 1;
      let max = -1;
      const start = i * bucketSize;
      const end = Math.min(data.length, start + bucketSize);
      for (let j = start; j < end; j++) {
        const v = data[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const x = (i / numPoints) * width;
      ctx.moveTo(x, mid + min * mid);
      ctx.lineTo(x, mid + max * mid);
    }
    ctx.stroke();
  }, [buffer]);

  return <canvas ref={canvasRef} width={392} height={64} className="rec-waveform" />;
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type Take = {
  bytes: Uint8Array;
  durationSec: number;
  buffer: AudioBuffer | null;
  audioUrl: string;
};

export function SampleRecorder() {
  const [open, setOpen] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [take, setTake] = useState<Take | null>(null);
  const [name, setName] = useState("Recording");

  const bankIdx = useMPCStore((s) => s.bankIdx);
  const padMap = useMPCStore((s) => s.padMap);
  const registerUserSample = useMPCStore((s) => s.registerUserSample);
  const setPadSample = useMPCStore((s) => s.setPadSample);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const engineRef = useRef<RecorderEngine>(new RecorderEngine());
  const levelRef = useRef(0);
  const startedAtRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const handler = () => {
      setOpen((prev) => {
        if (!prev) lastFocusRef.current = document.activeElement as HTMLElement;
        return !prev;
      });
    };
    window.addEventListener("mpc:open-sample-recorder", handler);
    return () => window.removeEventListener("mpc:open-sample-recorder", handler);
  }, []);

  useEffect(() => {
    if (open) {
      const id = setTimeout(() => closeBtnRef.current?.focus(), prefersReducedMotion ? 0 : 220);
      return () => clearTimeout(id);
    }
    // Closing mid-recording aborts the capture rather than leaving it dangling.
    engineRef.current.cancel();
    setRecording(false);
    lastFocusRef.current?.focus();
    return undefined;
  }, [open, prefersReducedMotion]);

  // Revoke the preview object URL when a take is replaced/cleared or the component unmounts.
  useEffect(() => {
    return () => {
      if (take) URL.revokeObjectURL(take.audioUrl);
    };
  }, [take]);

  const tick = useCallback(() => {
    setLevel(levelRef.current);
    setElapsed((Date.now() - startedAtRef.current) / 1000);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const handleStart = useCallback(async () => {
    setError(null);
    if (take) {
      URL.revokeObjectURL(take.audioUrl);
      setTake(null);
    }
    try {
      await engineRef.current.start((rms) => {
        levelRef.current = rms;
      });
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start recording.");
    }
  }, [take, tick]);

  const handleStop = useCallback(async () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setRecording(false);

    const { samples, sampleRate, durationSec } = engineRef.current.stop();
    if (samples.length === 0 || samples[0].length === 0) {
      setError("No audio was captured — try again and make sure the source is actually playing.");
      return;
    }

    const bytes = encodeWavPCM16(samples, sampleRate);
    let buffer: AudioBuffer | null = null;
    try {
      const ctx = Tone.getContext().rawContext as AudioContext;
      buffer = await ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
    } catch {
      // Preview is best-effort; the recording itself is still usable.
    }
    const audioUrl = URL.createObjectURL(
      new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" }),
    );
    setTake({ bytes, durationSec, buffer, audioUrl });
    setName(
      `Recording ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    );
  }, []);

  const handleDiscard = useCallback(() => {
    if (take) URL.revokeObjectURL(take.audioUrl);
    setTake(null);
    setError(null);
  }, [take]);

  const handleAssign = useCallback(
    (globalIdx: GlobalPadIdx) => {
      if (!take) return;
      const fileName = sanitizeFileName(name || "Recording");
      const sampleName = fileName.replace(/\.wav$/i, "");
      const sampleId = `recording:${Date.now()}`;

      registerUserSample(sampleId, take.bytes);
      void useMPCStore.getState().engineRef?.registerImportedSample?.(sampleId, take.bytes);

      const pad: SamplePad = {
        globalPadIdx: globalIdx,
        sampleId,
        displayName: sampleName,
        sampleName,
        fileName,
        url: null,
        coarseTune: 0,
        fineTune: 0,
        gainCoefficient: 1,
        pan: 0.5,
      };
      setPadSample(globalIdx, pad);

      URL.revokeObjectURL(take.audioUrl);
      setTake(null);
    },
    [take, name, registerUserSample, setPadSample],
  );

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

  const padRows = useMemo(
    () =>
      Array.from({ length: 16 }, (_, localIdx) => {
        const globalIdx = localToGlobal(bankIdx, localIdx) as PadIndex;
        const pad = padMap[globalIdx];
        return { globalIdx, localNum: localIdx + 1, pad };
      }),
    [bankIdx, padMap],
  );

  const drag = useDraggablePanel(panelRef);
  const panelClass = `sample-recorder${open ? " open" : ""}${drag.className}`;
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
      aria-labelledby="sample-recorder-heading"
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      <header {...drag.headerProps}>
        <h3 id="sample-recorder-heading">RECORD SAMPLE</h3>
        <button
          ref={closeBtnRef}
          type="button"
          aria-label="Close sample recorder"
          onClick={closePanel}
        >
          ×
        </button>
      </header>

      <div className="rec-section">
        <div className="rec-transport">
          <button
            type="button"
            className={`rec-record-btn${recording ? " recording" : ""}`}
            onClick={recording ? handleStop : handleStart}
            aria-label={recording ? "Stop recording" : "Start recording"}
          >
            <span className="rec-dot" aria-hidden="true" />
            {recording ? "Stop" : "Record"}
          </button>
          <span className="rec-time">{formatElapsed(elapsed)}</span>
          <div
            className="rec-meter"
            role="meter"
            aria-label="Input level"
            aria-valuenow={Math.round(Math.min(1, level) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="rec-meter-fill"
              style={{ width: `${Math.min(100, Math.round(level * 140))}%` }}
            />
          </div>
        </div>

        {error && (
          <p className="rec-error" role="alert">
            {error}
          </p>
        )}

        {!take && !recording && (
          <p className="rec-hint">
            Click Record and it captures whatever's currently playing through your Mac's audio
            output (a browser tab, VLC, Plex, ...) — no virtual audio cable needed. Since it's
            system-wide, make sure only the thing you want to record is actually playing.
          </p>
        )}
      </div>

      {take && (
        <div className="rec-section rec-preview">
          <WaveformPreview buffer={take.buffer} />
          <audio controls src={take.audioUrl} style={{ width: "100%", marginTop: "8px" }}>
            <track kind="captions" />
          </audio>

          <label className="rec-name-field">
            <span>Sample name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Sample name"
            />
          </label>

          <div className="rec-preview-actions">
            <button type="button" onClick={handleDiscard}>
              Discard
            </button>
          </div>

          <p className="rec-pick-hint">Click a pad below to assign this recording.</p>
          <div className="rec-pad-grid" role="group" aria-label="Assign recording to a pad">
            {padRows.map((row) => (
              <button
                key={row.globalIdx}
                type="button"
                className={`rec-pad-cell${!row.pad ? " empty" : ""}`}
                aria-label={
                  row.pad
                    ? `Assign to pad ${row.localNum}, currently ${row.pad.displayName}`
                    : `Assign to pad ${row.localNum}, empty`
                }
                onClick={() => handleAssign(row.globalIdx as GlobalPadIdx)}
              >
                <span className="rec-pad-num">
                  {BANK_LABELS[bankIdx] ?? "A"}
                  {row.localNum}
                </span>
                <span className="rec-pad-name">{row.pad?.displayName ?? "—"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
