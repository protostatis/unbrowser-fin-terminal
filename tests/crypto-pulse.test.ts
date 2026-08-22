import assert from "node:assert/strict";
import test from "node:test";
import {
  CRYPTO_INTERACTIVE_UNIVERSE,
  buildMoversStrip,
  buildUniverseScoreboard,
  deriveCryptoMood,
  fetchCryptoPulse,
  interactiveUniverseIndex,
  isCryptoPulseUsable,
  isStablecoinListing,
  isStablecoinSymbol,
  type CryptoListing,
} from "../shared/crypto-pulse.js";

// Realistic payload fixtures captured from the live keyless endpoints
// (2026-08-22). Field names reflect the actual provider shapes.

const CMC_GLOBAL_METRICS = {
  data: {
    quote: {
      USD: {
        total_market_cap: 2607236260883.6235,
        total_volume_24h: 167449014414.27,
        altcoin_market_cap: 1061761528249.3,
        stablecoin_market_cap: 282184946134.57,
        total_market_cap_yesterday_percentage_change: 2.13,
        last_updated: "2026-08-22T14:18:00.000Z",
      },
    },
  },
};

const CMC_FEAR_GREED = {
  data: { value: 76, update_time: "2026-08-22T14:08:10.067Z", value_classification: "Greed" },
};

const CMC_LISTING = (overrides: Partial<Record<string, unknown>>) => ({
  id: 1,
  name: "Bitcoin",
  symbol: "BTC",
  slug: "bitcoin",
  cmc_rank: 1,
  circulating_supply: 20071518,
  tags: ["mineable", "pow"],
  last_updated: "2026-08-22T14:18:00.000Z",
  quote: [{
    symbol: "USD",
    price: 76959.37546695712,
    volume_24h: 54879089051.68,
    market_cap: 1544691489953.79,
    market_cap_dominance: 59.24,
    percent_change_1h: 0.34,
    percent_change_24h: 5.47,
    percent_change_7d: 22.32,
    last_updated: "2026-08-22T14:18:00.000Z",
  }],
  ...overrides,
});

const CMC_LISTINGS = {
  data: [
    CMC_LISTING({}),
    CMC_LISTING({
      id: 1027, symbol: "ETH", name: "Ethereum", slug: "ethereum", cmc_rank: 2,
      quote: [{ symbol: "USD", price: 2427.15, volume_24h: 2e10, market_cap: 2.9e11, market_cap_dominance: 11.4, percent_change_24h: 2.9, percent_change_7d: 8.1 }],
    }),
    // Stablecoin (tag-classified) excluded from the movers strip.
    CMC_LISTING({
      id: 825, symbol: "USDT", name: "Tether", slug: "tether", cmc_rank: 3, tags: ["stablecoin", "asset-backed-stablecoin"],
      quote: [{ symbol: "USD", price: 1.0, volume_24h: 5e10, market_cap: 1.2e11, market_cap_dominance: 4.6, percent_change_24h: 0.01, percent_change_7d: 0.0 }],
    }),
    CMC_LISTING({
      id: 5426, symbol: "SOL", name: "Solana", slug: "solana", cmc_rank: 5,
      quote: [{ symbol: "USD", price: 144.8, volume_24h: 8e9, market_cap: 6.6e10, market_cap_dominance: 2.5, percent_change_24h: 7.8, percent_change_7d: 15.0 }],
    }),
    // Non-universe mover appears in the display-only strip only.
    CMC_LISTING({
      id: 99999, symbol: "BOGUS", name: "BogusCoin", slug: "boguscoin", cmc_rank: 40,
      quote: [{ symbol: "USD", price: 0.5, volume_24h: 1e6, market_cap: 5e6, market_cap_dominance: 0.0, percent_change_24h: -12.0, percent_change_7d: -30.0 }],
    }),
  ],
};

/**
 * quotes/latest fixture for the 14 universe assets with deterministic 24h
 * changes (verified CMC IDs; name reflects the corrected registry).
 */
const UNIVERSE_CHANGES: ReadonlyArray<[number, string, number]> = [
  [1, 0.02],       // BTC
  [1027, 0.81],    // ETH
  [5426, 2.93],    // SOL
  [52, 5.94],      // XRP
  [1839, 2.61],    // BNB
  [74, 9.97],      // DOGE
  [2010, 4.56],    // ADA
  [5805, -0.54],   // AVAX
  [6636, 4.42],    // DOT
  [1975, 2.25],    // LINK
  [28321, 25.08],  // POL
  [2, 2.21],       // LTC
  [7083, 7.67],    // UNI
  [21794, 2.03],   // APT
];

