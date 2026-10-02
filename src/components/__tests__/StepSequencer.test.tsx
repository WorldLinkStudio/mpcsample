import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPattern } from "../../sequencer/sequencer.types";
import { useSequencerStore } from "../../sequencer/sequencerStore";
import { useMPCStore } from "../../state/store";
import { StepSequencer } from "../StepSequencer";

vi.mock("../../hooks/useReducedMotion", () => ({
  useReducedMotion: () => true,
}));

function openSequencer() {
  act(() => {
    window.dispatchEvent(new Event("mpc:open-sequencer"));
  });
}

beforeEach(() => {
  useSequencerStore.setState({
    pattern: createEmptyPattern(1, "16n"),
    isPlaying: false,
    currentStep: -1,
  });
  useMPCStore.setState({
    bankIdx: 0,
    padMap: { 0: null } as never,
  });
});

describe("StepSequencer — click-to-preview", () => {
  it("triggers the pad (and releases it) when a step is turned ON", () => {
    const triggerPad = vi.fn();
    const releasePad = vi.fn();
    useMPCStore.setState({ triggerPad, releasePad });

    render(<StepSequencer />);
    openSequencer();

    const cell = screen.getByLabelText("Pad 1, step 1, off");
    fireEvent.click(cell);

    expect(triggerPad).toHaveBeenCalledWith(0, 0.9);
    expect(releasePad).toHaveBeenCalledWith(0);
  });

  it("does NOT trigger the pad when a step is turned OFF", () => {
    // Pre-activate step 0 on pad 0 directly via the sequencer store.
    useSequencerStore.getState().toggleStep(0, 0);

    const triggerPad = vi.fn();
    const releasePad = vi.fn();
    useMPCStore.setState({ triggerPad, releasePad });

    render(<StepSequencer />);
    openSequencer();

    const cell = screen.getByLabelText("Pad 1, step 1, on, velocity 90%");
    fireEvent.click(cell);

    expect(triggerPad).not.toHaveBeenCalled();
    expect(releasePad).not.toHaveBeenCalled();
  });

  it("still toggles the step's active state regardless of preview", () => {
    render(<StepSequencer />);
    openSequencer();

    fireEvent.click(screen.getByLabelText("Pad 1, step 1, off"));
    expect(useSequencerStore.getState().pattern.steps[0]?.[0].active).toBe(true);

    fireEvent.click(screen.getByLabelText("Pad 1, step 1, on, velocity 90%"));
    expect(useSequencerStore.getState().pattern.steps[0]?.[0].active).toBe(false);
  });

  it("uses the step's own velocity when previewing", () => {
    useSequencerStore.getState().toggleStep(0, 1);
    useSequencerStore.getState().setStepVelocity(0, 1, 0.4);
    // Deactivate then reactivate isn't needed — toggleStep above already made it
    // active; flip it off first so the next click is an activation we can observe.
    useSequencerStore.getState().toggleStep(0, 1);

    const triggerPad = vi.fn();
    useMPCStore.setState({ triggerPad, releasePad: vi.fn() });

    render(<StepSequencer />);
    openSequencer();

    fireEvent.click(screen.getByLabelText("Pad 1, step 2, off"));
    expect(triggerPad).toHaveBeenCalledWith(0, 0.4);
  });
});

describe("StepSequencer — scroll-to-adjust velocity", () => {
  it("raises velocity by 0.1 on scroll up over an active step", () => {
    useSequencerStore.getState().toggleStep(0, 0);
    render(<StepSequencer />);
    openSequencer();

    fireEvent.wheel(screen.getByLabelText("Pad 1, step 1, on, velocity 90%"), { deltaY: -100 });

    expect(useSequencerStore.getState().pattern.steps[0]?.[0].velocity).toBeCloseTo(1);
  });

  it("lowers velocity by 0.1 on scroll down over an active step", () => {
    useSequencerStore.getState().toggleStep(0, 0);
    render(<StepSequencer />);
    openSequencer();

    fireEvent.wheel(screen.getByLabelText("Pad 1, step 1, on, velocity 90%"), { deltaY: 100 });

    expect(useSequencerStore.getState().pattern.steps[0]?.[0].velocity).toBeCloseTo(0.8);
  });

  it("does nothing when scrolling over an inactive step", () => {
    render(<StepSequencer />);
    openSequencer();

    fireEvent.wheel(screen.getByLabelText("Pad 1, step 1, off"), { deltaY: -100 });

    expect(useSequencerStore.getState().pattern.steps[0]).toBeUndefined();
  });

  it("does not lower velocity below the floor (0.1)", () => {
    useSequencerStore.getState().toggleStep(0, 0);
    useSequencerStore.getState().setStepVelocity(0, 0, 0.1);
    render(<StepSequencer />);
    openSequencer();

    fireEvent.wheel(screen.getByLabelText("Pad 1, step 1, on, velocity 10%"), { deltaY: 100 });

    expect(useSequencerStore.getState().pattern.steps[0]?.[0].velocity).toBeCloseTo(0.1);
  });
});

describe("StepSequencer — drag to reposition", () => {
  function getHeader(): HTMLElement {
    const heading = screen.getByRole("heading", { name: "STEP SEQUENCER" });
    const header = heading.closest("header");
    if (!header) throw new Error("header not found");
    return header;
  }

  it("moves the panel via its header and resets on double-click", () => {
    render(<StepSequencer />);
    openSequencer();

    const header = getHeader();
    const panel = header.parentElement as HTMLElement;

    fireEvent.pointerDown(header, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 150, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(header, { pointerId: 1 });

    expect(panel.style.getPropertyValue("--drag-x")).not.toBe("");
    expect(panel.className).toContain("moved");

    fireEvent.doubleClick(header);

    expect(panel.style.getPropertyValue("--drag-x")).toBe("");
    expect(panel.className).not.toContain("moved");
  });

  it("does not start a drag from the header's close button", () => {
    render(<StepSequencer />);
    openSequencer();

    const header = getHeader();
    const panel = header.parentElement as HTMLElement;
    const closeBtn = screen.getByLabelText("Close step sequencer");

    fireEvent.pointerDown(closeBtn, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 150, clientY: 130, pointerId: 1 });

    expect(panel.style.getPropertyValue("--drag-x")).toBe("");
  });
});
