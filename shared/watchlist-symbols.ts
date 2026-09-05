/** Shared symbol validation and bounded watchlist update rules. */

/** Bound the Yahoo refresh fan-out to a practical interactive watchlist size. */
export const WATCHLIST_MAX_SYMBOLS = 50;

export type WatchlistUpdateMode = "merge" | "replace";

export type WatchlistUpdate = {
  symbols: string[];
  added: number;
  invalid: number;
  duplicates: number;
  truncated: number;
};

/** Accept the Yahoo Finance symbol formats the terminal can fetch. */
export function normalizeWatchlistSymbol(value: string): string | undefined {
  const symbol = value.trim().toUpperCase();
  return /^(\^?[A-Z][A-Z0-9.\-=]{0,31}|[0-9]{6}\.(SS|SZ))$/.test(symbol)
    ? symbol
    : undefined;
}

/**
 * Build a bounded, ordered next list without mutating the caller's array.
 * Existing symbols retain their order for merges; imported symbols are appended
 * in the reviewed order from the screenshot.
 */
export function updateWatchlistSymbols(
  existing: readonly string[],
  imported: readonly string[],
  mode: WatchlistUpdateMode,
  maximum = WATCHLIST_MAX_SYMBOLS,
): WatchlistUpdate {
  const limit = Math.max(1, Math.floor(maximum));
  const symbols: string[] = [];
  const seen = new Set<string>();

  if (mode === "merge") {
    for (const raw of existing) {
      const symbol = normalizeWatchlistSymbol(raw);
      if (!symbol || seen.has(symbol) || symbols.length >= limit) continue;
      seen.add(symbol);
      symbols.push(symbol);
    }
  }

  let added = 0;
  let invalid = 0;
  let duplicates = 0;
  let truncated = 0;
  for (const raw of imported) {
    const symbol = normalizeWatchlistSymbol(raw);
    if (!symbol) {
      invalid++;
      continue;
    }
    if (seen.has(symbol)) {
      duplicates++;
      continue;
    }
    if (symbols.length >= limit) {
      truncated++;
      continue;
    }
    seen.add(symbol);
    symbols.push(symbol);
    added++;
  }

  return { symbols, added, invalid, duplicates, truncated };
}
