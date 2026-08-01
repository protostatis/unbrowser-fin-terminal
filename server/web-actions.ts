/**
 * Web Action Bridge — parses a web-originated semantic action (JSON) and the
 * current `activePanel.debugState()` and returns a deterministic array of
 * raw terminal input sequences, or a typed rejection.
 *
 * NEVER injects arbitrary data. Every emitted byte sequence is one of the
 * exact raw terminal sequences the market-terminal extension's handleInput
 * already understands (verified against pi-tui matchesKey() legacy sequences):
 *   Tab      "\t"        — focus-pane toggle (SIGNALS: headlines↔story, EVENTS: lanes↔briefing)
 *   Up       "\x1b[A"    — list selection or content scrolling (context-dependent)
 *   Down     "\x1b[B"    — list selection or content scrolling (context-dependent)
 *   Enter    "\r"        — primary action (open ticker, start brief research)
 *   k        "k"         — why action (deep research, literal printable)
 *
 * Supported web actions:
 *   select      { action: "select", screen, index, item }
 *   focus-pane  { action: "focus-pane", pane: "headlines"|"story"|"lanes"|"briefing" }
 *   scroll      { action: "scroll", direction: "up"|"down", amount?: number }
 *   primary     { action: "primary" }
 *   why         { action: "why" }
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type MarketDebugState = {
  mode: "market";
  screen: string;
  selectedIndex: number;
  available: string[];
  signalsFocus?: "headlines" | "story";
  eventsFocus?: "lanes" | "briefing";
  searching: boolean;
  cacheDecision?: unknown;
  storyScroll?: { offset: number; rows: number; viewportRows: number };
  eventScroll?: { offset: number; rows: number; viewportRows: number };
  loading?: boolean;
};

export type TickerDebugState = {
  mode: "ticker";
  screen: string;
  hasCanvas: boolean;
  cacheDecision?: unknown;
  searching?: boolean;
};

export type AnyDebugState = MarketDebugState | TickerDebugState;

export type SelectAction = {
  action: "select";
  screen: string;
  index: number;
  item: string;
};

export type FocusPaneAction = {
  action: "focus-pane";
  pane: "headlines" | "story" | "lanes" | "briefing";
};

export type ScrollAction = {
  action: "scroll";
  direction: "up" | "down";
  amount?: number;
};

export type PrimaryAction = { action: "primary" };
export type WhyAction = { action: "why" };

export type WebAction =
  | SelectAction
  | FocusPaneAction
  | ScrollAction
  | PrimaryAction
  | WhyAction;

/** Non-throwing rejection returned for invalid or unrecognized actions. */
export type WebActionRejection = {
  error: true;
  reason: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_SCROLL_AMOUNT = 8;
const SIGNALS_SCREEN = "SIGNALS";
const EVENTS_SCREEN = "EVENTS";
const MARKET_SCREEN_NAMES = new Set(["MARKET", "SIGNALS", "EVENTS", "MOVERS", "WATCH"]);

// Raw terminal sequences that the extension's handleInput / matchesKey() accepts.
// Verified against @earendil-works/pi-tui@0.83.0 and web/src/mobile-controls.ts TERMINAL_INPUTS.
const K_TAB = "\t";
const K_UP = "\x1b[A";
const K_DOWN = "\x1b[B";
const K_ENTER = "\r";

// ── Guards ───────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMarketState(value: unknown): value is MarketDebugState {
  return isObject(value) && value.mode === "market";
}

