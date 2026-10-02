/**
 * EffectsRackPanel.tsx — Offline multi-effect rack.
 *
 * Fixes the hardware's "add effect, bounce, add next effect, bounce again"
 * workflow: build a chain of effects (filter → bitcrusher → reverb → ...),
 * preview it live, then render the WHOLE chain through the sample in one
 * pass and write the result back onto the pad as a new sample. See
 * `src/audio/effectsChain.ts` for the actual signal-chain + render logic.
 *
 * Opened by dispatching `mpc:open-effects` with `detail: { padIdx }`.
 * Follows the same modal/focus-trap/Escape convention as `KitEditor.tsx` /
 * `SampleRecorder.tsx`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Tone from "tone";
import "../styles/effectsRack.css";
import {
  createEffect,
  defaultParamsFor,
  EFFECT_LABELS,
  EFFECT_TYPES,
  type EffectInstance,
  type EffectType,
} from "../audio/effects.types";
import { previewEffectsChain, renderEffectsChain } from "../audio/effectsChain";
import { encodeWavPCM16 } from "../audio/encodeWav";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { sanitizeFileName } from "../kits/importWav";
import type { GlobalPadIdx, SamplePad } from "../kits/kit.types";
import { useMPCStore } from "../state/store";

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
}

/**
 * Resolve a pad's raw sample bytes regardless of origin — mirrors the same
 * `url === null → userSamples` / `url !== null → fetch` split used by
 * `buildProjectArtifacts` (export) and `loadProjectFromDir` (project load).
 */
