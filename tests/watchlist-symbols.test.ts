import assert from "node:assert/strict";
import test from "node:test";
import {
  WATCHLIST_MAX_SYMBOLS,
  normalizeWatchlistSymbol,
  updateWatchlistSymbols,
} from "../shared/watchlist-symbols.js";

test("normalizes the Yahoo symbol formats used by the terminal", () => {
  assert.equal(normalizeWatchlistSymbol(" btc-usd "), "BTC-USD");
  assert.equal(normalizeWatchlistSymbol("sui20947-usd"), "SUI20947-USD");
  assert.equal(normalizeWatchlistSymbol("^gspc"), "^GSPC");
  assert.equal(normalizeWatchlistSymbol("000001.ss"), "000001.SS");
  assert.equal(normalizeWatchlistSymbol("BTC/USD"), undefined);
  assert.equal(normalizeWatchlistSymbol(""), undefined);
});

test("merging preserves current order and appends only valid new symbols", () => {
  const result = updateWatchlistSymbols(
    ["SPY", "BTC-USD", "SPY"],
    ["eth-usd", "BTC-USD", "not valid", "AAPL"],
    "merge",
  );

  assert.deepEqual(result.symbols, ["SPY", "BTC-USD", "ETH-USD", "AAPL"]);
  assert.equal(result.added, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid, 1);
});

test("replacement is bounded to the shared watchlist capacity", () => {
  const symbols = Array.from({ length: WATCHLIST_MAX_SYMBOLS + 2 }, (_, index) => `S${index}`);
  const result = updateWatchlistSymbols([], symbols, "replace");

  assert.equal(result.symbols.length, WATCHLIST_MAX_SYMBOLS);
  assert.equal(result.added, WATCHLIST_MAX_SYMBOLS);
  assert.equal(result.truncated, 2);
});