function universeQuote(cmcId: number, change24h: number | null): Record<string, unknown> {
  const universe = interactiveUniverseIndex().get(cmcId)!;
  return CMC_LISTING({
    id: cmcId,
    symbol: universe.label,
    name: universe.label,
    slug: universe.label.toLowerCase(),
    cmc_rank: cmcId,
    quote: [{
      symbol: "USD",
      price: 100 + cmcId,
      volume_24h: 1e9,
      market_cap: 1e11,
      market_cap_dominance: cmcId === 1 ? 59.24 : 0.1,
      percent_change_24h: change24h,
      percent_change_7d: (change24h ?? 0) * 2,
    }],
  });
}

const CMC_QUOTES = {
  data: UNIVERSE_CHANGES.map(([cmcId, change]) => universeQuote(cmcId, change)),
};

const PANIC_RADAR_SUMMARY = {
  timestamp: "2026-08-22T14:18:42.573039+00:00",
  sentiment_score: -0.006,
  sentiment_state: "Neutral",
  fear_greed_index: 71,
  fear_greed_label: "Greed",
  volatility_24h: 4.53,
  volatility_state: "High",
  btc_price: 77044.0,
  btc_change_24h: 5.47,
  btc_change_7d: 22.32,
};

const PANIC_RADAR_PANIC_SCORE = {
  panic_score: 15.5,
  total_posts: 228,
  bearish_posts: 25,
  bullish_posts: 27,
  avg_sentiment: 0.006,
  sentiment_label: "Calm",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetchFor(route: (url: string) => Response) {
  return async (url: string) => route(url);
}

function allProvidersMock(url: string): Response {
  if (url.includes("/global-metrics/")) return jsonResponse(CMC_GLOBAL_METRICS);
  if (url.includes("/fear-and-greed/")) return jsonResponse(CMC_FEAR_GREED);
  if (url.includes("/listings/")) return jsonResponse(CMC_LISTINGS);
  if (url.includes("/quotes/latest")) return jsonResponse(CMC_QUOTES);
  if (url.includes("/dashboard/summary")) return jsonResponse(PANIC_RADAR_SUMMARY);
  if (url.includes("/dashboard/panic-score")) return jsonResponse(PANIC_RADAR_PANIC_SCORE);
  return new Response("not found", { status: 404 });
}

test("fetches a normalized crypto pulse snapshot from all providers", async () => {
  const now = Date.parse("2026-08-22T14:20:00Z");

  const { snapshot, errors } = await fetchCryptoPulse({ fetchImpl: mockFetchFor(allProvidersMock), now: () => now });

  assert.deepEqual(errors, []);
  assert.deepEqual(snapshot.providers, { cmc: true, panicRadar: true });
  assert.ok(snapshot.globalMetrics);
  assert.equal(snapshot.globalMetrics.totalMarketCap, 2607236260883.6235);
  assert.ok(snapshot.fearGreed);
  assert.equal(snapshot.fearGreed.value, 76);
  assert.equal(snapshot.fearGreed.label, "GREED");
  assert.equal(snapshot.listings.length, 5);
  assert.equal(snapshot.hot.length, 7);
  assert.equal(snapshot.cold.length, 7);
  assert.equal(snapshot.unranked.length, 0);
  assert.ok(snapshot.movers);
  assert.equal(snapshot.movers.leaders.length, 3);
  assert.equal(snapshot.movers.laggards.length, 3);
  assert.ok(snapshot.panicRadarSummary);
  assert.equal(snapshot.panicRadarSummary.volatilityState, "High");
  assert.equal(snapshot.panicScore?.panicScore, 15.5);
});

test("mood derivation merges CMC primary with PanicRadar secondary", () => {
  const mood = deriveCryptoMood(
    { value: 76, label: "GREED", asOf: { provider: "cmc", fetchedAt: 1 } },
    { totalMarketCap: 2.6e12, totalVolume24h: 1.6e11, altcoinMarketCap: 1e12, stablecoinMarketCap: 2.8e11, changeYesterdayPercent: 2.13, asOf: { provider: "cmc", fetchedAt: 1 } },
    { sentimentScore: -0.006, sentimentState: "Neutral", fearGreedIndex: 71, fearGreedLabel: "GREED", volatility24h: 4.53, volatilityState: "High", btcPrice: 77044, btcChange24h: 5.47, btcChange7d: 22.32, asOf: { provider: "panicRadar", fetchedAt: 1 } },
    { panicScore: 15.5, totalPosts: 228, bearishPosts: 25, bullishPosts: 27, avgSentiment: 0.006, sentimentLabel: "CALM", asOf: { provider: "panicRadar", fetchedAt: 1 } },
    parseQuotes(CMC_QUOTES),
    1000,
  );

  assert.ok(mood);
  assert.equal(mood.value, 76);
  assert.equal(mood.label, "GREED");
  assert.equal(mood.barFill, 8);
  assert.equal(mood.panicScore, 15.5);
  assert.equal(mood.panicLabel, "CALM");
  assert.equal(mood.btcDominancePercent, 59.24);
  assert.equal(mood.totalMarketCapChangePercent, 2.13);
  assert.equal(mood.volatilityLabel, "High");
  assert.deepEqual(mood.sources, ["cmc", "panicRadar"]);
});

test("mood falls back to PanicRadar only when CMC Fear & Greed is absent", () => {
  const mood = deriveCryptoMood(null, null, {
    sentimentScore: 0, sentimentState: "Neutral", fearGreedIndex: 71, fearGreedLabel: "Greed",
    volatility24h: 4.53, volatilityState: "High", btcPrice: null, btcChange24h: null, btcChange7d: null,
    asOf: { provider: "panicRadar", fetchedAt: 1 },
  }, null, [], 1000);

  assert.ok(mood);
  assert.equal(mood.value, 71);
  assert.equal(mood.barFill, 7);
  assert.deepEqual(mood.sources, ["panicRadar"]);
});

test("mood is null when no mood provider responded", () => {
  const mood = deriveCryptoMood(null, null, null, null, [], 1000);
  assert.equal(mood, null);
});

test("provider failure isolates and degrades only its own datasets", async () => {
  const fetchImpl = mockFetchFor((url) => {
    if (url.includes("/dashboard/panic-score")) return new Response("oops", { status: 500 });
    if (url.includes("/dashboard/summary")) return new Response("not json", { status: 200, headers: { "content-type": "text/plain" } });
    if (url.includes("/global-metrics/")) return jsonResponse(CMC_GLOBAL_METRICS);
    if (url.includes("/fear-and-greed/")) return jsonResponse(CMC_FEAR_GREED);
    if (url.includes("/listings/")) return jsonResponse(CMC_LISTINGS);
    if (url.includes("/quotes/latest")) return jsonResponse(CMC_QUOTES);
    return new Response("not found", { status: 404 });
  });

  const { snapshot, errors } = await fetchCryptoPulse({ fetchImpl });

  assert.equal(snapshot.panicRadarSummary, null);
  assert.equal(snapshot.panicScore, null);
  assert.ok(snapshot.fearGreed);
  assert.equal(snapshot.listings.length, 5);
  assert.deepEqual(snapshot.providers, { cmc: true, panicRadar: false });
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => error.startsWith("panicRadar.summary")));
  assert.ok(errors.some((error) => error.startsWith("panicRadar.panic-score")));
  // Board still derives from the CMC quotes source.
  assert.equal(snapshot.hot.length, 7);
  assert.equal(snapshot.cold.length, 7);
  assert.equal(snapshot.mood?.value, 76);
});

