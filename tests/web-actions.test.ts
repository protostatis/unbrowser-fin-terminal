import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWebAction,
  type MarketDebugState,
  type TickerDebugState,
  type WebActionContext,
} from "../server/web-actions.js";

// ── Raw terminal sequences (verified against pi-tui matchesKey() legacy seqs) ─
const K_TAB = "\t";
const K_UP = "\x1b[A";
const K_DOWN = "\x1b[B";
const K_LEFT = "\x1b[D";
const K_RIGHT = "\x1b[C";
const K_ENTER = "\r";

// ── Helpers ──────────────────────────────────────────────────────────────────

function marketState(overrides: Partial<MarketDebugState> = {}): MarketDebugState {
  return {
    mode: "market",
    screen: "MARKET",
    selectedIndex: 2,
    selected: "GOOGL",
    available: ["AAPL", "MSFT", "GOOGL", "AMZN", "META"],
    searching: false,
    ...overrides,
  };
}

function tickerState(overrides: Partial<TickerDebugState> = {}): TickerDebugState {
  return {
    mode: "ticker",
    screen: "QUOTE",
    symbol: "AAPL",
    hasCanvas: false,
    ...overrides,
  };
}

function reject(value: unknown): asserts value is { error: true; reason: string } {
  assert.ok(typeof value === "object" && value !== null && (value as any).error === true);
}

function accepted(value: unknown): asserts value is string[] {
  assert.ok(Array.isArray(value));
}

function actionContext(
  state: MarketDebugState | TickerDebugState,
): WebActionContext {
  if (state.mode === "ticker") {
    return { mode: "ticker", screen: state.screen, symbol: state.symbol };
  }
  const pane =
    state.screen === "SIGNALS"
      ? state.signalsFocus ?? "headlines"
      : state.screen === "EVENTS"
        ? state.eventsFocus ?? "lanes"
        : null;
  return {
    mode: "market",
    screen: state.screen,
    selectedIndex: state.selectedIndex,
    selected: state.selected ?? null,
    pane,
  };
}

// ── Top selectors ─────────────────────────────────────────────────────────────

test("navigate-screen takes the shortest canonical screen path", () => {
  const forward = resolveWebAction(
    { action: "navigate-screen", screen: "SIGNALS" },
    marketState({ screen: "MARKET" }),
  );
  accepted(forward);
  assert.deepEqual(forward, [K_RIGHT]);

  const backward = resolveWebAction(
    { action: "navigate-screen", screen: "MOVERS" },
    marketState({ screen: "MARKET" }),
  );
  accepted(backward);
  assert.deepEqual(backward, [K_LEFT, K_LEFT]);
});

test("top selector actions reject invalid or locked state", () => {
  const invalidScreen = resolveWebAction(
    { action: "navigate-screen", screen: "QUOTE" },
    marketState(),
  );
  reject(invalidScreen);
  assert.match(invalidScreen.reason, /valid market screen/);

  const locked = resolveWebAction(
    { action: "set-chart-scope", scope: "month" },
    marketState({ cacheDecision: {} }),
  );
  reject(locked);
  assert.match(locked.reason, /cache decision/);
});

test("set-chart-scope emits only the mapped scope key", () => {
  const market = resolveWebAction(
    { action: "set-chart-scope", scope: "month" },
    marketState({ chartScope: "day" }),
  );
  accepted(market);
  assert.deepEqual(market, ["3"]);

  const ticker = resolveWebAction(
    { action: "set-chart-scope", scope: "max" },
    tickerState({ chartScope: "week" }),
  );
  accepted(ticker);
  assert.deepEqual(ticker, ["5"]);
});

// ── select action ────────────────────────────────────────────────────────────

test("select navigates to the target index with down keys", () => {
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 4, item: "META" },
    marketState({ screen: "MARKET", selectedIndex: 2 }),
  );
  accepted(result);
  assert.deepEqual(result, [K_DOWN, K_DOWN]);
});

test("select when current index is above target emits up keys", () => {
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 1, item: "MSFT" },
    marketState({ screen: "MARKET", selectedIndex: 3 }),
  );
  accepted(result);
  assert.deepEqual(result, [K_UP, K_UP]);
});

