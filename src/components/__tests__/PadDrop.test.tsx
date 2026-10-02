/**
 * PadDrop.test.tsx
 *
 * Tests for drag-and-drop WAV file import on Pad.
 * Covers: valid drop, invalid drop, drag-enter/over highlight, drag-leave,
 * store calls (registerUserSample, engineRef.registerImportedSample, setPadSample),
 * and bank-offset globalPadIdx derivation.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PADS } from "../../data/padLayout";
import { _resetImportCounter } from "../../kits/importWav";
import type { GlobalPadIdx } from "../../kits/kit.types";
import { LIBRARY_DRAG_MIME } from "../../library/library.types";
import { useMPCStore } from "../../state/store";
import { Pad } from "../Pad";

// ── jsdom Blob.arrayBuffer polyfill (same as importWav.test.ts) ───────────────
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function (): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal valid WAV File (44-byte header). */
function makeWavFile(name = "kick.wav", type = "audio/wav"): File {
  const header = new Uint8Array([
    // RIFF chunk
    0x52,
    0x49,
    0x46,
    0x46, // "RIFF"
    0x24,
    0x00,
    0x00,
    0x00, // ChunkSize = 36
    0x57,
    0x41,
    0x56,
    0x45, // "WAVE"
    // fmt sub-chunk
    0x66,
    0x6d,
    0x74,
    0x20, // "fmt "
    0x10,
    0x00,
    0x00,
    0x00, // Subchunk1Size = 16
    0x01,
    0x00, // AudioFormat = PCM
    0x01,
    0x00, // NumChannels = 1
    0x44,
    0xac,
    0x00,
    0x00, // SampleRate = 44100
    0x88,
    0x58,
    0x01,
    0x00, // ByteRate = 88200
    0x02,
    0x00, // BlockAlign = 2
    0x10,
    0x00, // BitsPerSample = 16
    // data sub-chunk
    0x64,
    0x61,
    0x74,
    0x61, // "data"
    0x00,
    0x00,
    0x00,
    0x00, // Subchunk2Size = 0
  ]);
  return new File([header], name, { type });
}

// Mock useReducedMotion
vi.mock("../../hooks/useReducedMotion", () => ({
  useReducedMotion: () => false,
}));

const padDef0 = PADS[0]; // localIdx 0, num 1

