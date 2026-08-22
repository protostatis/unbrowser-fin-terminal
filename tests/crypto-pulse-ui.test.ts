import assert from "node:assert/strict";
import test from "node:test";
import registerMarketExtension, {
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
    const listing = (id: number, symbol: string, name: string, rank: number, price: number, change24h: number, dominance: number) => ({
      id, symbol, name, slug: symbol.toLowerCase(), cmc_rank: rank,
      quote: [{ symbol: "USD", price, volume_24h: 1e9, market_cap: 1e11, market_cap_dominance: dominance, percent_change_24h: change24h, percent_change_7d: change24h * 2 }],
    });
    return jsonResponse({ data: [
      listing(1, "BTC", "Bitcoin", 1, 76959, 0.41, 59.24),
      listing(1027, "ETH", "Ethereum", 2, 2427, 1.8, 11.4),
      listing(825, "USDT", "Tether", 3, 1.0, 0.03, 4.6),
      listing(74, "DOGE", "Dogecoin", 9, 0.108, 8.5, 0.2),
      listing(52, "XRP", "XRP", 4, 0.62, -3.1, 1.2),
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

test.after(() => {
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
  assert.deepEqual(pulse.hot.map((row: any) => row.symbol), ["DOGE", "ETH", "BTC"]);
  assert.deepEqual(pulse.cold.map((row: any) => row.symbol), ["XRP"]);
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
  const moodLine = lines.find((line: string) => line.includes("MOOD ["));
  assert.ok(moodLine, "mood strip should render");
  assert.match(moodLine, /76 GREED/);
  assert.match(moodLine, /PANIC 15/);
  assert.match(moodLine, /BTC\.D 59\.2%/);
  // Wide layout: HOT/COLD are side-by-side columns (COLD appears inline).
  assert.ok(lines.some((line: string) => line.includes("HOT")), "HOT scoreboard should render");
  assert.ok(lines.some((line: string) => line.includes("COLD")), "COLD scoreboard should render");
  assert.ok(lines.some((line: string) => /DOGE/.test(line) && /8\.5/.test(line)), "HOT row should show DOGE +8.50%");
  assert.ok(lines.some((line: string) => /XRP/.test(line) && /-3\.1/.test(line)), "COLD row should show XRP -3.10%");

  // Narrow layout: blocks stack, so HOT/COLD become standalone headers.
  const narrow = await uiTest.execute("state", { action: "state", width: 80, height: 30 });
  const narrowLines: string[] = narrow.details.screen;
  assert.ok(narrowLines.some((line: string) => line.trim().startsWith("HOT")), "stacked HOT header should render");
  assert.ok(narrowLines.some((line: string) => line.trim().startsWith("COLD")), "stacked COLD header should render");
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