test("select at current index emits empty array", () => {
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 2, item: "GOOGL" },
    marketState({ screen: "MARKET", selectedIndex: 2 }),
  );
  accepted(result);
  assert.deepEqual(result, []);
});

test("select from story reading pane emits Tab first then down", () => {
  const state = marketState({
    screen: "SIGNALS",
    selectedIndex: 1,
    signalsFocus: "story",
    available: ["Headline A", "Headline B", "Headline C"],
  });
  const result = resolveWebAction(
    { action: "select", screen: "SIGNALS", index: 2, item: "Headline C" },
    state,
  );
  accepted(result);
  assert.deepEqual(result, [K_TAB, K_DOWN]);
});

test("select from briefing reading pane emits Tab first then down keys", () => {
  const state = marketState({
    screen: "EVENTS",
    selectedIndex: 0,
    eventsFocus: "briefing",
    available: ["Earnings", "FOMC", "OPEC"],
  });
  const result = resolveWebAction(
    { action: "select", screen: "EVENTS", index: 2, item: "OPEC" },
    state,
  );
  accepted(result);
  assert.deepEqual(result, [K_TAB, K_DOWN, K_DOWN]);
});

test("select supports large movers lists (100 items)", () => {
  const movers = Array.from({ length: 100 }, (_, i) => `MOVER-${i}`);
  const state = marketState({
    screen: "MOVERS",
    selectedIndex: 0,
    available: movers,
  });
  const result = resolveWebAction(
    { action: "select", screen: "MOVERS", index: 99, item: "MOVER-99" },
    state,
  );
  accepted(result);
  assert.equal(result.length, 99);
  assert.deepEqual(result[0], K_DOWN);
  assert.deepEqual(result[98], K_DOWN);
});

test("select rejects non-market mode", () => {
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 0, item: "AAPL" },
    tickerState(),
  );
  reject(result);
  assert.match(result.reason, /market mode/);
});

test("select rejects screen mismatch", () => {
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 0, item: "AAPL" },
    marketState({ screen: "MOVERS" }),
  );
  reject(result);
  assert.match(result.reason, /mismatch/);
});

test("select rejects index out of bounds", () => {
  const state = marketState({ screen: "SIGNALS", available: ["A", "B", "C"] });
  const result = resolveWebAction(
    { action: "select", screen: "SIGNALS", index: 3, item: "D" },
    state,
  );
  reject(result);
  assert.match(result.reason, /out of bounds/);
});

test("select rejects stale item", () => {
  const state = marketState({ screen: "WATCH", available: ["NKE", "SBUX"] });
  const result = resolveWebAction(
    { action: "select", screen: "WATCH", index: 0, item: "AAPL" },
    state,
  );
  reject(result);
  assert.match(result.reason, /stale selection/);
});

test("select rejects a missing or invalid current selection index", () => {
  const state = marketState({ selectedIndex: Number.NaN });
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 0, item: "AAPL" },
    state,
  );
  reject(result);
  assert.match(result.reason, /selectedIndex is missing or invalid/);
});

test("select rejects when search is active", () => {
  const state = marketState({ searching: true });
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 0, item: "AAPL" },
    state,
  );
  reject(result);
  assert.match(result.reason, /search/);
});

test("select rejects when cache decision is pending", () => {
  const state = marketState({ cacheDecision: {} });
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 0, item: "AAPL" },
    state,
  );
  reject(result);
  assert.match(result.reason, /cache decision/);
});

test("select rejects invalid screen name", () => {
  const result = resolveWebAction(
    { action: "select", screen: "HEADLINES", index: 0, item: "X" },
    marketState(),
  );
  reject(result);
  assert.match(result.reason, /valid market screen/);
});

// ── focus-pane action ────────────────────────────────────────────────────────

test("focus-pane returns empty array when already on the desired pane", () => {
  const state = marketState({
    screen: "SIGNALS",
    signalsFocus: "headlines",
  });
  const result = resolveWebAction(
    { action: "focus-pane", pane: "headlines" },
    state,
  );
  accepted(result);
  assert.deepEqual(result, []);
});

