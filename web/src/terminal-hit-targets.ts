import type { TerminalFrameState } from "./mobile-controls";
import {
  MARKET_SCREENS,
  selectableItems,
  terminalActionContext,
  type TerminalPane,
  type TerminalWebAction,
} from "./web-interactions";

/** A semantic action exposed by a visible terminal row or pane. */
export interface TerminalHitTarget {
  action: TerminalWebAction;
  label: string;
}

export interface TerminalHitPosition {
  columns?: number;
  rowCount?: number;
  xFraction?: number;
  /** Text in the exact ANSI-to-HTML span beneath the pointer, when available. */
  targetText?: string;
}

const SCOPE_SELECTOR_TOKENS: Record<string, NonNullable<TerminalFrameState["chartScope"]>> = {
  "1:DAY": "day",
  "2:WEEK": "week",
  "3:MONTH": "month",
  "4:YEAR": "year",
  "5:TOTAL": "max",
};

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim().toUpperCase();
}

function isUnlockedState(
  state?: TerminalFrameState,
): state is TerminalFrameState & { mode: "market" | "ticker"; screen: string } {
  return Boolean(
    state?.mode &&
    state.screen &&
    !state.cacheDecision &&
    !state.searching,
  );
}

function isUnlockedMarketState(
  state?: TerminalFrameState,
): state is TerminalFrameState & { mode: "market"; screen: string } {
  return isUnlockedState(state) && state.mode === "market";
}

function selectTarget(
  state: TerminalFrameState & { mode: "market"; screen: string },
  index: number,
  item: string,
): TerminalHitTarget {
  return {
    action: { action: "select", screen: state.screen, index, item },
    label: `Select ${item}`,
  };
}

function paneTarget(
  state: TerminalFrameState & { mode: "market"; screen: string },
  pane: TerminalPane,
): TerminalHitTarget | undefined {
  const activePane =
    state.screen.toUpperCase() === "SIGNALS"
      ? state.signalsFocus ?? "headlines"
      : state.eventsFocus ?? "lanes";
  if (activePane === pane) return undefined;
  return {
    action: { action: "focus-pane", pane },
    label: `Focus ${pane === "story" ? "market story" : pane}`,
  };
}

function quoteListRow(screen: string, row: string): boolean {
  if (screen === "MOVERS") return /#\s*\d+\s+[▲▼]/.test(row);
  return /^(?:>\s*)?[▲▼]\s+/.test(row);
}

function eventLabelMatchesRow(label: string, row: string): boolean {
  if (row.includes(label)) return true;
  const firstWord = label.split(/[^A-Z0-9]+/)[0];
  if (!firstWord || firstWord.length < 4) return false;
  return new RegExp(`^(?:>\\s*)?${firstWord}(?:\\s|$)`).test(row);
}

function isWideSplitPane(position: TerminalHitPosition): boolean {
  return Boolean(
    position.columns !== undefined &&
      position.columns >= 84 &&
      position.rowCount !== undefined &&
      position.rowCount >= 24,
  );
}

function inListPane(screen: string, position: TerminalHitPosition): boolean {
  if (!isWideSplitPane(position) || position.xFraction === undefined) return true;
  return position.xFraction < (screen === "EVENTS" ? 0.43 : 0.59);
}

function inDetailPane(screen: string, position: TerminalHitPosition): boolean {
  if (!isWideSplitPane(position) || position.xFraction === undefined) return true;
  return !inListPane(screen, position);
}

function isScreenSelectorRow(row: string): boolean {
  return MARKET_SCREENS.every((screen) => row.includes(screen));
}

function isScopeSelectorRow(row: string): boolean {
  return Object.keys(SCOPE_SELECTOR_TOKENS).every((token) => row.includes(token));
}

function selectorTarget(
  state: TerminalFrameState | undefined,
  row: string,
  targetText: string | undefined,
): TerminalHitTarget | undefined {
  if (!isUnlockedState(state) || !targetText) return undefined;
  const token = normalized(targetText);

  if (state.mode === "market" && isScreenSelectorRow(row)) {
    const screen = MARKET_SCREENS.find((candidate) => candidate === token);
    if (screen && screen !== state.screen.toUpperCase()) {
      return {
        action: { action: "navigate-screen", screen },
        label: `Open ${screen}`,
      };
    }
  }

  if (isScopeSelectorRow(row)) {
    const scope = SCOPE_SELECTOR_TOKENS[token];
    if (scope && scope !== state.chartScope) {
      return {
        action: { action: "set-chart-scope", scope },
        label: `Set ${token.slice(2).toLowerCase()} chart scope`,
      };
    }
  }

  return undefined;
}

