import assert from "node:assert/strict";
import test from "node:test";
import registerMarketExtension, {
	setCryptoPulseChartFetchImplForTest,
	setCryptoPulseFetchImplForTest,
} from "../.pi/extensions/market-terminal.js";

type TestTool = {
  name: string;
  execute: (...args: any[]) => Promise<any>;
};

function registeredTools(): Map<string, TestTool> {
  const tools = new Map<string, TestTool>();
  registerMarketExtension({
    on() {},
    registerCommand() {},
    registerTool(tool: TestTool) {
      tools.set(tool.name, tool);
    },
    sendUserMessage() {},
  } as any);
  return tools;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Deterministic crypto pulse fixture so the UI test never touches the network. */
function cryptoPulseFixtureFetch(url: string): Response {
	if (url.includes("/v8/finance/chart/")) {
		const timestamps = Array.from({ length: 12 }, (_, index) => 1_756_000_000 + index * 300);
		const closes = [0.100, 0.102, 0.101, 0.104, 0.106, 0.105, 0.108, 0.109, 0.107, 0.110, 0.111, 0.112];
		const opens = closes.map((close, index) => index === 0 ? close - 0.001 : closes[index - 1]!);
		const highs = closes.map((close, index) => Math.max(close, opens[index]!) + 0.001);
		const lows = closes.map((close, index) => Math.min(close, opens[index]!) - 0.001);
		return jsonResponse({ chart: { result: [{
			meta: {
				currency: "USD", symbol: "DOGE-USD", shortName: "Dogecoin",
				regularMarketPrice: 0.112, previousClose: 0.100, chartPreviousClose: 0.100,
				regularMarketDayLow: 0.099, regularMarketDayHigh: 0.113, regularMarketVolume: 12_000_000,
				regularMarketTime: timestamps.at(-1), exchangeTimezoneName: "UTC", dataGranularity: "5m",
				currentTradingPeriod: { regular: { start: timestamps[0], end: timestamps.at(-1)! + 300 } },
			},
			timestamp: timestamps,
			indicators: { quote: [{ close: closes, open: opens, high: highs, low: lows, volume: timestamps.map((_, index) => 100 + index * 10) }] },
		}] } });
	}
	if (url.includes("/v1/finance/search")) {
		return jsonResponse({ quotes: [{ symbol: "DOGE-USD", quoteType: "CRYPTOCURRENCY" }] });
	}
	if (url.includes("/global-metrics/")) {
    return jsonResponse({ data: { quote: { USD: {
      total_market_cap: 2607236260883.6235,
      total_volume_24h: 167449014414.27,
      altcoin_market_cap: 1e12,
      stablecoin_market_cap: 2.8e11,
      total_market_cap_yesterday_percentage_change: 2.13,
      last_updated: "2026-08-22T14:18:00.000Z",
    } } } });
  }
  if (url.includes("/fear-and-greed/")) {
    return jsonResponse({ data: { value: 76, update_time: "2026-08-22T14:08:10.067Z", value_classification: "Greed" } });
  }
  if (url.includes("/listings/")) {
    const listing = (id: number, symbol: string, name: string, rank: number, price: number, change24h: number, dominance: number, tags: string[] = []) => ({
      id, symbol, name, slug: symbol.toLowerCase(), cmc_rank: rank, tags,
      quote: [{ symbol: "USD", price, volume_24h: 1e9, market_cap: 1e11, market_cap_dominance: dominance, percent_change_24h: change24h, percent_change_7d: change24h * 2 }],
    });
    return jsonResponse({ data: [
      listing(1, "BTC", "Bitcoin", 1, 76959, 0.41, 59.24),
      listing(1027, "ETH", "Ethereum", 2, 2427, 2.5, 11.4),
      listing(825, "USDT", "Tether", 3, 1.0, 0.03, 4.6, ["stablecoin"]),
      listing(74, "DOGE", "Dogecoin", 9, 0.108, 8.5, 0.2),
      listing(52, "XRP", "XRP", 4, 0.62, -3.1, 1.2),
      listing(5426, "SOL", "Solana", 5, 144, 2.0, 2.5),
      listing(2010, "ADA", "Cardano", 14, 0.99, 1.9, 0.3),
    ] });
  }
  if (url.includes("/dashboard/summary")) {
    return jsonResponse({
      timestamp: "2026-08-22T14:18:42.573039+00:00",
      sentiment_score: -0.006, sentiment_state: "Neutral",
      fear_greed_index: 71, fear_greed_label: "Greed",
      volatility_24h: 4.53, volatility_state: "High",
      btc_price: 77044, btc_change_24h: 5.47, btc_change_7d: 22.32,
    });
  }
  if (url.includes("/dashboard/panic-score")) {
    return jsonResponse({
      panic_score: 15.5, total_posts: 228, bearish_posts: 25, bullish_posts: 27,
      avg_sentiment: 0.006, sentiment_label: "Calm",
    });
  }
  return new Response("not found", { status: 404 });
}

async function waitForState(uiTest: TestTool, predicate: (state: any) => boolean, timeoutMs = 2_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await uiTest.execute("state", { action: "state", width: 110, height: 30 });
    if (predicate(result.details.state)) return result.details.state;
    if (Date.now() > deadline) throw new Error("crypto pulse state did not settle in time");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function waitForScreen(uiTest: TestTool, predicate: (lines: string[]) => boolean, timeoutMs = 2_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await uiTest.execute("state", { action: "state", width: 110, height: 30 });
    const lines: string[] = result.details.screen;
    if (predicate(lines)) return lines;
    if (Date.now() > deadline) throw new Error("crypto pulse screen did not settle in time");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

type FixtureMode = "full" | "all-fail" | "board-only";

/** Mutable fixture fetch so a test can flip providers between refreshes. */
function fixtureFetch(mode: FixtureMode): (url: string) => Response {
  return (url: string): Response => {
    if (mode === "all-fail") return new Response("down", { status: 503 });
    if (mode === "board-only") {
      // Only the listings route succeeds: the board survives, mood is absent.
      if (url.includes("/listings/")) return cryptoPulseFixtureFetch(url);
      return new Response("down", { status: 503 });
    }
    return cryptoPulseFixtureFetch(url);
  };
}

test.after(() => {
	setCryptoPulseChartFetchImplForTest(undefined);
	setCryptoPulseFetchImplForTest(undefined);
});

test("G toggles the MARKET screen between GLOBAL and CRYPTO PULSE subviews", async () => {
  setCryptoPulseFetchImplForTest(cryptoPulseFixtureFetch);
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest, "market_ui_test should be registered");

  await uiTest.execute("reset", { action: "reset" });
  await uiTest.execute("open_market", { action: "open_market" });

  const before = await uiTest.execute("state", { action: "state", width: 110, height: 30 });
  assert.equal(before.details.state.marketView, "global");

  await uiTest.execute("press", { action: "press", button: "button_g" });
  const cryptoState = await waitForState(uiTest, (state: any) => state.marketView === "crypto" && state.cryptoPulse?.state === "ready");

  assert.equal(cryptoState.marketView, "crypto");
  assert.equal(cryptoState.screen, "MARKET");
  const pulse = cryptoState.cryptoPulse;
  assert.equal(pulse.moodValue, 76);
  assert.equal(pulse.moodLabel, "GREED");
  assert.equal(pulse.panicScore, 15.5);
  // Dynamic board ranked by 24h (6 non-stable listings → 3/3 split):
  // DOGE best, then ETH, SOL; cold = ADA, BTC, XRP (ascending, worst first).
  assert.deepEqual(pulse.hot.map((row: any) => row.symbol), ["DOGE", "ETH", "SOL"]);
  assert.deepEqual(pulse.cold.map((row: any) => row.symbol), ["XRP", "BTC", "ADA"]);
  assert.equal(pulse.hot[0].yahooSymbol, "DOGE-USD");

  // Toggle back to global.
  await uiTest.execute("press", { action: "press", button: "button_g" });
  const back = await uiTest.execute("state", { action: "state", width: 110, height: 30 });
  assert.equal(back.details.state.marketView, "global");
});

test("Crypto Pulse renders the mood strip and HOT/COLD scoreboard in char cells", async () => {
  setCryptoPulseFetchImplForTest(cryptoPulseFixtureFetch);
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest);

  await uiTest.execute("reset", { action: "reset" });
  await uiTest.execute("open_market", { action: "open_market" });
  await uiTest.execute("press", { action: "press", button: "button_g" });
  await waitForState(uiTest, (state: any) => state.cryptoPulse?.state === "ready");

  const rendered = await uiTest.execute("state", { action: "state", width: 110, height: 30 });
  const lines: string[] = rendered.details.screen;
  assert.ok(lines.some((line: string) => line.includes("CRYPTO PULSE")), "header should render");
  assert.ok(lines.some((line: string) => line.includes("MOOD [")), "mood strip should render");
  assert.ok(lines.some((line: string) => /MOOD/.test(line) && /76 GREED/.test(line)), "mood value/label should render");
  assert.ok(lines.some((line: string) => /PANIC 15/.test(line)), "panic score should render");
  assert.ok(lines.some((line: string) => /BTC\.D 59\.2%/.test(line)), "BTC dominance should render");
  assert.ok(lines.some((line: string) => /BREADTH/.test(line)), "breadth should render");
  // Wide layout: HOTTEST/COLDEST are side-by-side columns.
  assert.ok(lines.some((line: string) => line.includes("HOTTEST")), "HOTTEST scoreboard should render");
  assert.ok(lines.some((line: string) => line.includes("COLDEST")), "COLDEST scoreboard should render");
  assert.ok(lines.some((line: string) => line.includes("RELATIVE 24H")), "relative ranking should be labeled");
  assert.ok(lines.some((line: string) => /DOGE/.test(line) && /8\.5/.test(line)), "HOTTEST row should show DOGE +8.50%");
  assert.ok(lines.some((line: string) => /XRP/.test(line) && /-3\.1/.test(line)), "COLDEST row should show XRP -3.10%");
  assert.equal(lines.some((line: string) => line.includes("SNAPSHOT · 0 QUOTES")), false, "crypto footer must not report the unrelated global snapshot");
  // Display-only broad-market strip renders and is labeled.
  const stripIdx = lines.findIndex((line: string) => line.includes("TOP-20 MOVERS"));
  assert.ok(stripIdx >= 0, "movers strip should render");
  assert.ok(stripIdx < 20, `movers strip must sit under the board, not be stranded at the bottom (index ${stripIdx})`);

  // Narrow layout: single merged HOTTEST•COLDEST board header + window label.
  const narrow = await uiTest.execute("state", { action: "state", width: 80, height: 30 });
  const narrowLines: string[] = narrow.details.screen;
  assert.ok(narrowLines.some((line: string) => line.includes("HOTTEST")), "stacked board header should render");
  assert.ok(narrowLines.some((line: string) => line.includes("COLDEST")), "stacked board header should mention COLDEST");
});

test("compact Crypto Pulse keeps the complete chart tail at mobile heights", async () => {
	setCryptoPulseFetchImplForTest(cryptoPulseFixtureFetch);
	setCryptoPulseChartFetchImplForTest(cryptoPulseFixtureFetch);
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest);

  await uiTest.execute("reset", { action: "reset" });
	await uiTest.execute("open_market", { action: "open_market" });
	await uiTest.execute("press", { action: "press", button: "button_g" });
	await waitForState(uiTest, (state: any) => state.cryptoPulse?.state === "ready");
	for (let index = 0; index < 5; index++) await uiTest.execute("press", { action: "press", button: "dpad_down" });
	await waitForScreen(uiTest, (lines) => lines.some((line) => line.includes("CANDLE")));

	for (const [width, height] of [[48, 20], [60, 22], [48, 24], [80, 30]] as const) {
		const rendered = await uiTest.execute("state", { action: "state", width, height });
		const lines: string[] = rendered.details.screen;
		assert.ok(lines.some((line: string) => line.includes("PRICE CHART")), `${width}x${height} compact must show PRICE CHART`);
		assert.ok(lines.some((line: string) => line.includes("CANDLE")), `${width}x${height} chart legend must survive`);
		assert.ok(lines.some((line: string) => line.includes("VOL")), `${width}x${height} chart volume row must survive`);
		assert.ok(lines.some((line: string) => line.includes("UTC")), `${width}x${height} chart time axis must survive`);
		assert.ok(lines.some((line: string) => line.includes("Range")), `${width}x${height} chart range must survive`);
		assert.ok(lines.some((line: string) => line.includes("►")), `${width}x${height} selected board row must survive chart fitting`);
		assert.ok(!lines.some((line: string) => line.includes("TOP-20")), `${width}x${height} compact must suppress TOP-20 display-only strip`);
		assert.ok(!lines.some((line: string) => line.includes("UNRANKED")), `${width}x${height} compact must suppress UNRANKED`);
	}
});

