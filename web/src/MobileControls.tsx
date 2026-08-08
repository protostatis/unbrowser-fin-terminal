import { useEffect, useRef, useState } from "react";
import {
  mobileActions,
  normalizeSymbolInput,
  SCOPE_ACTIONS,
  symbolSearchInputs,
  TERMINAL_INPUTS,
  type MobileAction,
  type ResearchActivityStatus,
  type TerminalFrameState,
} from "./mobile-controls";

interface MobileControlsProps {
  state?: TerminalFrameState;
  researchStatus?: ResearchActivityStatus;
  disabled: boolean;
  onInput: (data: string) => void;
  onReturnToTerminal?(): void;
}

function contextLabel(state?: TerminalFrameState): string {
  if (state?.mode === "ticker") return state.symbol || "TICKER";
  return state?.screen || "MARKET";
}

function primaryActionLabel(state?: TerminalFrameState): "Open" | "Brief" {
  const screen = state?.screen?.toUpperCase();
  return state?.mode === "ticker" || screen === "SIGNALS" || screen === "EVENTS"
    ? "Brief"
    : "Open";
}

export function MobileControls({
  state,
  researchStatus,
  disabled,
  onInput,
  onReturnToTerminal,
}: MobileControlsProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchError, setSearchError] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchSheetRef = useRef<HTMLFormElement>(null);
  const cacheLocked = Boolean(state?.cacheDecision);
  const actions = mobileActions(state);
  const primaryLabel = primaryActionLabel(state);
  const researchSubject = researchStatus?.contextLabel ?? researchStatus?.symbol;
  const tickerCycle = state?.mode === "ticker"
    && state.tickerLayout === "quote"
    && (state.tickerNavigation?.count ?? 0) > 1
    ? state.tickerNavigation
    : undefined;
  const tickerCycleSource = tickerCycle?.source === "watch" ? "watchlist" : "movers";

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setSearchError("");
    requestAnimationFrame(() => onReturnToTerminal?.());
  };

  useEffect(() => {
    if (disabled) setSearchOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => searchInputRef.current?.focus());

    const sheet = searchSheetRef.current;
    if (!sheet) return;
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = [...sheet.querySelectorAll<HTMLElement>("input, button")]
        .filter((element) => !element.hasAttribute("disabled"));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    sheet.addEventListener("keydown", handleDialogKeyDown);
    return () => sheet.removeEventListener("keydown", handleDialogKeyDown);
  }, [searchOpen]);

  const activate = (action: MobileAction) => {
    if (disabled) return;
    if (action.id === "search") {
      setQuery("");
      setSearchError("");
      setSearchOpen(true);
      return;
    }
    if (action.input) onInput(action.input);
  };

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const inputs = symbolSearchInputs(query);
    if (inputs.length === 0) {
      setSearchError("Use a ticker such as AAPL, ^GSPC, or BTC-USD.");
      return;
    }
    inputs.forEach(onInput);
    closeSearch();
  };

  return (
    <>
      <footer className="mobile-controls" aria-label="Touch terminal controls">
        <div className="mobile-console-head">
          <span className="mobile-console-brand">TOUCH // COMMAND DECK</span>
          <span className="mobile-console-context">{contextLabel(state)}</span>
          {researchStatus ? (
            <span
              className={`mobile-research-status mobile-research-${researchStatus.tone}`}
              role={researchStatus.tone === "failed" ? "alert" : "status"}
              aria-live={researchStatus.tone === "failed" ? "assertive" : "polite"}
              title={researchStatus.text}
            >
              <span className="mobile-research-lamp" aria-hidden="true" />
              <span className="mobile-research-label">
                {researchSubject
                  ? `${researchSubject} · ${researchStatus.label}`
                  : researchStatus.label}
              </span>
            </span>
          ) : (
            <span className="mobile-swipe-hint">SWIPE TO CHANGE VIEW</span>
          )}
        </div>

        <div className="mobile-nav" aria-label="Navigate terminal">
          <button
            type="button"
            className="mobile-key mobile-key-nav"
            aria-label="Previous screen or tab"
            disabled={disabled || cacheLocked}
            onClick={() => onInput(TERMINAL_INPUTS.left)}
          >
            <span aria-hidden="true">←</span>
            <small>VIEW</small>
          </button>
          <button
            type="button"
            className="mobile-key mobile-key-nav"
            aria-label={tickerCycle ? `Previous ${tickerCycleSource} ticker` : "Move selection or research up"}
            disabled={disabled || cacheLocked}
            onClick={() => onInput(TERMINAL_INPUTS.up)}
          >
            <span aria-hidden="true">↑</span>
            <small>{tickerCycle ? "CYCLE" : "MOVE"}</small>
          </button>
          <button
            type="button"
            className="mobile-key mobile-key-open"
            aria-label={`${primaryLabel} selected item or run primary action`}
            disabled={disabled || cacheLocked}
            onClick={() => onInput(TERMINAL_INPUTS.enter)}
          >
            <span>{primaryLabel}</span>
            <small>ENTER</small>
          </button>
          <button
            type="button"
            className="mobile-key mobile-key-nav"
            aria-label={tickerCycle ? `Next ${tickerCycleSource} ticker` : "Move selection or research down"}
            disabled={disabled || cacheLocked}
            onClick={() => onInput(TERMINAL_INPUTS.down)}
          >
            <span aria-hidden="true">↓</span>
            <small>{tickerCycle ? "CYCLE" : "MOVE"}</small>
          </button>
          <button
            type="button"
            className="mobile-key mobile-key-nav"
            aria-label="Next screen or tab"
            disabled={disabled || cacheLocked}
            onClick={() => onInput(TERMINAL_INPUTS.right)}
          >
            <span aria-hidden="true">→</span>
            <small>VIEW</small>
          </button>
        </div>

        <div
          className={`mobile-actions mobile-actions-${actions.length}`}
          aria-label={cacheLocked ? "Cached research decision" : "Terminal actions"}
        >
          {actions.map((action) => (
            <button
              type="button"
              key={action.id}
              className={`mobile-key mobile-key-action mobile-key-${action.tone || "default"}`}
              disabled={disabled || action.disabled}
              onClick={() => activate(action)}
            >
              <span>{action.label}</span>
              <small>{action.keyHint}</small>
            </button>
          ))}
        </div>

        <div className="mobile-scopes" aria-label="Chart range">
          {SCOPE_ACTIONS.map((scope) => (
            <button
              type="button"
              key={scope.scope}
              className="mobile-scope"
              aria-label={`Set chart range to ${scope.scope}`}
              aria-pressed={state?.chartScope === scope.scope}
              disabled={disabled || cacheLocked}
              onClick={() => onInput(scope.input)}
            >
              {scope.label}
            </button>
          ))}
        </div>
      </footer>

      {/* Touch-only symbol-search trigger. The command deck above is hidden on
          touch devices (see styles.css): the terminal becomes scroll- and
          tap-driven, and this single floating button opens the ticker lookup
          sheet — the one deck action that genuinely needs a real keyboard. */}
      <button
        type="button"
        className="mobile-search-fab"
        aria-label="Search symbol"
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setSearchError("");
          setSearchOpen(true);
        }}
      >
        <span aria-hidden="true">⌕</span>
      </button>

      {searchOpen && (
        <div
          className="symbol-search-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="symbol-search-title"
          onClick={closeSearch}
        >
          <form
            ref={searchSheetRef}
            className="symbol-search-sheet"
            onSubmit={submitSearch}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="symbol-search-kicker">MARKET LOOKUP</div>
            <label id="symbol-search-title" htmlFor="symbol-search-input">
              Jump to a symbol
            </label>
            <input
              ref={searchInputRef}
              id="symbol-search-input"
              value={query}
              onChange={(event) => {
                setQuery(normalizeSymbolInput(event.target.value));
                setSearchError("");
              }}
              maxLength={11}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              placeholder="AAPL"
              aria-describedby="symbol-search-help symbol-search-error"
            />
            <p id="symbol-search-help">Stocks, indices, and crypto pairs.</p>
            <p id="symbol-search-error" className="symbol-search-error" role="alert">
              {searchError}
            </p>
            <div className="symbol-search-actions">
              <button type="button" onClick={closeSearch}>Cancel</button>
              <button type="submit" className="symbol-search-go">Open symbol</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
