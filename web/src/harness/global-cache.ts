/** Authenticated read-only helper for the shared global research cache. */
import { browserApiUrl } from "./browser-api.js";

export interface GlobalCacheQuery {
  symbol: string;
  chartScope: string;
  researchKey: string;
  intent: string;
}

export interface GlobalCacheHit {
  version: 1;
  provenance: "global";
  cacheKey: string;
  identity: GlobalCacheQuery;
  kind: string;
  canvas: unknown;
  quality: { usable: boolean; fetchedCount: number; qualityVersion: number };
  asOf: number;
  generatedAt: number;
  expiresAt: number;
  source: { title: string; url?: string; publishedAt?: number };
}

/** Exact-identity lookup. Returns undefined on miss/expiry so callers fall back to live research. */
export async function fetchGlobalCacheEntry(
  query: GlobalCacheQuery,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<GlobalCacheHit | undefined> {
  const url = new URL(browserApiUrl("/api/browser/v1/global-cache"));
  url.searchParams.set("symbol", query.symbol);
  url.searchParams.set("scope", query.chartScope);
  url.searchParams.set("researchKey", query.researchKey);
  url.searchParams.set("intent", query.intent);
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`global cache lookup returned HTTP ${response.status}`);
  const parsed = (await response.json()) as GlobalCacheHit;
  if (!parsed || parsed.version !== 1 || parsed.provenance !== "global" || !parsed.canvas) return undefined;
  return parsed;
}