test("leaving the MARKET screen resets the crypto subview to GLOBAL", async () => {
  setCryptoPulseFetchImplForTest(cryptoPulseFixtureFetch);
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest);

  await uiTest.execute("reset", { action: "reset" });
  await uiTest.execute("open_market", { action: "open_market" });
  await uiTest.execute("press", { action: "press", button: "button_g" });
  await waitForState(uiTest, (state: any) => state.marketView === "crypto");

  await uiTest.execute("press", { action: "press", button: "dpad_right" });
  const moved = await uiTest.execute("state", { action: "state", width: 110, height: 30 });
  assert.notEqual(moved.details.state.screen, "MARKET");
  assert.equal(moved.details.state.marketView, "global");
});

test("J opens the visible crypto row and preserves the subview in return state", async () => {
  setCryptoPulseFetchImplForTest((url) => fixtureFetch("full")(url));
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest);

  await uiTest.execute("reset", { action: "reset" });
  await uiTest.execute("open_market", { action: "open_market" });
  await uiTest.execute("press", { action: "press", button: "button_g" });
  await waitForState(uiTest, (state: any) => state.cryptoPulse?.state === "ready");

  // Default selection is the first HOT row (DOGE).
  await uiTest.execute("press", { action: "press", button: "button_j" });
  const opened = await uiTest.execute("state", { action: "state", width: 110, height: 30 });
  assert.equal(opened.details.lastAction?.action, "quote");
  assert.equal(opened.details.lastAction?.symbol, "DOGE-USD");
  assert.equal(opened.details.lastAction?.returnState?.marketView, "crypto");

  // Move selection down to ETH and open that row.
  await uiTest.execute("press", { action: "press", button: "button_g" });
  await uiTest.execute("press", { action: "press", button: "button_g" });
  await waitForState(uiTest, (state: any) => state.marketView === "crypto");
  await uiTest.execute("press", { action: "press", button: "dpad_down" });
  await uiTest.execute("press", { action: "press", button: "button_j" });
  const second = await uiTest.execute("state", { action: "state", width: 110, height: 30 });
  assert.equal(second.details.lastAction?.action, "quote");
  assert.equal(second.details.lastAction?.symbol, "ETH-USD");
  assert.equal(second.details.state.cryptoPulse?.selectedIndex, 1);
  assert.equal(second.details.state.cryptoPulse?.selectedSymbol, "ETH-USD");
});

