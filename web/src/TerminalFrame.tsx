import {
  memo,
  useEffect,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type Ref,
  type WheelEvent,
} from "react";
import { horizontalSwipeInput, verticalSwipeScroll, type SwipePoint } from "./mobile-controls";
import type { TerminalFrameState } from "./mobile-controls";
import {
  canUsePointerScroll,
  type TerminalPane,
  type TerminalWebAction,
} from "./web-interactions";
import {
  terminalPaneAtPosition,
  terminalPaneHitTarget,
  terminalRowHitTarget,
} from "./terminal-hit-targets";

interface TerminalFrameProps {
  /** Array of HTML-safe row strings emitted by the backend web theme. */
  rows: string[];
  /** The current semantic state, used only to gate pointer scrolling. */
  state?: TerminalFrameState;
  /** Current terminal width, used to detect the wide split-pane layout. */
  columns?: number;
  onInput?: (data: string) => void;
  onWebAction?: (action: TerminalWebAction) => void;
  terminalRef?: Ref<HTMLDivElement>;
}

const WHEEL_STEP_PIXELS = 48;
const WHEEL_ACTION_INTERVAL_MS = 520;
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
  columns,
  onInput,
  onWebAction,
  terminalRef,
}: TerminalFrameProps) {
  const swipeStartRef = useRef<SwipePoint | null>(null);
  const activeTouchPointersRef = useRef(new Set<number>());
  const wheelRemainderRef = useRef(0);
  const wheelDirectionRef = useRef<"up" | "down" | null>(null);
  const wheelFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWheelActionAtRef = useRef(0);
  const pendingWheelRef = useRef<{
    direction: "up" | "down";
    pane?: TerminalPane;
    screen?: string;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const hoveredPaneRef = useRef<TerminalPane | null>(null);

  useEffect(
    () => () => {
      if (wheelFlushTimerRef.current !== null) {
        clearTimeout(wheelFlushTimerRef.current);
      }
    },
    [],
  );

  const pointerPoint = (event: PointerEvent<HTMLDivElement>): SwipePoint => ({
    x: event.clientX,
    y: event.clientY,
    at: performance.now(),
  });

  const handleRowClick = (
    event: MouseEvent<HTMLDivElement>,
    row: string,
    rowIndex: number,
  ) => {
    if (!onWebAction) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    const frame = event.currentTarget.parentElement;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0) return;
    const xFraction = (event.clientX - rect.left) / rect.width;
    const rowTarget = terminalRowHitTarget(state, row, {
      columns,
      rowCount: rows.length,
      xFraction,
      targetText:
        event.target instanceof Element ? event.target.textContent ?? undefined : undefined,
    });
    if (rowTarget) {
      onWebAction(rowTarget.action);
      return;
    }

    const paneTarget = terminalPaneHitTarget(
      state,
      columns,
      rowIndex,
      rows.length,
      xFraction,
    );
    if (paneTarget) onWebAction(paneTarget.action);
  };

  const handleRowPointerMove = (
    event: PointerEvent<HTMLDivElement>,
    row: string,
    rowIndex: number,
  ) => {
    if (!onWebAction || event.pointerType === "touch") return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const xFraction = (event.clientX - rect.left) / rect.width;
    const rowTarget = terminalRowHitTarget(state, row, {
      columns,
      rowCount: rows.length,
      xFraction,
      targetText:
        event.target instanceof Element ? event.target.textContent ?? undefined : undefined,
    });
    const pane = terminalPaneAtPosition(
      state,
      columns,
      rowIndex,
      rows.length,
      xFraction,
    );
    const paneTarget = pane
      ? terminalPaneHitTarget(state, columns, rowIndex, rows.length, xFraction)
      : undefined;
    event.currentTarget.classList.toggle("term-row-interactive", Boolean(rowTarget || pane));
    event.currentTarget.title = rowTarget?.label ?? paneTarget?.label ?? (pane ? "Focus this pane for scrolling" : "");
    if (!pane) {
      hoveredPaneRef.current = null;
      return;
    }
    // Keep hover non-mutating; the next wheel action focuses and scrolls atomically.
    hoveredPaneRef.current = pane;
  };

  const hoveredPaneForScreen = (): TerminalPane | undefined => {
    const pane = hoveredPaneRef.current;
    const screen = state?.screen?.toUpperCase();
    if (screen === "SIGNALS" && (pane === "headlines" || pane === "story")) {
      return pane;
    }
    if (screen === "EVENTS" && (pane === "lanes" || pane === "briefing")) {
      return pane;
    }
    return undefined;
  };

  const flushWheel = () => {
    const pending = pendingWheelRef.current;
    if (!pending || !onWebAction) return;
    const amount = Math.min(
      8,
      Math.floor(wheelRemainderRef.current / WHEEL_STEP_PIXELS),
    );
    if (amount < 1) return;

    wheelRemainderRef.current -= amount * WHEEL_STEP_PIXELS;
    pendingWheelRef.current = null;
    lastWheelActionAtRef.current = performance.now();
    onWebAction({
      action: "scroll",
      direction: pending.direction,
      amount,
      ...(pending.pane ? { pane: pending.pane } : {}),
      ...(pending.screen ? { screen: pending.screen } : {}),
    });
  };

  const flushWheelWhenAllowed = () => {
    const elapsed = performance.now() - lastWheelActionAtRef.current;
    if (
      lastWheelActionAtRef.current === 0 ||
      elapsed >= WHEEL_ACTION_INTERVAL_MS
    ) {
      flushWheel();
      return;
    }
    if (wheelFlushTimerRef.current !== null) return;
    wheelFlushTimerRef.current = setTimeout(() => {
      wheelFlushTimerRef.current = null;
      flushWheel();
    }, WHEEL_ACTION_INTERVAL_MS - elapsed);
  };

  const touchScrollEnabled = canUsePointerScroll(state);

  return (
    <div
      ref={terminalRef}
      className="terminal-frame"
      role="application"
      aria-label="Market terminal. Keyboard commands active. Use Tab to change panes."
      tabIndex={0}
      style={{ touchAction: touchScrollEnabled ? "none" : undefined }}
      onPointerDown={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        if (event.pointerType !== "touch") return;
        suppressClickRef.current = false;
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
        const end = pointerPoint(event);
        const input = horizontalSwipeInput(start, end);
        if (input) {
          suppressClickRef.current = true;
          onInput?.(input);
          requestAnimationFrame(() => {
            suppressClickRef.current = false;
          });
          return;
        }
        const scroll = verticalSwipeScroll(start, end);
        if (scroll && touchScrollEnabled && onWebAction) {
          suppressClickRef.current = true;
          onWebAction({
            action: "scroll",
            ...scroll,
            ...(state?.screen ? { screen: state.screen } : {}),
          });
          requestAnimationFrame(() => {
            suppressClickRef.current = false;
          });
        }
      }}
      onPointerCancel={(event) => {
        activeTouchPointersRef.current.delete(event.pointerId);
        swipeStartRef.current = null;
      }}
      onPointerLeave={() => {
        hoveredPaneRef.current = null;
      }}
      onWheel={(event) => {
        const pane = hoveredPaneForScreen();
        if (!onWebAction || !canUsePointerScroll(state, pane)) return;
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
        pendingWheelRef.current = {
          direction,
          ...(pane ? { pane } : {}),
          ...(state?.screen ? { screen: state.screen } : {}),
        };
        if (wheelRemainderRef.current < WHEEL_STEP_PIXELS) return;
        flushWheelWhenAllowed();
      }}
    >
      {rows.map((row, i) => {
        const pane =
          terminalPaneAtPosition(state, columns, i, rows.length, 0.1) ??
          terminalPaneAtPosition(state, columns, i, rows.length, 0.9);
        const interactive = Boolean(pane);
        return (
          <div
            key={i}
            className={`term-row${interactive ? " term-row-interactive" : ""}`}
            title={pane ? "Focus this pane for scrolling" : undefined}
            onClick={onWebAction ? (event) => handleRowClick(event, row, i) : undefined}
            onPointerMove={
              onWebAction ? (event) => handleRowPointerMove(event, row, i) : undefined
            }
            dangerouslySetInnerHTML={{ __html: row || "&nbsp;" }}
          />
        );
      })}
    </div>
  );
});
