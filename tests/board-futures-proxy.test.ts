import assert from "node:assert/strict";
import test from "node:test";
import {
  FUTURES_BOARD_SYMBOL,
  US_INDEX_FUTURES_PROXY,
  boardScoreboard,
  configureMarketTerminalRuntime,
  deriveUniverseSession,
  fetchMarketSnapshot,
  resetMarketTerminalRuntime,
  resolveBoardQuote,
} from "../.pi/extensions/market-terminal.js";
import { parseChartPayloadToQuote } from "../shared/kernel/quotes.js";
import type { KernelPorts } from "../shared/kernel/ports.js";
import { normalizeWatchlistSymbol } from "../shared/watchlist-symbols.js";

function quote(symbol: string, marketState: string, extra: Record<string, unknown> = {}) {
  return {
    symbol,
    name: symbol,
    exchange: "X",
    currency: "USD",
    price: 100,
    change: 1,
    changePercent: 1,
    previousClose: 99,
    dayLow: 98,
    dayHigh: 101,
    volume: 1_000_000,
    preMarketVolume: null,
    postMarketVolume: null,
    marketState,
    updatedAt: Date.now(),
    points: [99, 100],
    pointTimes: [],
    pointSessions: [],
    timezone: "America/New_York",
    interval: "5m",
    source: "fixture",
    chartScope: "day",
    ...extra,
  } as Parameters<typeof deriveUniverseSession>[0][number];
}

test("index futures cover the US board", () => {
  assert.deepEqual(US_INDEX_FUTURES_PROXY, { "^GSPC": "ES=F", "^IXIC": "NQ=F", "^DJI": "YM=F" });
});

test("deriveUniverseSession ignores stale board bars and follows the stock universe", () => {
  // Pre-market: stocks trade PRE while indices still print Friday REGULAR bars.
  const quotes = [
    quote("^GSPC", "REGULAR"),
    quote("^IXIC", "REGULAR"),
    quote("BTC-USD", "REGULAR"),
    quote("AAPL", "PRE"),
    quote("NVDA", "PRE"),
    quote("MSFT", "PRE"),
  ];
  assert.equal(deriveUniverseSession(quotes), "PRE");
});

test("deriveUniverseSession reports POST and REGULAR steady states", () => {
  assert.equal(
    deriveUniverseSession([quote("^GSPC", "REGULAR"), quote("AAPL", "POST"), quote("NVDA", "POST")]),
    "POST",
  );
  assert.equal(
    deriveUniverseSession([quote("^GSPC", "REGULAR"), quote("AAPL", "REGULAR")]),
    "REGULAR",
  );
});

test("deriveUniverseSession needs corroboration: a lone straggler never flips the universe", () => {
  const quotes = [
    quote("^GSPC", "REGULAR"),
    quote("HALTED", "PRE"),
    quote("AAPL", "REGULAR"),
    quote("NVDA", "REGULAR"),
    quote("MSFT", "REGULAR"),
    quote("TSLA", "REGULAR"),
  ];
  assert.equal(deriveUniverseSession(quotes), "REGULAR");
});

test("deriveUniverseSession breaks PRE/POST ties toward POST", () => {
  const quotes = [
    quote("AAPL", "PRE"),
    quote("NVDA", "PRE"),
    quote("MSFT", "POST"),
    quote("TSLA", "POST"),
  ];
  assert.equal(deriveUniverseSession(quotes), "POST");
});

test("resolveBoardQuote substitutes futures in PRE and keeps indices in REGULAR", () => {
  const pre = [
    quote("^GSPC", "REGULAR"),
    quote("ES=F", "REGULAR", { price: 7722, changePercent: -0.4 }),
    quote("AAPL", "PRE"),
  ];
  const resolved = resolveBoardQuote("^GSPC", pre, "PRE");
  assert.equal(resolved.quote?.symbol, "ES=F");
  assert.equal(resolved.proxied, true);

  const regular = resolveBoardQuote("^GSPC", pre, "REGULAR");
  assert.equal(regular.quote?.symbol, "^GSPC");
  assert.equal(regular.proxied, false);
});

test("resolveBoardQuote flags a missing proxy STALE instead of passing Friday off as live", () => {
  const noFutures = [quote("^GSPC", "REGULAR"), quote("AAPL", "PRE"), quote("NVDA", "PRE")];
  const fallback = resolveBoardQuote("^GSPC", noFutures, "PRE");
  assert.equal(fallback.quote?.symbol, "^GSPC");
  assert.equal(fallback.proxied, false);
  assert.equal(fallback.proxyMissing, true);
});

