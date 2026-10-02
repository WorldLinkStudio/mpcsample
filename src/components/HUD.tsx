import { useCallback, useEffect, useState } from "react";
import { desktop, isDesktop } from "../desktop/bridge";
import { loadProjectFromDir } from "../desktop/loadProject";
import type { SampleKit } from "../kits/kit.types";
import { useMPCStore } from "../state/store";
import { ExportButton } from "./ExportButton";

const BANK_LETTERS = ["A", "B", "C", "D"] as const;
const MIDI_STATUS_LABELS: Record<string, string> = {
  idle: "MIDI: idle",
  searching: "MIDI: searching…",
  connected: "MIDI: connected",
  "no-devices": "MIDI: no devices",
  unsupported: "MIDI: unsupported",
  denied: "MIDI: permission denied",
};

const ZOOM_STEP = 0.1;

/** Inline style shared by all HUD chrome buttons. */
const HUD_BTN_STYLE: React.CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  color: "#cfd6e4",
  border: "1px solid rgba(255,255,255,0.15)",
  padding: "4px 8px",
  borderRadius: "4px",
  fontFamily: "inherit",
  cursor: "pointer",
  fontSize: "11px",
};

export function HUD() {
  const bankIdx = useMPCStore((s) => s.bankIdx);
  const activeKit = useMPCStore((s) => s.activeKit);
  const activeKitId = useMPCStore((s) => s.activeKitId);
  const midiStatus = useMPCStore((s) => s.midiStatus);
  const midiDeviceName = useMPCStore((s) => s.midiDeviceName);
  const uiScale = useMPCStore((s) => s.uiScale);
  const zoomBy = useMPCStore((s) => s.zoomBy);
  const resetUiTransform = useMPCStore((s) => s.resetUiTransform);
  const setUiScale = useMPCStore((s) => s.setUiScale);
  const hudVisible = useMPCStore((s) => s.hudVisible);
  const setHudVisible = useMPCStore((s) => s.setHudVisible);

  const [isLoadingKit, setIsLoadingKit] = useState(false);

  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(-ZOOM_STEP), [zoomBy]);
  const handleFit = useCallback(() => {
    const mpcEl = document.querySelector(".mpc");
    if (!mpcEl) return;
    const rect = mpcEl.getBoundingClientRect();
    const naturalW = rect.width / uiScale;
    const naturalH = rect.height / uiScale;
    const fitScale = Math.min(window.innerWidth / naturalW, window.innerHeight / naturalH);
    setUiScale(Math.max(0.5, Math.min(2, fitScale)));
  }, [uiScale, setUiScale]);

  const pct = Math.round(uiScale * 100);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target?.tagName) {
        const tag = target.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || target.isContentEditable) return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomBy(-ZOOM_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        resetUiTransform();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomBy, resetUiTransform]);

  const bankLetter = BANK_LETTERS[bankIdx] ?? "A";
  const kitLabel = activeKit?.displayName ?? activeKitId;
  const midiConnected = midiStatus === "connected";
  const midiLabel =
    midiConnected && midiDeviceName
      ? `MIDI: ${midiDeviceName}`
      : (MIDI_STATUS_LABELS[midiStatus] ?? "MIDI: idle");

  const handleTweaksClick = () => {
    window.dispatchEvent(new CustomEvent("mpc:open-tweaks"));
  };

  const handleEditKitClick = () => {
    window.dispatchEvent(new CustomEvent("mpc:open-editor"));
  };

  const handleLoadKit = async () => {
    setIsLoadingKit(true);
    try {
      const filePath = await desktop().chooseProjectDir();
      if (filePath === null) return;
      await loadProjectFromDir(filePath);
    } finally {
      setIsLoadingKit(false);
    }
  };

  if (!hudVisible) {
    return (
      <button
        type="button"
        className="hud-restore"
        onClick={() => setHudVisible(true)}
        aria-label="Show info panel"
      >
        ⌃
      </button>
    );
  }

  const handleNewKit = () => {
    const blank: SampleKit = {
      id: `user-${Date.now()}`,
      displayName: "New Kit",
      exportName: "New Kit",
      key: "",
      bpm: 120,
      pads: [],
    };
    useMPCStore.getState().loadKit(blank);
    window.dispatchEvent(new CustomEvent("mpc:open-editor"));
  };

  return (
    <div className="hud" role="region" aria-label="Keyboard shortcuts and device status">
      <div>
        <b>KEYS</b> 1234 · QWER · ASDF · ZXCV
      </div>
      <div>
        BANK <b>{bankLetter}</b> · KIT <b>{kitLabel}</b>
      </div>
      <div className="midi-state">
        <span className={`dot${midiConnected ? " ok" : ""}`} aria-hidden="true" />
        <span>{midiLabel}</span>
      </div>
      <div style={{ marginTop: "6px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={handleTweaksClick}
          aria-label="Open tweaks panel"
          style={HUD_BTN_STYLE}
        >
          ⚙ TWEAKS
        </button>
        <button
          type="button"
          onClick={handleEditKitClick}
          aria-label="Open kit editor"
          style={HUD_BTN_STYLE}
        >
          ✎ EDIT KIT
        </button>
        <ExportButton />
        {isDesktop() && (
          <button
            type="button"
            onClick={handleLoadKit}
            aria-label="Load a kit from an .xpj file"
            disabled={isLoadingKit}
            style={HUD_BTN_STYLE}
          >
            {isLoadingKit ? "Loading…" : "⊙ LOAD KIT"}
          </button>
        )}
        <button
          type="button"
          onClick={handleNewKit}
          aria-label="Create a new empty kit"
          style={HUD_BTN_STYLE}
        >
          + NEW KIT
        </button>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("mpc:open-help"))}
          aria-label="Open help guide"
          style={HUD_BTN_STYLE}
        >
          ? HELP
        </button>
        <button
          type="button"
          onClick={() => setHudVisible(false)}
          aria-label="Hide info panel"
          style={HUD_BTN_STYLE}
        >
          ⌄ HIDE
        </button>
        <span
          style={{ width: "1px", height: "14px", background: "rgba(255,255,255,0.15)", alignSelf: "center" }}
          aria-hidden="true"
        />
        <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {`Zoom ${pct}%`}
        </span>
        <div role="group" aria-label="Zoom controls" style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <button type="button" onClick={zoomOut} aria-label="Zoom out" style={HUD_BTN_STYLE}>
            −
          </button>
          <span style={{ fontSize: "11px", color: "#9aa3b0", minWidth: "30px", textAlign: "center" }} aria-hidden="true">
            {`${pct}%`}
          </span>
          <button type="button" onClick={zoomIn} aria-label="Zoom in" style={HUD_BTN_STYLE}>
            +
          </button>
          <button type="button" onClick={resetUiTransform} aria-label="Reset zoom" style={HUD_BTN_STYLE}>
            ⊙
          </button>
          <button type="button" onClick={handleFit} aria-label="Fit MPC to window" style={HUD_BTN_STYLE}>
            ⊡ Fit
          </button>
        </div>
      </div>

    </div>
  );
}
