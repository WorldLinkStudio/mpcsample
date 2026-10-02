/**
 * useSequencer.ts — Wires the hardware-style PLAY/STOP transport buttons
 * (`Transport.tsx`, which dispatch `mpc:transport-play` / `mpc:transport-stop`)
 * to a `PatternPlayer`. Mirrors the `useMidiInput` hook's lifecycle convention:
 * one instance created on mount, torn down on unmount.
 *
 * Listens to `mpc:transport-stop` independently of `App.tsx`'s own listener
 * (which calls `store.stopAll()`) — STOP should always halt a running pattern
 * in addition to silencing live audio, and there's no shared state to
 * coordinate between the two listeners.
 */

import { useEffect, useRef } from "react";
import { PatternPlayer } from "../sequencer/PatternPlayer";

export function useSequencer(): void {
  const playerRef = useRef<PatternPlayer | null>(null);

  useEffect(() => {
    const player = new PatternPlayer();
    playerRef.current = player;

    const handlePlay = () => player.start();
    const handleStop = () => player.stop();
    window.addEventListener("mpc:transport-play", handlePlay);
    window.addEventListener("mpc:transport-stop", handleStop);

    return () => {
      window.removeEventListener("mpc:transport-play", handlePlay);
      window.removeEventListener("mpc:transport-stop", handleStop);
      player.stop();
      playerRef.current = null;
    };
  }, []);
}
