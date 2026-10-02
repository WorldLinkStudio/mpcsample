import type { MidiEvent, MidiOutputLike, MidiStatus, PadIndex } from "../types/mpc.types";

export type MidiHandlers = {
  onEvent?: (event: MidiEvent) => void;
  onStatusChange?: (status: MidiStatus, deviceName: string | null) => void;
};

/** MIDI note number for GlobalPadIdx 0 (Bank A, pad 1). */
const NOTE_BASE = 36;

/**
 * Wraps the Web MIDI API with defensive handling for:
 * - Missing API (Firefox / non-Chromium browsers) → 'unsupported'
 * - Permission denied → 'denied'
 * - No devices connected → 'no-devices'
 * - Hot-plug / hot-unplug via onstatechange
 *
 * MIDI note mapping (verified against a real MPC Sample, "Pad MIDI Out: Always"):
 *   The hardware shifts the outgoing note number by 16 per physical pad
 *   bank — Bank A = notes 36–51, Bank B = 52–67, Bank C = 68–83, etc. — so
 *   the bank is encoded in the note itself; global pad index = note - 36
 *   directly (0..127), independent of whatever bank is selected in this
 *   app's own UI. (MIDI notes cap at 127, so only banks A–E are fully
 *   addressable this way — 116..127 covers bank F pads 1–12 only; higher
 *   banks/pads have not been observed and may use a different mechanism.)
 *
 * Also implements {@link MidiOutputLike} to send pad triggers back out to
 * the same device(s) — e.g. so a pad clicked in this app's UI also triggers
 * the physical MPC Sample's pad (requires "Pad MIDI In: On" on the hardware).
 * Reuses the single `MIDIAccess` object rather than requesting a second one.
 */
export class MidiInput implements MidiOutputLike {
  private access: MIDIAccess | null = null;
  private handlers: MidiHandlers = {};
  private boundOnMessage: (e: MIDIMessageEvent) => void;
  private status: MidiStatus = "idle";
  private outputs: MIDIOutput[] = [];

  constructor(handlers?: MidiHandlers) {
    this.handlers = handlers ?? {};
    this.boundOnMessage = (e) => this.parseMessage(e);
  }

  setHandlers(handlers: MidiHandlers): void {
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    if (typeof navigator === "undefined" || !("requestMIDIAccess" in navigator)) {
      this.setStatus("unsupported", null);
      return;
    }
    this.setStatus("searching", null);
    try {
      this.access = await (
        navigator as Navigator & {
          requestMIDIAccess(opts: { sysex: boolean }): Promise<MIDIAccess>;
        }
      ).requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this.bindInputs();
      this.bindInputs();
    } catch {
      this.setStatus("denied", null);
    }
  }

  stop(): void {
    if (!this.access) return;
    this.access.inputs.forEach((inp) => {
      inp.onmidimessage = null;
    });
    this.access.onstatechange = null;
    this.access = null;
    this.outputs = [];
    this.setStatus("idle", null);
  }

  private bindInputs(): void {
    if (!this.access) return;

    const outputs: MIDIOutput[] = [];
    this.access.outputs.forEach((out) => {
      outputs.push(out);
    });
    this.outputs = outputs;

    const inputs: MIDIInput[] = [];
    this.access.inputs.forEach((inp) => {
      inputs.push(inp);
    });
    if (inputs.length === 0) {
      this.setStatus("no-devices", null);
      return;
    }
    inputs.forEach((inp) => {
      inp.onmidimessage = this.boundOnMessage;
    });
    this.setStatus("connected", inputs[0].name ?? "Unknown");
  }

  // ── MidiOutputLike ─────────────────────────────────────────────────────

  hasOutput(): boolean {
    return this.outputs.length > 0;
  }

  sendNoteOn(padIdx: PadIndex, velocity: number): void {
    const note = padIdx + NOTE_BASE;
    if (note < 0 || note > 127) return;
    const vel = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    this.send([0x90, note, vel]);
  }

  sendNoteOff(padIdx: PadIndex): void {
    const note = padIdx + NOTE_BASE;
    if (note < 0 || note > 127) return;
    this.send([0x80, note, 0]);
  }

  private send(bytes: number[]): void {
    for (const out of this.outputs) {
      try {
        out.send(bytes);
      } catch {
        // Device may have disconnected between the hot-plug check and send.
      }
    }
  }

  private setStatus(status: MidiStatus, deviceName: string | null): void {
    this.status = status;
    this.handlers.onStatusChange?.(status, deviceName);
  }

  getStatus(): MidiStatus {
    return this.status;
  }

  private parseMessage(e: MIDIMessageEvent): void {
    // Guard: malformed message
    if (!e.data || e.data.length < 2) return;

    const statusByte = e.data[0];
    const note = e.data[1];
    const vel = e.data.length >= 3 ? (e.data[2] ?? 0) : 0;
    const cmd = statusByte & 0xf0;

    if (cmd === 0x90 && vel > 0) {
      // Note On with velocity — the note already encodes both bank and local
      // pad (see class doc comment), so it maps directly to a global index.
      const globalPad = note - NOTE_BASE;
      if (globalPad >= 0 && globalPad < 128) {
        this.handlers.onEvent?.({
          type: "noteOn",
          padIdx: globalPad as PadIndex,
          velocity: vel / 127,
        });
      }
    } else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) {
      // Note Off (0x80) or Note On with vel=0 (running status note-off).
      const globalPad = note - NOTE_BASE;
      if (globalPad >= 0 && globalPad < 128) {
        this.handlers.onEvent?.({
          type: "noteOff",
          padIdx: globalPad as PadIndex,
        });
      }
    } else if (cmd === 0xb0) {
      // Control Change
      this.handlers.onEvent?.({
        type: "cc",
        controller: note,
        value: vel / 127,
      });
    }
    // All other status bytes (aftertouch, pitch bend, SysEx remnants) are ignored
  }
}
