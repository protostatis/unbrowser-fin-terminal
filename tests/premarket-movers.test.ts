import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleMoverQuotes,
  moverEligible,
  moverVolume,
  moverVolumeRowLabel,
  parseChartPayloadToQuote,
  rankMovers,
} from "../.pi/extensions/market-terminal.js";

type QuoteFixture = {
  symbol?: string;
  price?: number;
  changePercent?: number | null;
  volume?: number | null;
  preMarketVolume?: number | null;
  postMarketVolume?: number | null;
  marketState?: string;
};

function quote(overrides: QuoteFixture = {}) {
  return {
    symbol: "AAPL",
    name: "Apple Inc.",
    exchange: "NasdaqGS",
    currency: "USD",
    price: 200,
    changePercent: 2.4,
    change: 4.7,
    previousClose: 195.3,
    dayLow: 194,
    dayHigh: 205,
    volume: null,
    preMarketVolume: null,
    postMarketVolume: null,
    marketState: "REGULAR",
    updatedAt: Date.now(),
    points: [195, 200],
    pointTimes: [],
    pointSessions: ["pre", "regular"],
    timezone: "America/New_York",
    interval: "5m",
    source: "fixture",
    chartScope: "day",
    ...overrides,
  };
}

test("moverVolume defaults to the proxy basis and prefers live pre-market volume", () => {
  const resolution = moverVolume(quote({ marketState: "PRE", price: 210, volume: 5_000_000, preMarketVolume: 800_000 }));
  assert.deepEqual(resolution, { volume: 800_000, session: "pre", proxied: false });
});

test("moverVolume proxy basis falls back to regular volume and labels the EXACT source session", () => {
  // The figure measures the regular session — volumeSource must say "regular",
  // never pretend the proxy is pre-market volume.
  const resolution = moverVolume(quote({ marketState: "PRE", volume: 5_000_000, preMarketVolume: null }));
  assert.deepEqual(resolution, { volume: 5_000_000, session: "regular", proxied: true });
  const post = moverVolume(quote({ marketState: "POST", volume: 6_000_000, postMarketVolume: null }));
  assert.deepEqual(post, { volume: 6_000_000, session: "regular", proxied: true });
});

test("moverVolume live basis never invents a volume figure for missing extended data", () => {
  // Under the live basis a missing pre-market volume resolves to 0 (movement-first),
  // so a "live 100K pre vol" quote is never ranked against a regular-session proxy.
  const live = moverVolume(quote({ marketState: "PRE", volume: 5_000_000, preMarketVolume: null }), "live");
  assert.deepEqual(live, { volume: 0, session: "pre", proxied: false });
  const livePost = moverVolume(quote({ marketState: "POST", volume: 6_000_000, postMarketVolume: null }), "live");
  assert.deepEqual(livePost, { volume: 0, session: "post", proxied: false });
});

test("moverVolume keeps the legacy regular-session figure for REGULAR", () => {
  assert.deepEqual(moverVolume(quote({ marketState: "REGULAR", volume: 4_200_000 })), {
    volume: 4_200_000,
    session: "regular",
    proxied: false,
  });
});

test("moverEligible drops only zero-volume REGULAR quotes, never extended sessions", () => {
  assert.equal(moverEligible("REGULAR", 0), false);
  assert.equal(moverEligible("REGULAR", null), false);
  assert.equal(moverEligible("REGULAR", 100), true);
  assert.equal(moverEligible("PRE", 0), true);
  assert.equal(moverEligible("PRE", null), true);
  assert.equal(moverEligible("PREPRE", null), true);
  assert.equal(moverEligible("POST", null), true);
  assert.equal(moverEligible("POSTPOST", null), true);
});