test("universe board ranks all 14 into relative HOTTEST/COLDEST halves", () => {
  const { hot, cold, unranked } = buildUniverseScoreboard(parseQuotes(CMC_QUOTES));

  assert.equal(hot.length, 7);
  assert.equal(cold.length, 7);
  assert.equal(unranked.length, 0);
  assert.deepEqual(hot.map((row) => row.symbol), ["POL", "DOGE", "UNI", "XRP", "ADA", "DOT", "SOL"]);
  assert.equal(hot[0]!.change24h, 25.08);
  // COLDEST is ascending (worst first) and can contain positive returns.
  assert.deepEqual(cold.map((row) => row.symbol), ["AVAX", "BTC", "ETH", "APT", "LTC", "LINK", "BNB"]);
  assert.ok(cold[0]!.change24h <= cold.at(-1)!.change24h);
  // Every universe asset appears exactly once across the board.
  const seen = new Set([...hot, ...cold, ...unranked].map((row) => row.cmcId));
  assert.equal(seen.size, CRYPTO_INTERACTIVE_UNIVERSE.length);
  for (const asset of CRYPTO_INTERACTIVE_UNIVERSE) assert.ok(seen.has(asset.cmcId), `missing ${asset.label}`);
});

test("a one-directional (all-positive) market still fills both columns", () => {
  const quotes = UNIVERSE_CHANGES.map(([cmcId]) => universeQuote(cmcId, 1 + cmcId % 7));
  const { hot, cold } = buildUniverseScoreboard(parseQuotes({ data: quotes }));
  assert.equal(hot.length, 7);
  assert.equal(cold.length, 7);
  assert.ok(cold.every((row) => row.change24h > 0), "COLDEST is relative, not sign-based");
  assert.ok(cold[0]!.change24h <= cold.at(-1)!.change24h);
});

