import assert from "node:assert/strict";
import test from "node:test";
import { contextHudChips, contextHudShowBack } from "../web/src/context-hud-chips.js";
import type { TerminalFrameState } from "../web/src/mobile-controls.js";

const ids = (state?: TerminalFrameState) => contextHudChips(state).map((chip) => chip.id);

test("ticker exposes brief, why, watch, and refresh", () => {
  assert.deepEqual(ids({ mode: "ticker", screen: "QUOTE" }), ["brief", "why", "watch", "refresh"]);
  // Watch label flips with the watched flag.
  const watched = contextHudChips({ mode: "ticker", screen: "QUOTE", watched: true });
  assert.equal(watched.find((chip) => chip.id === "watch")?.label, "★ Unwatch");
});

test("wide ticker full views expose a Split restore control", () => {
  for (const tickerLayout of ["quote", "research"] as const) {
    const split = contextHudChips({
      mode: "ticker",
      screen: tickerLayout.toUpperCase(),
      tickerLayout,
      tickerSplitAvailable: true,
    }).find((chip) => chip.id === "split");
    assert.deepEqual(split, {
      id: "split",
      label: "▦ Split",
      input: "\t",
      tone: "accent",
    });
  }
  assert.equal(
    contextHudChips({
      mode: "ticker",
      screen: "SPLIT",
      tickerLayout: "split",
      tickerSplitAvailable: true,
    }).some((chip) => chip.id === "split"),
    false,
  );
  assert.equal(
    contextHudChips({
      mode: "ticker",
      screen: "QUOTE",
      tickerLayout: "quote",
      tickerSplitAvailable: false,
    }).some((chip) => chip.id === "split"),
    false,
  );
});

test("Quote exposes existing-arrow ticker cycling for an originating source list", () => {
  const chips = contextHudChips({
    mode: "ticker",
    screen: "QUOTE",
    tickerLayout: "quote",
    tickerNavigation: { source: "watch", index: 1, count: 3 },
  });
  assert.deepEqual(
    chips.filter((chip) => chip.id === "previous-ticker" || chip.id === "next-ticker"),
    [
      { id: "previous-ticker", label: "‹ Watch", input: "\x1b[A" },
      { id: "next-ticker", label: "Watch ›", input: "\x1b[B" },
    ],
  );
  assert.equal(
    contextHudChips({
      mode: "ticker",
      screen: "SPLIT",
      tickerLayout: "split",
      tickerNavigation: { source: "movers", index: 1, count: 3 },
    }).some((chip) => chip.id === "next-ticker"),
    false,
  );
});

test("research and wide ticker split expose archive navigation", () => {
  assert.deepEqual(ids({ mode: "ticker", screen: "RESEARCH" }), [
    "brief",
    "why",
    "older",
    "watch",
    "refresh",
  ]);
  assert.deepEqual(ids({
    mode: "ticker",
    screen: "SPLIT",
    tickerLayout: "split",
    archive: { position: 0, count: 3 },
  }), ["brief", "why", "older", "newer", "watch", "refresh"]);
});

test("MARKET / MOVERS / WATCH expose Open + Refresh", () => {
  for (const screen of ["MARKET", "MOVERS", "WATCH"]) {
    assert.deepEqual(ids({ mode: "market", screen }), ["open", "refresh"]);
  }
});

test("SIGNALS and EVENTS expose a pane toggle plus relevant research actions", () => {
  assert.deepEqual(ids({ mode: "market", screen: "SIGNALS", signalsFocus: "headlines" }), [
    "pane",
    "brief",
    "why",
    "older",
    "refresh",
  ]);
  assert.deepEqual(ids({ mode: "market", screen: "EVENTS", eventsFocus: "lanes" }), [
    "pane",
    "brief",
    "why",
    "refresh",
  ]);
  // The pane chip relabels to return to the list once the brief pane is focused.
  assert.equal(
    contextHudChips({ mode: "market", screen: "SIGNALS", signalsFocus: "story" }).find((chip) => chip.id === "pane")?.label,
    "◂ List",
  );
});

test("running research prepends a Cancel chip on every screen", () => {
  const research = { active: true, label: "RUNNING", text: "x", tone: "active" } as const;
  assert.equal(
    contextHudChips({ mode: "market", screen: "SIGNALS", signalsFocus: "headlines" }, research)[0]?.id,
    "cancel",
  );
});

test("the cache decision is screen-agnostic: SIGNALS and EVENTS surface Use/Refresh/Cancel only", () => {
  // The cache prompt must appear on SIGNALS / EVENTS research, not just tickers.
  for (const screen of ["SIGNALS", "EVENTS", "MARKET", "MOVERS", "WATCH"]) {
    const state = { mode: "market", screen, cacheDecision: { symbol: "MARKET" } } as TerminalFrameState;
    const chips = contextHudChips(state);
    assert.deepEqual(
      chips.map((chip) => chip.id),
      ["use", "refresh-cache", "cancel-cache"],
      `${screen} cache decision must surface Use/Refresh/Cancel and nothing else`,
    );
    assert.equal(chips.find((chip) => chip.id === "use")?.input, "u");
    assert.equal(chips.find((chip) => chip.id === "refresh-cache")?.input, "f");
    assert.equal(chips.find((chip) => chip.id === "cancel-cache")?.input, "\x1b");
  }

  // Same on a ticker, and it overrides the normal ticker chip set.
  assert.deepEqual(
    contextHudChips({ mode: "ticker", screen: "QUOTE", cacheDecision: { symbol: "AAPL" } } as TerminalFrameState).map((chip) => chip.id),
    ["use", "refresh-cache", "cancel-cache"],
  );
});

test("the cache decision suppresses Back even in a ticker", () => {
  assert.equal(contextHudShowBack({ mode: "ticker", screen: "QUOTE" }), true);
  assert.equal(
    contextHudShowBack({ mode: "ticker", screen: "QUOTE", cacheDecision: { symbol: "AAPL" } } as TerminalFrameState),
    false,
  );
});

test("symbol search exposes no chips (the search sheet owns the keyboard)", () => {
  assert.deepEqual(ids({ mode: "market", screen: "MARKET", searching: true }), []);
});