test("failed refresh preserves previously good data instead of blanking it", async () => {
  let mode: FixtureMode = "full";
  setCryptoPulseFetchImplForTest((url) => fixtureFetch(mode)(url));
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest);

  await uiTest.execute("reset", { action: "reset" });
  await uiTest.execute("open_market", { action: "open_market" });
  await uiTest.execute("press", { action: "press", button: "button_g" });
  await waitForState(uiTest, (state: any) => state.cryptoPulse?.state === "ready" && state.cryptoPulse?.moodValue === 76);

  // All providers go down; a forced refresh must retain the good snapshot.
  mode = "all-fail";
  await uiTest.execute("press", { action: "press", button: "button_r" });
  const after = await waitForState(uiTest, (state: any) => state.cryptoPulse?.state === "ready");
  assert.equal(after.cryptoPulse.moodValue, 76, "mood should be retained on provider failure");
  assert.equal(after.cryptoPulse.hot.length, 3);
  assert.equal(after.cryptoPulse.cold.length, 3);
});

test("board-only partial source renders the board with MOOD UNAVAILABLE", async () => {
  setCryptoPulseFetchImplForTest((url) => fixtureFetch("board-only")(url));
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest);

  await uiTest.execute("reset", { action: "reset" });
  await uiTest.execute("open_market", { action: "open_market" });
  await uiTest.execute("press", { action: "press", button: "button_g" });
  await waitForState(uiTest, (state: any) => state.cryptoPulse?.state === "ready");

  const st = await uiTest.execute("state", { action: "state", width: 110, height: 30 });
  assert.equal(st.details.state.cryptoPulse.moodValue, null);
  assert.equal(st.details.state.cryptoPulse.hot.length, 3, "scoreboard survives a mood-only outage");
  const lines: string[] = st.details.screen;
  assert.ok(lines.some((line: string) => line.includes("MOOD UNAVAILABLE")), "mood outage should be labeled");
  assert.ok(lines.some((line: string) => line.includes("HOTTEST")), "board should still render");
});

