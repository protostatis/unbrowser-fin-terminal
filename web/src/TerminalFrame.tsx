import { memo, useRef, type PointerEvent } from "react";
import { horizontalSwipeInput, type SwipePoint } from "./mobile-controls";

interface TerminalFrameProps {
  /** Array of HTML-safe row strings emitted by the backend web theme. */
  rows: string[];
  onInput?: (data: string) => void;
}

/**
 * Renders the terminal grid.
 *
 * Each row is set via dangerouslySetInnerHTML — this is safe because the
 * backend HTML-escapes all dynamic text before wrapping in
 * `<span class="tc tc-{color}">` segments.
 *
 * Empty rows still produce a visible line (via `&nbsp;`) so the terminal
 * grid maintains its vertical rhythm.
 */
export const TerminalFrame = memo(function TerminalFrame({
  rows,
  onInput,
}: TerminalFrameProps) {
  const swipeStartRef = useRef<SwipePoint | null>(null);
  const activeTouchPointersRef = useRef(new Set<number>());

  const pointerPoint = (event: PointerEvent<HTMLDivElement>): SwipePoint => ({
    x: event.clientX,
    y: event.clientY,
    at: performance.now(),
  });

  return (
    <div
      className="terminal-frame"
      role="region"
      aria-label="Market terminal display. Swipe left or right to change view."
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") return;
        activeTouchPointersRef.current.add(event.pointerId);
        swipeStartRef.current =
          activeTouchPointersRef.current.size === 1 && event.isPrimary
            ? pointerPoint(event)
            : null;
      }}
      onPointerUp={(event) => {
        const start = swipeStartRef.current;
        const wasOnlyPointer =
          activeTouchPointersRef.current.size === 1 &&
          activeTouchPointersRef.current.has(event.pointerId);
        activeTouchPointersRef.current.delete(event.pointerId);
        swipeStartRef.current = null;
        if (
          !start ||
          !wasOnlyPointer ||
          event.pointerType !== "touch" ||
          !event.isPrimary
        ) return;
        const input = horizontalSwipeInput(start, pointerPoint(event));
        if (input) onInput?.(input);
      }}
      onPointerCancel={(event) => {
        activeTouchPointersRef.current.delete(event.pointerId);
        swipeStartRef.current = null;
      }}
    >
      {rows.map((row, i) => (
        <div
          key={i}
          className="term-row"
          dangerouslySetInnerHTML={{ __html: row || "&nbsp;" }}
        />
      ))}
    </div>
  );
});