test("missing-change universe assets land in unranked and remain mapped", () => {
  const quotes = [
    ...UNIVERSE_CHANGES.slice(0, 13).map(([cmcId, change]) => universeQuote(cmcId, change)),
    universeQuote(21794, null), // APT without a finite 24h change
  ];
  const { hot, cold, unranked } = buildUniverseScoreboard(parseQuotes({ data: quotes }));
  assert.equal(hot.length, 7);
  assert.equal(cold.length, 6);
  assert.equal(unranked.length, 1);
  assert.equal(unranked[0]!.symbol, "APT");
  assert.equal(unranked[0]!.yahooSymbol, "APT-USD");
});

test("movers strip excludes stablecoins, reports breadth, and is display-only", () => {
  const strip = buildMoversStrip(parseListings(CMC_LISTINGS), 3);
  assert.ok(strip);
  assert.deepEqual(strip.leaders.map((row) => row.symbol), ["SOL", "BTC", "ETH"]);
  assert.deepEqual(strip.laggards.map((row) => row.symbol), ["BOGUS", "ETH", "BTC"]);
  assert.deepEqual(strip.breadth, { advancing: 3, declining: 1, measured: 4 });
  assert.ok(strip.leaders.every((row) => row.yahooSymbol === null), "strip rows are display-only");
});

test("stablecoin helpers prefer the CMC tag over the symbol denylist", () => {
  assert.equal(isStablecoinSymbol("USDT"), true);
  assert.equal(isStablecoinSymbol("usdc"), true);
  assert.equal(isStablecoinSymbol("USDE"), true);
  assert.equal(isStablecoinSymbol("BTC"), false);
  // Tag-classified even when the symbol would not match the denylist.
  const tagged = parseListings(CMC_LISTINGS).find((listing) => listing.symbol === "USDT")!;
  assert.equal(isStablecoinListing(tagged), true);
  const untagged = parseListings(CMC_LISTINGS).find((listing) => listing.symbol === "ETH")!;
  assert.equal(isStablecoinListing(untagged), false);
});

test("registry uses the verified stable CMC IDs for every universe asset", () => {
  const ids = CRYPTO_INTERACTIVE_UNIVERSE.map((asset) => asset.cmcId);
  assert.equal(new Set(ids).size, ids.length, "CMC IDs must be unique");
  const known: Record<number, string> = {
    1: "BTC", 1027: "ETH", 5426: "SOL", 52: "XRP", 1839: "BNB", 74: "DOGE", 2010: "ADA",
    5805: "AVAX", 6636: "DOT", 1975: "LINK", 28321: "POL", 2: "LTC", 7083: "UNI", 21794: "APT",
  };
  for (const asset of CRYPTO_INTERACTIVE_UNIVERSE) {
    assert.equal(asset.label, known[asset.cmcId], `CMC id ${asset.cmcId} must be ${known[asset.cmcId]}`);
  }
});

function parseListings(raw: { data: unknown[] }): CryptoListing[] {
  const fetchedAt = Date.parse("2026-08-22T14:18:00Z");
  return raw.data.flatMap((item) => {
    const r = item as Record<string, unknown>;
    const quote = (r.quote as unknown[])[0] as Record<string, number>;
    return [{
      cmcId: r.id as number,
      symbol: r.symbol as string,
      name: r.name as string,
      slug: r.slug as string,
      rank: r.cmc_rank as number,
      price: quote.price,
      marketCap: quote.market_cap,
      marketCapDominance: quote.market_cap_dominance,
      volume24h: quote.volume_24h,
      change1h: quote.percent_change_1h,
      change24h: quote.percent_change_24h,
      change7d: quote.percent_change_7d,
      tags: Array.isArray(r.tags) ? r.tags as string[] : [],
      asOf: { provider: "cmc", fetchedAt },
    }];
  });
}

function parseQuotes(raw: { data: unknown[] }): CryptoListing[] {
  return parseListings(raw);
}

test("isCryptoPulseUsable rejects provider-outage snapshots", async () => {
  const { snapshot: empty, errors: emptyErrors } = await fetchCryptoPulse({
    fetchImpl: async () => new Response("down", { status: 503 }),
  });
  assert.equal(isCryptoPulseUsable(empty), false);
  assert.equal(emptyErrors.length, 6);
  assert.equal(empty.mood, null);
  assert.equal(empty.hot.length + empty.cold.length + empty.unranked.length, 0);
  assert.equal(empty.movers, null);
});
