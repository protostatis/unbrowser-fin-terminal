import { useCallback, useEffect, useMemo, useState } from "react";
import type { TerminalFrameState } from "./mobile-controls";
import {
  selectableItems,
  paneChoices,
  scrollControls,
  contextKeyHints,
  terminalActionContext,
  type TerminalWebAction,
  type PaneModel,
  type ScrollControl,
  type ContextKeyHint,
} from "./web-interactions";

export type { TerminalWebAction } from "./web-interactions";

/* ── Props ──────────────────────────────────────────────────────────── */

export interface InteractionOverlayProps {
  state?: TerminalFrameState;
  disabled: boolean;
  onAction(action: TerminalWebAction): void;
  onInput?(data: string): void;
  onReturnToTerminal?(): void;
}

/* ── Component ──────────────────────────────────────────────────────── */

export function InteractionOverlay({
  state,
  disabled,
  onAction,
  onInput,
  onReturnToTerminal,
}: InteractionOverlayProps) {
  const [open, setOpen] = useState(false);
  /* Once dismissed, the corner toggle stays hidden until the page reloads —
   * the contextual HUD now covers everything this panel offered on touch. */
  const [dismissed, setDismissed] = useState(false);

  /* Close the overlay when the terminal becomes fully disabled (e.g. panel
   * was closed remotely), so the toggle starts collapsed for the next session. */
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  /* ── Derived UI model ──────────────────────────────────────────────── */

  const items = useMemo(() => selectableItems(state), [state]);
  const paneModel = useMemo(() => paneChoices(state), [state]);
  const scrollCtrls = useMemo(() => scrollControls(state), [state]);
  const hints = useMemo(() => contextKeyHints(state), [state]);
  const actionContext = useMemo(() => terminalActionContext(state), [state]);

  const cacheLocked = Boolean(state?.cacheDecision);
  const searching = Boolean(state?.searching);
  const actionDisabled =
    disabled || !state || !actionContext || cacheLocked || searching;

  const hasSplitPane =
    paneModel !== undefined && paneModel.panes.length > 1;

  const isTicker = state?.mode === "ticker";
  const hasMarketViewToggle = state?.mode === "market" && state.screen?.toUpperCase() === "MARKET";
  const hasItems = items.length > 0;
  const hasScroll = scrollCtrls.some((c) => c.scrollable);

  /* Show "unavailable" when the terminal is busy but no interactive
   * surface is visible — this covers cache/search/disabled gracefully. */
  const showUnavailable =
    actionDisabled && !hasItems && hints.length === 0;

  /* ── Emit helpers ──────────────────────────────────────────────────── */

  const emit = useCallback(
    (action: TerminalWebAction) => {
      if (actionDisabled) return;
      onAction(action);
      /* Return focus to the terminal keyboard asynchronously so the
       * click fully completes before Tab steals focus. */
      setTimeout(() => onReturnToTerminal?.(), 0);
    },
    [actionDisabled, onAction, onReturnToTerminal],
  );

  const toggleOpen = useCallback(() => {
    setOpen((v) => !v);
    // The overlay is a mouse/touch aid, not a second terminal focus model.
    // Keep the terminal hot after opening or closing it so normal shortcuts
    // such as G continue to work immediately.
    setTimeout(() => onReturnToTerminal?.(), 0);
  }, [onReturnToTerminal]);

  const emitInput = useCallback(
    (input: string) => {
      if (disabled || !state || cacheLocked || searching) return;
      onInput?.(input);
      setTimeout(() => onReturnToTerminal?.(), 0);
    },
    [cacheLocked, disabled, onInput, onReturnToTerminal, searching, state],
  );

  if (dismissed) return null;

  /* ── Render ────────────────────────────────────────────────────────── */

  return (
    <section
      className="interaction-overlay"
      data-overlay-open={open || undefined}
      aria-label="Market interaction overlay"
    >
      {/* Always-visible toggle */}
      <button
        type="button"
        className="interaction-toggle"
        onClick={toggleOpen}
        aria-label={open ? "Close market controls" : "Open market controls"}
        aria-expanded={open}
        aria-controls="interaction-panel"
        disabled={disabled}
        title={open ? "Close market controls" : "Open market controls"}
      >
        <span aria-hidden="true" className="interaction-toggle-chevron">
          {open ? "▾" : "▸"}
        </span>
        <span aria-hidden="true" className="interaction-toggle-label">CTRL</span>
      </button>

      {/* Collapsible panel */}
      {open && (
        <div
          className="interaction-panel"
          id="interaction-panel"
          role="region"
          aria-labelledby="interaction-panel-title"
        >
          <div className="interaction-panel-head">
            <strong id="interaction-panel-title">MARKET CONTROLS</strong>
            <span>{isTicker ? state?.symbol || "TICKER" : state?.screen || "MARKET"}</span>
          </div>
          {/* ── Selectable list ─────────────────────────────────────── */}
          {hasItems && (
            <div
              className="interaction-list"
              role="group"
              aria-label={`Select item in ${state?.screen ?? "market"}`}
            >
              {items.map((item) => (
                <button
                  key={item.index}
                  type="button"
                  className="interaction-list-item"
                  aria-pressed={item.selected}
                  disabled={actionDisabled}
                  onClick={() =>
                    emit({
                      action: "select",
                      screen: state?.screen ?? "MARKET",
                      index: item.index,
                      item: item.label,
                    })
                  }
                >
                  <span className="interaction-item-index">
                    {String(item.index + 1).padStart(2, "0")}
                  </span>
                  <span className="interaction-item-label">
                    {item.label}
                  </span>
                  {item.selected && (
                    <span
                      className="interaction-item-selected"
                      aria-hidden="true"
                    >
                      ◀
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* ── Pane buttons (SIGNALS/EVENTS) ─────────────────────────── */}
          {paneModel && (
            <div className="interaction-panes" aria-label="Pane selector">
              {paneModel.panes.map((pane) => (
                <button
                  key={pane.id}
                  type="button"
                  className="interaction-pane-btn"
                  aria-pressed={pane.selected}
                  disabled={actionDisabled || pane.selected}
                  onClick={() => emit({ action: "focus-pane", pane: pane.id })}
                >
                  {pane.label}
                </button>
              ))}
            </div>
          )}

          {/* ── Core actions: primary + why ───────────────────────────── */}
          <div className="interaction-core-actions">
            <button
              type="button"
              className="interaction-primary-btn"
              disabled={actionDisabled}
              onClick={() => {
                if (actionContext) {
                  emit({ action: "primary", context: actionContext });
                }
              }}
              aria-label={
                isTicker
                  ? "Brief on current ticker"
                  : hasSplitPane
                    ? "Brief on selected story or briefing"
                    : "Open selected item"
              }
            >
              <span className="interaction-btn-key">Enter</span>
              <span className="interaction-btn-label">
                {isTicker || hasSplitPane ? "Brief" : "Open"}
              </span>
            </button>

            <button
              type="button"
              className="interaction-why-btn"
              disabled={actionDisabled}
              onClick={() => {
                if (actionContext) {
                  emit({ action: "why", context: actionContext });
                }
              }}
              aria-label={
                isTicker
                  ? "Explain why this ticker is moving"
                  : "Explain why the selected market context matters"
              }
            >
              <span className="interaction-btn-key">K</span>
              <span className="interaction-btn-label">Why</span>
            </button>
          </div>

          {/* ── Scroll controls ───────────────────────────────────────── */}
          {hasScroll &&
            scrollCtrls.map((ctrl) =>
              ctrl.scrollable ? (
                <div
                  key={ctrl.target}
                  className="interaction-scroll"
                  aria-label={`Scroll ${ctrl.target}`}
                >
                  <button
                    type="button"
                    className="interaction-scroll-btn"
                    disabled={actionDisabled}
                    onClick={() =>
                      emit({
                        action: "scroll",
                        direction: "up",
                        amount: 3,
                        screen: state?.screen,
                      })
                    }
                  >
                    <span aria-hidden="true">▲</span> Prev
                  </button>
                  <button
                    type="button"
                    className="interaction-scroll-btn"
                    disabled={actionDisabled}
                    onClick={() =>
                      emit({
                        action: "scroll",
                        direction: "down",
                        amount: 3,
                        screen: state?.screen,
                      })
                    }
                  >
                    <span aria-hidden="true">▼</span> Next
                  </button>
                </div>
              ) : null,
            )}

          {/* ── Keyboard legend ────────────────────────────────────────── */}
          {hints.length > 0 && (
            <div
              className="interaction-legend"
              aria-label="Keyboard shortcuts"
            >
              {hints.map((hint, i) => (
                <span
                  key={i}
                  className={`interaction-legend-item interaction-legend-${hint.tone}`}
                >
                  <kbd>{hint.keys}</kbd>{" "}
                  <span className="interaction-legend-label">
                    {hint.label}
                  </span>
                </span>
              ))}
            </div>
          )}

          {/* ── Unavailable state ─────────────────────────────────────── */}
          {showUnavailable && (
            <div
              className="interaction-unavailable"
              role="status"
              aria-live="polite"
            >
              {cacheLocked
                ? "Cache decision required — use keyboard"
                : searching
                  ? "Search in progress…"
                  : "Controls unavailable"}
            </div>
          )}

          {hasMarketViewToggle && onInput && (
            <button
              type="button"
              className="interaction-market-toggle"
              disabled={disabled || cacheLocked || searching}
              onClick={() => emitInput("g")}
              aria-label={state?.marketView === "crypto" ? "Switch to global market view" : "Switch to crypto market view"}
            >
              <span className="interaction-market-toggle-key">G</span>
              <span>{state?.marketView === "crypto" ? "GLOBAL VIEW" : "CRYPTO PULSE"}</span>
            </button>
          )}

          {/* ── Dismiss the corner toggle entirely ─────────────────────── */}
          <button
            type="button"
            className="interaction-dismiss-btn"
            onClick={() => {
              setDismissed(true);
              setOpen(false);
              setTimeout(() => onReturnToTerminal?.(), 0);
            }}
          >
            Hide controls
          </button>
        </div>
      )}
    </section>
  );
}

/* ── Re-exports for convenience ────────────────────────────────────────── */

export type {
  PaneModel,
  ScrollControl,
  ContextKeyHint,
};
