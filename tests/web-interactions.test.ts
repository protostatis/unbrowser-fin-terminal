import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalFrameState } from "../web/src/mobile-controls.js";
import {
  arrowsMoveSelection,
  canUsePointerScroll,
  contextKeyHints,
  paneChoices,
  scrollControls,
  selectableItems,
  terminalActionContext,
} from "../web/src/web-interactions.js";

test("selectable items come from the market available list with selection state", () => {
  const items = selectableItems({
    mode: "market",
    screen: "MARKET",
    available: ["^GSPC", "^IXIC", "^DJI"],
    selectedIndex: 1,
  });
  assert.deepEqual(items, [
    { label: "^GSPC", index: 0, selected: false },
    { label: "^IXIC", index: 1, selected: true },
    { label: "^DJI", index: 2, selected: false },
  ]);
});

test("selectable items are empty unless market has an available list", () => {
  assert.deepEqual(selectableItems(), []);
  assert.deepEqual(selectableItems({ mode: "ticker", symbol: "AAPL" }), []);
  assert.deepEqual(selectableItems({ mode: "market", screen: "MOVERS" }), []);
});

test("selectable items are suppressed while cache or search locks the list", () => {
  const base = { mode: "market" as const, screen: "MARKET", available: ["AAPL"] };
  assert.deepEqual(selectableItems({ ...base, cacheDecision: {} }), []);
  assert.deepEqual(selectableItems({ ...base, searching: true }), []);
});

test("pane choices expose SIGNALS and EVENTS focus with the active pane", () => {
  assert.equal(paneChoices({ mode: "market", screen: "SIGNALS" })?.activePaneId, "headlines");
  const story = paneChoices({ mode: "market", screen: "SIGNALS", signalsFocus: "story" });
  assert.deepEqual(story?.panes, [
    { id: "headlines", label: "Headlines", selected: false },
    { id: "story", label: "Market Story", selected: true },
  ]);
  const briefing = paneChoices({ mode: "market", screen: "EVENTS", eventsFocus: "briefing" });
  assert.equal(briefing?.activePaneId, "briefing");
  assert.deepEqual(briefing?.panes.map((pane) => pane.id), ["lanes", "briefing"]);
});

test("pane choices are undefined for single-pane views", () => {
  assert.equal(paneChoices({ mode: "market", screen: "MOVERS" }), undefined);
  assert.equal(paneChoices({ mode: "ticker", screen: "QUOTE" }), undefined);
  assert.equal(paneChoices(), undefined);
});

test("ticker research scrolls its canvas only when one is displayed", () => {
  assert.deepEqual(scrollControls(), []);
  assert.deepEqual(scrollControls({ mode: "ticker", screen: "QUOTE", hasCanvas: true }), []);
  assert.deepEqual(scrollControls({ mode: "ticker", screen: "RESEARCH", hasCanvas: false }), []);
  assert.deepEqual(scrollControls({ mode: "ticker", screen: "RESEARCH", hasCanvas: true }), [
    { target: "canvas", scrollable: true },
  ]);
});

test("story and briefing scroll only when content exceeds the viewport", () => {
  const scrollableStory = scrollControls({
    mode: "market",
    screen: "SIGNALS",
    signalsFocus: "story",
    storyScroll: { offset: 3, rows: 20, viewportRows: 10 },
  });
  assert.deepEqual(scrollableStory, [
    { target: "story", scrollable: true, offset: 3, rows: 20, viewportRows: 10 },
  ]);

  const fittingStory = scrollControls({
    mode: "market",
    screen: "SIGNALS",
    signalsFocus: "story",
    storyScroll: { offset: 0, rows: 5, viewportRows: 10 },
  });
  assert.equal(fittingStory.length, 1);
  assert.equal(fittingStory[0]?.scrollable, false);

  const briefing = scrollControls({
    mode: "market",
    screen: "EVENTS",
    eventsFocus: "briefing",
    eventScroll: { offset: 0, rows: 12, viewportRows: 8 },
  });
  assert.equal(briefing[0]?.target, "briefing");
  assert.equal(briefing[0]?.scrollable, true);
});

test("no scroll controls for selection screens or story without canvas", () => {
  assert.deepEqual(scrollControls({ mode: "market", screen: "MARKET" }), []);
  assert.deepEqual(scrollControls({ mode: "market", screen: "SIGNALS", signalsFocus: "headlines" }), []);
  assert.deepEqual(
    scrollControls({ mode: "market", screen: "SIGNALS", signalsFocus: "story" }),
    [],
  );
});