test("display-only movers strip never participates in W/S selection or J-open", async () => {
  setCryptoPulseFetchImplForTest((url) => fixtureFetch("full")(url));
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest);

  await uiTest.execute("reset", { action: "reset" });
  await uiTest.execute("open_market", { action: "open_market" });
  await uiTest.execute("press", { action: "press", button: "button_g" });
  await waitForState(uiTest, (state: any) => state.cryptoPulse?.state === "ready");

  // The ranked board is the only selectable list; the strip is not part of
  // the selection list, so hammering W/S must never exceed the board.
  for (let step = 0; step < 30; step++) await uiTest.execute("press", { action: "press", button: "dpad_down" });
  const st = await uiTest.execute("state", { action: "state", width: 110, height: 30 });
  const cp = st.details.state.cryptoPulse;
  assert.ok(cp.selectedIndex <= 5, "selection must stay within the 6-row ranked board");
  assert.ok(cp.selectedSymbol, "selected row must always resolve to an openable pair");
  assert.ok(cp.movers?.leaders.length === 3, "strip leaders exposed for the web skin");
});

test("failed crypto chart requests render as unavailable and remain retryable", async () => {
  const previousFetch = globalThis.fetch;
  let yahooCalls = 0;
  globalThis.fetch = (async () => {
    yahooCalls++;
    return new Response("upstream unavailable", { status: 429 });
  }) as typeof fetch;
  try {
    setCryptoPulseFetchImplForTest(cryptoPulseFixtureFetch);
    const uiTest = registeredTools().get("market_ui_test");
    assert.ok(uiTest);

    await uiTest.execute("reset", { action: "reset" });
    await uiTest.execute("open_market", { action: "open_market" });
    await uiTest.execute("press", { action: "press", button: "button_g" });
    await waitForState(uiTest, (state: any) => state.cryptoPulse?.state === "ready");
    const unavailable = await waitForScreen(uiTest, (lines) => lines.some((line) => line.includes("CHART UNAVAILABLE")));
    assert.equal(unavailable.some((line) => line.includes("syncing chart")), false, "failed chart must not remain stuck syncing");

    const callsBeforeRetry = yahooCalls;
    await uiTest.execute("press", { action: "press", button: "button_r" });
    await waitForScreen(uiTest, (lines) => yahooCalls > callsBeforeRetry && lines.some((line) => line.includes("CHART UNAVAILABLE")));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("PanicRadar kill switch disables the provider end to end", async () => {
  const previous = process.env.MARKET_PANIC_RADAR_ENABLED;
  process.env.MARKET_PANIC_RADAR_ENABLED = "0";
  try {
    setCryptoPulseFetchImplForTest((url) => fixtureFetch("full")(url));
    const uiTest = registeredTools().get("market_ui_test");
    assert.ok(uiTest);

    await uiTest.execute("reset", { action: "reset" });
    await uiTest.execute("open_market", { action: "open_market" });
    await uiTest.execute("press", { action: "press", button: "button_g" });
    await waitForState(uiTest, (state: any) => state.cryptoPulse?.state === "ready");

    const st = await uiTest.execute("state", { action: "state", width: 110, height: 30 });
    assert.equal(st.details.state.cryptoPulse.panicScore, null, "panic score should be absent when disabled");
    assert.equal(st.details.state.cryptoPulse.moodValue, 76, "CMC mood should still be present");
  } finally {
    if (previous === undefined) delete process.env.MARKET_PANIC_RADAR_ENABLED;
    else process.env.MARKET_PANIC_RADAR_ENABLED = previous;
  }
});
