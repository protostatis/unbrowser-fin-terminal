import { StrictMode, useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TerminalSocket } from "./socket";
import { TerminalFrame } from "./TerminalFrame";
import { MobileControls } from "./MobileControls";
import { keyToData } from "./keyboard";
import type { FrameMessage, SelectRequestMessage } from "./socket";
import "./styles.css";

/**
 * Application shell for the Market Terminal Web UI.
 *
 * On mount it opens a WebSocket to the backend, subscribes to frame/notify/
 * select/closed events, measures the viewport to send a resize, and captures
 * keyboard input to forward to the extension.
 */

function App() {
  const socketRef = useRef(new TerminalSocket());
  const socket = socketRef.current;

  /* ── Re-render trigger (avoids stale-closure issues with refs) ─────── */
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  /* ── Ref-based state so the keyboard handler always reads latest ───── */
  const connectionStateRef = useRef(socket.connectionState);
  const rowsRef = useRef<string[]>([]);
  const colsRef = useRef(80);
  const rowsCountRef = useRef(24);
  const isClosedRef = useRef(false);
  const wasReplacedRef = useRef(false);
  const frameStateRef = useRef<FrameMessage["state"]>(undefined);

  /* ── React state for overlays ──────────────────────────────────────── */
  const [notify, setNotify] = useState<{
    level: string;
    message: string;
  } | null>(null);
  const [selectReq, setSelectReq] = useState<{
    id: string;
    title: string;
    options: string[];
  } | null>(null);
  const notifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Refs for overlays (keyboard handler reads these) ──────────────── */
  const selectReqRef = useRef(selectReq);
  selectReqRef.current = selectReq;

  /* ── Container / ruler refs for viewport measurement ───────────────── */
  const containerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLSpanElement>(null);

  /* ── WebSocket lifecycle ──────────────────────────────────────────────── */

  useEffect(() => {
    const s = socketRef.current;

    const unsubFrame = s.on("frame", (msg: FrameMessage) => {
      rowsRef.current = msg.rows;
      colsRef.current = msg.width;
      rowsCountRef.current = msg.rows_count;
      frameStateRef.current = msg.state;
      isClosedRef.current = false;
      forceUpdate();
    });

    const unsubNotify = s.on("notify", (msg) => {
      setNotify({ level: msg.level, message: msg.message });
      if (notifyTimerRef.current) clearTimeout(notifyTimerRef.current);
      notifyTimerRef.current = setTimeout(() => {
        notifyTimerRef.current = null;
        setNotify(null);
      }, 4000);
    });

    const unsubSelect = s.on("select_request", (msg: SelectRequestMessage) => {
      setSelectReq({ id: msg.id, title: msg.title, options: msg.options });
    });

    const unsubClosed = s.on("closed", () => {
      rowsRef.current = [];
      frameStateRef.current = undefined;
      isClosedRef.current = true;
      forceUpdate();
    });

    const unsubOpen = s.on("_open", () => {
      connectionStateRef.current = "connected";
      wasReplacedRef.current = false;
      // The first viewport measurement can happen while the socket is still
      // connecting, in which case sendResize() is intentionally a no-op.
      // Re-send the latest dimensions on every open so a fresh connection or
      // reconnect always asks the backend for a frame.
      s.sendResize(colsRef.current, rowsCountRef.current);
      forceUpdate();
    });

    const unsubClose = s.on("_close", (event) => {
      connectionStateRef.current = "disconnected";
      wasReplacedRef.current = Boolean(event.replaced);
      if (event.replaced) rowsRef.current = [];
      if (event.replaced) frameStateRef.current = undefined;
      forceUpdate();
    });

    const unsubConnecting = s.on("_connecting", () => {
      connectionStateRef.current = "connecting";
      wasReplacedRef.current = false;
      forceUpdate();
    });

    s.connect();

    return () => {
      unsubFrame();
      unsubNotify();
      unsubSelect();
      unsubClosed();
      unsubOpen();
      unsubClose();
      unsubConnecting();
      if (notifyTimerRef.current) {
        clearTimeout(notifyTimerRef.current);
        notifyTimerRef.current = null;
      }
      s.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Viewport sizing via hidden ruler ────────────────────────────────────
   *
   * Measure one character cell, floor-divide the container dimensions,
   * and send a resize message. Runs on mount and on every container resize.
   */

  useEffect(() => {
    const s = socketRef.current;
    const container = containerRef.current;
    const ruler = rulerRef.current;
    if (!container || !ruler) return;

    const measure = () => {
      const charRect = ruler.getBoundingClientRect();
      // Measure the actual grid area (the .terminal-frame content box), NOT
      // the whole container. This accounts for the frame's padding and the
      // status line so the rendered rows fit the viewport exactly.
      const frame = container.querySelector(".terminal-frame") as HTMLElement | null;
      if (!frame) return;

      const charW = charRect.width;
      const charH = charRect.height;
      if (charW === 0 || charH === 0) return;

      // clientWidth/Height include padding but exclude borders/scrollbars.
      const st = getComputedStyle(frame);
      const padT = parseFloat(st.paddingTop) || 0;
      const padB = parseFloat(st.paddingBottom) || 0;
      const padL = parseFloat(st.paddingLeft) || 0;
      const padR = parseFloat(st.paddingRight) || 0;
      const gridH = frame.clientHeight - padT - padB;
      const gridW = frame.clientWidth - padL - padR;

      const rows = Math.max(12, Math.floor(gridH / charH));
      const cols = Math.max(54, Math.floor(gridW / charW));

      if (cols < 54 || rows < 12) {
        console.warn(
          `Terminal viewport very small: ${cols}×${rows}; minimum is 54×12`,
        );
      }

      s.sendResize(cols, rows);
      colsRef.current = cols;
      rowsCountRef.current = rows;
      forceUpdate();
    };

    // Measure after first paint
    requestAnimationFrame(() => requestAnimationFrame(measure));

    const observer = new ResizeObserver(measure);
    observer.observe(container);

    return () => observer.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Global keyboard capture ─────────────────────────────────────────────
   *
   * Forward every handled key to the backend as an "input" message.
   * Prevent browser defaults for handled keys (Backspace/Tab navigation,
   * Space/Arrow scroll, `/` quick-find, etc.).
   */

  useEffect(() => {
    const s = socketRef.current;

    const handler = (e: KeyboardEvent) => {
      // When a select modal is shown, only Escape is handled (to cancel).
      if (selectReqRef.current) {
        if (e.key === "Escape") {
          e.preventDefault();
          s.sendSelectResponse(selectReqRef.current.id, undefined, true);
          setSelectReq(null);
        }
        return;
      }

      const data = keyToData(e);
      if (data !== null) {
        e.preventDefault();
        s.sendInput(data);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Select modal handlers ──────────────────────────────────────────────── */

  const handleSelectOption = (value: string) => {
    if (selectReq) {
      socket.sendSelectResponse(selectReq.id, value);
      setSelectReq(null);
    }
  };

  const handleSelectCancel = () => {
    if (selectReq) {
      socket.sendSelectResponse(selectReq.id, undefined, true);
      setSelectReq(null);
    }
  };

  /* ── Closed-panel reopen ────────────────────────────────────────────────── */

  const handleReopen = () => {
    isClosedRef.current = false;
    socket.sendCommand("market", "");
    forceUpdate();
  };

  const handleTouchInput = (data: string) => {
    if (
      connectionStateRef.current !== "connected" ||
      isClosedRef.current ||
      selectReqRef.current
    ) return;
    socket.sendInput(data);
  };

  /* ── Render ──────────────────────────────────────────────────────────────── */

  const cs = connectionStateRef.current;
  const hasFrame = rowsRef.current.length > 0;
  const wasReplaced = wasReplacedRef.current;

  const emptyTitle =
    cs === "connected"
      ? "Preparing market map"
      : cs === "connecting"
        ? "Connecting to market session"
        : wasReplaced
          ? "Session opened in another tab"
          : "Market session unavailable";
  const emptyDetail =
    cs === "connected"
      ? "The Pi bridge is online. Waiting for the first terminal frame…"
      : cs === "connecting"
        ? "Opening the live renderer and restoring terminal state…"
        : wasReplaced
          ? "This tab stopped reconnecting to avoid competing for the singleton session. Retry to take control here."
          : "The web bridge could not be reached. Check the server, then retry.";

  return (
    <div className="terminal" ref={containerRef}>
      {/* Hidden ruler — one character cell for viewport measurement */}
      <span
        ref={rulerRef}
        className="term-row ruler"
        aria-hidden="true"
      >
        M
      </span>

      {/* Terminal grid */}
      <TerminalFrame rows={rowsRef.current} onInput={handleTouchInput} />

      {/* Actionable startup / terminal-less reconnect state */}
      {!hasFrame && !isClosedRef.current && (
        <div className="connection-empty" role="status" aria-live="polite">
          <div className="connection-copy">
            <div className="connection-brand">SIGNAL // MARKET ARCADE</div>
            <div className="connection-title">{emptyTitle}</div>
            <div className="connection-detail">{emptyDetail}</div>
            {cs === "disconnected" && (
              <button className="connection-retry" onClick={() => socket.connect()}>
                Retry connection
              </button>
            )}
          </div>
        </div>
      )}

      {/* Status line */}
      <div className="status-line" aria-live="polite">
        <span className={`status-dot ${cs}`} />
        {cs === "connected"
          ? `${colsRef.current}×${rowsCountRef.current}`
          : cs === "connecting"
            ? "Connecting…"
            : "Disconnected"}
      </div>

      <MobileControls
        state={frameStateRef.current}
        disabled={cs !== "connected" || Boolean(selectReq) || isClosedRef.current}
        onInput={handleTouchInput}
      />

      {/* Toast notification */}
      {notify && (
        <div
          className={`toast toast-${notify.level}`}
          role="alert"
        >
          {notify.message}
        </div>
      )}

      {/* Select modal */}
      {selectReq && (
        <div
          className="select-overlay"
          onClick={handleSelectCancel}
          role="dialog"
          aria-modal="true"
          aria-label={selectReq.title}
        >
          <div className="select-modal" onClick={(e) => e.stopPropagation()}>
            <div className="select-title">{selectReq.title}</div>
            <div className="select-options">
              {selectReq.options.map((opt, i) => (
                <button
                  key={i}
                  className="select-option"
                  onClick={() => handleSelectOption(opt)}
                  autoFocus={i === 0}
                >
                  {opt}
                </button>
              ))}
            </div>
            <button className="select-cancel" onClick={handleSelectCancel}>
              Cancel (Esc)
            </button>
          </div>
        </div>
      )}

      {/* Closed overlay */}
      {isClosedRef.current && (
        <div className="closed-overlay" role="dialog" aria-modal="true">
          <div className="closed-modal">
            <div className="closed-title">Panel closed</div>
            <button
              className="closed-reopen"
              onClick={handleReopen}
              autoFocus
            >
              Reopen Market Map
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Bootstrap ──────────────────────────────────────────────────────────────── */

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
