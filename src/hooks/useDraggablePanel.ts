/**
 * useDraggablePanel.ts — Lets a fixed-position panel (Sample Browser, Step
 * Sequencer) be dragged by its header to an arbitrary on-screen position.
 *
 * Mirrors the pointer-drag idiom already used for value-dragging on
 * `Knob.tsx`/`PitchFader.tsx`: a `useRef` drag-origin, `useCallback`
 * handlers, `setPointerCapture` on `e.currentTarget`.
 *
 * The panel's own CSS already positions it via `transform` (slide-in
 * animation, and — for the sequencer — horizontal centering). `translate()`
 * functions compose additively regardless of how many are chained, so this
 * hook only ever contributes a `translate(var(--drag-x), var(--drag-y))`
 * appended to the panel's existing `transform` declarations (see
 * `library.css`/`sequencer.css`) rather than touching `left`/`top`/`right`.
 */

import { useCallback, useRef, useState } from "react";

/** Matches both panels' existing `@media (max-width: 480px)` bottom-sheet breakpoint. */
const DRAG_DISABLED_MAX_WIDTH = 480;
/** Minimum px of the panel kept on-screen on every side while dragging. */
const EDGE_MARGIN = 40;

type Offset = { x: number; y: number };

type DragOrigin = {
  startX: number;
  startY: number;
  startRect: DOMRect;
  baseOffset: Offset;
};

export type DraggablePanelHandle = {
  /** Merge into the panel root's existing `style` object. */
  style: React.CSSProperties;
  /** Append to the panel root's existing className string. */
  className: string;
  /** Spread onto the panel's `<header>` (the drag handle). */
  headerProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    onDoubleClick: () => void;
    style: React.CSSProperties;
  };
};

export function useDraggablePanel(
  panelRef: React.RefObject<HTMLElement | null>,
): DraggablePanelHandle {
  const [offset, setOffset] = useState<Offset | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef<DragOrigin | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (window.innerWidth <= DRAG_DISABLED_MAX_WIDTH) return;
      if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
      const panel = panelRef.current;
      if (!panel) return;

      dragOrigin.current = {
        startX: e.clientX,
        startY: e.clientY,
        startRect: panel.getBoundingClientRect(),
        baseOffset: offset ?? { x: 0, y: 0 },
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    },
    [offset, panelRef],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const origin = dragOrigin.current;
    if (!origin) return;

    const deltaX = e.clientX - origin.startX;
    const deltaY = e.clientY - origin.startY;

    const { startRect } = origin;
    const minLeft = EDGE_MARGIN - startRect.width;
    const maxLeft = window.innerWidth - EDGE_MARGIN;
    const minTop = 0;
    const maxTop = window.innerHeight - EDGE_MARGIN;

    const clampedLeft = Math.min(Math.max(startRect.left + deltaX, minLeft), maxLeft);
    const clampedTop = Math.min(Math.max(startRect.top + deltaY, minTop), maxTop);

    setOffset({
      x: origin.baseOffset.x + (clampedLeft - startRect.left),
      y: origin.baseOffset.y + (clampedTop - startRect.top),
    });
  }, []);

  const endDrag = useCallback(() => {
    dragOrigin.current = null;
    setDragging(false);
  }, []);

  const resetPosition = useCallback(() => setOffset(null), []);

  const style: React.CSSProperties = offset
    ? ({ "--drag-x": `${offset.x}px`, "--drag-y": `${offset.y}px` } as React.CSSProperties)
    : {};

  const className = `${offset ? " moved" : ""}${dragging ? " dragging" : ""}`;

  return {
    style,
    className,
    headerProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick: resetPosition,
      style: { cursor: dragging ? "grabbing" : "grab", touchAction: "none" },
    },
  };
}
