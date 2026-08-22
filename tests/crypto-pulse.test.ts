import assert from "node:assert/strict";
import test from "node:test";
import {
  CRYPTO_INTERACTIVE_UNIVERSE,
  buildHotColdScoreboard,
  deriveCryptoMood,
  fetchCryptoPulse,
  interactiveUniverseIndex,
  isCryptoPulseUsable,
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
    CMC_LISTING({
      id: 5426, symbol: "SOL", name: "Solana", slug: "solana", cmc_rank: 5,
      quote: [{ symbol: "USD", price: 144.8, volume_24h: 8e9, market_cap: 6.6e10, market_cap_dominance: 2.5, percent_change_24h: 7.8, percent_change_7d: 15.0 }],
    }),
    // Stablecoin excluded from scoreboard.
    CMC_LISTING({
      id: 825, symbol: "USDT", name: "Tether", slug: "tether", cmc_rank: 3,
      quote: [{ symbol: "USD", price: 1.0, volume_24h: 5e10, market_cap: 1.2e11, market_cap_dominance: 4.6, percent_change_24h: 0.01, percent_change_7d: 0.0 }],
    }),
    // Losing asset, not in interactive universe (render-only).
    CMC_LISTING({
      id: 99999, symbol: "BOGUS", name: "BogusCoin", slug: "boguscoin", cmc_rank: 40,
      quote: [{ symbol: "USD", price: 0.5, volume_24h: 1e6, market_cap: 5e6, market_cap_dominance: 0.0, percent_change_24h: -12.0, percent_change_7d: -30.0 }],
    }),
  ],
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

test("fetches a normalized crypto pulse snapshot from all providers", async () => {
  const fetchImpl = mockFetchFor((url) => {
    if (url.includes("/global-metrics/")) return jsonResponse(CMC_GLOBAL_METRICS);
    if (url.includes("/fear-and-greed/")) return jsonResponse(CMC_FEAR_GREED);
    if (url.includes("/listings/")) return jsonResponse(CMC_LISTINGS);
    if (url.includes("/dashboard/summary")) return jsonResponse(PANIC_RADAR_SUMMARY);
    if (url.includes("/dashboard/panic-score")) return jsonResponse(PANIC_RADAR_PANIC_SCORE);
    return new Response("not found", { status: 404 });
  });
  const now = Date.parse("2026-08-22T14:20:00Z");

  const { snapshot, errors } = await fetchCryptoPulse({ fetchImpl, now: () => now });

  assert.deepEqual(errors, []);
  assert.deepEqual(snapshot.providers, { cmc: true, panicRadar: true });
  assert.ok(snapshot.globalMetrics);
  assert.equal(snapshot.globalMetrics.totalMarketCap, 2607236260883.6235);
  assert.equal(snapshot.globalMetrics.changeYesterdayPercent, 2.13);
  assert.ok(snapshot.fearGreed);
  assert.equal(snapshot.fearGreed.value, 76);
  assert.equal(snapshot.fearGreed.label, "GREED");
  assert.equal(snapshot.listings.length, 5);
  assert.ok(snapshot.panicRadarSummary);
  assert.equal(snapshot.panicRadarSummary.fearGreedIndex, 71);
  assert.equal(snapshot.panicRadarSummary.volatilityState, "High");
  assert.ok(snapshot.panicScore);
  assert.equal(snapshot.panicScore.panicScore, 15.5);
});

test("mood derivation merges CMC primary with PanicRadar secondary", () => {
  const listings = snapshotListings();
  const mood = deriveCryptoMood(
    { value: 76, label: "GREED", asOf: { provider: "cmc", fetchedAt: 1 } },
    { totalMarketCap: 2.6e12, totalVolume24h: 1.6e11, altcoinMarketCap: 1e12, stablecoinMarketCap: 2.8e11, changeYesterdayPercent: 2.13, asOf: { provider: "cmc", fetchedAt: 1 } },
    { sentimentScore: -0.006, sentimentState: "Neutral", fearGreedIndex: 71, fearGreedLabel: "GREED", volatility24h: 4.53, volatilityState: "High", btcPrice: 77044, btcChange24h: 5.47, btcChange7d: 22.32, asOf: { provider: "panicRadar", fetchedAt: 1 } },
    { panicScore: 15.5, totalPosts: 228, bearishPosts: 25, bullishPosts: 27, avgSentiment: 0.006, sentimentLabel: "CALM", asOf: { provider: "panicRadar", fetchedAt: 1 } },
    listings,
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

  // PanicRadar down: both its datasets null, CMC intact.
  assert.equal(snapshot.panicRadarSummary, null);
  assert.equal(snapshot.panicScore, null);
  assert.ok(snapshot.fearGreed);
  assert.equal(snapshot.listings.length, 5);
  assert.deepEqual(snapshot.providers, { cmc: true, panicRadar: false });
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => error.startsWith("panicRadar.summary")));
  assert.ok(errors.some((error) => error.startsWith("panicRadar.panic-score")));
  // Mood still derivable from CMC alone.
  assert.ok(snapshot.mood);
  assert.equal(snapshot.mood.value, 76);
});