test("resolveBoardQuote keeps a feed-capable index authoritative", () => {
  const capable = [quote("^GSPC", "PRE", { hasPrePostMarketData: true }), quote("ES=F", "REGULAR")];
  const kept = resolveBoardQuote("^GSPC", capable, "PRE");
  assert.equal(kept.quote?.symbol, "^GSPC");
  assert.equal(kept.proxied, false);
  assert.equal(kept.proxyMissing, false);
});

test("boardScoreboard matches the TUI: futures-labeled in PRE, stale-marked without proxy", () => {
  const pre = [
    quote("^GSPC", "REGULAR", { changePercent: 0 }),
    quote("ES=F", "REGULAR", { changePercent: -0.42 }),
    quote("AAPL", "PRE"),
    quote("NVDA", "PRE"),
  ];
  const board = boardScoreboard(pre, "PRE");
  assert.match(board, /S&P 500 \(ES=F fut\): -0\.42%/);

  const missing = [quote("^GSPC", "REGULAR", { changePercent: 0 }), quote("AAPL", "PRE"), quote("NVDA", "PRE")];
  assert.match(boardScoreboard(missing, "PRE"), /S&P 500 \(stale\): \+0\.00%/);
});

test("futures map back to their board index at action boundaries (E never watches ES=F)", () => {
  assert.equal(FUTURES_BOARD_SYMBOL["ES=F"], "^GSPC");
  assert.equal(FUTURES_BOARD_SYMBOL["NQ=F"], "^IXIC");
  assert.equal(FUTURES_BOARD_SYMBOL["YM=F"], "^DJI");
});

test("resolveBoardQuote leaves Asia and crypto rows untouched", () => {
  const quotes = [quote("^N225", "REGULAR"), quote("BTC-USD", "REGULAR"), quote("AAPL", "PRE")];
  assert.equal(resolveBoardQuote("^N225", quotes, "PRE").quote?.symbol, "^N225");
  assert.equal(resolveBoardQuote("BTC-USD", quotes, "PRE").quote?.symbol, "BTC-USD");
  assert.equal(resolveBoardQuote("^N225", quotes, "PRE").proxied, false);
});

function chartPayload(hasPrePostMarketData?: boolean) {
  return {
    chart: {
      result: [{
        meta: {
          symbol: "^GSPC",
          currency: "USD",
          shortName: "S&P 500",
          fullExchangeName: "SNP",
          exchangeTimezoneName: "America/New_York",
          dataGranularity: "5m",
          regularMarketPrice: 7718,
          regularMarketVolume: 1000,
          regularMarketTime: 1788553986,
          previousClose: 7747,
          chartPreviousClose: 7747,
          ...(hasPrePostMarketData === undefined ? {} : { hasPrePostMarketData }),
          currentTradingPeriod: {
            pre: { start: 1788508800, end: 1788528600 },
            regular: { start: 1788528600, end: 1788552000 },
            post: { start: 1788552000, end: 1788566400 },
          },
        },
        timestamp: [1788528600, 1788528900],
        indicators: { quote: [{ close: [7710, 7718], volume: [10, 12] }] },
      }],
    },
  };
}

test("parseChartPayloadToQuote plumbs hasPrePostMarketData (indices false, ETFs true)", () => {
  const index = parseChartPayloadToQuote("^GSPC", chartPayload(false), {
    yahooInterval: "5m",
    includePrePost: true,
    chartScope: "day",
  });
  assert.equal(index.hasPrePostMarketData, false);
  const etf = parseChartPayloadToQuote("SPY", chartPayload(true), {
    yahooInterval: "5m",
    includePrePost: true,
    chartScope: "day",
  });
  assert.equal(etf.hasPrePostMarketData, true);
  const legacy = parseChartPayloadToQuote("^GSPC", chartPayload(undefined), {
    yahooInterval: "5m",
    includePrePost: true,
    chartScope: "day",
  });
  assert.equal(legacy.hasPrePostMarketData, false);
});

test("futures symbols validate as fetchable watchlist symbols", () => {
  assert.equal(normalizeWatchlistSymbol("ES=F"), "ES=F");
  assert.equal(normalizeWatchlistSymbol("nq=f"), "NQ=F");
  assert.equal(normalizeWatchlistSymbol("BTC/USD"), undefined);
});

/**
 * Two-phase fetchMarketSnapshot integration (fake transport, stubbed Pi).
 * Covers the advisor-flagged chain: session → futures leg → append →
 * requested accounting → movers exclusion → honest STALE on total failure.
 */
