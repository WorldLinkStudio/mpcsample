/**
 * PatternPlayer.ts — Schedules the active pattern's steps against `Tone.Transport`.
 *
 * Triggers pads directly via `engineRef`/`midiOutRef` (bypassing `store.triggerPad`,
 * which has extra side effects meant for user-initiated taps — e.g. resetting
 * release timers) and uses `pressPad`/`unpressPad` purely for the visual flash,
 * per the doc comment already left on those actions in `state/store.ts`.
 *
 * `Tone.Transport`'s BPM is already kept in sync with the app's tempo control by
 * `SampleEngine.setBpm()` — this class schedules against it directly with no
 * extra tempo wiring needed.
 */

import * as Tone from "tone";
import { useMPCStore } from "../state/store";
import type { PadIndex } from "../types/mpc.types";
import { totalSteps } from "./sequencer.types";
import { useSequencerStore } from "./sequencerStore";

/** Delay before sending Note Off / clearing the visual press, after a step's Note On. */
const NOTE_OFF_DELAY_SEC = 0.05;

export class PatternPlayer {
  private repeatEventId: number | null = null;
  private stepIndex = 0;

  get isRunning(): boolean {
    return this.repeatEventId !== null;
  }

  start(): void {
    if (this.isRunning) return;
    this.stepIndex = 0;
    const { pattern } = useSequencerStore.getState();
    this.repeatEventId = Tone.getTransport().scheduleRepeat((time) => {
      this.playStep(time);
    }, pattern.resolution);
    Tone.getTransport().start();
    useSequencerStore.getState().setIsPlaying(true);
  }

  stop(): void {
    if (this.repeatEventId !== null) {
      Tone.getTransport().clear(this.repeatEventId);
      this.repeatEventId = null;
    }
    Tone.getTransport().stop();
    useSequencerStore.getState().setIsPlaying(false);
  }

  private playStep(time: number): void {
    const { pattern } = useSequencerStore.getState();
    const total = totalSteps(pattern.bars, pattern.resolution);
    const step = this.stepIndex % total;

    Tone.getDraw().schedule(() => {
      useSequencerStore.getState().setCurrentStep(step);
    }, time);

    const { engineRef, midiOutRef, pressPad, unpressPad } = useMPCStore.getState();

    for (const key of Object.keys(pattern.steps)) {
      const padIdx = Number(key) as PadIndex;
      const s = pattern.steps[padIdx]?.[step];
      if (!s?.active) continue;

      engineRef?.trigger(padIdx, s.velocity, time);
      midiOutRef?.sendNoteOn(padIdx, s.velocity);
      Tone.getDraw().schedule(() => {
        pressPad(padIdx);
      }, time);
      Tone.getTransport().scheduleOnce(() => {
        midiOutRef?.sendNoteOff(padIdx);
        unpressPad(padIdx);
      }, time + NOTE_OFF_DELAY_SEC);
    }

    this.stepIndex = step + 1;
  }
}
