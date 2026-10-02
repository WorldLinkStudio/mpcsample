import { useCallback, useRef } from "react";
import "../styles/controls.css";
import { useMPCStore } from "../state/store";

const TAP_WINDOW_MS = 3000;
const MIN_TAPS = 2;

export function UtilityButtons() {
  const setBpm = useMPCStore((s) => s.setBpm);
  const tapTimestamps = useRef<number[]>([]);

  const handleOpenLibrary = useCallback(() => {
    window.dispatchEvent(new Event("mpc:open-library"));
  }, []);

  const handleOpenSequencer = useCallback(() => {
    window.dispatchEvent(new Event("mpc:open-sequencer"));
  }, []);

  const handleOpenSampleRecorder = useCallback(() => {
    window.dispatchEvent(new Event("mpc:open-sample-recorder"));
  }, []);

  const handleTapTempo = useCallback(() => {
    const now = Date.now();
    const taps = tapTimestamps.current;

    // Drop taps older than window
    const recent = taps.filter((t) => now - t < TAP_WINDOW_MS);
    recent.push(now);
    tapTimestamps.current = recent;

    if (recent.length >= MIN_TAPS) {
      // Average interval from consecutive taps
      let totalInterval = 0;
      for (let i = 1; i < recent.length; i++) {
        totalInterval += recent[i] - recent[i - 1];
      }
      const avgInterval = totalInterval / (recent.length - 1);
      const bpm = Math.round(60000 / avgInterval);
      setBpm(bpm);
    }
  }, [setBpm]);

  return (
    <>
      <div className="right-mid">
        <div className="btn-stack">
          <button
            type="button"
            className="btn"
            aria-label="Open sample library"
            onClick={handleOpenLibrary}
          >
            SAMPLE
            <br />
            SELECT
          </button>
          <div className="lbl">SAVE SAMPLE</div>
        </div>
        <div className="btn-stack">
          <button type="button" className="btn" aria-label="Tap tempo" onClick={handleTapTempo}>
            TAP
            <br />
            TEMPO
          </button>
          <div className="lbl">METRO</div>
        </div>
      </div>

      <div className="undo-row">
        <div className="btn-stack">
          <button type="button" className="btn square" aria-label="Undo">
            −
          </button>
          <div className="lbl">UNDO</div>
        </div>
        <div className="btn-stack">
          <button type="button" className="btn square" aria-label="Redo">
            +
          </button>
          <div className="lbl">REDO</div>
        </div>
      </div>

      <div className="rec-row">
        <div className="btn-stack">
          <button
            type="button"
            className="btn"
            aria-label="Open sample recorder"
            onClick={handleOpenSampleRecorder}
          >
            SAMPLE
            <br />
            RECORD
          </button>
          <div className="lbl">RECALL</div>
        </div>
        <div className="btn-stack">
          <button
            type="button"
            className="btn"
            aria-label="Open step sequencer"
            onClick={handleOpenSequencer}
          >
            SEQ
            <br />
            RECORD
          </button>
          <div className="lbl">RECALL</div>
        </div>
      </div>
    </>
  );
}