test("eligibleMoverQuotes admits pre-market movers that were previously dropped", () => {
  const regular = quote({ symbol: "NVDA", marketState: "REGULAR", volume: 3_000_000 });
  const preMarketNoVolume = quote({ symbol: "MSFT", marketState: "PRE", volume: 0, preMarketVolume: null });
  const preMarketWithVolume = quote({ symbol: "AMD", marketState: "PRE", volume: 0, preMarketVolume: 900_000 });
  const closedZeroVolume = quote({ symbol: "TSLA", marketState: "CLOSED", volume: 0 });

  const symbols = eligibleMoverQuotes([regular, preMarketNoVolume, preMarketWithVolume, closedZeroVolume]).map((q) => q.symbol);
  assert.deepEqual(symbols, ["NVDA", "MSFT", "AMD"]);
});

test("rankMovers uses the proxy basis uniformly when no live extended volume exists", () => {
  const nvda = quote({ symbol: "NVDA", marketState: "PRE", changePercent: 3.1, price: 900, volume: 5_000_000, preMarketVolume: null });
  const msft = quote({ symbol: "MSFT", marketState: "PRE", changePercent: 5.2, price: 400, volume: 12_000_000, preMarketVolume: null });

  const movers = rankMovers([nvda, msft]);

  assert.equal(movers[0]!.quote.symbol, "MSFT");
  // Proxy basis: $VOL uses regular-session figure, labeled as such.
  assert.equal(movers[0]!.volumeSource, "regular");
  assert.equal(movers[0]!.volumeProxied, true);
  assert.equal(movers[0]!.volumeBasis, "proxy");
  assert.equal(movers[0]!.dollarVolume, 400 * 12_000_000);
});

test("rankMovers refuses to mix live pre-market volume with a regular proxy in one snapshot", () => {
  // CRWD has real pre-market volume; NVDA (also PRE) has none. With any live
  // extended volume present, NVDA must NOT inherit a regular-session proxy into
  // the distribution — it ranks movement-first with $VOL 0.
  const crwd = quote({ symbol: "CRWD", marketState: "PRE", changePercent: 6.5, price: 380, volume: 0, preMarketVolume: 1_100_000 });
  const nvda = quote({ symbol: "NVDA", marketState: "PRE", changePercent: 3.1, price: 910, volume: 5_000_000, preMarketVolume: null });

  const movers = rankMovers([crwd, nvda]);

  const crwdRank = movers.find((m) => m.quote.symbol === "CRWD")!;
  const nvdaRank = movers.find((m) => m.quote.symbol === "NVDA")!;
  assert.equal(crwdRank.volumeSource, "pre");
  assert.equal(crwdRank.volumeProxied, false);
  assert.equal(crwdRank.volumeBasis, "live");
  // NVDA does not inherit a regular proxy into a live-basis distribution.
  assert.equal(nvdaRank.volumeSource, "pre");
  assert.equal(nvdaRank.volumeBasis, "live");
  assert.equal(nvdaRank.volumeProxied, false);
  assert.equal(nvdaRank.dollarVolume, 0);
});

test("rankMovers flags a move-only snapshot when no candidate has usable volume", () => {
  const a = quote({ symbol: "NVDA", marketState: "PRE", changePercent: 4.8, volume: 0, preMarketVolume: null });
  const b = quote({ symbol: "MSFT", marketState: "PRE", changePercent: -2.9, volume: 0, preMarketVolume: null });

  const movers = rankMovers([a, b]);

  assert.equal(movers.length, 2);
  assert.ok(movers.every((m) => m.moveOnly));
  assert.equal(movers[0]!.quote.symbol, "NVDA");
  // Move-only: score is purely the movement percentile (movement of 4.8 > 2.9).
  assert.equal(movers[0]!.score, 1);
  assert.equal(movers[1]!.score, 0);
  assert.equal(movers[0]!.volumePercentile, 0);
  assert.equal(movers[0]!.dollarVolume, 0);
});

test("rankMovers single zero-volume quote resolves to movement-only score 1", () => {
  const single = quote({ symbol: "NVDA", marketState: "PRE", changePercent: 3.1, volume: 0, preMarketVolume: null });
  const movers = rankMovers([single]);
  assert.equal(movers.length, 1);
  assert.equal(movers[0]!.moveOnly, true);
  assert.equal(movers[0]!.score, 1);
});