function isTickerState(value: unknown): value is TickerDebugState {
  return isObject(value) && value.mode === "ticker";
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function reject(reason: string): WebActionRejection {
  return { error: true, reason };
}

function isLocked(state: { searching?: boolean; cacheDecision?: unknown }): string | null {
  if (state.searching) return "search is active";
  if (state.cacheDecision) return "cache decision pending";
  return null;
}

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * Parse and validate a web action against the current terminal state.
 * Returns an array of canonical terminal input strings, or a rejection.
 */
export function resolveWebAction(
  action: unknown,
  state: unknown,
): string[] | WebActionRejection {
  if (!isObject(action)) return reject(`invalid action: expected an object, got ${typeof action}`);
  if (!isObject(state)) return reject(`invalid state: expected an object, got ${typeof state}`);

  const actionType = action.action;
  if (typeof actionType !== "string") return reject(`invalid action: missing or non-string "action" field`);

  switch (actionType) {
    case "select":
      return resolveSelect(action, state);
    case "focus-pane":
      return resolveFocusPane(action, state);
    case "scroll":
      return resolveScroll(action, state);
    case "primary":
      return resolvePrimary(state);
    case "why":
      return resolveWhy(state);
    default:
      return reject(`unrecognized action: ${actionType}`);
  }
}

// ── Action resolvers ─────────────────────────────────────────────────────────

function resolveSelect(
  action: Record<string, unknown>,
  state: unknown,
): string[] | WebActionRejection {
  if (!isMarketState(state)) return reject("select requires market mode");

  const { screen, index, item } = action;

  if (typeof screen !== "string" || !MARKET_SCREEN_NAMES.has(screen)) {
    return reject(`select requires a valid market screen, got: ${String(screen)}`);
  }
  if (screen !== state.screen) {
    return reject(`screen mismatch: action specifies "${screen}" but state is "${state.screen}"`);
  }

  if (!isSafeNonNegativeInteger(index)) {
    return reject(`select requires a non-negative integer index, got: ${JSON.stringify(index)}`);
  }
  if (typeof item !== "string") {
    return reject(`select requires an item string, got: ${JSON.stringify(item)}`);
  }

  const lockReason = isLocked(state);
  if (lockReason) return reject(`select rejected: ${lockReason}`);

  // Bounds and staleness checks
  if (!Array.isArray(state.available)) {
    return reject("select rejected: available list missing or invalid");
  }
  if (index >= state.available.length) {
    return reject(
      `select index ${index} out of bounds (available length: ${state.available.length})`,
    );
  }
  if (state.available[index] !== item) {
    return reject(
      `stale selection: item at index ${index} is "${String(state.available[index])}", expected "${item}"`,
    );
  }

  // Guard: selectedIndex must be sane
  const currentIndex = isSafeNonNegativeInteger(state.selectedIndex)
    ? state.selectedIndex
    : 0;

  const inputs: string[] = [];

  // If currently in a reading pane, Tab back to the selectable list
  const inReadingPane =
    (state.screen === SIGNALS_SCREEN && state.signalsFocus === "story") ||
    (state.screen === EVENTS_SCREEN && state.eventsFocus === "briefing");

  if (inReadingPane) {
    inputs.push(K_TAB);
  }

  // Navigate from current index to target
  if (index < currentIndex) {
    for (let i = 0; i < currentIndex - index; i++) inputs.push(K_UP);
  } else if (index > currentIndex) {
    for (let i = 0; i < index - currentIndex; i++) inputs.push(K_DOWN);
  }

  return inputs;
}

function resolveFocusPane(
  action: Record<string, unknown>,
  state: unknown,
): string[] | WebActionRejection {
  if (!isMarketState(state)) return reject("focus-pane requires market mode");

  const pane = action.pane;
  if (pane !== "headlines" && pane !== "story" && pane !== "lanes" && pane !== "briefing") {
    return reject(`focus-pane requires a valid pane, got: ${String(pane)}`);
  }

  // Pane → screen mapping
  const expectedScreen =
    pane === "headlines" || pane === "story" ? SIGNALS_SCREEN : EVENTS_SCREEN;

  if (state.screen !== expectedScreen) {
    return reject(`focus-pane "${pane}" requires screen "${expectedScreen}", currently "${state.screen}"`);
  }

  const lockReason = isLocked(state);
  if (lockReason) return reject(`focus-pane rejected: ${lockReason}`);

  // Determine current focus
  const currentFocus =
    expectedScreen === SIGNALS_SCREEN ? state.signalsFocus : state.eventsFocus;

  // Map pane to focus value
  const desiredFocus =
    pane === "headlines" ? "headlines"
    : pane === "story" ? "story"
    : pane === "lanes" ? "lanes"
    : "briefing";

  // Tab only when a change is needed
  if (currentFocus === desiredFocus) return [];

  return [K_TAB];
}

function resolveScroll(
  action: Record<string, unknown>,
  state: unknown,
): string[] | WebActionRejection {
  const direction = action.direction;
  if (direction !== "up" && direction !== "down") {
    return reject(`scroll requires direction "up" or "down", got: ${String(direction)}`);
  }

  // Validate and cap amount
  let amount = 1;
  if (action.amount !== undefined) {
    if (
      typeof action.amount !== "number"
      || !Number.isInteger(action.amount)
      || action.amount < 1
    ) {
      return reject(`scroll amount must be a positive integer, got: ${JSON.stringify(action.amount)}`);
    }
    amount = Math.min(action.amount, MAX_SCROLL_AMOUNT);
  }

  const key = direction === "up" ? K_UP : K_DOWN;

  // ── Market mode ──────────────────────────────────────────────────────────
  if (isMarketState(state)) {
    const lockReason = isLocked(state);
    if (lockReason) return reject(`scroll rejected: ${lockReason}`);

    // SIGNALS story pane: scroll only when scrollable
    if (state.screen === SIGNALS_SCREEN && state.signalsFocus === "story") {
      if (!state.storyScroll || state.storyScroll.rows <= state.storyScroll.viewportRows) {
        return reject("scroll rejected: story pane has no scrollable content");
      }
      return Array<string>(amount).fill(key);
    }

    // EVENTS briefing pane: scroll only when scrollable
    if (state.screen === EVENTS_SCREEN && state.eventsFocus === "briefing") {
      if (!state.eventScroll || state.eventScroll.rows <= state.eventScroll.viewportRows) {
        return reject("scroll rejected: briefing pane has no scrollable content");
      }
      return Array<string>(amount).fill(key);
    }

    // Regular lists: move selection
    return Array<string>(amount).fill(key);
  }

  // ── Ticker mode ──────────────────────────────────────────────────────────
  if (isTickerState(state)) {
    if (state.screen !== "RESEARCH") {
      return reject("scroll rejected: ticker QUOTE tab does not support scroll");
    }
    if (!state.hasCanvas) {
      return reject("scroll rejected: ticker RESEARCH has no canvas to scroll");
    }
    const lockReason = isLocked(state);
    if (lockReason) return reject(`scroll rejected: ${lockReason}`);

    return Array<string>(amount).fill(key);
  }

  return reject("scroll requires a valid market or ticker debug state");
}

function resolvePrimary(state: unknown): string[] | WebActionRejection {
  if (isMarketState(state)) {
    const lockReason = isLocked(state);
    if (lockReason) return reject(`primary rejected: ${lockReason}`);
    return [K_ENTER];
  }

  if (isTickerState(state)) {
    const lockReason = isLocked(state);
    if (lockReason) return reject(`primary rejected: ${lockReason}`);
    return [K_ENTER];
  }

  return reject("primary requires a valid debug state");
}

function resolveWhy(state: unknown): string[] | WebActionRejection {
  if (isMarketState(state)) {
    const lockReason = isLocked(state);
    if (lockReason) return reject(`why rejected: ${lockReason}`);
    return ["k"];
  }

  if (isTickerState(state)) {
    const lockReason = isLocked(state);
    if (lockReason) return reject(`why rejected: ${lockReason}`);
    return ["k"];
  }

  return reject("why requires a valid debug state");
}
