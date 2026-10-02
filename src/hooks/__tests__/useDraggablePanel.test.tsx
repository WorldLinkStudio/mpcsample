/**
 * useDraggablePanel.test.ts — Unit tests for panel drag-to-reposition.
 *
 * Test coverage:
 *  - pointerDown + pointerMove sets --drag-x/--drag-y CSS vars
 *  - dragging is clamped to keep the panel on-screen
 *  - double-click on the header resets position
 *  - pointerDown on a descendant button doesn't start a drag
 *  - dragging is disabled below the 480px mobile breakpoint
 *  - the "dragging" class is only present while a drag is in progress
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraggablePanel } from "../useDraggablePanel";

function TestPanel() {
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useDraggablePanel(panelRef);
  return (
    <div ref={panelRef} data-testid="panel" className={`panel${drag.className}`} style={drag.style}>
      <header data-testid="header" {...drag.headerProps}>
        <h3>Title</h3>
        <button type="button" data-testid="close">
          ×
        </button>
      </header>
    </div>
  );
}

function dragVars(panel: HTMLElement): { x: string; y: string } {
  return {
    x: panel.style.getPropertyValue("--drag-x"),
    y: panel.style.getPropertyValue("--drag-y"),
  };
}

const FIXED_RECT: DOMRect = {
  left: 200,
  top: 150,
  right: 500,
  bottom: 400,
  width: 300,
  height: 250,
  x: 200,
  y: 150,
  toJSON: () => ({}),
};

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1024, writable: true, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, writable: true, configurable: true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(FIXED_RECT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDraggablePanel", () => {
  it("sets --drag-x/--drag-y on pointerDown + pointerMove", () => {
    render(<TestPanel />);
    const header = screen.getByTestId("header");
    const panel = screen.getByTestId("panel");

    expect(dragVars(panel)).toEqual({ x: "", y: "" });

    fireEvent.pointerDown(header, { clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 340, clientY: 320, pointerId: 1 });

    expect(dragVars(panel)).toEqual({ x: "40px", y: "20px" });
  });

  it("clamps the drag so the panel stays on-screen", () => {
    render(<TestPanel />);
    const header = screen.getByTestId("header");
    const panel = screen.getByTestId("panel");

    fireEvent.pointerDown(header, { clientX: 300, clientY: 300, pointerId: 1 });
    // Drag far up-left — well past the viewport edge.
    fireEvent.pointerMove(header, { clientX: -5000, clientY: -5000, pointerId: 1 });

    const vars = dragVars(panel);
    // startRect.left=200, min allowed left = 40 - width(300) = -260 -> min offset = -260 - 200 = -460
    expect(vars.x).toBe("-460px");
    // startRect.top=150, min allowed top = 0 -> min offset = 0 - 150 = -150
    expect(vars.y).toBe("-150px");
  });

  it("resets position on header double-click", () => {
    render(<TestPanel />);
    const header = screen.getByTestId("header");
    const panel = screen.getByTestId("panel");

    fireEvent.pointerDown(header, { clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 340, clientY: 320, pointerId: 1 });
    fireEvent.pointerUp(header, { pointerId: 1 });
    expect(dragVars(panel)).toEqual({ x: "40px", y: "20px" });

    fireEvent.doubleClick(header);
    expect(dragVars(panel)).toEqual({ x: "", y: "" });
    expect(panel.className).not.toContain("moved");
  });

  it("does not start a drag when pointerDown originates on a descendant button", () => {
    render(<TestPanel />);
    const closeBtn = screen.getByTestId("close");
    const header = screen.getByTestId("header");
    const panel = screen.getByTestId("panel");

    fireEvent.pointerDown(closeBtn, { clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 340, clientY: 320, pointerId: 1 });

    expect(dragVars(panel)).toEqual({ x: "", y: "" });
  });

  it("disables dragging below the 480px mobile breakpoint", () => {
    Object.defineProperty(window, "innerWidth", { value: 400, writable: true, configurable: true });
    render(<TestPanel />);
    const header = screen.getByTestId("header");
    const panel = screen.getByTestId("panel");

    fireEvent.pointerDown(header, { clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 340, clientY: 320, pointerId: 1 });

    expect(dragVars(panel)).toEqual({ x: "", y: "" });
  });

  it("applies the 'dragging' class only while a drag is in progress", () => {
    render(<TestPanel />);
    const header = screen.getByTestId("header");
    const panel = screen.getByTestId("panel");

    expect(panel.className).not.toContain("dragging");

    fireEvent.pointerDown(header, { clientX: 300, clientY: 300, pointerId: 1 });
    expect(panel.className).toContain("dragging");

    fireEvent.pointerMove(header, { clientX: 340, clientY: 320, pointerId: 1 });
    fireEvent.pointerUp(header, { pointerId: 1 });
    expect(panel.className).not.toContain("dragging");
    expect(panel.className).toContain("moved");
  });
});