test("focus-pane emits raw Tab to switch from headlines to story", () => {
  const state = marketState({
    screen: "SIGNALS",
    signalsFocus: "headlines",
  });
  const result = resolveWebAction(
    { action: "focus-pane", pane: "story" },
    state,
  );
  accepted(result);
  assert.deepEqual(result, [K_TAB]);
});

test("focus-pane emits raw Tab to switch from story to headlines", () => {
  const state = marketState({
    screen: "SIGNALS",
    signalsFocus: "story",
  });
  const result = resolveWebAction(
    { action: "focus-pane", pane: "headlines" },
    state,
  );
  accepted(result);
  assert.deepEqual(result, [K_TAB]);
});

test("focus-pane emits raw Tab to switch from lanes to briefing", () => {
  const state = marketState({
    screen: "EVENTS",
    eventsFocus: "lanes",
  });
  const result = resolveWebAction(
    { action: "focus-pane", pane: "briefing" },
    state,
  );
  accepted(result);
  assert.deepEqual(result, [K_TAB]);
});

test("focus-pane emits raw Tab to switch from briefing to lanes", () => {
  const state = marketState({
    screen: "EVENTS",
    eventsFocus: "briefing",
  });
  const result = resolveWebAction(
    { action: "focus-pane", pane: "lanes" },
    state,
  );
  accepted(result);
  assert.deepEqual(result, [K_TAB]);
});

test("focus-pane rejects wrong screen for headlines", () => {
  const result = resolveWebAction(
    { action: "focus-pane", pane: "headlines" },
    marketState({ screen: "EVENTS" }),
  );
  reject(result);
  assert.match(result.reason, /requires screen/);
});

test("focus-pane rejects wrong screen for briefing", () => {
  const result = resolveWebAction(
    { action: "focus-pane", pane: "briefing" },
    marketState({ screen: "SIGNALS" }),
  );
  reject(result);
  assert.match(result.reason, /requires screen/);
});

test("focus-pane rejects on non-split screens", () => {
  const result = resolveWebAction(
    { action: "focus-pane", pane: "story" },
    marketState({ screen: "MARKET" }),
  );
  reject(result);
  assert.match(result.reason, /requires screen/);
});

test("focus-pane rejects when locked (searching)", () => {
  const result = resolveWebAction(
    { action: "focus-pane", pane: "headlines" },
    marketState({ screen: "SIGNALS", searching: true }),
  );
  reject(result);
  assert.match(result.reason, /search/);
});

test("focus-pane rejects when locked (cache)", () => {
  const result = resolveWebAction(
    { action: "focus-pane", pane: "lanes" },
    marketState({ screen: "EVENTS", cacheDecision: {} }),
  );
  reject(result);
  assert.match(result.reason, /cache decision/);
});

test("focus-pane rejects invalid pane name", () => {
  const result = resolveWebAction(
    { action: "focus-pane", pane: "other" },
    marketState({ screen: "SIGNALS" }),
  );
  reject(result);
  assert.match(result.reason, /valid pane/);
});

// ── scroll action ────────────────────────────────────────────────────────────

test("scroll market list moves selection (up)", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "up" },
    marketState({ screen: "MARKET" }),
  );
  accepted(result);
  assert.deepEqual(result, [K_UP]);
});

test("scroll market list moves selection (down)", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down" },
    marketState({ screen: "MARKET" }),
  );
  accepted(result);
  assert.deepEqual(result, [K_DOWN]);
});

test("scroll SIGNALS story pane when scrollable (down)", () => {
  const state = marketState({
    screen: "SIGNALS",
    signalsFocus: "story",
    storyScroll: { offset: 0, rows: 30, viewportRows: 10 },
  });
  const result = resolveWebAction(
    { action: "scroll", direction: "down", amount: 3 },
    state,
  );
  accepted(result);
  assert.deepEqual(result, [K_DOWN, K_DOWN, K_DOWN]);
});

