import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleMoverQuotes,
  moverEligible,
  moverVolume,
  moverVolumeRowLabel,
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

test("moverVolume prefers live pre-market volume during PRE", () => {
  const resolution = moverVolume(quote({ marketState: "PRE", price: 210, volume: 5_000_000, preMarketVolume: 800_000 }));
  assert.deepEqual(resolution, { volume: 800_000, session: "pre", proxied: false });
});

test("moverVolume falls back to regular volume as a proxied liquidity signal during PRE", () => {
  const resolution = moverVolume(quote({ marketState: "PRE", volume: 5_000_000, preMarketVolume: null }));
  assert.deepEqual(resolution, { volume: 5_000_000, session: "pre", proxied: true });
});

test("moverVolume allows movement-only ranking when PRE ships no volume at all", () => {
  const resolution = moverVolume(quote({ marketState: "PRE", volume: null, preMarketVolume: null }));
  assert.deepEqual(resolution, { volume: 0, session: "pre", proxied: false });
});

test("moverVolume resolves POST volume against post-market volume first", () => {
  const primary = moverVolume(quote({ marketState: "POST", volume: 6_000_000, postMarketVolume: 1_200_000 }));
  assert.deepEqual(primary, { volume: 1_200_000, session: "post", proxied: false });
  const proxied = moverVolume(quote({ marketState: "POST", volume: 6_000_000, postMarketVolume: null }));
  assert.deepEqual(proxied, { volume: 6_000_000, session: "post", proxied: true });
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
  // Extended sessions stay eligible even with no volume: Yahoo often ships the
  // pre-post move before it ships extended-hours volume.
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

test("rankMovers scores pre-market movers by their own volume leg", () => {
  // MSFT: largest |move| (+5.2%) and no volume metadata at all → movement-first.
  const msft = quote({ symbol: "MSFT", marketState: "PRE", changePercent: 5.2, price: 400, volume: 0, preMarketVolume: null });
  // NVDA: smaller move but real pre-market volume.
  const nvda = quote({ symbol: "NVDA", marketState: "PRE", changePercent: 3.1, price: 900, volume: 0, preMarketVolume: 1_500_000 });
  const aapl = quote({ symbol: "AAPL", marketState: "REGULAR", changePercent: 1.2, volume: 8_000_000 });

  const movers = rankMovers([msft, nvda, aapl]);

  assert.equal(movers.length, 3);
  assert.equal(movers[0]!.quote.symbol, "MSFT");
  assert.equal(movers[0]!.volumeSource, "pre");
  assert.equal(movers[0]!.volumeProxied, false);

  const nvdaRank = movers.find((mover) => mover.quote.symbol === "NVDA")!;
  assert.equal(nvdaRank.dollarVolume, 900 * 1_500_000);
  assert.equal(nvdaRank.volumeProxied, false);
  assert.equal(nvdaRank.volumeSource, "pre");
});

test("rankMovers labels proxied pre-market volume for UI transparency", () => {
  const premarket = quote({ symbol: "NVDA", marketState: "PRE", volume: 5_000_000, preMarketVolume: null });
  const mover = rankMovers([premarket])[0]!;
  assert.equal(mover.volumeProxied, true);
  assert.equal(mover.dollarVolume, premarket.price * 5_000_000);
  assert.equal(moverVolumeRowLabel(premarket), "VOL PM 5M~");
});

test("moverVolumeRowLabel exports the session semantics", () => {
  assert.equal(moverVolumeRowLabel(quote({ marketState: "PRE", preMarketVolume: 1_234_567, volume: 0 })), "VOL PM 1.2M");
  assert.equal(moverVolumeRowLabel(quote({ marketState: "POST", postMarketVolume: 987_654, volume: 9_000_000 })), "VOL AF 987.7K");
  assert.equal(moverVolumeRowLabel(quote({ marketState: "REGULAR", volume: 4_200_000 })), "VOL 4.2M");
  assert.equal(moverVolumeRowLabel(quote({ marketState: "PRE", volume: 5_000_000, preMarketVolume: null })), "VOL PM 5M~");
});