test("arrows move selection on normal market lists, not story or briefing", () => {
  assert.equal(arrowsMoveSelection({ mode: "market", screen: "MARKET" }), true);
  assert.equal(arrowsMoveSelection({ mode: "market", screen: "MOVERS" }), true);
  assert.equal(arrowsMoveSelection({ mode: "market", screen: "WATCH" }), true);
  assert.equal(arrowsMoveSelection({ mode: "market", screen: "SIGNALS" }), true);
  assert.equal(arrowsMoveSelection({ mode: "market", screen: "SIGNALS", signalsFocus: "story" }), false);
  assert.equal(arrowsMoveSelection({ mode: "market", screen: "EVENTS", eventsFocus: "briefing" }), false);
  assert.equal(arrowsMoveSelection({ mode: "ticker", screen: "RESEARCH" }), false);
});

test("pointer scrolling is available only when a list or canvas can respond", () => {
  assert.equal(canUsePointerScroll(), false);
  assert.equal(canUsePointerScroll({ mode: "ticker", screen: "QUOTE" }), false);
  assert.equal(
    canUsePointerScroll({ mode: "ticker", screen: "RESEARCH", hasCanvas: true }),
    true,
  );
  assert.equal(canUsePointerScroll({ mode: "market", screen: "MOVERS" }), true);
  assert.equal(
    canUsePointerScroll({
      mode: "market",
      screen: "SIGNALS",
      signalsFocus: "story",
      storyScroll: { offset: 0, rows: 8, viewportRows: 8 },
    }),
    false,
  );
  assert.equal(
    canUsePointerScroll({
      mode: "market",
      screen: "SIGNALS",
      signalsFocus: "story",
      storyScroll: { offset: 0, rows: 9, viewportRows: 8 },
    }),
    true,
  );
  const storyView: TerminalFrameState = {
    mode: "market",
    screen: "SIGNALS",
    signalsFocus: "story",
    storyScroll: { offset: 0, rows: 8, viewportRows: 8 },
  };
  assert.equal(canUsePointerScroll(storyView, "headlines"), true);
  assert.equal(canUsePointerScroll(storyView, "story"), false);
  assert.equal(
    canUsePointerScroll(
      { ...storyView, storyScroll: { offset: 0, rows: 9, viewportRows: 8 } },
      "story",
    ),
    true,
  );
});

test("action context binds primary actions to the rendered selection and pane", () => {
  assert.deepEqual(
    terminalActionContext({
      mode: "market",
      screen: "SIGNALS",
      selectedIndex: 2,
      selected: "Oil supply concern",
      signalsFocus: "story",
    }),
    {
      mode: "market",
      screen: "SIGNALS",
      selectedIndex: 2,
      selected: "Oil supply concern",
      pane: "story",
    },
  );
  assert.deepEqual(
    terminalActionContext({ mode: "ticker", screen: "RESEARCH", symbol: "AAPL" }),
    { mode: "ticker", screen: "RESEARCH", symbol: "AAPL" },
  );
  assert.equal(terminalActionContext({ mode: "market", screen: "MARKET" }), undefined);
});

test("key hints foreground arrows, Enter, and Tab before J/K", () => {
  const hints = contextKeyHints({ mode: "market", screen: "SIGNALS" });
  const tones = hints.map((hint) => hint.tone);
  assert.deepEqual(tones, ["primary", "primary", "primary", "secondary", "why"]);
  assert.equal(hints[0]?.keys, "↑/↓");
  assert.equal(hints[1]?.keys, "Enter");
  assert.equal(hints[2]?.keys, "Tab");
  assert.equal(hints[2]?.input, "\t");
  assert.equal(hints[3]?.keys, "J");
  assert.equal(hints[4]?.keys, "K");
  assert.equal(hints[4]?.label, "Why");
});

test("key hints adapt navigation label and omit Tab on single-pane views", () => {
  const market = contextKeyHints({ mode: "market", screen: "MARKET", available: ["AAPL"] });
  assert.deepEqual(market.map((hint) => hint.keys), ["↑/↓", "Enter", "J", "K"]);
  assert.equal(market[0]?.label, "Select");
  assert.equal(market[1]?.label, "Open");

  const ticker = contextKeyHints({ mode: "ticker", screen: "RESEARCH", hasCanvas: true });
  assert.deepEqual(ticker.map((hint) => hint.keys), ["↑/↓", "Enter", "J", "K"]);
  assert.equal(ticker[0]?.label, "Scroll canvas");
  assert.equal(ticker[1]?.label, "Brief");
  assert.equal(ticker[2]?.label, "Brief");
});

test("key hints prefer scroll guidance when a story pane is scrollable", () => {
  const hints = contextKeyHints({
    mode: "market",
    screen: "SIGNALS",
    signalsFocus: "story",
    storyScroll: { offset: 0, rows: 20, viewportRows: 8 },
  });
  assert.equal(hints[0]?.label, "Scroll story");
  assert.equal(hints.some((hint) => hint.keys === "Tab"), true);
});

test("key hints are empty while the terminal is locked or searching", () => {
  assert.deepEqual(contextKeyHints(), []);
  assert.deepEqual(contextKeyHints({ mode: "market", screen: "MARKET", cacheDecision: {} }), []);
  assert.deepEqual(contextKeyHints({ mode: "market", screen: "MARKET", searching: true }), []);
});
