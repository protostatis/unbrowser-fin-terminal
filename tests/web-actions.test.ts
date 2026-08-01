import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWebAction,
  type MarketDebugState,
  type TickerDebugState,
} from "../server/web-actions.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function marketState(overrides: Partial<MarketDebugState> = {}): MarketDebugState {
  return {
    mode: "market",
    screen: "MARKET",
    selectedIndex: 2,
    available: ["AAPL", "MSFT", "GOOGL", "AMZN", "META"],
    searching: false,
    ...overrides,
  };
}

function tickerState(overrides: Partial<TickerDebugState> = {}): TickerDebugState {
  return {
    mode: "ticker",
    screen: "QUOTE",
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

// ── select action ────────────────────────────────────────────────────────────

test("select navigates to the target index with up/down", () => {
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 4, item: "META" },
    marketState({ screen: "MARKET", selectedIndex: 2 }),
  );
  accepted(result);
  assert.deepEqual(result, ["down", "down"]);
});

test("select when current index is above target emits up keys", () => {
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 1, item: "MSFT" },
    marketState({ screen: "MARKET", selectedIndex: 3 }),
  );
  accepted(result);
  assert.deepEqual(result, ["up", "up"]);
});

test("select at current index emits empty array", () => {
  const result = resolveWebAction(
    { action: "select", screen: "MARKET", index: 2, item: "GOOGL" },
    marketState({ screen: "MARKET", selectedIndex: 2 }),
  );
  accepted(result);
  assert.deepEqual(result, []);
});

test("select from story reading pane emits Tab first", () => {
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
  assert.deepEqual(result, ["tab", "down"]);
});

test("select from briefing reading pane emits Tab first", () => {
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
  assert.deepEqual(result, ["tab", "down", "down"]);
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
  assert.deepEqual(result[0], "down");
  assert.deepEqual(result[98], "down");
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

test("focus-pane emits Tab to switch from headlines to story", () => {
  const state = marketState({
    screen: "SIGNALS",
    signalsFocus: "headlines",
  });
  const result = resolveWebAction(
    { action: "focus-pane", pane: "story" },
    state,
  );
  accepted(result);
  assert.deepEqual(result, ["tab"]);
});

test("focus-pane emits Tab to switch from story to headlines", () => {
  const state = marketState({
    screen: "SIGNALS",
    signalsFocus: "story",
  });
  const result = resolveWebAction(
    { action: "focus-pane", pane: "headlines" },
    state,
  );
  accepted(result);
  assert.deepEqual(result, ["tab"]);
});

test("focus-pane emits Tab to switch from lanes to briefing", () => {
  const state = marketState({
    screen: "EVENTS",
    eventsFocus: "lanes",
  });
  const result = resolveWebAction(
    { action: "focus-pane", pane: "briefing" },
    state,
  );
  accepted(result);
  assert.deepEqual(result, ["tab"]);
});

test("focus-pane emits Tab to switch from briefing to lanes", () => {
  const state = marketState({
    screen: "EVENTS",
    eventsFocus: "briefing",
  });
  const result = resolveWebAction(
    { action: "focus-pane", pane: "lanes" },
    state,
  );
  accepted(result);
  assert.deepEqual(result, ["tab"]);
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
  assert.deepEqual(result, ["up"]);
});

test("scroll market list moves selection (down)", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down" },
    marketState({ screen: "MARKET" }),
  );
  accepted(result);
  assert.deepEqual(result, ["down"]);
});

test("scroll SIGNALS story pane when scrollable", () => {
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
  assert.deepEqual(result, ["down", "down", "down"]);
});

test("scroll EVENTS briefing pane when scrollable", () => {
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
  assert.deepEqual(result, ["up", "up"]);
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

test("scroll rejects SIGNALS headlines list when no story scroll info", () => {
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

test("scroll SIGNALS headlines focus moves selection", () => {
  const state = marketState({
    screen: "SIGNALS",
    signalsFocus: "headlines",
  });
  const result = resolveWebAction(
    { action: "scroll", direction: "down", amount: 2 },
    state,
  );
  accepted(result);
  assert.deepEqual(result, ["down", "down"]);
});

test("scroll MOVERS list moves selection", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "up", amount: 4 },
    marketState({ screen: "MOVERS" }),
  );
  accepted(result);
  assert.deepEqual(result, ["up", "up", "up", "up"]);
});

test("scroll ticker RESEARCH with canvas", () => {
  const result = resolveWebAction(
    { action: "scroll", direction: "down", amount: 3 },
    tickerState({ screen: "RESEARCH", hasCanvas: true }),
  );
  accepted(result);
  assert.deepEqual(result, ["down", "down", "down"]);
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
  assert.deepEqual(result, ["up"]);
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

test("primary returns enter on unlocked market state", () => {
  const result = resolveWebAction(
    { action: "primary" },
    marketState(),
  );
  accepted(result);
  assert.deepEqual(result, ["enter"]);
});

test("primary returns enter on unlocked ticker state", () => {
  const result = resolveWebAction(
    { action: "primary" },
    tickerState({ screen: "RESEARCH", hasCanvas: true }),
  );
  accepted(result);
  assert.deepEqual(result, ["enter"]);
});

test("primary rejects on locked market (searching)", () => {
  const result = resolveWebAction(
    { action: "primary" },
    marketState({ searching: true }),
  );
  reject(result);
  assert.match(result.reason, /search/);
});

test("primary rejects on locked market (cache)", () => {
  const result = resolveWebAction(
    { action: "primary" },
    marketState({ cacheDecision: {} }),
  );
  reject(result);
  assert.match(result.reason, /cache decision/);
});

test("primary rejects on locked ticker", () => {
  const result = resolveWebAction(
    { action: "primary" },
    tickerState({ cacheDecision: {} }),
  );
  reject(result);
  assert.match(result.reason, /cache decision/);
});

// ── why action ───────────────────────────────────────────────────────────────

test("why returns k on unlocked market state", () => {
  const result = resolveWebAction(
    { action: "why" },
    marketState(),
  );
  accepted(result);
  assert.deepEqual(result, ["k"]);
});

test("why returns k on unlocked ticker state", () => {
  const result = resolveWebAction(
    { action: "why" },
    tickerState(),
  );
  accepted(result);
  assert.deepEqual(result, ["k"]);
});

test("why rejects on locked state", () => {
  const result = resolveWebAction(
    { action: "why" },
    marketState({ searching: true, cacheDecision: {} }),
  );
  reject(result);
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