const BOARD_LIKE = new Set([...Object.keys(US_INDEX_FUTURES_PROXY), ...Object.values(US_INDEX_FUTURES_PROXY)]);

function snapshotTransport(
  fetched: string[],
  session: "PRE" | "REGULAR",
  failFutures = false,
): KernelPorts {
  return {
    clock: { now: () => Date.now() },
    storage: {
      resolveDataPath: (relative) => relative,
      readJsonFile: async () => undefined,
      writeJsonFileAtomic: async () => {},
    },
    transport: {
      fetchQuote: async (symbol: string) => {
        fetched.push(symbol);
        if (failFutures && BOARD_LIKE.has(symbol) && symbol.includes("=")) throw new Error("upstream 429");
        const state = BOARD_LIKE.has(symbol) ? "REGULAR" : session;
        return {
          symbol,
          name: symbol,
          exchange: "X",
          currency: "USD",
          price: 100,
          change: 1,
          changePercent: symbol.includes("=") ? -0.42 : 1.5,
          previousClose: 99,
          dayLow: 98,
          dayHigh: 101,
          volume: 1_000_000,
          preMarketVolume: null,
          postMarketVolume: null,
          marketState: state,
          updatedAt: Date.now(),
          points: [99, 100],
          pointTimes: [],
          pointSessions: [],
          timezone: "America/New_York",
          interval: "5m",
          source: "fixture",
          chartScope: "day",
        };
      },
      fetchCryptoPulse: async () => ({ snapshot: {} as never, errors: [] }),
      resolveCryptoPair: async () => null,
      unbrowserEndpoint: () => undefined,
    } as KernelPorts["transport"],
    events: { notify: () => {} },
  };
}

const stubPi = {
  exec: async () => ({ code: 0, stdout: "{}", stderr: "" }),
} as never;

test("fetchMarketSnapshot pulls futures in PRE and keeps them out of movers", async () => {
  const fetched: string[] = [];
  configureMarketTerminalRuntime(snapshotTransport(fetched, "PRE"));
  try {
    const snapshot = await fetchMarketSnapshot(stubPi, "day");
    for (const future of Object.values(US_INDEX_FUTURES_PROXY)) {
      assert.ok(fetched.includes(future), `${future} fetched`);
      assert.ok(snapshot.quotes.some((q) => q.symbol === future), `${future} appended`);
    }
    // Requested counts the leg that arrived (base universe + 3 futures).
    assert.equal(snapshot.requested, new Set(fetched).size);
    assert.equal(snapshot.requested, snapshot.quotes.length);
    // Futures never rank as movers.
    assert.ok(snapshot.movers.every((m) => !Object.values(US_INDEX_FUTURES_PROXY).includes(m.quote.symbol)));
    // Screen and MCP agree: futures-labeled scoreboard.
    assert.match(boardScoreboard(snapshot.quotes), /\(ES=F fut\)/);
  } finally {
    resetMarketTerminalRuntime();
  }
});

test("fetchMarketSnapshot skips the futures leg in REGULAR (zero extra cost)", async () => {
  const fetched: string[] = [];
  configureMarketTerminalRuntime(snapshotTransport(fetched, "REGULAR"));
  try {
    const snapshot = await fetchMarketSnapshot(stubPi, "day");
    for (const future of Object.values(US_INDEX_FUTURES_PROXY)) {
      assert.ok(!fetched.includes(future), `${future} not fetched`);
    }
    assert.equal(snapshot.requested, new Set(fetched).size);
  } finally {
    resetMarketTerminalRuntime();
  }
});

test("a failed futures leg stays honest: rows resolve STALE, universe intact", async () => {
  const fetched: string[] = [];
  configureMarketTerminalRuntime(snapshotTransport(fetched, "PRE", true));
  try {
    const snapshot = await fetchMarketSnapshot(stubPi, "day");
    assert.ok(!snapshot.quotes.some((q) => q.symbol === "ES=F"));
    const session = deriveUniverseSession(snapshot.quotes);
    assert.equal(session, "PRE");
    const resolution = resolveBoardQuote("^GSPC", snapshot.quotes, session);
    assert.equal(resolution.proxied, false);
    assert.equal(resolution.proxyMissing, true);
    assert.match(boardScoreboard(snapshot.quotes, session), /S&P 500 \(stale\)/);
  } finally {
    resetMarketTerminalRuntime();
  }
});

