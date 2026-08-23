/**
 * Deterministic crypto pulse data layer — Phase 1 foundation.
 *
 * Keyless providers:
 *  - CoinMarketCap Public API  https://pro-api.coinmarketcap.com/public-api
 *  - PanicRadar frontend API   https://panicradar.ai/api (undocumented; opportunistic)
 *
 * Every provider response is acquired with a bounded fetch (timeout, byte cap),
 * schema-validated into typed datasets, and isolated so a single provider
 * failure degrades only its own enrichment. This module never dispatches model
 * research and never stores Canvas state — it produces a provider-neutral,
 * domain-normalized snapshot for deterministic rendering and derived research.
 *
 * See docs/crypto-pulse-design.md for the source ownership matrix and freshness
 * semantics.
 */

/** Minimal fetch signature used by adapters and tests (injectable). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ── Provider endpoints ──────────────────────────────────────────────────────

const CMC_BASE_URL = "https://pro-api.coinmarketcap.com/public-api";
const CMC_GLOBAL_METRICS_URL = `${CMC_BASE_URL}/v1/global-metrics/quotes/latest?convert=USD`;
const CMC_FEAR_GREED_URL = `${CMC_BASE_URL}/v3/fear-and-greed/latest`;
const CMC_LISTINGS_URL = (limit: number) =>
  `${CMC_BASE_URL}/v3/cryptocurrency/listings/latest?start=1&limit=${limit}&convert=USD`;

const PANIC_RADAR_BASE_URL = "https://panicradar.ai";
const PANIC_RADAR_SUMMARY_URL = `${PANIC_RADAR_BASE_URL}/api/dashboard/summary`;
const PANIC_RADAR_PANIC_SCORE_URL = `${PANIC_RADAR_BASE_URL}/api/dashboard/panic-score`;

// ── Bounds ──────────────────────────────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
/**
 * PanicRadar is opportunistic enrichment: give it a short, independent latency
 * budget so a hung PanicRadar endpoint can never delay healthy CMC data.
 */
const DEFAULT_PANIC_RADAR_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
/**
 * How many CMC listings the dynamic drill-down universe covers. The design
 * doc says "display ≠ drill-down", but a static 14-asset registry chokes on
 * every rebrand and new listing. The top-100 by market cap is fetched live,
 * stablecoins excluded, and every row maps to a Yahoo pair via the
 * `<SYMBOL>-USD` convention (with a small override registry for known
 * collisions). Rows are selectable and openable like MOVERS.
 */
const MAX_LISTINGS = 100;
/** Stablecoins are excluded from the HOT/COLD scoreboard. */
const STABLECOIN_SYMBOLS = new Set([
  "USDT", "USDC", "DAI", "BUSD", "TUSD", "USDP", "PYUSD", "FDUSD", "USDE", "USDY", "RLUSD", "USDS",
]);

/**
 * Dynamic drill-down universe: no static registry. The CMC top-100 listings
 * ARE the universe (stablecoins excluded), so rebrands and new listings flow
 * in automatically. Yahoo pairs are derived as `<SYMBOL>-USD`, which matches
 * Yahoo's crypto convention for the vast majority of liquid assets; a small
 * override registry fixes documented collisions and an exclusion set drops
 * assets Yahoo has never hosted (verified live 2026-08-22).
 *
 * `null` returns mean "no reliable Yahoo pair — keep the row display-only";
 * the UI marks such rows as `DISPLAY-ONLY` instead of opening a broken
 * chart, per the design doc's "explicit open behavior" invariant.
 */
/*   This replaces the old `${SYMBOL}-USD`-only convention, which silently
 *   missed assets Yahoo hosts under numeric-suffix pairs (TRUMP→TRUMP35336-USD,
 *   ZRO→ZRO26997-USD, HYPE→HYPE32196-USD, verified 2026-08-22).
 */
export type YahooPairResolution = string | null;

/** Overrides for assets whose Yahoo pair differs from `<SYMBOL>-USD`. */
const YAHOO_SYMBOL_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  POL: "MATIC-USD", // Polygon rebrand: Yahoo quotes Polygon as MATIC-USD; POL-USD is Proof Of Liquidity
});