test("scoreboard ranks interactive universe, excludes stablecoins", () => {
  const listings = snapshotListings();
  const { hot, cold } = buildHotColdScoreboard(listings, 5);

  assert.deepEqual(hot.map((row) => row.symbol), ["SOL", "BTC", "ETH"]);
  assert.equal(hot[0]!.change24h, 7.8);
  assert.equal(hot[0]!.yahooSymbol, "SOL-USD");
  // BogusCoin is not in the interactive universe; USDT is a stablecoin.
  assert.deepEqual(cold, []);
});

test("scoreboard splits a losing interactive asset into COLD", () => {
  const listings = [
    ...snapshotListings(),
    listing(2, "LTC", 2, -4.2),
  ];
  const { hot, cold } = buildHotColdScoreboard(listings, 5);
  assert.deepEqual(cold.map((row) => row.symbol), ["LTC"]);
  assert.equal(cold[0]!.yahooSymbol, "LTC-USD");
});

function snapshotListings(): CryptoListing[] {
  return parseListings(CMC_LISTINGS);
}

function parseListings(raw: { data: unknown[] }): CryptoListing[] {
  const fetchedAt = Date.parse("2026-08-22T14:18:00Z");
  return raw.data.flatMap((item) => {
    const r = item as Record<string, unknown>;
    const quote = (r.quote as unknown[])[0] as Record<string, number>;
    const id = r.id as number;
    return [{
      cmcId: id,
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
      asOf: { provider: "cmc", fetchedAt },
    }];
  });
}

function listing(cmcId: number, symbol: string, rank: number, change24h: number): CryptoListing {
  const yahoo = CRYPTO_INTERACTIVE_UNIVERSE.find((asset) => asset.cmcId === cmcId);
  return {
    cmcId,
    symbol: yahoo?.label ?? symbol,
    name: symbol,
    slug: symbol.toLowerCase(),
    rank,
    price: 100,
    marketCap: 1e9,
    marketCapDominance: 0.1,
    volume24h: 1e8,
    change1h: 0,
    change24h,
    change7d: 0,
    asOf: { provider: "cmc", fetchedAt: 1 },
  };
}

test("stablecoin and universe helpers behave deterministically", () => {
  assert.equal(isStablecoinSymbol("USDT"), true);
  assert.equal(isStablecoinSymbol("usdc"), true);
  assert.equal(isStablecoinSymbol("BTC"), false);
  assert.equal(isStablecoinSymbol("USDE"), true);
  const universe = interactiveUniverseIndex();
  assert.equal(universe.get(1)?.yahooSymbol, "BTC-USD");
  assert.equal(universe.get(1027)?.yahooSymbol, "ETH-USD");
  assert.equal(CRYPTO_INTERACTIVE_UNIVERSE.length >= 10, true);
});

test("panicRadarEnabled=false skips PanicRadar entirely", async () => {
  const requested: string[] = [];
  const fetchImpl = async (url: string) => {
    requested.push(url);
    if (url.includes("/global-metrics/")) return jsonResponse(CMC_GLOBAL_METRICS);
    if (url.includes("/fear-and-greed/")) return jsonResponse(CMC_FEAR_GREED);
    if (url.includes("/listings/")) return jsonResponse(CMC_LISTINGS);
    return new Response("not found", { status: 404 });
  };

  const { snapshot, errors } = await fetchCryptoPulse({ fetchImpl, panicRadarEnabled: false });

  assert.deepEqual(errors, []);
  assert.deepEqual(snapshot.providers, { cmc: true, panicRadar: false });
  assert.equal(snapshot.panicRadarSummary, null);
  assert.equal(snapshot.panicScore, null);
  assert.ok(snapshot.mood);
  assert.equal(requested.some((url) => url.includes("panicradar.ai")), false);
  assert.equal(requested.length, 3);
});

test("a hanging PanicRadar endpoint never blocks CMC data", async () => {
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("panicradar.ai")) {
      // Resolve only when the caller aborts (simulates a hung upstream).
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    if (url.includes("/global-metrics/")) return jsonResponse(CMC_GLOBAL_METRICS);
    if (url.includes("/fear-and-greed/")) return jsonResponse(CMC_FEAR_GREED);
    if (url.includes("/listings/")) return jsonResponse(CMC_LISTINGS);
    return new Response("not found", { status: 404 });
  };

  const started = Date.now();
  const { snapshot, errors } = await fetchCryptoPulse({ fetchImpl, panicRadarTimeoutMs: 10, requestTimeoutMs: 10_000 });

  // CMC came back intact; PanicRadar was cut off by its own short budget.
  assert.ok(snapshot.fearGreed, "CMC fear/greed should be present");
  assert.equal(snapshot.panicRadarSummary, null);
  assert.equal(snapshot.panicScore, null);
  assert.deepEqual(snapshot.providers, { cmc: true, panicRadar: false });
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => error.startsWith("panicRadar.")));
  assert.ok(Date.now() - started < 1_000, "hanging PanicRadar should not add a long tail");
});

test("isCryptoPulseUsable rejects provider-outage snapshots", async () => {
  const { snapshot: empty, errors: emptyErrors } = await fetchCryptoPulse({
    fetchImpl: async () => new Response("down", { status: 503 }),
  });
  assert.equal(isCryptoPulseUsable(empty), false);
  assert.equal(emptyErrors.length, 5);
  assert.equal(empty.mood, null);
  assert.deepEqual(empty.hot, []);
});
