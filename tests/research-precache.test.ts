import assert from "node:assert/strict";
import test from "node:test";
import {
  appendMoverPrecacheRequests,
  buildResearchPrecachePlan,
  isResearchFreshToDate,
  precacheWarmCapacity,
  readPrecacheTickers,
  type PrecacheResearchRequest,
  type ResearchPrecachePlanOptions,
} from "../.pi/extensions/market-terminal.js";

const noFresh = () => false;
const allFresh = () => true;

function plan(options: Partial<ResearchPrecachePlanOptions> & { isFresh?: (s: string, k: string) => boolean }): PrecacheResearchRequest[] {
  return buildResearchPrecachePlan({
    tickers: options.tickers ?? ["AAPL", "MSFT", "NVDA"],
    maxJobs: options.maxJobs,
    includeMarketStory: options.includeMarketStory,
    isFresh: options.isFresh ?? noFresh,
  });
}

function symbolOf(item: PrecacheResearchRequest): string {
  return item.symbol;
}

test("isResearchFreshToDate treats only the current UTC calendar date as fresh", () => {
  const now = Date.UTC(2026, 7, 6, 15, 30, 0); // Aug 6 2026 15:30 UTC
  assert.equal(isResearchFreshToDate(Date.UTC(2026, 7, 6, 0, 0, 1), now), true);
  assert.equal(isResearchFreshToDate(Date.UTC(2026, 7, 6, 23, 59, 59), now), true);
  assert.equal(isResearchFreshToDate(Date.UTC(2026, 7, 5, 23, 59, 59), now), false, "yesterday is stale");
  assert.equal(isResearchFreshToDate(Date.UTC(2026, 7, 7, 0, 0, 0), now), false, "tomorrow is not yet usable");
  assert.equal(isResearchFreshToDate(now, now), true);
});

test("isResearchFreshToDate is calendar-date based across month and year boundaries", () => {
  // Jun 30 23:59 UTC vs Jul 1 00:01 UTC — one minute apart, different dates.
  assert.equal(
    isResearchFreshToDate(Date.UTC(2026, 5, 30, 23, 59, 0), Date.UTC(2026, 6, 1, 0, 1, 0)),
    false,
  );
  // Dec 31 2025 vs Jan 1 2026.
  assert.equal(
    isResearchFreshToDate(Date.UTC(2025, 11, 31, 20, 0, 0), Date.UTC(2026, 0, 1, 1, 0, 0)),
    false,
  );
  // Leap day Feb 29 stays fresh through the same date.
  assert.equal(
    isResearchFreshToDate(Date.UTC(2028, 1, 29, 8, 0, 0), Date.UTC(2028, 1, 29, 18, 0, 0)),
    true,
  );
});

test("buildResearchPrecachePlan puts the Market Story BRIEF first, then ticker BRIEFs", () => {
  const items = plan({});
  assert.equal(items.length, 4); // story + 3 tickers
  assert.equal(items[0]!.symbol, "MARKET");
  assert.equal(items[0]!.researchKey, "v1/market/story/brief");
  assert.equal(items[0]!.intent, "brief");
  assert.equal(items[0]!.contextLabel, "MARKET STORY BRIEF");
  assert.deepEqual(items.slice(1).map(symbolOf), ["AAPL", "MSFT", "NVDA"]);
  for (const ticker of items.slice(1)) {
    assert.equal(ticker.researchKey, "v1/ticker/brief");
    assert.equal(ticker.intent, "brief");
    assert.equal(ticker.chartScope, "day");
  }
});

test("buildResearchPrecachePlan uses the exact J-key questions so cached results satisfy live requests", () => {
  const items = plan({});
  assert.equal(
    items[0]!.question,
    "Build a source-verified factual market brief: current leadership, cross-asset moves, consequential developments, verified upcoming catalysts, and explicit unknowns.",
  );
  assert.equal(
    items[1]!.question,
    "Build a source-verified factual brief of the latest company developments and catalysts: what happened, when, key reported numbers, upcoming verified dates, and explicit unknowns.",
  );
});

test("buildResearchPrecachePlan skips identities whose archive canvas is fresh", () => {
  const items = plan({ isFresh: (symbol) => symbol === "MARKET" || symbol === "AAPL" });
  assert.deepEqual(items.map(symbolOf), ["MSFT", "NVDA"]);
});

test("buildResearchPrecachePlan skips only the exact stale identity", () => {
  const items = plan({
    isFresh: (symbol, researchKey) => symbol !== "MSFT",
  });
  assert.deepEqual(items.map(symbolOf), ["MSFT"]);
});

test("buildResearchPrecachePlan returns an empty plan when everything is fresh", () => {
  assert.deepEqual(plan({ isFresh: allFresh }), []);
});

test("buildResearchPrecachePlan caps total jobs including the Market Story", () => {
  const items = plan({ maxJobs: 2 });
  assert.deepEqual(items.map(symbolOf), ["MARKET", "AAPL"]);
  const tickerOnly = plan({ includeMarketStory: false, maxJobs: 1 });
  assert.deepEqual(tickerOnly.map(symbolOf), ["AAPL"]);
});

test("buildResearchPrecachePlan normalizes, dedupes, and drops invalid tickers", () => {
  const items = plan({ tickers: [" aapl ", "AAPL", "not-a-ticker!", "msft"] });
  assert.deepEqual(items.slice(1).map(symbolOf), ["AAPL", "MSFT"]);
});

test("buildResearchPrecachePlan defaults to the default watchlist when no tickers are supplied", () => {
  const items = buildResearchPrecachePlan({ isFresh: noFresh });
  assert.deepEqual(items.slice(1).map(symbolOf), [
    "SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "TSLA", "JPM", "XLE", "TLT", "GLD", "BTC-USD",
  ]);
});