beforeEach(() => {
  // Reset the import counter so each test starts from sampleId "user:<name>"
  _resetImportCounter();
  const pads: Record<number, "idle" | "armed" | "press"> = {};
  for (let i = 0; i < 128; i++) pads[i] = "armed";
  useMPCStore.setState({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pads: pads as any,
    bankIdx: 0,
    loadingPads: {},
    engineRef: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Convenience: render a Pad with fresh spy actions injected in store ────────

function renderPadWithSpies(globalIdx: GlobalPadIdx) {
  const registerUserSample = vi.fn();
  const setPadSample = vi.fn();
  const registerImportedSample = vi.fn().mockResolvedValue(undefined);
  // Inject spies into store BEFORE rendering so the component subscribes to them.
  useMPCStore.setState({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerUserSample: registerUserSample as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPadSample: setPadSample as any,
    engineRef: { registerImportedSample } as any,
  });
  const result = render(<Pad definition={padDef0} globalIdx={globalIdx} />);
  return { ...result, registerUserSample, setPadSample, registerImportedSample };
}

function renderPadWithSpiesNoEngine(globalIdx: GlobalPadIdx) {
  const registerUserSample = vi.fn();
  const setPadSample = vi.fn();
  useMPCStore.setState({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerUserSample: registerUserSample as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPadSample: setPadSample as any,
    engineRef: null,
  });
  const result = render(<Pad definition={padDef0} globalIdx={globalIdx} />);
  return { ...result, registerUserSample, setPadSample };
}

// ── Drag visual state ─────────────────────────────────────────────────────────

describe("Pad — drag-over highlight", () => {
  it("adds pad--drop-target class on dragEnter with files", () => {
    const { container } = renderPadWithSpies(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    fireEvent.dragEnter(btn, { dataTransfer: { types: ["Files"] } });
    expect(btn.className).toContain("pad--drop-target");
  });

  it("adds pad--drop-target class on dragOver with files", () => {
    const { container } = renderPadWithSpies(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    fireEvent.dragOver(btn, { dataTransfer: { types: ["Files"] } });
    expect(btn.className).toContain("pad--drop-target");
  });

  it("removes pad--drop-target class on dragLeave", () => {
    const { container } = renderPadWithSpies(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    fireEvent.dragEnter(btn, { dataTransfer: { types: ["Files"] } });
    expect(btn.className).toContain("pad--drop-target");
    fireEvent.dragLeave(btn);
    expect(btn.className).not.toContain("pad--drop-target");
  });

  it("does NOT add pad--drop-target when drag contains no files (internal element drag)", () => {
    const { container } = renderPadWithSpies(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    fireEvent.dragOver(btn, {
      dataTransfer: { files: [], types: ["text/plain"] },
    });
    expect(btn.className).not.toContain("pad--drop-target");
  });

  it("removes pad--drop-target after a valid drop completes", async () => {
    const { container, registerUserSample, setPadSample } = renderPadWithSpies(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    fireEvent.dragEnter(btn, { dataTransfer: { types: ["Files"] } });
    expect(btn.className).toContain("pad--drop-target");

    const file = makeWavFile("snap.wav");
    fireEvent.drop(btn, { dataTransfer: { files: [file], types: ["Files"] } });
    // isDragOver is cleared synchronously in onDrop before the async work starts.
    expect(btn.className).not.toContain("pad--drop-target");

    // Wait for the FileReader-based arrayBuffer polyfill to resolve.
    await waitFor(() => expect(setPadSample).toHaveBeenCalledOnce(), { timeout: 3000 });
    expect(registerUserSample).toHaveBeenCalledOnce();
  });
});

// ── Valid WAV drop ────────────────────────────────────────────────────────────

describe("Pad — valid WAV drop", () => {
  it("calls registerUserSample with a user-prefixed sampleId and Uint8Array bytes", async () => {
    const { container, registerUserSample } = renderPadWithSpies(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    const file = makeWavFile("snare.wav");

    fireEvent.drop(btn, { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() => expect(registerUserSample).toHaveBeenCalledOnce(), { timeout: 3000 });

    const [sampleId, bytes] = registerUserSample.mock.calls[0] as [string, Uint8Array];
    expect(sampleId).toMatch(/^user:/);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("calls engineRef.registerImportedSample with the same sampleId and bytes", async () => {
    const { container, registerUserSample, registerImportedSample } = renderPadWithSpies(
      0 as GlobalPadIdx,
    );
    const btn = container.querySelector("button")!;
    const file = makeWavFile("hihat.wav");

    fireEvent.drop(btn, { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() => expect(registerImportedSample).toHaveBeenCalledOnce(), { timeout: 3000 });

    const [sid, bytes] = registerImportedSample.mock.calls[0] as [string, Uint8Array];
    // Same sampleId passed to both calls.
    expect(sid).toBe(registerUserSample.mock.calls[0][0]);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it("calls setPadSample with globalIdx=0 and a pad whose displayName matches the filename stem", async () => {
    _resetImportCounter();
    const { container, setPadSample } = renderPadWithSpies(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    const file = makeWavFile("kick808.wav");

    fireEvent.drop(btn, { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() => expect(setPadSample).toHaveBeenCalledOnce(), { timeout: 3000 });

    const [idx, pad] = setPadSample.mock.calls[0] as [
      number,
      { globalPadIdx: number; displayName: string },
    ];
    expect(idx).toBe(0);
    expect(pad.globalPadIdx).toBe(0);
    expect(pad.displayName).toBe("kick808");
  });

  it("calls setPadSample with globalIdx=16 when the pad prop is globalIdx=16 (bank B, local 0)", async () => {
    _resetImportCounter();
    const { container, setPadSample } = renderPadWithSpies(16 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    const file = makeWavFile("tom.wav");

    fireEvent.drop(btn, { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() => expect(setPadSample).toHaveBeenCalledOnce(), { timeout: 3000 });

    const [idx] = setPadSample.mock.calls[0] as [number];
    expect(idx).toBe(16);
  });

  it("does not render an error alert after a valid drop", async () => {
    const { container, setPadSample } = renderPadWithSpies(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    const file = makeWavFile("clap.wav");

    fireEvent.drop(btn, { dataTransfer: { files: [file], types: ["Files"] } });
    // Wait for the drop to complete (no error should appear).
    await waitFor(() => expect(setPadSample).toHaveBeenCalledOnce(), { timeout: 3000 });

    expect(container.querySelector("[role='alert']")).not.toBeInTheDocument();
  });

  it("succeeds without an engineRef (engineRef is null)", async () => {
    const { container, registerUserSample, setPadSample } = renderPadWithSpiesNoEngine(
      0 as GlobalPadIdx,
    );
    const btn = container.querySelector("button")!;
    const file = makeWavFile("rim.wav");

    fireEvent.drop(btn, { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() => expect(registerUserSample).toHaveBeenCalledOnce(), { timeout: 3000 });
    expect(setPadSample).toHaveBeenCalledOnce();
  });
});

// ── Invalid / non-WAV drop ────────────────────────────────────────────────────

describe("Pad — non-WAV drop", () => {
  it("does NOT call setPadSample when a non-WAV file is dropped", async () => {
    const { container, setPadSample } = renderPadWithSpiesNoEngine(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    const mp3 = new File([new Uint8Array(4)], "beat.mp3", { type: "audio/mpeg" });

    await act(async () => {
      fireEvent.drop(btn, { dataTransfer: { files: [mp3], types: ["Files"] } });
    });

    expect(setPadSample).not.toHaveBeenCalled();
  });

  it("does NOT call registerUserSample when a non-WAV file is dropped", async () => {
    const { container, registerUserSample } = renderPadWithSpiesNoEngine(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    const aiff = new File([new Uint8Array(4)], "drum.aiff", { type: "audio/aiff" });

    await act(async () => {
      fireEvent.drop(btn, { dataTransfer: { files: [aiff], types: ["Files"] } });
    });

    expect(registerUserSample).not.toHaveBeenCalled();
  });

  it("shows an accessible role=alert after a non-WAV drop with a .wav hint in the message", async () => {
    const { container } = renderPadWithSpiesNoEngine(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    const mp3 = new File([new Uint8Array(4)], "track.mp3", { type: "audio/mpeg" });

    await act(async () => {
      fireEvent.drop(btn, { dataTransfer: { files: [mp3], types: ["Files"] } });
    });

    const alert = container.querySelector("[role='alert']");
    expect(alert).toBeInTheDocument();
    expect(alert?.textContent).toMatch(/\.wav/i);
  });

  it("error message auto-dismisses after ~4 seconds (fake timers)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { container } = renderPadWithSpiesNoEngine(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    const mp3 = new File([new Uint8Array(4)], "track.mp3", { type: "audio/mpeg" });

    // importWavFile throws synchronously on extension check (before arrayBuffer),
    // so the error state is set in the same microtask tick.
    fireEvent.drop(btn, { dataTransfer: { files: [mp3], types: ["Files"] } });
    // Drain the async function's promise chain (the void async IIFE).
    await act(async () => {
      // Tick once for the void async wrapper to settle.
      await new Promise<void>((r) => {
        queueMicrotask(r);
      });
    });

    expect(container.querySelector("[role='alert']")).toBeInTheDocument();

    // Advance past the 4 000ms auto-dismiss timer.
    await act(async () => {
      vi.advanceTimersByTime(4001);
    });

    expect(container.querySelector("[role='alert']")).not.toBeInTheDocument();
  });

  it("clears the drop-target highlight even after a rejected drop", async () => {
    const { container } = renderPadWithSpiesNoEngine(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    fireEvent.dragEnter(btn, { dataTransfer: { types: ["Files"] } });
    expect(btn.className).toContain("pad--drop-target");

    const mp3 = new File([new Uint8Array(4)], "track.mp3", { type: "audio/mpeg" });
    // isDragOver is cleared synchronously at the start of onDrop regardless of WAV validation.
    // Wrap in act to capture the synchronous state update + the async catch branch.
    await act(async () => {
      fireEvent.drop(btn, { dataTransfer: { files: [mp3], types: ["Files"] } });
      await new Promise<void>((r) => {
        queueMicrotask(r);
      });
    });
    expect(btn.className).not.toContain("pad--drop-target");
  });
});

// ── Sample Browser internal drag (library MIME payload) ──────────────────────

describe("Pad — Sample Browser library drag-drop", () => {
  it("adds pad--drop-target class on dragOver carrying the library MIME type", () => {
    const { container } = renderPadWithSpiesNoEngine(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;
    fireEvent.dragOver(btn, { dataTransfer: { types: [LIBRARY_DRAG_MIME], files: [] } });
    expect(btn.className).toContain("pad--drop-target");
  });

  it("assigns a library-backed SamplePad via setPadSample without touching registerUserSample", () => {
    const { container, setPadSample, registerUserSample } = renderPadWithSpiesNoEngine(
      3 as GlobalPadIdx,
    );
    const btn = container.querySelector("button")!;
    const payload = {
      absPath: "/Library/Kicks/808.wav",
      relPath: "Kicks/808.wav",
      fileName: "808.wav",
    };

    fireEvent.drop(btn, {
      dataTransfer: {
        files: [],
        types: [LIBRARY_DRAG_MIME],
        getData: (type: string) => (type === LIBRARY_DRAG_MIME ? JSON.stringify(payload) : ""),
      },
    });

    expect(registerUserSample).not.toHaveBeenCalled();
    expect(setPadSample).toHaveBeenCalledOnce();
    const [idx, pad] = setPadSample.mock.calls[0] as [
      number,
      { url: string | null; fileName: string },
    ];
    expect(idx).toBe(3);
    expect(pad.fileName).toBe("808.wav");
    expect(pad.url).toBe(`mpc-sample://local/read?path=${encodeURIComponent(payload.absPath)}`);
  });

  it("shows an error alert and does not assign when the drag payload is malformed", () => {
    const { container, setPadSample } = renderPadWithSpiesNoEngine(0 as GlobalPadIdx);
    const btn = container.querySelector("button")!;

    fireEvent.drop(btn, {
      dataTransfer: {
        files: [],
        types: [LIBRARY_DRAG_MIME],
        getData: (type: string) => (type === LIBRARY_DRAG_MIME ? "not json" : ""),
      },
    });

    expect(setPadSample).not.toHaveBeenCalled();
    expect(container.querySelector("[role='alert']")).toBeInTheDocument();
  });
});

// ── Empty drop (no file) ──────────────────────────────────────────────────────

describe("Pad — empty drop (no file)", () => {
  it("does nothing when dataTransfer.files is empty", async () => {
    const { container, registerUserSample, setPadSample } = renderPadWithSpiesNoEngine(
      0 as GlobalPadIdx,
    );
    const btn = container.querySelector("button")!;

    fireEvent.drop(btn, { dataTransfer: { files: [], types: ["Files"] } });
    // Give a tick for any potential async work.
    await act(async () => {
      await Promise.resolve();
    });

    expect(registerUserSample).not.toHaveBeenCalled();
    expect(setPadSample).not.toHaveBeenCalled();
    expect(container.querySelector("[role='alert']")).not.toBeInTheDocument();
  });
});

// ── Existing interactions not broken ─────────────────────────────────────────

describe("Pad — existing interactions still work after drop handlers added", () => {
  it("triggerPad is still called on pointerDown", () => {
    const triggerPad = vi.fn();
    useMPCStore.setState({ triggerPad } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    render(<Pad definition={padDef0} globalIdx={0 as GlobalPadIdx} />);
    const btn = screen.getByRole("button");
    fireEvent.pointerDown(btn, { pressure: 0 });
    expect(triggerPad).toHaveBeenCalledWith(0, 0.9);
  });

  it("releasePad is still called on pointerUp", () => {
    const releasePad = vi.fn();
    useMPCStore.setState({ releasePad } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    render(<Pad definition={padDef0} globalIdx={0 as GlobalPadIdx} />);
    const btn = screen.getByRole("button");
    fireEvent.pointerUp(btn);
    expect(releasePad).toHaveBeenCalledWith(0);
  });

  it("a file drop does not trigger triggerPad", async () => {
    const triggerPad = vi.fn();
    const registerUserSample = vi.fn();
    const setPadSample = vi.fn();
    useMPCStore.setState({
      triggerPad,
      registerUserSample,
      setPadSample,
      engineRef: null,
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    const { container } = render(<Pad definition={padDef0} globalIdx={0 as GlobalPadIdx} />);
    const btn = container.querySelector("button")!;
    const file = makeWavFile("perc.wav");

    fireEvent.drop(btn, { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() => expect(setPadSample).toHaveBeenCalledOnce(), { timeout: 3000 });

    expect(triggerPad).not.toHaveBeenCalled();
  });
});