async function getPadBytes(
  pad: SamplePad,
  userSamples: Map<string, Uint8Array>,
): Promise<Uint8Array> {
  if (pad.url === null) {
    const bytes = userSamples.get(pad.sampleId);
    if (!bytes) {
      throw new Error(`No bytes registered for sample "${pad.sampleId}" — try reloading the pad.`);
    }
    return bytes;
  }
  const res = await fetch(pad.url);
  if (!res.ok) {
    throw new Error(`Failed to fetch sample (HTTP ${res.status}).`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Per-effect-type param field definitions, driven generically below. */
type FieldSpec = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
};
const FIELD_SPECS: Record<EffectType, FieldSpec[]> = {
  filter: [
    { key: "frequency", label: "Frequency", min: 20, max: 20000, step: 10, unit: "Hz" },
    { key: "Q", label: "Resonance", min: 0.1, max: 20, step: 0.1 },
  ],
  distortion: [{ key: "amount", label: "Drive", min: 0, max: 1, step: 0.01 }],
  bitcrusher: [{ key: "bits", label: "Bit depth", min: 1, max: 16, step: 1 }],
  chorus: [
    { key: "frequency", label: "Rate", min: 0.1, max: 10, step: 0.1, unit: "Hz" },
    { key: "delayTime", label: "Delay", min: 1, max: 20, step: 0.5, unit: "ms" },
    { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01 },
  ],
  delay: [
    { key: "delayTime", label: "Time", min: 0.01, max: 1, step: 0.01, unit: "s" },
    { key: "feedback", label: "Feedback", min: 0, max: 0.95, step: 0.01 },
    { key: "wet", label: "Mix", min: 0, max: 1, step: 0.01 },
  ],
  reverb: [
    { key: "decay", label: "Decay", min: 0.1, max: 10, step: 0.1, unit: "s" },
    { key: "preDelay", label: "Pre-delay", min: 0, max: 0.5, step: 0.01, unit: "s" },
    { key: "wet", label: "Mix", min: 0, max: 1, step: 0.01 },
  ],
};

export function EffectsRackPanel() {
  const [open, setOpen] = useState(false);
  const [padIdx, setPadIdx] = useState<GlobalPadIdx | null>(null);
  const [chain, setChain] = useState<EffectInstance[]>([]);
  const [addType, setAddType] = useState<EffectType>("filter");
  const [status, setStatus] = useState<"idle" | "loading" | "previewing" | "rendering" | "done">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  const prefersReducedMotion = useReducedMotion();

  const padMap = useMPCStore((s) => s.padMap);
  const userSamples = useMPCStore((s) => s.userSamples);
  const registerUserSample = useMPCStore((s) => s.registerUserSample);
  const setPadSample = useMPCStore((s) => s.setPadSample);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const stopPreviewRef = useRef<(() => void) | null>(null);

  const pad = padIdx !== null ? padMap[padIdx] : null;

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ padIdx: GlobalPadIdx }>).detail;
      lastFocusRef.current = document.activeElement as HTMLElement;
      setPadIdx(detail.padIdx);
      setChain([]);
      setError(null);
      setStatus("idle");
      setOpen(true);
    };
    window.addEventListener("mpc:open-effects", handler);
    return () => window.removeEventListener("mpc:open-effects", handler);
  }, []);

  useEffect(() => {
    if (open) {
      const id = setTimeout(() => closeBtnRef.current?.focus(), prefersReducedMotion ? 0 : 220);
      return () => clearTimeout(id);
    }
    stopPreviewRef.current?.();
    stopPreviewRef.current = null;
    lastFocusRef.current?.focus();
    return undefined;
  }, [open, prefersReducedMotion]);

  // Stop any in-flight preview on unmount.
  useEffect(() => () => stopPreviewRef.current?.(), []);

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

  const handleAddEffect = useCallback(() => {
    setChain((prev) => [...prev, createEffect(addType)]);
  }, [addType]);

  const handleRemoveEffect = useCallback((id: string) => {
    setChain((prev) => prev.filter((fx) => fx.id !== id));
  }, []);

  const handleMove = useCallback((id: string, dir: -1 | 1) => {
    setChain((prev) => {
      const i = prev.findIndex((fx) => fx.id === id);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const handleParamChange = useCallback((id: string, key: string, value: number) => {
    setChain(
      (prev) =>
        prev.map((fx) =>
          fx.id === id ? { ...fx, params: { ...fx.params, [key]: value } } : fx,
        ) as EffectInstance[],
    );
  }, []);

  const handleResetParams = useCallback((id: string) => {
    setChain(
      (prev) =>
        prev.map((fx) =>
          fx.id === id ? { ...fx, params: defaultParamsFor(fx.type) } : fx,
        ) as EffectInstance[],
    );
  }, []);

  const decodePadBuffer = useCallback(async (): Promise<AudioBuffer> => {
    if (!pad) throw new Error("No pad selected.");
    const bytes = await getPadBytes(pad, userSamples);
    const audioCtx = Tone.getContext().rawContext as AudioContext;
    // Copy into a fresh ArrayBuffer — decodeAudioData detaches its input.
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return audioCtx.decodeAudioData(copy as ArrayBuffer);
  }, [pad, userSamples]);

  const handlePreview = useCallback(async () => {
    if (chain.length === 0 || !pad) return;
    setError(null);
    stopPreviewRef.current?.();
    setStatus("loading");
    try {
      await Tone.start();
      const buffer = await decodePadBuffer();
      setStatus("previewing");
      const { stop } = await previewEffectsChain(buffer, chain);
      stopPreviewRef.current = stop;
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed.");
      setStatus("idle");
    }
  }, [chain, pad, decodePadBuffer]);

  const handleStopPreview = useCallback(() => {
    stopPreviewRef.current?.();
    stopPreviewRef.current = null;
    setStatus("idle");
  }, []);

  const handleRender = useCallback(async () => {
    if (chain.length === 0 || !pad || padIdx === null) return;
    setError(null);
    stopPreviewRef.current?.();
    stopPreviewRef.current = null;
    setStatus("rendering");
    try {
      const buffer = await decodePadBuffer();
      const rendered = await renderEffectsChain(buffer, chain);
      const channels = Array.from({ length: rendered.numberOfChannels }, (_, i) =>
        rendered.getChannelData(i),
      );
      const bytes = encodeWavPCM16(channels, rendered.sampleRate);

      const baseName = pad.sampleName.replace(/\s*\(FX\)$/i, "");
      const fileName = sanitizeFileName(`${baseName} (FX)`);
      const sampleId = `fx:${Date.now()}:${fileName}`;

      registerUserSample(sampleId, bytes);
      const engine = useMPCStore.getState().engineRef;
      if (engine) await engine.registerImportedSample(sampleId, bytes);

      const newPad: SamplePad = {
        ...pad,
        sampleId,
        displayName: fileName.replace(/\.wav$/i, ""),
        sampleName: fileName.replace(/\.wav$/i, ""),
        fileName,
        url: null,
      };
      setPadSample(padIdx, newPad);
      setChain([]);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Render failed.");
      setStatus("idle");
    }
  }, [chain, pad, padIdx, decodePadBuffer, registerUserSample, setPadSample]);

  const busy = status === "loading" || status === "rendering";

  const panelClass = `effects-rack${open ? " open" : ""}`;
  const style: React.CSSProperties = prefersReducedMotion ? { transition: "none" } : {};

  const chainIsEmpty = useMemo(() => chain.length === 0, [chain]);

  return (
    <div
      ref={panelRef}
      className={panelClass}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-labelledby="effects-rack-heading"
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      <header>
        <h3 id="effects-rack-heading">EFFECTS RACK{pad ? ` — ${pad.displayName}` : ""}</h3>
        <button
          ref={closeBtnRef}
          type="button"
          aria-label="Close effects rack"
          onClick={closePanel}
        >
          ×
        </button>
      </header>

      {!pad && <p className="fxr-hint">No pad selected — close this and select a pad first.</p>}

      {pad && (
        <>
          <div className="fxr-add-row">
            <select
              value={addType}
              onChange={(e) => setAddType(e.target.value as EffectType)}
              aria-label="Effect type to add"
            >
              {EFFECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EFFECT_LABELS[t]}
                </option>
              ))}
            </select>
            <button type="button" onClick={handleAddEffect} disabled={busy}>
              + Add to chain
            </button>
          </div>

          {chainIsEmpty && (
            <p className="fxr-hint">
              Add effects above — they run in the order shown, top to bottom, like a signal chain.
              Preview to audition, then Render to bake the whole chain into one new sample on this
              pad in a single pass.
            </p>
          )}

          <ol className="fxr-chain" aria-label="Effects chain">
            {chain.map((fx, i) => (
              <li key={fx.id} className="fxr-fx">
                <div className="fxr-fx-header">
                  <span className="fxr-fx-name">
                    {i + 1}. {EFFECT_LABELS[fx.type]}
                  </span>
                  <div className="fxr-fx-actions">
                    <button
                      type="button"
                      aria-label={`Move ${EFFECT_LABELS[fx.type]} up`}
                      disabled={i === 0 || busy}
                      onClick={() => handleMove(fx.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${EFFECT_LABELS[fx.type]} down`}
                      disabled={i === chain.length - 1 || busy}
                      onClick={() => handleMove(fx.id, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Reset ${EFFECT_LABELS[fx.type]} params`}
                      disabled={busy}
                      onClick={() => handleResetParams(fx.id)}
                    >
                      ↺
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${EFFECT_LABELS[fx.type]} from chain`}
                      disabled={busy}
                      onClick={() => handleRemoveEffect(fx.id)}
                    >
                      ×
                    </button>
                  </div>
                </div>
                {fx.type === "filter" && (
                  <div className="fxr-field">
                    <label htmlFor={`fxr-${fx.id}-filterType`}>Type</label>
                    <select
                      id={`fxr-${fx.id}-filterType`}
                      value={fx.params.filterType}
                      onChange={(e) =>
                        setChain((prev) =>
                          prev.map((f) =>
                            f.id === fx.id && f.type === "filter"
                              ? {
                                  ...f,
                                  params: {
                                    ...f.params,
                                    filterType: e.target.value as "lowpass" | "highpass",
                                  },
                                }
                              : f,
                          ),
                        )
                      }
                      disabled={busy}
                    >
                      <option value="lowpass">Lowpass</option>
                      <option value="highpass">Highpass</option>
                    </select>
                  </div>
                )}
                {FIELD_SPECS[fx.type].map((spec) => {
                  const value = (fx.params as Record<string, number>)[spec.key];
                  return (
                    <div className="fxr-field" key={spec.key}>
                      <label htmlFor={`fxr-${fx.id}-${spec.key}`}>{spec.label}</label>
                      <div className="fxr-slider-row">
                        <input
                          id={`fxr-${fx.id}-${spec.key}`}
                          type="range"
                          min={spec.min}
                          max={spec.max}
                          step={spec.step}
                          value={value}
                          disabled={busy}
                          onChange={(e) =>
                            handleParamChange(fx.id, spec.key, Number(e.target.value))
                          }
                        />
                        <span className="fxr-slider-val">
                          {value}
                          {spec.unit ?? ""}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </li>
            ))}
          </ol>

          {error && (
            <div className="fxr-error" role="alert" aria-live="assertive">
              {error}
            </div>
          )}

          <div className="fxr-transport">
            {status === "previewing" ? (
              <button type="button" onClick={handleStopPreview}>
                Stop Preview
              </button>
            ) : (
              <button type="button" onClick={handlePreview} disabled={chainIsEmpty || busy}>
                {status === "loading" ? "Loading…" : "Preview"}
              </button>
            )}
            <button type="button" onClick={handleRender} disabled={chainIsEmpty || busy}>
              {status === "rendering" ? "Rendering…" : "Render & Replace Pad Sample"}
            </button>
          </div>

          {status === "done" && (
            <p className="fxr-hint" role="status">
              Done — the pad now plays the processed sample. Add more effects and render again to
              stack further, or close this panel.
            </p>
          )}
        </>
      )}
    </div>
  );
}