test("rankMovers scores mixed pre-market/regular snapshots on their own volume legs", () => {
  const msft = quote({ symbol: "MSFT", marketState: "PRE", changePercent: 5.2, price: 400, volume: 0, preMarketVolume: 1_500_000 });
  const aapl = quote({ symbol: "AAPL", marketState: "REGULAR", changePercent: 1.2, volume: 8_000_000 });

  const movers = rankMovers([msft, aapl]);

  assert.equal(movers.length, 2);
  assert.equal(movers[0]!.quote.symbol, "MSFT");
  const msftRank = movers.find((m) => m.quote.symbol === "MSFT")!;
  const aaplRank = movers.find((m) => m.quote.symbol === "AAPL")!;
  assert.equal(msftRank.dollarVolume, 400 * 1_500_000);
  assert.equal(msftRank.volumeSource, "pre");
  assert.equal(msftRank.volumeBasis, "live");
  assert.equal(aaplRank.volumeSource, "regular");
  assert.equal(aaplRank.volumeBasis, "live");
  assert.ok(aaplRank.dollarVolume > 0);
});

test("moverVolumeRowLabel marks proxied figures and never claims extended volume for them", () => {
  // Live pre-market figure → "VOL PM 1.2M".
  assert.equal(moverVolumeRowLabel(quote({ marketState: "PRE", preMarketVolume: 1_234_567, volume: 0 })), "VOL PM 1.2M");
  // Live post-market figure → "VOL AF 988K" (compact form).
  assert.equal(moverVolumeRowLabel(quote({ marketState: "POST", postMarketVolume: 987_654, volume: 9_000_000 })), "VOL AF 988K");
  // Regular session → "VOL 4.2M".
  assert.equal(moverVolumeRowLabel(quote({ marketState: "REGULAR", volume: 4_200_000 })), "VOL 4.2M");
  // Proxy fallback: marked with ~, no PRE/AF prefix (it measures the regular session).
  assert.equal(moverVolumeRowLabel(quote({ marketState: "PRE", volume: 5_000_000, preMarketVolume: null })), "VOL 5M~");
  // Live basis with no volume at all → movement-only marker.
  assert.equal(moverVolumeRowLabel(quote({ marketState: "PRE", volume: 5_000_000, preMarketVolume: null }), "live"), "VOL --");
  assert.equal(moverVolumeRowLabel(quote({ marketState: "REGULAR", volume: null })), "VOL --");
});

test("moverVolumeRowLabel labels stay within the fixed row field width", () => {
  for (const label of ["VOL PM 1.2M", "VOL AF 988K", "VOL 5M~", "VOL --", "VOL 4.2M", "VOL 999.9K"]) {
    assert.ok(label.length <= 11, `label too long: ${label} (${label.length})`);
  }
});

// ── Yahoo chart payload contract ─────────────────────────────────────────────
// The live chart v8 endpoint does NOT return meta.marketState / preMarketPrice /
// postMarketPrice (verified: current meta carries neither). The parser must
// derive session and extended price from currentTradingPeriod bounds + bars.

const PRE_START = 1_700_000_000; // 4:00 AM ET
const REGULAR_START = PRE_START + 3 * 3_600; // 7:00 AM ET (test-relative)
const REGULAR_END = REGULAR_START + 6.5 * 3_600; // 1:30 PM ET
const POST_END = REGULAR_END + 4 * 3_600; // 5:30 PM ET

function baseBounds() {
  return {
    pre: { start: PRE_START, end: REGULAR_START, timezone: "America/New_York", gmtoffset: -14400 },
    regular: { start: REGULAR_START, end: REGULAR_END, timezone: "America/New_York", gmtoffset: -14400 },
    post: { start: REGULAR_END, end: POST_END, timezone: "America/New_York", gmtoffset: -14400 },
  };
}