test("hovered pane scroll focuses the pane before applying the wheel step", () => {
  const story = resolveWebAction(
    { action: "scroll", direction: "down", amount: 2, pane: "story" },
    marketState({
      screen: "SIGNALS",
      signalsFocus: "headlines",
      storyScroll: { offset: 0, rows: 30, viewportRows: 10 },
    }),
  );
  accepted(story);
  assert.deepEqual(story, [K_TAB, K_DOWN, K_DOWN]);

  const headlines = resolveWebAction(
    { action: "scroll", direction: "up", pane: "headlines" },
    marketState({ screen: "SIGNALS", signalsFocus: "story" }),
  );
  accepted(headlines);
  assert.deepEqual(headlines, [K_TAB, K_UP]);
});

test("hovered scroll pane must belong to the visible screen", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down", pane: "briefing" },
    marketState({ screen: "SIGNALS", signalsFocus: "headlines" }),
  );
  reject(result);
  assert.match(result.reason, /requires screen/);
});

test("scroll rejects a delayed action from a different rendered screen", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down", screen: "MOVERS" },
    marketState({ screen: "SIGNALS", signalsFocus: "headlines" }),
  );
  reject(result);
  assert.match(result.reason, /stale/);
});

test("scroll EVENTS briefing pane when scrollable (up)", () => {
  const state = marketState({
    screen: "EVENTS",
    eventsFocus: "briefing",
    eventScroll: { offset: 0, rows: 15, viewportRows: 8 },
  });
  const result = resolveWebAction(
    { action: "scroll", direction: "up", amount: 2 },
    state,
  );
  accepted(result);
  assert.deepEqual(result, [K_UP, K_UP]);
});

test("scroll rejects story pane when not scrollable", () => {
  const state = marketState({
    screen: "SIGNALS",
    signalsFocus: "story",
    storyScroll: { offset: 0, rows: 5, viewportRows: 10 },
  });
  const result = resolveWebAction(
    { action: "scroll", direction: "down" },
    state,
  );
  reject(result);
  assert.match(result.reason, /no scrollable content/);
});

test("scroll rejects briefing pane when not scrollable", () => {
  const state = marketState({
    screen: "EVENTS",
    eventsFocus: "briefing",
    eventScroll: { offset: 0, rows: 8, viewportRows: 8 },
  });
  const result = resolveWebAction(
    { action: "scroll", direction: "up" },
    state,
  );
  reject(result);
  assert.match(result.reason, /no scrollable content/);
});

test("scroll rejects SIGNALS story when no story scroll info", () => {
  const state = marketState({
    screen: "SIGNALS",
    signalsFocus: "story",
    // No storyScroll means not scrollable
  });
  const result = resolveWebAction(
    { action: "scroll", direction: "down" },
    state,
  );
  reject(result);
});

test("scroll SIGNALS headlines focus moves selection (down)", () => {
  const state = marketState({
    screen: "SIGNALS",
    signalsFocus: "headlines",
  });
  const result = resolveWebAction(
    { action: "scroll", direction: "down", amount: 2 },
    state,
  );
  accepted(result);
  assert.deepEqual(result, [K_DOWN, K_DOWN]);
});

test("scroll MOVERS list moves selection (up)", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "up", amount: 4 },
    marketState({ screen: "MOVERS" }),
  );
  accepted(result);
  assert.deepEqual(result, [K_UP, K_UP, K_UP, K_UP]);
});

test("scroll ticker RESEARCH with canvas (down)", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down", amount: 3 },
    tickerState({ screen: "RESEARCH", hasCanvas: true }),
  );
  accepted(result);
  assert.deepEqual(result, [K_DOWN, K_DOWN, K_DOWN]);
});

test("scroll ticker wide SPLIT research canvas (down)", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down", amount: 2 },
    tickerState({ screen: "SPLIT", tickerLayout: "split", hasCanvas: true }),
  );
  accepted(result);
  assert.deepEqual(result, [K_DOWN, K_DOWN]);
});

test("scroll rejects ticker QUOTE tab", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down" },
    tickerState({ screen: "QUOTE", hasCanvas: true }),
  );
  reject(result);
  assert.match(result.reason, /QUOTE/);
});

test("scroll rejects ticker RESEARCH without canvas", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "up" },
    tickerState({ screen: "RESEARCH", hasCanvas: false }),
  );
  reject(result);
  assert.match(result.reason, /no canvas/);
});

test("scroll caps amount to 8", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down", amount: 100 },
    marketState({ screen: "MARKET" }),
  );
  accepted(result);
  assert.equal(result.length, 8);
});