/** fetchTechnicalQuote: TA basis follows the live feed, identity stays put. */
function technicalTransport(fetched: string[], behavior: (symbol: string) => { state: string; capable: boolean; points: number[] } | null): KernelPorts {
  return {
    clock: { now: () => Date.now() },
    storage: {
      resolveDataPath: (relative) => relative,
      readJsonFile: async () => undefined,
      writeJsonFileAtomic: async () => {},
    },
    transport: {
      fetchQuote: async (symbol: string) => {
        fetched.push(symbol);
        const spec = behavior(symbol);
        if (!spec) throw new Error(`upstream 404 for ${symbol}`);
        return {
          symbol,
          name: symbol,
          exchange: "X",
          currency: "USD",
          price: 100,
          change: 1,
          changePercent: 1,
          previousClose: 99,
          dayLow: 98,
          dayHigh: 101,
          volume: 1_000_000,
          preMarketVolume: null,
          postMarketVolume: null,
          marketState: spec.state,
          updatedAt: Date.now(),
          points: spec.points,
          pointTimes: [],
          pointSessions: [],
          timezone: "America/New_York",
          interval: "5m",
          source: "fixture",
          chartScope: "day",
          hasPrePostMarketData: spec.capable,
        };
      },
      fetchCryptoPulse: async () => ({ snapshot: {} as never, errors: [] }),
      resolveCryptoPair: async () => null,
      unbrowserEndpoint: () => undefined,
    } as KernelPorts["transport"],
    events: { notify: () => {} },
  };
}

test("fetchTechnicalQuote scores stale indices on the annotated futures proxy", async () => {
  const { fetchTechnicalQuote } = await import("../.pi/extensions/market-terminal.js");
  const fetched: string[] = [];
  configureMarketTerminalRuntime(technicalTransport(fetched, (symbol) =>
    symbol === "^GSPC"
      ? { state: "REGULAR", capable: false, points: [7700, 7718] }
      : { state: "REGULAR", capable: false, points: [7700, 7710, 7722] },
  ));
  try {
    const { quote, taProxySymbol } = await fetchTechnicalQuote("^GSPC", "day");
    assert.equal(quote.symbol, "ES=F");
    assert.equal(taProxySymbol, "ES=F");
    assert.deepEqual(fetched.sort(), ["ES=F", "^GSPC"]);
  } finally {
    resetMarketTerminalRuntime();
  }
});

test("fetchTechnicalQuote keeps feed-capable indices and non-day scopes on a single fetch", async () => {
  const { fetchTechnicalQuote } = await import("../.pi/extensions/market-terminal.js");
  const fetched: string[] = [];
  configureMarketTerminalRuntime(technicalTransport(fetched, (symbol) =>
    symbol === "^GSPC"
      ? { state: "PRE", capable: true, points: [7700, 7718] }
      : { state: "REGULAR", capable: false, points: [1, 2] },
  ));
  try {
    const direct = await fetchTechnicalQuote("^GSPC", "day");
    assert.equal(direct.quote.symbol, "^GSPC");
    assert.equal(direct.taProxySymbol, undefined);
    fetched.length = 0;
    const weekly = await fetchTechnicalQuote("^GSPC", "week");
    assert.equal(weekly.quote.symbol, "^GSPC");
    assert.deepEqual(fetched, ["^GSPC"]);
    fetched.length = 0;
    const stock = await fetchTechnicalQuote("AAPL", "day");
    assert.equal(stock.quote.symbol, "AAPL");
    assert.deepEqual(fetched, ["AAPL"]);
  } finally {
    resetMarketTerminalRuntime();
  }
});

test("fetchTechnicalQuote falls back to the index when the proxy is unchartable, and throws when both legs fail", async () => {
  const { fetchTechnicalQuote } = await import("../.pi/extensions/market-terminal.js");
  const fetched: string[] = [];
  configureMarketTerminalRuntime(technicalTransport(fetched, (symbol) =>
    symbol === "^GSPC"
      ? { state: "REGULAR", capable: false, points: [7700, 7718] }
      : { state: "REGULAR", capable: false, points: [7722] },
  ));
  try {
    const fallback = await fetchTechnicalQuote("^GSPC", "day");
    assert.equal(fallback.quote.symbol, "^GSPC");
    assert.equal(fallback.taProxySymbol, undefined);
  } finally {
    resetMarketTerminalRuntime();
  }
  configureMarketTerminalRuntime(technicalTransport(fetched, () => null));
  try {
    await assert.rejects(() => fetchTechnicalQuote("^GSPC", "day"), /quote request failed for \^GSPC/);
  } finally {
    resetMarketTerminalRuntime();
  }
});
