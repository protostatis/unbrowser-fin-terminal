import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMoversStrip,
  buildUniverseScoreboard,
  deriveCryptoMood,
  fetchCryptoPulse,
  isCryptoPulseUsable,
  isStablecoinListing,
  isStablecoinSymbol,
  resolveYahooPair,
  yahooPairForSymbol,
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
    // Stablecoin (tag-classified) excluded from board and movers strip.
    CMC_LISTING({
      id: 825, symbol: "USDT", name: "Tether", slug: "tether", cmc_rank: 3, tags: ["stablecoin", "asset-backed-stablecoin"],
      quote: [{ symbol: "USD", price: 1.0, volume_24h: 5e10, market_cap: 1.2e11, market_cap_dominance: 4.6, percent_change_24h: 0.01, percent_change_7d: 0.0 }],
    }),
    CMC_LISTING({
      id: 5426, symbol: "SOL", name: "Solana", slug: "solana", cmc_rank: 5,
      quote: [{ symbol: "USD", price: 144.8, volume_24h: 8e9, market_cap: 6.6e10, market_cap_dominance: 2.5, percent_change_24h: 7.8, percent_change_7d: 15.0 }],
    }),
    // Non-top mover appears in the display-only strip only.
    CMC_LISTING({
      id: 99999, symbol: "BOGUS", name: "BogusCoin", slug: "boguscoin", cmc_rank: 40,
      quote: [{ symbol: "USD", price: 0.5, volume_24h: 1e6, market_cap: 5e6, market_cap_dominance: 0.0, percent_change_24h: -12.0, percent_change_7d: -30.0 }],
    }),
    // Dynamic-universe fixtures: derived Yahoo pairs plus one no-chart cohort.
    CMC_LISTING({
      id: 52, symbol: "XRP", name: "XRP", slug: "xrp", cmc_rank: 4,
      quote: [{ symbol: "USD", price: 0.624, volume_24h: 2e9, market_cap: 3.2e10, market_cap_dominance: 1.2, percent_change_24h: 5.94, percent_change_7d: 9.0 }],
    }),
    CMC_LISTING({
      id: 1839, symbol: "BNB", name: "BNB", slug: "bnb", cmc_rank: 6,
      quote: [{ symbol: "USD", price: 691, volume_24h: 1.5e9, market_cap: 1.0e11, market_cap_dominance: 3.8, percent_change_24h: 2.61, percent_change_7d: 5.0 }],
    }),
    // PEPE: Yahoo never hosts it — row must resolve to a null pair (display-only).
    CMC_LISTING({
      id: 24478, symbol: "PEPE", name: "Pepe", slug: "pepe", cmc_rank: 25,
      quote: [{ symbol: "USD", price: 0.00001, volume_24h: 5e8, market_cap: 4e9, market_cap_dominance: 0.2, percent_change_24h: 18.0, percent_change_7d: 40.0 }],
    }),
  ],
};

/** Deterministic top-100 listings for scoreboard tests (excluding stables). */
const SCOREBOARD_LISTINGS: ReadonlyArray<[string, number, number]> = [
  ["BTC", 1, 5.47], ["ETH", 1027, 2.9], ["SOL", 5426, 7.8], ["XRP", 52, 5.94],
  ["BNB", 1839, 2.61], ["DOGE", 74, 9.97], ["ADA", 2010, 4.56], ["AVAX", 5805, -0.54],
  ["DOT", 6636, 4.42], ["LINK", 1975, 2.25], ["POL", 28321, 25.08], ["LTC", 2, 2.21],
  ["UNI", 7083, 7.67], ["APT", 21794, 2.03], ["PEPE", 24478, null],
];

function boardListing(symbol: string, cmcId: number, change24h: number | null): Record<string, unknown> {
  return CMC_LISTING({
    id: cmcId,
    symbol,
    name: symbol,
    slug: symbol.toLowerCase(),
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
  assert.equal(snapshot.listings.length, 8);
  // Ranked board = non-stable listings with finite 24h change; PEPE is ranked
  // but resolves display-only (no Yahoo pair).
  assert.ok(snapshot.hot.length + snapshot.cold.length >= 4);
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
    parseListings(CMC_LISTINGS),
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
    return new Response("not found", { status: 404 });
  });

  const { snapshot, errors } = await fetchCryptoPulse({ fetchImpl });

  assert.equal(snapshot.panicRadarSummary, null);
  assert.equal(snapshot.panicScore, null);
  assert.ok(snapshot.fearGreed);
  assert.equal(snapshot.listings.length, 8);
  assert.deepEqual(snapshot.providers, { cmc: true, panicRadar: false });
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => error.startsWith("panicRadar.summary")));
  assert.ok(errors.some((error) => error.startsWith("panicRadar.panic-score")));
  // Board still derives from the CMC listings source.
  assert.ok(snapshot.hot.length + snapshot.cold.length >= 4);
  assert.equal(snapshot.mood?.value, 76);
});

