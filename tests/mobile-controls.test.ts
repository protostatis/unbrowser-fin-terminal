import assert from "node:assert/strict";
import test from "node:test";
import {
  horizontalSwipeInput,
  isValidSymbolInput,
  mobileActions,
  normalizeSymbolInput,
  symbolSearchInputs,
  TERMINAL_INPUTS,
} from "../web/src/mobile-controls.js";

test("mobile actions adapt to market, ticker, research, and cache states", () => {
  const market = mobileActions({ mode: "market" });
  assert.equal(market[0]?.id, "help");
  assert.equal(market.find((action) => action.id === "brief")?.label, "Open");
  assert.equal(market.at(-1)?.id, "search");

  const signals = mobileActions({ mode: "market", screen: "SIGNALS" });
  assert.equal(signals[0]?.id, "pane");
  assert.equal(signals.find((action) => action.id === "older")?.input, "[");

  const ticker = mobileActions({ mode: "ticker", watched: true });
  assert.equal(ticker[0]?.id, "back");
  assert.equal(ticker.find((action) => action.id === "watch")?.label, "Unwatch");

  const researching = mobileActions({
    mode: "market",
    research: { active: true },
  });
  assert.equal(
    researching.find((action) => action.id === "cancel-research")?.input,
    "c",
  );

  const cache = mobileActions({ mode: "ticker", cacheDecision: {} });
  assert.deepEqual(cache.map((action) => action.id), [
    "use-cache",
    "refresh-cache",
    "cancel-cache",
  ]);
});

test("mobile symbol entry normalizes valid stock, index, and crypto symbols", () => {
  assert.equal(normalizeSymbolInput(" btc-usd "), "BTC-USD");
  assert.equal(normalizeSymbolInput("^gspc!"), "^GSPC");
  assert.equal(isValidSymbolInput("AAPL"), true);
  assert.equal(isValidSymbolInput("^GSPC"), true);
  assert.equal(isValidSymbolInput("BTC-USD"), true);
  assert.equal(isValidSymbolInput("123"), false);
  assert.deepEqual(symbolSearchInputs("btc-usd"), [
    "/",
    "B",
    "T",
    "C",
    "-",
    "U",
    "S",
    "D",
    TERMINAL_INPUTS.enter,
  ]);
  assert.deepEqual(symbolSearchInputs(""), []);
});

test("only deliberate horizontal swipes change terminal screens", () => {
  const start = { x: 200, y: 100, at: 1000 };
  assert.equal(
    horizontalSwipeInput(start, { x: 120, y: 105, at: 1250 }),
    TERMINAL_INPUTS.right,
  );
  assert.equal(
    horizontalSwipeInput(start, { x: 280, y: 95, at: 1250 }),
    TERMINAL_INPUTS.left,
  );
  assert.equal(horizontalSwipeInput(start, { x: 175, y: 104, at: 1200 }), null);
  assert.equal(horizontalSwipeInput(start, { x: 120, y: 190, at: 1200 }), null);
  assert.equal(horizontalSwipeInput(start, { x: 100, y: 100, at: 2100 }), null);
});
