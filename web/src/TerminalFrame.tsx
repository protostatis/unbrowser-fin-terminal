import {
  memo,
  useRef,
  type PointerEvent,
  type Ref,
  type WheelEvent,
} from "react";
import { horizontalSwipeInput, type SwipePoint } from "./mobile-controls";
import type { TerminalFrameState } from "./mobile-controls";
import {
  canUsePointerScroll,
  type TerminalWebAction,
} from "./web-interactions";

interface TerminalFrameProps {
  /** Array of HTML-safe row strings emitted by the backend web theme. */
  rows: string[];
  /** The current semantic state, used only to gate pointer scrolling. */
  state?: TerminalFrameState;
  onInput?: (data: string) => void;
  onWebAction?: (action: TerminalWebAction) => void;
  terminalRef?: Ref<HTMLDivElement>;
}

const WHEEL_STEP_PIXELS = 48;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;

function normalizedWheelPixels(event: WheelEvent<HTMLDivElement>): number {
  if (event.deltaMode === WHEEL_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === WHEEL_DELTA_PAGE) {
    return event.deltaY * event.currentTarget.clientHeight;
  }
  return event.deltaY;
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
  state,
  onInput,
  onWebAction,
  terminalRef,
}: TerminalFrameProps) {
  const swipeStartRef = useRef<SwipePoint | null>(null);
  const activeTouchPointersRef = useRef(new Set<number>());
  const wheelRemainderRef = useRef(0);
  const wheelDirectionRef = useRef<"up" | "down" | null>(null);

  const pointerPoint = (event: PointerEvent<HTMLDivElement>): SwipePoint => ({
    x: event.clientX,
    y: event.clientY,
    at: performance.now(),
  });

  return (
    <div
      ref={terminalRef}
      className="terminal-frame"
      role="application"
      aria-label="Market terminal. Keyboard commands active. Use Tab to change panes."
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.focus({ preventScroll: true });
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
      onWheel={(event) => {
        if (!onWebAction || !canUsePointerScroll(state)) return;
        const pixels = normalizedWheelPixels(event);
        if (!Number.isFinite(pixels) || pixels === 0) return;

        event.preventDefault();
        const direction = pixels < 0 ? "up" : "down";
        if (
          wheelDirectionRef.current !== null &&
          wheelDirectionRef.current !== direction
        ) {
          wheelRemainderRef.current = 0;
        }
        wheelDirectionRef.current = direction;
        wheelRemainderRef.current = Math.min(
          WHEEL_STEP_PIXELS * 8,
          wheelRemainderRef.current + Math.abs(pixels),
        );

        const amount = Math.min(
          8,
          Math.floor(wheelRemainderRef.current / WHEEL_STEP_PIXELS),
        );
        if (amount < 1) return;

        wheelRemainderRef.current -= amount * WHEEL_STEP_PIXELS;
        onWebAction({ action: "scroll", direction, amount });
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
