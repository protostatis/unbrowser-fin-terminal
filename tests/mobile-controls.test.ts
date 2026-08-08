import assert from "node:assert/strict";
import test from "node:test";
import {
  activeResearchStatus,
  horizontalSwipeInput,
  isValidSymbolInput,
  mobileActions,
  normalizeSymbolInput,
  recentResearchStatuses,
  researchActivityStatus,
  symbolSearchInputs,
  TERMINAL_INPUTS,
  verticalSwipeScroll,
} from "../web/src/mobile-controls.js";

test("mobile actions adapt to market, ticker, research, and cache states", () => {
  const market = mobileActions({ mode: "market" });
  assert.equal(market[0]?.id, "help");
  assert.equal(market.find((action) => action.id === "why")?.input, "k");
  assert.equal(market.some((action) => action.id === "brief"), false);
  assert.equal(market.length, 5);
  assert.equal(market.at(-1)?.id, "search");

  const signals = mobileActions({ mode: "market", screen: "SIGNALS" });
  assert.equal(signals[0]?.id, "pane");
  assert.equal(signals.find((action) => action.id === "older")?.input, "[");

  const ticker = mobileActions({ mode: "ticker", watched: true });
  assert.equal(ticker[0]?.id, "back");
  assert.equal(ticker.find((action) => action.id === "watch")?.label, "Unwatch");

  const archivedTicker = mobileActions({
    mode: "ticker",
    screen: "RESEARCH",
    archive: { position: 1, count: 3 },
  });
  assert.deepEqual(archivedTicker.map((action) => action.id), [
    "back",
    "why",
    "older",
    "newer",
    "sync",
    "search",
  ]);
  assert.equal(archivedTicker.find((action) => action.id === "older")?.disabled, false);

  const researching = mobileActions({
    mode: "market",
    research: { active: true },
  });
  assert.equal(
    researching.find((action) => action.id === "cancel-research")?.input,
    "c",
  );

  const cache = mobileActions({ mode: "ticker", cacheDecision: {} });
  assert.deepEqual(cache.map((action) => action.id), [
    "use-cache",
    "refresh-cache",
    "cancel-cache",
  ]);
});

test("mobile symbol entry normalizes valid stock, index, and crypto symbols", () => {
  assert.equal(normalizeSymbolInput(" btc-usd "), "BTC-USD");
  assert.equal(normalizeSymbolInput("^gspc!"), "^GSPC");
  assert.equal(isValidSymbolInput("AAPL"), true);
  assert.equal(isValidSymbolInput("^GSPC"), true);
  assert.equal(isValidSymbolInput("BTC-USD"), true);
  assert.equal(isValidSymbolInput("123"), false);
  assert.deepEqual(symbolSearchInputs("btc-usd"), [
    "/",
    "B",
    "T",
    "C",
    "-",
    "U",
    "S",
    "D",
    TERMINAL_INPUTS.enter,
  ]);
  assert.deepEqual(symbolSearchInputs(""), []);
});

test("only deliberate horizontal swipes change terminal screens", () => {
  const start = { x: 200, y: 100, at: 1000 };
  assert.equal(
    horizontalSwipeInput(start, { x: 120, y: 105, at: 1250 }),
    TERMINAL_INPUTS.right,
  );
  assert.equal(
    horizontalSwipeInput(start, { x: 280, y: 95, at: 1250 }),
    TERMINAL_INPUTS.left,
  );
  assert.equal(horizontalSwipeInput(start, { x: 175, y: 104, at: 1200 }), null);
  assert.equal(horizontalSwipeInput(start, { x: 120, y: 190, at: 1200 }), null);
  assert.equal(horizontalSwipeInput(start, { x: 100, y: 100, at: 2100 }), null);
});

test("research status names the active source-search and evidence phases", () => {
  assert.equal(
    activeResearchStatus({
      research: { active: true, symbol: "NVDA", phase: "running", activity: "seeding" },
    }),
    "RESEARCH NVDA · SEARCHING SOURCES",
  );
  assert.equal(
    activeResearchStatus({
      researchQueue: [{ symbol: "AAPL", phase: "running", activity: "extracting" }],
    }),
    "RESEARCH AAPL · EXTRACTING EVIDENCE",
  );
  assert.equal(
    activeResearchStatus({
      researchQueue: [{ symbol: "MSFT", phase: "cancelling", outcome: "cancelled" }],
    }),
    "RESEARCH MSFT · CANCELLING",
  );
  assert.equal(
    activeResearchStatus({
      researchQueue: [
        { symbol: "MSFT", phase: "cancelling", outcome: "cancelled" },
        { symbol: "AAPL", phase: "running", activity: "extracting" },
      ],
    }),
    "RESEARCH AAPL · EXTRACTING EVIDENCE",
  );
  assert.equal(activeResearchStatus({}), undefined);
});

test("research activity status exposes a visible active phase and buffers settled outcomes", () => {
  assert.deepEqual(
    researchActivityStatus({
      research: { id: "job-active", active: true, symbol: "NVDA", phase: "running", activity: "extracting" },
    }),
    {
      id: "job-active",
      contextLabel: undefined,
      symbol: "NVDA",
      label: "EXTRACTING EVIDENCE",
      text: "RESEARCH NVDA · EXTRACTING EVIDENCE",
      tone: "active",
      active: true,
    },
  );
  assert.deepEqual(
    recentResearchStatuses({
      recentResearch: [
        { id: "job-complete", contextLabel: "REUTERS HEADLINE", symbol: "MARKET", phase: "settled", outcome: "complete" },
        { id: "job-failed", contextLabel: "AAPL BRIEF", symbol: "AAPL", phase: "settled", outcome: "failed" },
      ],
    }),
    [
      {
        id: "job-complete",
        contextLabel: "REUTERS HEADLINE",
        symbol: "MARKET",
        label: "RESULTS READY",
        text: "RESEARCH REUTERS HEADLINE · RESULTS READY",
        tone: "complete",
        active: false,
      },
      {
        id: "job-failed",
        contextLabel: "AAPL BRIEF",
        symbol: "AAPL",
        label: "RESEARCH FAILED",
        text: "RESEARCH AAPL BRIEF · RESEARCH FAILED",
        tone: "failed",
        active: false,
      },
    ],
  );
});

test("vertical touch drags map to bounded terminal scroll actions", () => {
  const start = { x: 200, y: 300, at: 1000 };
  assert.deepEqual(
    verticalSwipeScroll(start, { x: 205, y: 180, at: 1200 }),
    { direction: "down", amount: 2 },
  );
  assert.deepEqual(
    verticalSwipeScroll(start, { x: 195, y: 420, at: 1200 }),
    { direction: "up", amount: 2 },
  );
  assert.equal(verticalSwipeScroll(start, { x: 280, y: 290, at: 1200 }), null);
  assert.equal(verticalSwipeScroll(start, { x: 202, y: 260, at: 1200 }), null);
});