test("dynamic scoreboard ranks all finite-change listings into HOT/COLD halves", () => {
  const listings = parseListings({ data: SCOREBOARD_LISTINGS.map(([symbol, cmcId, change]) => boardListing(symbol, cmcId, change)) });
  const { hot, cold, unranked } = buildUniverseScoreboard(listings);

  assert.equal(hot.length, 7);
  assert.equal(cold.length, 7);
  assert.equal(unranked.length, 1);
  // Sorted descending: POL best, then DOGE, SOL, UNI, XRP, BTC, ADA.
  assert.deepEqual(hot.map((row) => row.symbol), ["POL", "DOGE", "SOL", "UNI", "XRP", "BTC", "ADA"]);
  assert.equal(hot[0]!.change24h, 25.08);
  // COLDEST is ascending (worst first).
  assert.deepEqual(cold.map((row) => row.symbol), ["AVAX", "APT", "LTC", "LINK", "BNB", "ETH", "DOT"]);
  assert.ok(cold[0]!.change24h <= cold.at(-1)!.change24h);
  // Every ranked listing appears exactly once; PEPE has no finite change → unranked.
  const seen = new Set([...hot, ...cold, ...unranked].map((row) => row.cmcId));
  assert.equal(seen.size, SCOREBOARD_LISTINGS.length);
});

test("dynamic Yahoo pair derivation: -USD convention with overrides and exclusions", () => {
  assert.equal(yahooPairForSymbol("BTC"), "BTC-USD");
  assert.equal(yahooPairForSymbol("btc"), "BTC-USD");
  assert.equal(yahooPairForSymbol("POL"), "MATIC-USD"); // Polygon rebrand override
  assert.equal(yahooPairForSymbol("PEPE"), null); // Yahoo never hosts it
  assert.equal(yahooPairForSymbol("SUI"), null);
  assert.equal(yahooPairForSymbol("UNI"), null);
  assert.equal(yahooPairForSymbol("APT"), null);
});

test("Yahoo pair search rejects fuzzy matches for unrelated tickers", async () => {
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/chart/LIT-USD")) return new Response("not found", { status: 404 });
    if (url.includes("/v1/finance/search?q=LIT")) {
      return jsonResponse({ quotes: [{ symbol: "LTC-USD", quoteType: "CRYPTOCURRENCY" }] });
    }
    return new Response("not found", { status: 404 });
  };

  assert.equal(await resolveYahooPair("LIT", fetchImpl), null);
});

test("Yahoo pair search accepts numeric-suffix crypto pairs", async () => {
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/chart/TRUMP-USD")) return new Response("not found", { status: 404 });
    if (url.includes("/v1/finance/search?q=TRUMP")) {
      return jsonResponse({ quotes: [{ symbol: "TRUMP35336-USD", quoteType: "CRYPTOCURRENCY" }] });
    }
    return new Response("not found", { status: 404 });
  };

  assert.equal(await resolveYahooPair("TRUMP", fetchImpl), "TRUMP35336-USD");
});

test("Yahoo pair resolution propagates transient provider failures", async () => {
  let calls = 0;
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    calls += 1;
    assert.match(String(input), /chart\/BTC-USD/);
    return new Response("busy", { status: 429 });
  };

  await assert.rejects(() => resolveYahooPair("BTC", fetchImpl), /HTTP 429/);
  assert.equal(calls, 1, "a rate-limited direct probe must not fan out into a fuzzy search");
});

test("a one-directional (all-positive) market still fills both columns", () => {
  const listings = parseListings({
    data: SCOREBOARD_LISTINGS.filter(([symbol, , change]) => symbol !== "PEPE")
      .map(([symbol, cmcId]) => boardListing(symbol, cmcId, 1 + cmcId % 7)),
  });
  const { hot, cold } = buildUniverseScoreboard(listings);
  assert.equal(hot.length, 7);
  assert.equal(cold.length, 7);
  assert.ok(cold.every((row) => row.change24h > 0), "COLDEST is relative, not sign-based");
  assert.ok(cold[0]!.change24h <= cold.at(-1)!.change24h);
});

test("missing-change listings land in unranked and stay mapped", () => {
  const listings = parseListings({
    data: [
      ...SCOREBOARD_LISTINGS.slice(0, 13).map(([symbol, cmcId, change]) => boardListing(symbol, cmcId, change)),
      boardListing("PEPE", 24478, null),
      boardListing("SUI", 20947, null),
    ],
  });
  const { hot, cold, unranked } = buildUniverseScoreboard(listings);
  assert.equal(hot.length, 7);
  assert.equal(cold.length, 6);
  assert.equal(unranked.length, 2);
  assert.equal(unranked[0]!.symbol, "PEPE");
  assert.equal(unranked[0]!.yahooSymbol, null);
});

test("movers strip excludes stablecoins, reports breadth, and is display-only", () => {
  const strip = buildMoversStrip(parseListings(CMC_LISTINGS), 3);
  assert.ok(strip);
  assert.deepEqual(strip.leaders.map((row) => row.symbol), ["PEPE", "SOL", "XRP"]);
  assert.deepEqual(strip.laggards.map((row) => row.symbol), ["BOGUS", "BNB", "ETH"]);
  assert.deepEqual(strip.breadth, { advancing: 6, declining: 1, measured: 7 });
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

test("isCryptoPulseUsable rejects provider-outage snapshots", async () => {
  const { snapshot: empty, errors: emptyErrors } = await fetchCryptoPulse({
    fetchImpl: async () => new Response("down", { status: 503 }),
  });
  assert.equal(isCryptoPulseUsable(empty), false);
  assert.equal(emptyErrors.length, 5); // global-metrics + fear-and-greed + listings + 2x panicRadar
  assert.equal(empty.mood, null);
  assert.equal(empty.hot.length + empty.cold.length + empty.unranked.length, 0);
  assert.equal(empty.movers, null);
});