test("buildResearchPrecachePlan treats an empty override list as no tickers", () => {
  const items = plan({ tickers: [] });
  assert.deepEqual(items.map(symbolOf), ["MARKET"]);
});

test("buildResearchPrecachePlan treats an explicit zero cap as no pre-warming", () => {
  assert.deepEqual(plan({ maxJobs: 0 }), []);
});

test("precacheWarmCapacity keeps one worker slot reserved for interactive research", () => {
  assert.equal(precacheWarmCapacity(6, 6), 5, "default concurrency reserves one slot");
  assert.equal(precacheWarmCapacity(6, 2), 2, "a smaller cap wins");
  assert.equal(precacheWarmCapacity(3, 24), 2, "concurrency-1 is the binding constraint");
  assert.equal(precacheWarmCapacity(1, 6), 0, "a single worker disables pre-warming");
  assert.equal(precacheWarmCapacity(6, 0), 0);
  assert.equal(precacheWarmCapacity(0, 6), 0);
});

test("readPrecacheTickers falls back to the active watchlist when unset", () => {
  const previous = process.env.MARKET_PRECACHE_TICKERS;
  delete process.env.MARKET_PRECACHE_TICKERS;
  try {
    assert.deepEqual(readPrecacheTickers(["SPY", "AAPL"]), ["SPY", "AAPL"]);
    assert.deepEqual(readPrecacheTickers([]), []);
  } finally {
    if (previous === undefined) delete process.env.MARKET_PRECACHE_TICKERS;
    else process.env.MARKET_PRECACHE_TICKERS = previous;
  }
});

test("readPrecacheTickers parses, normalizes, and supports an explicit none", () => {
  const previous = process.env.MARKET_PRECACHE_TICKERS;
  try {
    process.env.MARKET_PRECACHE_TICKERS = " aapl ,NVDA, btc-usd ";
    assert.deepEqual(readPrecacheTickers(["SPY"]), ["AAPL", "NVDA", "BTC-USD"]);
    process.env.MARKET_PRECACHE_TICKERS = "none";
    assert.deepEqual(readPrecacheTickers(["SPY"]), [], "none keeps the Market Story only");
  } finally {
    if (previous === undefined) delete process.env.MARKET_PRECACHE_TICKERS;
    else process.env.MARKET_PRECACHE_TICKERS = previous;
  }
});

test("readPrecacheTickers rejects a non-empty list with no valid symbols", () => {
  const previous = process.env.MARKET_PRECACHE_TICKERS;
  try {
    process.env.MARKET_PRECACHE_TICKERS = "not-a-ticker!,$$$";
    assert.throws(() => readPrecacheTickers(["SPY"]), /MARKET_PRECACHE_TICKERS/);
  } finally {
    if (previous === undefined) delete process.env.MARKET_PRECACHE_TICKERS;
    else process.env.MARKET_PRECACHE_TICKERS = previous;
  }
});

test("re-planning after a partial warm run only rebuilds the still-stale identities", () => {
  // Simulate a bootstrap that dispatched [MARKET, AAPL, MSFT, NVDA] and then
  // was interrupted by a session transition; the story and AAPL completed and
  // archived before the reset, MSFT and NVDA did not.
  const completed = new Set(["MARKET", "AAPL"]);
  const first = plan({});
  assert.deepEqual(first.map(symbolOf), ["MARKET", "AAPL", "MSFT", "NVDA"]);
  const second = plan({ isFresh: (symbol) => completed.has(symbol) });
  assert.deepEqual(second.map(symbolOf), ["MSFT", "NVDA"], "fresh identities are not re-dispatched");
});

test("appendMoverPrecacheRequests appends the top movers in rank order after the base plan", () => {
  const base = buildResearchPrecachePlan({ tickers: ["AAPL"], isFresh: noFresh });
  const expanded = appendMoverPrecacheRequests(base, ["NVDA", "TSLA", "SMCI"], noFresh);
  assert.deepEqual(expanded.map(symbolOf), ["MARKET", "AAPL", "NVDA", "TSLA", "SMCI"]);
  for (const item of expanded.slice(2)) {
    assert.equal(item.researchKey, "v1/ticker/brief");
    assert.equal(item.intent, "brief");
  }
});

test("appendMoverPrecacheRequests caps at the top ten movers", () => {
  const movers = Array.from({ length: 15 }, (_, index) => `T${index + 1}`);
  const expanded = appendMoverPrecacheRequests([], movers, noFresh);
  assert.equal(expanded.length, 10);
});

test("appendMoverPrecacheRequests skips symbols already in the plan or already fresh", () => {
  const base = buildResearchPrecachePlan({ tickers: ["AAPL", "MSFT"], isFresh: noFresh });
  const expanded = appendMoverPrecacheRequests(
    base,
    ["MSFT", "NVDA", "GOOGL"],
    (symbol) => symbol === "GOOGL", // fresh mover, skip
  );
  assert.deepEqual(expanded.map(symbolOf), ["MARKET", "AAPL", "MSFT", "NVDA"]);
});

test("appendMoverPrecacheRequests drops invalid symbols and preserves the base plan", () => {
  const base = buildResearchPrecachePlan({ tickers: [], isFresh: noFresh });
  const expanded = appendMoverPrecacheRequests(base, ["not-a-ticker!", " btc-usd ", "$$$"], noFresh);
  assert.deepEqual(expanded.map(symbolOf), ["MARKET", "BTC-USD"]);
});