/** Symbols Yahoo has never charted as a crypto pair; rows stay display-only. */
const YAHOO_SYMBOL_EXCLUSIONS = new Set([
  "PEPE", "SUI", "UNI", "APT", "VVV", "PANG", "BB", "SUP", "INK", "WOL", "OQ", "ECL", // verified 2026-08-22: no pair
]);

export function yahooPairForSymbol(symbol: string): YahooPairResolution {
  const canonical = symbol.trim().toUpperCase();
  if (!canonical) return null;
  if (YAHOO_SYMBOL_EXCLUSIONS.has(canonical)) return null;
  return YAHOO_SYMBOL_OVERRIDES[canonical] ?? `${canonical}-USD`;
}

/**
 * Yahoo search URL for the crypto-pair lookup; quoted so the resolver can
 * discover numeric-suffix pairs (`<SYMBOL>12345-USD`) that never match the
 * `<SYMBOL>-USD` convention.
 */
export const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";

/**
 * Resolve a CMC symbol to the Yahoo pair that actually carries bars.
 *
 * `<SYMBOL>-USD` covers most liquid assets; when that comes back empty the
 * Yahoo search endpoint reveals numeric-suffix pairs (e.g. TRUMP35336-USD)
 * or confirms the asset is never charted (returns null). The result is cached
 * by the caller; this function is pure and does no caching of its own.
 */