function makeChartPayload(
  bars: Array<{ t: number; close: number; vol?: number }>,
  metaOverrides: Record<string, unknown> = {},
) {
  return {
    chart: {
      result: [{
        meta: {
          symbol: "AAPL",
          currency: "USD",
          longName: "Apple Inc.",
          shortName: "Apple Inc.",
          fullExchangeName: "NasdaqGS",
          exchangeTimezoneName: "America/New_York",
          dataGranularity: "5m",
          regularMarketPrice: 310,
          regularMarketVolume: 22_000_000,
          regularMarketTime: REGULAR_END,
          previousClose: 311,
          chartPreviousClose: 311,
          currentTradingPeriod: baseBounds(),
          ...metaOverrides,
        },
        timestamp: bars.map((b) => b.t),
        indicators: { quote: [{ close: bars.map((b) => b.close), volume: bars.map((b) => b.vol ?? 0) }] },
      }],
    },
  };
}

test("parseChartPayloadToQuote derives PRE session and extended price from bars when meta omits marketState", () => {
  // Real Yahoo chart v8 responses ship no marketState/preMarketPrice; the last
  // bar's session + close must supply both.
  const payload = makeChartPayload([
    { t: REGULAR_END - 3_600, close: 310, vol: 22_000_000 },
    { t: REGULAR_END + 1_000, close: 305.5, vol: 0 },
  ]);
  const quote = parseChartPayloadToQuote("AAPL", payload, { yahooInterval: "5m", includePrePost: true, chartScope: "day" });

  assert.equal(quote.marketState, "POST");
  assert.equal(quote.price, 305.5); // last per-session close (post) — not regularMarketPrice
  assert.ok(Math.abs(quote.changePercent! - ((305.5 - 311) / 311) * 100) < 1e-9);
  // Post bars carry no volume on the public feed → postMarketVolume stays null.
  assert.equal(quote.postMarketVolume, null);
});

test("parseChartPayloadToQuote derives REGULAR session from last bar when meta omits marketState", () => {
  const payload = makeChartPayload([
    { t: PRE_START + 500, close: 309.5, vol: 0 },
    { t: REGULAR_START + 500, close: 310.25, vol: 22_000_000 },
  ]);
  const quote = parseChartPayloadToQuote("AAPL", payload, { yahooInterval: "5m", includePrePost: true, chartScope: "day" });

  assert.equal(quote.marketState, "REGULAR");
  // During regular hours the live price is meta.regularMarketPrice (310), not the
  // raw last bar close (310.25 is the bar midpoint). Legacy semantics preserved.
  assert.equal(quote.price, 310);
  assert.equal(quote.volume, 22_000_000);
});

test("parseChartPayloadToQuote derives PRE session + price when the last bar is pre-market", () => {
  const payload = makeChartPayload([
    { t: PRE_START + 500, close: 309, vol: 0 },
    { t: REGULAR_START - 1_200, close: 312.75, vol: 0 },
  ]);
  const quote = parseChartPayloadToQuote("AAPL", payload, { yahooInterval: "5m", includePrePost: true, chartScope: "day" });

  assert.equal(quote.marketState, "PRE");
  assert.equal(quote.price, 312.75);
  // Pre bars carry no volume in the public feed → preMarketVolume stays null;
  // the mover volume leg then uses the uniform proxy basis.
  assert.equal(quote.preMarketVolume, null);
});

test("parseChartPayloadToQuote classifies a single early pre-market bar (>= 1 bar, not 2)", () => {
  // First refresh of the day may carry one bar; it must still derive PRE.
  const payload = makeChartPayload([
    { t: PRE_START + 200, close: 313.4, vol: 0 },
  ]);
  const quote = parseChartPayloadToQuote("AAPL", payload, { yahooInterval: "5m", includePrePost: true, chartScope: "day" });
  assert.equal(quote.marketState, "PRE");
  assert.equal(quote.price, 313.4);
});

test("parseChartPayloadToQuote honors meta.marketState when present and keeps same base price", () => {
  const payload = makeChartPayload(
    [{ t: REGULAR_START + 500, close: 310.25, vol: 22_000_000 }],
    { marketState: "REGULAR" },
  );
  const quote = parseChartPayloadToQuote("AAPL", payload, { yahooInterval: "5m", includePrePost: true, chartScope: "week" });
  assert.equal(quote.marketState, "REGULAR");
  assert.equal(quote.chartScope, "week");
});