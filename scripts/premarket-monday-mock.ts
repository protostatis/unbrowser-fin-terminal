/**
 * Monday pre-market mock — run the REAL parser + mover pipeline against a
 * synthetic Monday (2026-08-24) pre-market feed, and print the MOVERS screen.
 *
 * Sources the same mock payloads the extension serves under MARKET_MOCK_MONDAY=1
 * (scripts/premarket-monday-mock → .pi/extensions/market-terminal.ts), so what
 * you see here is what `MARKET_MOCK_MONDAY=1 npm run dev` renders.
 *
 * Usage:
 *   npx tsx scripts/premarket-monday-mock.ts
 *   MARKET_MOCK_MONDAY=1 npm run dev   # live terminal with Monday pre-market data
 */
import assert from "node:assert/strict";
import {
  mockMondayChartPayload,
  parseChartPayloadToQuote,
  rankMovers,
  moverVolumeRowLabel,
} from "../.pi/extensions/market-terminal.js";

const SYMBOLS = ["NVDA", "CRWD", "TSLA", "MSFT", "AMD", "META", "GOOGL", "AAPL"];

const quotes = SYMBOLS.map((symbol) =>
  parseChartPayloadToQuote(symbol, mockMondayChartPayload(symbol), {
    yahooInterval: "5m",
    includePrePost: true,
    chartScope: "day",
  }),
);
const movers = rankMovers(quotes);

// Contract assertions — the whole point of the mock is proving the PRE session
// path that the real feed can't produce on a weekend.
assert.ok(quotes.length === 8, "8 mock quotes");
for (const quote of quotes) {
  assert.ok(quote.marketState === "PRE", `${quote.symbol} should classify PRE from a Monday pre bar`);
  assert.ok(Number.isFinite(quote.price) && quote.price > 0);
  assert.ok(Math.abs(quote.changePercent!) < 10, `${quote.symbol} move within band`);
}
assert.equal(quotes.every((q) => q.preMarketVolume === null), true, "public feed: no pre volume");
assert.equal(quotes.every((q) => q.volume! > 0), true, "Friday regular volume present (proxy leg)"); 
assert.equal(movers.some((m) => m.volumeProxied), true, "proxy basis engaged (no live extended volume)");
console.log("contract assertions OK");

const sessionTag = movers.some((m) => (m.quote.marketState || "").toUpperCase().startsWith("PRE")) ? "PRE-MKT" : "";
const moveOnly = movers.every((m) => m.moveOnly);
const scoringNote = moveOnly
  ? "MOVE-ONLY · NO VOL DATA"
  : movers.some((m) => m.volumeProxied)
    ? "65% MOVE / 35% $VOL · VOL~ PROXY"
    : "65% MOVE / 35% $VOL";
console.log(`\nMOVERS SCREEN (as of Mon 2026-08-24 ~08:55 ET)`);
console.log(`TITLE: ${sessionTag ? sessionTag + " · " : ""}AUTO MOVERS · ${movers.length}/100 · DAY · AGE 0s · ${scoringNote}`);
for (const [i, m] of movers.entries()) {
  const q = m.quote;
  const tone = (q.change ?? 0) >= 0 ? "+" : "";
  console.log(
    `#${String(i + 1).padStart(2, "0")} ${q.symbol.padEnd(6)} ${tone}${(q.changePercent ?? 0).toFixed(2)}% `.padEnd(18) +
      `${moverVolumeRowLabel(q, m.volumeBasis).padEnd(12)} ` +
      `src=${m.volumeSource} prox=${m.volumeProxied} moveOnly=${m.moveOnly} $vol=${(m.dollarVolume / 1e6).toFixed(1)}M`,
  );
}