export async function resolveYahooPair(
  symbol: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 4_000,
  maxResponseBytes = 64 * 1024,
): Promise<YahooPairResolution> {
  const canonical = symbol.trim().toUpperCase();
  const direct = yahooPairForSymbol(canonical);
  if (!direct) return null;
  // Probe the direct pair first.
  try {
    const chart = await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(direct)}?range=1mo&interval=1d`,
      fetchImpl,
      timeoutMs,
      maxResponseBytes,
    );
    const bars = (chart as { chart?: { result?: Array<{ timestamp?: unknown[] }> } })?.chart?.result?.[0]?.timestamp?.length ?? 0;
    if (bars > 0) return direct;
  } catch {
    // Fall through to search if the direct pair fails to parse.
  }
  // Search for the real crypto pair (numeric suffix or renamed ticker).
  try {
    const search = await fetchJson(
      `${YAHOO_SEARCH_URL}?q=${encodeURIComponent(canonical)}&quotesCount=8&newsCount=0`,
      fetchImpl,
      timeoutMs,
      maxResponseBytes,
    );
    const quotes = (search as { quotes?: Array<{ symbol?: unknown; quoteType?: unknown }> })?.quotes ?? [];
    const cryptoPair = quotes.find(
      (quote) => quote.quoteType === "CRYPTOCURRENCY" && typeof quote.symbol === "string" && /-USD$/.test(quote.symbol),
    )?.symbol;
    return typeof cryptoPair === "string" ? cryptoPair : null;
  } catch {
    return null;
  }
}

// ── Typed datasets ──────────────────────────────────────────────────────────

export type ProviderSource =
  | { provider: "cmc"; fetchedAt: number; sourceUpdatedAt?: number }
  | { provider: "panicRadar"; fetchedAt: number; sourceUpdatedAt?: number };

export interface CryptoGlobalMetrics {
  totalMarketCap: number;
  totalVolume24h: number;
  altcoinMarketCap: number;
  stablecoinMarketCap: number;
  changeYesterdayPercent: number | null;
  asOf: ProviderSource;
}

export interface CryptoFearGreed {
  value: number; // 0-100
  label: string;
  asOf: ProviderSource;
}

export interface CryptoListing {
  cmcId: number;
  symbol: string;
  name: string;
  slug: string;
  rank: number;
  price: number | null;
  marketCap: number | null;
  marketCapDominance: number | null;
  volume24h: number | null;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  /** CMC-provided tags; `stablecoin` distinguishes stables from their ticker. */
  tags: readonly string[];
  asOf: ProviderSource;
}

export interface PanicRadarSummary {
  sentimentScore: number;
  sentimentState: string;
  fearGreedIndex: number;
  fearGreedLabel: string;
  volatility24h: number;
  volatilityState: string;
  btcPrice: number | null;
  btcChange24h: number | null;
  btcChange7d: number | null;
  asOf: ProviderSource;
}

export interface PanicRadarPanicScore {
  panicScore: number;
  totalPosts: number;
  bearishPosts: number;
  bullishPosts: number;
  avgSentiment: number;
  sentimentLabel: string;
  asOf: ProviderSource;
}

/**
 * Deterministic mood-strip input, merged from CMC (primary) and PanicRadar
 * (opportunistic secondary). The terminal renderer consumes this directly.
 */
export interface CryptoMood {
  /** Primary 0-100 mood value (CMC Fear & Greed; PanicRadar index when CMC is down). */
  value: number;
  /** Upper-case label, e.g. "GREED" / "CALM" / "FEAR". */
  label: string;
  /** 0-10 filled blocks for an ASCII bar. */
  barFill: number;
  /** Contrarian PanicRadar signal (0-100, lower = calmer). */
  panicScore: number | null;
  panicLabel: string | null;
  btcDominancePercent: number | null;
  totalMarketCapUsd: number | null;
  totalMarketCapChangePercent: number | null;
  volatilityLabel: string | null;
  asOf: number;
  /** Which provider(s) backed this mood. */
  sources: ReadonlyArray<"cmc" | "panicRadar">;
}

/** HOTTEST/COLDEST scoreboard row for the interactive drill-down universe. */
export interface CryptoScoreboardRow {
  cmcId: number;
  symbol: string;
  yahooSymbol: string | null;
  rank: number;
  price: number | null;
  /** Signed 24h % change. COLDEST rows may be positive in broad rallies. */
  change24h: number;
  volume24h: number | null;
}

/** Broad-market display-only strip derived from the CMC top-N listings. */
export interface CryptoMoversStrip {
  /** Top leaders by 24h % (descending). */
  leaders: CryptoScoreboardRow[];
  /** Worst laggards by 24h % (ascending, worst first). */
  laggards: CryptoScoreboardRow[];
  /** Advance/decline breadth over the measured non-stable listings. */
  breadth: { advancing: number; declining: number; measured: number };
}

export interface CryptoPulseSnapshot {
  fetchedAt: number;
  providers: {
    cmc: boolean;
    panicRadar: boolean;
  };
  globalMetrics: CryptoGlobalMetrics | null;
  fearGreed: CryptoFearGreed | null;
  /** CMC top-N listings (display-only movers strip + breadth source). */
  listings: CryptoListing[];
  panicRadarSummary: PanicRadarSummary | null;
  panicScore: PanicRadarPanicScore | null;
  mood: CryptoMood | null;
  /**
   * HOTTEST (top half of the 14-asset universe by signed 24h move) and
   * COLDEST (bottom half, ascending). Both are relative rankings, so both
   * columns stay populated even in one-directional markets.
   */
  hot: CryptoScoreboardRow[];
  cold: CryptoScoreboardRow[];
  /** Universe assets with no finite 24h change; still selectable/openable. */
  unranked: CryptoScoreboardRow[];
  /** Broad-market display-only strip (never selectable). */
  movers: CryptoMoversStrip | null;
}

// ── Bounded fetch ───────────────────────────────────────────────────────────

export interface CryptoPulseFetchOptions {
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  /** Kill switch for the undocumented PanicRadar frontend API. Defaults to on. */
  panicRadarEnabled?: boolean;
  /** Independent latency budget for PanicRadar so it never blocks CMC. */
  panicRadarTimeoutMs?: number;
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("crypto pulse request timed out")), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`crypto pulse response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response too large");
        throw new Error(`crypto pulse response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchJson(
  url: string,
  fetchImpl: FetchLike,
  requestTimeoutMs: number,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const timed = timeoutSignal(signal, requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "market-terminal/0.1 (crypto-pulse)" },
      signal: timed.signal,
    });
    if (!response.ok) throw new Error(`crypto pulse endpoint returned HTTP ${response.status}`);
    const text = await readBoundedText(response, maxResponseBytes);
    return JSON.parse(text) as unknown;
  } finally {
    timed.cleanup();
  }
}

// ── Schema validation (defensive; never trust provider shapes) ──────────────

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function providerSource(provider: "cmc" | "panicRadar", fetchedAt: number, rawUpdatedAt: unknown): ProviderSource {
  const sourceUpdatedAt = asIsoTimestamp(rawUpdatedAt);
  return sourceUpdatedAt === undefined
    ? { provider, fetchedAt }
    : { provider, fetchedAt, sourceUpdatedAt };
}

function parseCmcGlobalMetrics(raw: unknown, fetchedAt: number): CryptoGlobalMetrics | null {
  const root = asRecord(raw);
  const data = root ? asRecord(root.data) : null;
  const quote = data ? asRecord(data.quote) : null;
  const usd = quote ? asRecord(quote.USD) : null;
  if (!usd) return null;
  const totalMarketCap = finiteNumber(usd.total_market_cap);
  const totalVolume24h = finiteNumber(usd.total_volume_24h);
  if (totalMarketCap === null || totalVolume24h === null) return null;
  return {
    totalMarketCap,
    totalVolume24h,
    altcoinMarketCap: finiteNumber(usd.altcoin_market_cap) ?? 0,
    stablecoinMarketCap: finiteNumber(usd.stablecoin_market_cap) ?? 0,
    changeYesterdayPercent: finiteNumber(usd.total_market_cap_yesterday_percentage_change),
    asOf: providerSource("cmc", fetchedAt, usd.last_updated),
  };
}

function parseCmcFearGreed(raw: unknown, fetchedAt: number): CryptoFearGreed | null {
  const root = asRecord(raw);
  const data = root ? asRecord(root.data) : null;
  if (!data) return null;
  const value = finiteNumber(data.value);
  const label = typeof data.value_classification === "string" ? data.value_classification : null;
  if (value === null) return null;
  return {
    value: Math.max(0, Math.min(100, value)),
    label: label ? label.toUpperCase() : "UNKNOWN",
    asOf: providerSource("cmc", fetchedAt, data.update_time),
  };
}

function parseCmcListing(raw: unknown, fetchedAt: number): CryptoListing | null {
  const item = asRecord(raw);
  if (!item) return null;
  const cmcId = finiteNumber(item.id);
  const rank = finiteNumber(item.cmc_rank);
  const symbol = typeof item.symbol === "string" ? item.symbol.trim().toUpperCase() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const slug = typeof item.slug === "string" ? item.slug.trim() : "";
  if (cmcId === null || rank === null || !symbol || !name) return null;
  const quote = Array.isArray(item.quote) ? asRecord(item.quote[0]) : null;
  if (!quote) return null;
  const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 40) : [];
  return {
    cmcId,
    symbol,
    name,
    slug,
    rank,
    price: finiteNumber(quote.price),
    marketCap: finiteNumber(quote.market_cap),
    marketCapDominance: finiteNumber(quote.market_cap_dominance),
    volume24h: finiteNumber(quote.volume_24h),
    change1h: finiteNumber(quote.percent_change_1h),
    change24h: finiteNumber(quote.percent_change_24h),
    change7d: finiteNumber(quote.percent_change_7d),
    tags,
    asOf: providerSource("cmc", fetchedAt, quote.last_updated),
  };
}

function parseCmcListings(raw: unknown, fetchedAt: number, limit: number): CryptoListing[] {
  const root = asRecord(raw);
  const data = root ? root.data : null;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => parseCmcListing(item, fetchedAt))
    .filter((listing): listing is CryptoListing => listing !== null)
    .slice(0, limit);
}

function parsePanicRadarSummary(raw: unknown, fetchedAt: number): PanicRadarSummary | null {
  const root = asRecord(raw);
  if (!root) return null;
  const sentimentScore = finiteNumber(root.sentiment_score);
  const fearGreedIndex = finiteNumber(root.fear_greed_index);
  const volatility24h = finiteNumber(root.volatility_24h);
  if (sentimentScore === null || fearGreedIndex === null || volatility24h === null) return null;
  return {
    sentimentScore,
    sentimentState: typeof root.sentiment_state === "string" ? root.sentiment_state : "Unknown",
    fearGreedIndex: Math.max(0, Math.min(100, fearGreedIndex)),
    fearGreedLabel: typeof root.fear_greed_label === "string" ? root.fear_greed_label.toUpperCase() : "UNKNOWN",
    volatility24h,
    volatilityState: typeof root.volatility_state === "string" ? root.volatility_state : "Unknown",
    btcPrice: finiteNumber(root.btc_price),
    btcChange24h: finiteNumber(root.btc_change_24h),
    btcChange7d: finiteNumber(root.btc_change_7d),
    asOf: providerSource("panicRadar", fetchedAt, root.timestamp),
  };
}

function parsePanicRadarPanicScore(raw: unknown, fetchedAt: number): PanicRadarPanicScore | null {
  const root = asRecord(raw);
  if (!root) return null;
  const panicScore = finiteNumber(root.panic_score);
  const totalPosts = finiteNumber(root.total_posts);
  if (panicScore === null || totalPosts === null) return null;
  return {
    panicScore: Math.max(0, Math.min(100, panicScore)),
    totalPosts,
    bearishPosts: finiteNumber(root.bearish_posts) ?? 0,
    bullishPosts: finiteNumber(root.bullish_posts) ?? 0,
    avgSentiment: finiteNumber(root.avg_sentiment) ?? 0,
    sentimentLabel: typeof root.sentiment_label === "string" ? root.sentiment_label.toUpperCase() : "UNKNOWN",
    asOf: providerSource("panicRadar", fetchedAt, undefined),
  };
}

// ── Deterministic derivation ────────────────────────────────────────────────

export function isStablecoinSymbol(symbol: string): boolean {
  return STABLECOIN_SYMBOLS.has(symbol.trim().toUpperCase());
}

/**
 * Rank the dynamic top-N listings by signed 24h move into relative HOTTEST
 * (top half) / COLDEST (bottom half, ascending). Both columns stay populated
 * in one-directional markets; signed percentages make a positive COLDEST row
 * legible. Stablecoins are excluded; assets without a finite 24h change land
 * in `unranked` (still selectable).
 */
export function buildUniverseScoreboard(
  listings: CryptoListing[],
): { hot: CryptoScoreboardRow[]; cold: CryptoScoreboardRow[]; unranked: CryptoScoreboardRow[] } {
  const toRow = (listing: CryptoListing): CryptoScoreboardRow => ({
    cmcId: listing.cmcId,
    symbol: listing.symbol,
    yahooSymbol: yahooPairForSymbol(listing.symbol),
    rank: listing.rank,
    price: listing.price,
    change24h: listing.change24h!,
    volume24h: listing.volume24h,
  });
  const eligible = listings.filter((listing) => !isStablecoinListing(listing));
  const ranked = eligible
    .filter((listing) => listing.change24h !== null && Number.isFinite(listing.change24h))
    .sort((a, b) => b.change24h! - a.change24h!);
  const unranked = eligible
    .filter((listing) => listing.change24h === null || !Number.isFinite(listing.change24h))
    .map(toRow);
  const hotCount = Math.ceil(ranked.length / 2);
  const hot = ranked.slice(0, hotCount).map(toRow);
  const cold = ranked.slice(hotCount).reverse().map(toRow);
  return { hot, cold, unranked };
}

/**
 * Merge CMC and PanicRadar into one deterministic mood-strip input.
 * CMC Fear & Greed is the primary value; PanicRadar is an opportunistic
 * secondary (contrarian panic score + volatility) that must never substitute
 * for the CMC-backed value when both are absent.
 */
export function deriveCryptoMood(
  fearGreed: CryptoFearGreed | null,
  globalMetrics: CryptoGlobalMetrics | null,
  panicRadarSummary: PanicRadarSummary | null,
  panicScore: PanicRadarPanicScore | null,
  listings: CryptoListing[],
  now: number,
): CryptoMood | null {
  const btcDominance = listings.find((listing) => listing.symbol === "BTC")?.marketCapDominance ?? null;
  const sources: Array<"cmc" | "panicRadar"> = [];
  let value: number | null = null;
  let label = "UNKNOWN";

  if (fearGreed) {
    value = fearGreed.value;
    label = fearGreed.label;
    sources.push("cmc");
  } else if (panicRadarSummary) {
    value = panicRadarSummary.fearGreedIndex;
    label = panicRadarSummary.fearGreedLabel;
    sources.push("panicRadar");
  }
  if (panicScore) sources.push("panicRadar");
  if (panicRadarSummary) sources.push("panicRadar");

  if (value === null) return null;
  const barFill = Math.round((value / 100) * 10);
  return {
    value,
    label,
    barFill: Math.max(0, Math.min(10, barFill)),
    panicScore: panicScore?.panicScore ?? null,
    panicLabel: panicScore?.sentimentLabel ?? null,
    btcDominancePercent: btcDominance,
    totalMarketCapUsd: globalMetrics?.totalMarketCap ?? null,
    totalMarketCapChangePercent: globalMetrics?.changeYesterdayPercent ?? null,
    volatilityLabel: panicRadarSummary?.volatilityState ?? null,
    asOf: now,
    sources: [...new Set(sources)],
  };
}

/**
 * Stablecoin detection: prefer the CMC `stablecoin` tag, fall back to an
 * uppercased symbol denylist for providers that omit tags. The tag is the
 * primary signal; the denylist is a defensive fallback, not the classifier.
 */
export function isStablecoinListing(listing: CryptoListing): boolean {
  if (listing.tags.some((tag) => tag.toLowerCase() === "stablecoin")) return true;
  return isStablecoinSymbol(listing.symbol);
}

/**
 * Broad-market display-only strip: leaders/laggards from the CMC top-N listings
 * (stablecoins excluded) plus advance/decline breadth. Never selectable; it is
 * a glance surface, not a drill-down list.
 */
export function buildMoversStrip(
  listings: CryptoListing[],
  leaderLimit: number,
): CryptoMoversStrip | null {
  const measured = listings
    .filter((listing) => !isStablecoinListing(listing)
      && listing.change24h !== null && Number.isFinite(listing.change24h))
    .sort((a, b) => b.change24h! - a.change24h!);
  if (measured.length === 0) return null;
  const toRow = (listing: CryptoListing): CryptoScoreboardRow => ({
    cmcId: listing.cmcId,
    symbol: listing.symbol,
    yahooSymbol: null, // display-only: no drill-down
    rank: listing.rank,
    price: listing.price,
    change24h: listing.change24h!,
    volume24h: listing.volume24h,
  });
  const advancing = measured.filter((listing) => listing.change24h! > 0).length;
  const declining = measured.filter((listing) => listing.change24h! < 0).length;
  return {
    leaders: measured.slice(0, leaderLimit).map(toRow),
    laggards: measured.slice(-leaderLimit).reverse().map(toRow),
    breadth: { advancing, declining, measured: measured.length },
  };
}

// ── Snapshot fetch (per-provider isolation) ─────────────────────────────────

export interface FetchCryptoPulseResult {
  snapshot: CryptoPulseSnapshot;
  errors: string[];
}

/**
 * Fetch every crypto pulse dataset concurrently with per-provider isolation.
 * A provider failure records an error and yields null datasets for its groups —
 * it never rejects the whole snapshot, so enrichment degrades while the rest
 * of the terminal stays healthy.
 *
 * CMC and PanicRadar run concurrently: PanicRadar's own short budget (4s) means
 * a hung endpoint adds at most that budget once — it never stacks on CMC's
 * latency. CMC's board source is the by-ID quotes fetch, so the 14-asset board
 * is stable across CMC rank churn; the top-N listings feed only the display-only
 * movers strip and breadth.
 */
export async function fetchCryptoPulse(
  options: CryptoPulseFetchOptions = {},
  signal?: AbortSignal,
): Promise<FetchCryptoPulseResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const panicRadarTimeoutMs = options.panicRadarTimeoutMs ?? DEFAULT_PANIC_RADAR_TIMEOUT_MS;
  const panicRadarEnabled = options.panicRadarEnabled !== false;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const now = options.now ?? Date.now;
  const fetchedAt = now();
  const errors: string[] = [];

  const guard = async <T>(label: string, task: () => Promise<T>): Promise<T | null> => {
    try {
      return await task();
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const cmcTask = Promise.all([
    guard("cmc.global-metrics", async () => {
      const raw = await fetchJson(CMC_GLOBAL_METRICS_URL, fetchImpl, requestTimeoutMs, maxResponseBytes, signal);
      return parseCmcGlobalMetrics(raw, fetchedAt);
    }),
    guard("cmc.fear-and-greed", async () => {
      const raw = await fetchJson(CMC_FEAR_GREED_URL, fetchImpl, requestTimeoutMs, maxResponseBytes, signal);
      return parseCmcFearGreed(raw, fetchedAt);
    }),
    guard("cmc.listings", async () => {
      const raw = await fetchJson(CMC_LISTINGS_URL(MAX_LISTINGS), fetchImpl, requestTimeoutMs, maxResponseBytes, signal);
      return parseCmcListings(raw, fetchedAt, MAX_LISTINGS);
    }),
  ]);

  const panicTask = panicRadarEnabled
    ? Promise.all([
        guard("panicRadar.summary", async () => {
          const raw = await fetchJson(PANIC_RADAR_SUMMARY_URL, fetchImpl, panicRadarTimeoutMs, maxResponseBytes, signal);
          return parsePanicRadarSummary(raw, fetchedAt);
        }),
        guard("panicRadar.panic-score", async () => {
          const raw = await fetchJson(PANIC_RADAR_PANIC_SCORE_URL, fetchImpl, panicRadarTimeoutMs, maxResponseBytes, signal);
          return parsePanicRadarPanicScore(raw, fetchedAt);
        }),
      ])
    : Promise.resolve([null, null] as const);

  const [[globalMetrics, fearGreed, listings], [panicRadarSummary, panicScore]] = await Promise.all([
    cmcTask,
    panicTask,
  ]);

  const parsedListings = listings ?? [];
  const mood = deriveCryptoMood(fearGreed, globalMetrics, panicRadarSummary, panicScore, parsedListings, fetchedAt);
  const { hot, cold, unranked } = buildUniverseScoreboard(parsedListings);
  const movers = buildMoversStrip(parsedListings, 3);

  return {
    snapshot: {
      fetchedAt,
      providers: {
        cmc: Boolean(globalMetrics || fearGreed || parsedListings.length > 0),
        panicRadar: Boolean(panicRadarSummary || panicScore),
      },
      globalMetrics,
      fearGreed,
      listings: parsedListings,
      panicRadarSummary,
      panicScore,
      mood,
      hot,
      cold,
      unranked,
      movers,
    },
    errors,
  };
}

// ── Freshness (snapshot TTL + stale fallback) ───────────────────────────────

/**
 * A snapshot is "usable" when it carries at least one renderable dataset
 * (a mood or any board rows). Unusable snapshots must never be cached or used to
 * replace a previously good snapshot — they represent a provider outage, not a
 * real state change.
 */
export function isCryptoPulseUsable(snapshot: CryptoPulseSnapshot): boolean {
  return snapshot.mood !== null
    || snapshot.hot.length > 0
    || snapshot.cold.length > 0
    || snapshot.unranked.length > 0;
}

/**
 * Simple in-memory snapshot cache. Callers today store one snapshot under one
 * TTL (provider cadences are not yet per-dataset). The stale-while-revalidate
 * fallback returns the last value even when expired, with no maximum stale age.
 */
export class CryptoPulseCache {
  private readonly entries = new Map<string, { fetchedAt: number; value: unknown }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number = 60_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  set(key: string, value: unknown): void {
    this.entries.set(key, { fetchedAt: this.now(), value });
  }

  getFresh<T>(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return this.now() - entry.fetchedAt < this.ttlMs ? entry.value as T : null;
  }

  /** Stale-while-revalidate fallback; returns the last value even when expired. */
  getStale<T>(key: string): T | null {
    return (this.entries.get(key)?.value as T | undefined) ?? null;
  }

  clear(): void {
    this.entries.clear();
  }
}