test("scroll defaults amount to 1 when unspecified", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "up" },
    marketState({ screen: "WATCH" }),
  );
  accepted(result);
  assert.deepEqual(result, [K_UP]);
});

test("scroll rejects locked state (searching)", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down" },
    marketState({ searching: true }),
  );
  reject(result);
  assert.match(result.reason, /search/);
});

test("scroll rejects locked state (cache decision)", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "up" },
    marketState({ cacheDecision: {} }),
  );
  reject(result);
  assert.match(result.reason, /cache decision/);
});

test("scroll rejects ticker locked (cache)", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down" },
    tickerState({ screen: "RESEARCH", hasCanvas: true, cacheDecision: {} }),
  );
  reject(result);
  assert.match(result.reason, /cache decision/);
});

test("scroll rejects invalid direction", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "left" },
    marketState(),
  );
  reject(result);
  assert.match(result.reason, /direction/);
});

test("scroll rejects zero or negative amount", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down", amount: 0 },
    marketState(),
  );
  reject(result);
  assert.match(result.reason, /positive integer/);
});

// ── primary action ───────────────────────────────────────────────────────────

test("primary returns raw enter on unlocked market state", () => {
  const state = marketState();
  const result = resolveWebAction({ action: "primary", context: actionContext(state) }, state);
  accepted(result);
  assert.deepEqual(result, [K_ENTER]);
});

test("primary keeps a market-level action available when no item is selected", () => {
  const state = marketState({ available: [], selected: undefined, selectedIndex: 0 });
  const result = resolveWebAction({ action: "primary", context: actionContext(state) }, state);
  accepted(result);
  assert.deepEqual(result, [K_ENTER]);
});

test("primary returns raw enter on unlocked ticker state", () => {
  const state = tickerState({ screen: "RESEARCH", hasCanvas: true });
  const result = resolveWebAction({ action: "primary", context: actionContext(state) }, state);
  accepted(result);
  assert.deepEqual(result, [K_ENTER]);
});

test("primary rejects on locked market (searching)", () => {
  const state = marketState({ searching: true });
  const result = resolveWebAction({ action: "primary", context: actionContext(state) }, state);
  reject(result);
  assert.match(result.reason, /search/);
});

test("primary rejects on locked market (cache)", () => {
  const state = marketState({ cacheDecision: {} });
  const result = resolveWebAction({ action: "primary", context: actionContext(state) }, state);
  reject(result);
  assert.match(result.reason, /cache decision/);
});

test("primary rejects on locked ticker", () => {
  const state = tickerState({ cacheDecision: {} });
  const result = resolveWebAction({ action: "primary", context: actionContext(state) }, state);
  reject(result);
  assert.match(result.reason, /cache decision/);
});

// ── why action ───────────────────────────────────────────────────────────────

test("why returns literal k on unlocked market state", () => {
  const state = marketState();
  const result = resolveWebAction({ action: "why", context: actionContext(state) }, state);
  accepted(result);
  assert.deepEqual(result, ["k"]);
});

test("why returns literal k on unlocked ticker state", () => {
  const state = tickerState();
  const result = resolveWebAction({ action: "why", context: actionContext(state) }, state);
  accepted(result);
  assert.deepEqual(result, ["k"]);
});

test("why rejects on locked state", () => {
  const state = marketState({ searching: true, cacheDecision: {} });
  const result = resolveWebAction({ action: "why", context: actionContext(state) }, state);
  reject(result);
});

test("primary rejects a stale market selection or pane", () => {
  const state = marketState({
    screen: "SIGNALS",
    selectedIndex: 1,
    selected: "Headline B",
    signalsFocus: "headlines",
    available: ["Headline A", "Headline B"],
  });
  const staleSelection = resolveWebAction(
    {
      action: "primary",
      context: {
        ...actionContext(state),
        selectedIndex: 0,
        selected: "Headline A",
      },
    },
    state,
  );
  reject(staleSelection);
  assert.match(staleSelection.reason, /selection index is stale/);

  const stalePane = resolveWebAction(
    {
      action: "why",
      context: { ...actionContext(state), pane: "story" },
    },
    state,
  );
  reject(stalePane);
  assert.match(stalePane.reason, /pane is stale/);
});