/**
 * Recover plain text from the web theme's trusted presentational markup. This
 * is deliberately limited to the HTML emitted for a terminal row; selection
 * always comes from the semantic `available` state, never arbitrary page text.
 */
export function terminalRowText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"');
}

/**
 * Return an action only for stable, visibly rendered selector spans, list
 * tokens, and headings. Quote rows use a second tap to open the already-
 * selected ticker; headline and event taps only select, so they never start
 * costly research by accident.
 */
export function terminalRowHitTarget(
  state: TerminalFrameState | undefined,
  rowMarkup: string,
  position: TerminalHitPosition = {},
): TerminalHitTarget | undefined {
  const row = normalized(terminalRowText(rowMarkup));
  if (!row) return undefined;

  const selector = selectorTarget(state, row, position.targetText);
  if (selector) return selector;
  if (!isUnlockedMarketState(state)) return undefined;

  const screen = state.screen.toUpperCase();

  if (screen === "SIGNALS") {
    if (row.includes("MARKET STORY") && inDetailPane(screen, position)) {
      return paneTarget(state, "story");
    }
    if (
      (row.includes("HEADLINES") || row.includes("CROSS-TICKER SIGNALS")) &&
      inListPane(screen, position)
    ) {
      return paneTarget(state, "headlines");
    }
  }
  if (screen === "EVENTS") {
    if (row.includes("CATALYST LANES") && inListPane(screen, position)) {
      return paneTarget(state, "lanes");
    }
    if (
      (row.includes("SELECTED BRIEFING") || row.includes("BRIEFING FOCUS")) &&
      inDetailPane(screen, position)
    ) {
      return paneTarget(state, "briefing");
    }
  }

  const items = selectableItems(state);
  if (screen === "MOVERS" || screen === "WATCH") {
    if (!inListPane(screen, position)) return undefined;
    if (!quoteListRow(screen, row)) return undefined;
    const item = items.find((candidate) => row.includes(normalized(candidate.label)));
    if (!item) return undefined;
    if (item.selected) {
      const context = terminalActionContext(state);
      if (context) {
        return {
          action: { action: "primary", context },
          label: `Open ${item.label}`,
        };
      }
    }
    return selectTarget(state, item.index, item.label);
  }

  if (screen === "SIGNALS" || screen === "EVENTS") {
    if (!inListPane(screen, position)) return undefined;
    const item = items.find((candidate) =>
      screen === "EVENTS"
        ? eventLabelMatchesRow(normalized(candidate.label), row)
        : row.includes(normalized(candidate.label)),
    );
    return item ? selectTarget(state, item.index, item.label) : undefined;
  }

  return undefined;
}

/** True when a selector row has at least one direct browser interaction. */
export function terminalRowHasPointerTarget(
  state: TerminalFrameState | undefined,
  rowMarkup: string,
): boolean {
  if (terminalRowHitTarget(state, rowMarkup)) return true;
  if (!isUnlockedState(state)) return false;

  const row = normalized(terminalRowText(rowMarkup));
  return (
    (state.mode === "market" && isScreenSelectorRow(row)) ||
    isScopeSelectorRow(row)
  );
}

/**
 * Wide SIGNALS/EVENTS layouts render a stable two-column split. Clicking a
 * pane body changes focus just like Tab; compact layouts use their headings.
 */
export function terminalPaneAtPosition(
  state: TerminalFrameState | undefined,
  columns: number | undefined,
  rowIndex: number,
  rowCount: number,
  xFraction: number,
): TerminalPane | undefined {
  if (!isUnlockedMarketState(state) || columns === undefined) return undefined;
  if (columns < 84 || rowCount < 24 || rowIndex < 5 || rowIndex >= rowCount - 4) {
    return undefined;
  }

  const screen = state.screen.toUpperCase();
  if (screen === "SIGNALS") {
    return xFraction < 0.59 ? "headlines" : "story";
  }
  if (screen === "EVENTS") {
    return xFraction < 0.43 ? "lanes" : "briefing";
  }
  return undefined;
}

export function terminalPaneHitTarget(
  state: TerminalFrameState | undefined,
  columns: number | undefined,
  rowIndex: number,
  rowCount: number,
  xFraction: number,
): TerminalHitTarget | undefined {
  const pane = terminalPaneAtPosition(state, columns, rowIndex, rowCount, xFraction);
  return pane && isUnlockedMarketState(state) ? paneTarget(state, pane) : undefined;
}
