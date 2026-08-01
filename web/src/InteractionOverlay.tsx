import { useCallback, useEffect, useMemo, useState } from "react";
import type { TerminalFrameState } from "./mobile-controls";
import {
  selectableItems,
  paneChoices,
  scrollControls,
  contextKeyHints,
  type PaneModel,
  type ScrollControl,
  type ContextKeyHint,
} from "./web-interactions";

/* ── Discriminated action union matching the server protocol ─────────── */

export type TerminalWebAction =
  | { action: "select"; screen: string; index: number; item: string }
  | { action: "focus-pane"; paneId: string }
  | { action: "primary" }
  | { action: "why" }
  | { action: "scroll"; direction: "prev" | "next"; amount: number };

/* ── Props ──────────────────────────────────────────────────────────── */

export interface InteractionOverlayProps {
  state?: TerminalFrameState;
  disabled: boolean;
  onAction(action: TerminalWebAction): void;
  onReturnToTerminal?(): void;
}

/* ── Safe matchMedia helper (browser only) ─────────────────────────── */

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onchange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onchange);
    return () => mql.removeEventListener("change", onchange);
  }, [query]);

  return matches;
}

/* ── Component ──────────────────────────────────────────────────────── */

export function InteractionOverlay({
  state,
  disabled,
  onAction,
  onReturnToTerminal,
}: InteractionOverlayProps) {
  /* Open-state defaults to true on coarse/touch pointers. */
  const isCoarsePointer = useMediaQuery(
    "(hover: none) and (pointer: coarse)",
  );
  const [open, setOpen] = useState<boolean>(isCoarsePointer);

  /* Sync open when coarse-pointer media-query first resolves. The useEffect
   * only fires when the query result changes (e.g. dev-tool emulation toggle),
   * giving the user a chance to close the overlay without it fighting back on
   * every render. */
  useEffect(() => {
    setOpen(isCoarsePointer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCoarsePointer]);

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

  const cacheLocked = Boolean(state?.cacheDecision);
  const searching = Boolean(state?.searching);
  const actionDisabled = disabled || cacheLocked || searching;

  const hasSplitPane =
    paneModel !== undefined && paneModel.panes.length > 1;

  const isTicker = state?.mode === "ticker";
  const isMarket = state?.mode === "market" || !state?.mode;
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

  const toggleOpen = useCallback(() => setOpen((v) => !v), []);

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
        aria-expanded={open}
        aria-controls="interaction-panel"
        disabled={disabled}
      >
        <span className="interaction-toggle-label">Web controls</span>
        <span aria-hidden="true" className="interaction-toggle-chevron">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {/* Collapsible panel */}
      {open && (
        <div className="interaction-panel" id="interaction-panel">
          {/* ── Selectable list ─────────────────────────────────────── */}
          {hasItems && (
            <div
              className="interaction-list"
              role="listbox"
              aria-label={`Select item in ${state?.screen ?? "market"}`}
            >
              {items.map((item) => (
                <button
                  key={item.index}
                  type="button"
                  className="interaction-list-item"
                  role="option"
                  aria-selected={item.selected}
                  disabled={actionDisabled}
                  onClick={() =>
                    emit({
                      action: "select",
                      screen: state?.screen ?? "market",
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
                  onClick={() =>
                    emit({ action: "focus-pane", paneId: pane.id })
                  }
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
              onClick={() => emit({ action: "primary" })}
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
              onClick={() => emit({ action: "why" })}
              aria-label="Show why — market context"
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
                        direction: "prev",
                        amount: 3,
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
                        direction: "next",
                        amount: 3,
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