test("contextual actions reject a stale ticker or missing context", () => {
  const state = tickerState({ symbol: "MSFT" });
  const staleTicker = resolveWebAction(
    { action: "primary", context: { mode: "ticker", screen: "QUOTE", symbol: "AAPL" } },
    state,
  );
  reject(staleTicker);
  assert.match(staleTicker.reason, /ticker is stale/);

  const missingContext = resolveWebAction({ action: "why" }, state);
  reject(missingContext);
  assert.match(missingContext.reason, /expected context/);
});

// ── Rejection of malformed / unrecognized actions ────────────────────────────

test("rejects null action", () => {
  const result = resolveWebAction(null, marketState());
  reject(result);
  assert.match(result.reason, /object/);
});

test("rejects string action", () => {
  const result = resolveWebAction("select", marketState());
  reject(result);
  assert.match(result.reason, /object/);
});

test("rejects number action", () => {
  const result = resolveWebAction(42, marketState());
  reject(result);
  assert.match(result.reason, /object/);
});

test("rejects array action", () => {
  const result = resolveWebAction([], marketState());
  reject(result);
  assert.match(result.reason, /object/);
});

test("rejects action without action field", () => {
  const result = resolveWebAction({ foo: "bar" }, marketState());
  reject(result);
  assert.match(result.reason, /action/);
});

test("rejects unknown action type", () => {
  const result = resolveWebAction({ action: "unknown" }, marketState());
  reject(result);
  assert.match(result.reason, /unrecognized/);
});

test("rejects null state", () => {
  const result = resolveWebAction({ action: "primary" }, null);
  reject(result);
  assert.match(result.reason, /object/);
});

test("rejects undefined state", () => {
  const result = resolveWebAction({ action: "why" }, undefined);
  reject(result);
  assert.match(result.reason, /object/);
});

test("rejects string state", () => {
  const result = resolveWebAction({ action: "scroll", direction: "down" }, "market");
  reject(result);
  assert.match(result.reason, /object/);
});

test("rejects array state", () => {
  const result = resolveWebAction({ action: "focus-pane", pane: "story" }, []);
  reject(result);
  assert.match(result.reason, /object/);
});

// ── Edge: non-string item and non-integer index in select ────────────────────

test("select rejects non-integer index", () => {
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 1.5, item: "GOOGL" },
    marketState(),
  );
  reject(result);
  assert.match(result.reason, /integer index/);
});

test("select rejects non-string item", () => {
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 0, item: 123 },
    marketState(),
  );
  reject(result);
  assert.match(result.reason, /item string/);
});

test("select rejects negative index", () => {
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: -1, item: "AAPL" },
    marketState(),
  );
  reject(result);
  assert.match(result.reason, /integer index/);
});

// ── Verify raw byte values to guard against accidental string-literal drift ───

test("raw sequences match expected hex bytes", () => {
  assert.equal(K_TAB, "\x09");
  assert.equal(K_UP, "\x1b[A");
  assert.equal(K_DOWN, "\x1b[B");
  assert.equal(K_ENTER, "\x0d");
  assert.equal("k", "k"); // literal: no escape sequence needed
});

test("raw up/down are distinct 3-byte sequences", () => {
  assert.notEqual(K_UP, K_DOWN);
  assert.equal(K_UP.length, 3);
  assert.equal(K_DOWN.length, 3);
  assert.equal(K_UP.charCodeAt(0), 0x1b);
  assert.equal(K_DOWN.charCodeAt(0), 0x1b);
});

test("different directions produce different arrays via scroll", () => {
  const upResult = resolveWebAction(
    { action: "scroll", direction: "up", amount: 1 },
    marketState({ screen: "MARKET" }),
  );
  const downResult = resolveWebAction(
    { action: "scroll", direction: "down", amount: 1 },
    marketState({ screen: "MARKET" }),
  );
  accepted(upResult);
  accepted(downResult);
  assert.notDeepEqual(upResult, downResult);
  assert.equal(upResult[0], K_UP);
  assert.equal(downResult[0], K_DOWN);
});
