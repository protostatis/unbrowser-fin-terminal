import assert from "node:assert/strict";
import test from "node:test";
import registerMarketExtension from "../.pi/extensions/market-terminal.js";
import {
  dossierPacketCount,
  effectiveEvidenceStatus,
  retrievalStatusOf,
  type DossierPacket,
  type TerminalDossier,
} from "../web/src/dossier.js";

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

test("market UI fixture exposes the canonical evidence packet contract", async () => {
  const tools = registeredTools();
  const uiTest = tools.get("market_ui_test");
  assert.ok(uiTest, "market_ui_test should be registered");

  await uiTest.execute("dossier-reset", { action: "reset" });
  const result = await uiTest.execute("dossier-canvas", {
    action: "open_ticker",
    symbol: "AAPL",
    width: 80,
    height: 24,
  });
  const loaded = await uiTest.execute("dossier-load", {
    action: "load_canvas",
    width: 80,
    height: 24,
  });
  const research = await uiTest.execute("dossier-research", {
    action: "press",
    button: "dpad_right",
    width: 160,
    height: 80,
  });

  assert.equal(result.details.state?.dossier, undefined);
  const dossier = loaded.details.state?.dossier as TerminalDossier | undefined;
  assert.ok(dossier, "loaded canvas should include a browser dossier");
  assert.equal(effectiveEvidenceStatus(dossier), "available");
  assert.equal(dossierPacketCount(dossier), 1);
  assert.match(dossier.summary ?? "", /^AAPL demonstrates/);
  assert.deepEqual(dossier.summarySourceIds, ["S1"]);
  assert.deepEqual(dossier.summaryCitations, [{
    sourceId: "S1",
    quote: "Revenue growth and margins are sourced from the filing fixture.",
  }]);

  const summaryRow = research.details.screen.findIndex((line: string) =>
    line.includes("DISCOVERY SUMMARY"),
  );
  const technicalRow = research.details.screen.findIndex((line: string) =>
    line.includes("PRICE ACTION"),
  );
  assert.ok(summaryRow >= 0, "main read should be visible at the top of research");
  assert.ok(technicalRow >= 0, "technical blocks should still be rendered");
  assert.ok(summaryRow < technicalRow, "main read should render before technical blocks");

  const packet = dossier.packets?.[0];
  assert.ok(packet, "fixture dossier should contain its fetched source packet");
  assert.equal(typeof packet.extractedAt, "number");
  assert.deepEqual({ ...packet, extractedAt: 0 }, {
    sourceId: "S1",
    sourceTitle: "Company 10-Q filing",
    sourceDomain: "example.test",
    sourceUrl: "https://example.test/10q",
    excerpt: "Revenue growth and margins are sourced from the filing fixture.",
    retrievalStatus: "fetched",
    extractedAt: 0,
    extractionMode: "text_main",
    truncated: false,
  });
});

test("browser dossier preserves a blocked extraction packet", () => {
  const packet: DossierPacket = {
    sourceId: "S2",
    sourceTitle: "Primary source",
    sourceDomain: "source.example",
    sourceUrl: "https://source.example/report",
    retrievalStatus: "failed",
    extractedAt: 1_700_000_000_000,
    extractionMode: "text_main",
    truncated: false,
    failureNote: "Source extraction failed",
  };
  const dossier: TerminalDossier = {
    evidenceStatus: "blocked",
    packets: [packet],
  };

  assert.equal(effectiveEvidenceStatus(dossier), "blocked");
  assert.equal(retrievalStatusOf(packet), "failed");
  assert.equal(dossierPacketCount(dossier), 1);
});

test("research status renders a clear source-search phase", async () => {
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest, "market_ui_test should be registered");

  await uiTest.execute("research-status-reset", { action: "reset" });
  await uiTest.execute("research-status-open", {
    action: "open_ticker",
    symbol: "NVDA",
    background: true,
    width: 100,
    height: 30,
  });
  await uiTest.execute("research-status-start", {
    action: "press",
    button: "button_j",
    width: 100,
    height: 30,
  });
  const researching = await uiTest.execute("research-status-advance", {
    action: "advance_research",
    width: 100,
    height: 30,
  });

  assert.equal(researching.details.state?.research?.activity, "seeding");
  assert.match(researching.details.screen.join("\n"), /SEARCHING SOURCES/);
});

test("ticker cycles its originating Watch or Movers list only from Quote", async () => {
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest, "market_ui_test should be registered");

  await uiTest.execute("cycle-origin-reset", { action: "reset" });
  await uiTest.execute("cycle-origin-market", { action: "open_market", width: 120, height: 35 });
  await uiTest.execute("cycle-origin-watch", { action: "press", button: "dpad_left", width: 120, height: 35 });
  const watchOpen = await uiTest.execute("cycle-origin-watch-open", { action: "press", button: "button_j", width: 120, height: 35 });
  const watchAction = watchOpen.details.lastAction as any;
  assert.equal(watchAction?.action, "quote");
  assert.equal(watchAction?.tickerNavigation?.source, "watch");
  assert.ok(watchAction?.tickerNavigation?.symbols.length > 1);
  assert.equal(watchAction?.tickerNavigation?.symbols[watchAction?.tickerNavigation?.index], watchAction?.symbol);

  await uiTest.execute("cycle-origin-movers", { action: "press", button: "dpad_left", width: 120, height: 35 });
  const moversOpen = await uiTest.execute("cycle-origin-movers-open", { action: "press", button: "button_j", width: 120, height: 35 });
  const moversAction = moversOpen.details.lastAction as any;
  assert.equal(moversAction?.action, "quote");
  assert.equal(moversAction?.tickerNavigation?.source, "movers");
  assert.ok(moversAction?.tickerNavigation?.symbols.length > 1);

  const navigation = { source: "movers", symbols: ["AAPL", "MSFT", "NVDA"], index: 0 };
  await uiTest.execute("cycle-quote-open", {
    action: "open_ticker",
    symbol: "AAPL",
    ticker_navigation: navigation,
    width: 120,
    height: 35,
  });
  await uiTest.execute("cycle-quote-select", { action: "press", button: "dpad_left", width: 120, height: 35 });
  const next = await uiTest.execute("cycle-quote-next", { action: "press", button: "dpad_down", width: 120, height: 35 });
  const nextAction = next.details.lastAction as any;
  assert.equal(nextAction?.symbol, "MSFT");
  assert.equal(nextAction?.tickerLayout, "quote");
  assert.equal(nextAction?.tickerNavigation?.index, 1);
  assert.match(next.details.screen.join("\n"), /\[W\/S\] cycle/);

  await uiTest.execute("cycle-quote-wrap-open", {
    action: "open_ticker",
    symbol: "AAPL",
    ticker_navigation: navigation,
    width: 120,
    height: 35,
  });
  await uiTest.execute("cycle-quote-wrap-select", { action: "press", button: "dpad_left", width: 120, height: 35 });
  const previous = await uiTest.execute("cycle-quote-previous", { action: "press", button: "dpad_up", width: 120, height: 35 });
  assert.equal((previous.details.lastAction as any)?.symbol, "NVDA");

  await uiTest.execute("cycle-split-open", {
    action: "open_ticker",
    symbol: "AAPL",
    ticker_navigation: navigation,
    width: 120,
    height: 35,
  });
  const splitDown = await uiTest.execute("cycle-split-down", { action: "press", button: "dpad_down", width: 120, height: 35 });
  assert.equal(splitDown.details.lastAction, undefined);
  assert.match(splitDown.details.state.status, /RESEARCH HAS NO CANVAS/);

  await uiTest.execute("cycle-direct-open", { action: "open_ticker", symbol: "AAPL", width: 120, height: 35 });
  await uiTest.execute("cycle-direct-select", { action: "press", button: "dpad_left", width: 120, height: 35 });
  const direct = await uiTest.execute("cycle-direct-down", { action: "press", button: "dpad_down", width: 120, height: 35 });
  assert.equal(direct.details.lastAction, undefined);
  assert.match(direct.details.state.status, /NO SOURCE LIST/);
});

test("wide ticker Split activates only when both viewport thresholds fit", async () => {
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest, "market_ui_test should be registered");

  await uiTest.execute("split-threshold-reset", { action: "reset" });
  await uiTest.execute("split-compact-open", { action: "open_ticker", symbol: "AAPL", width: 109, height: 26 });
  const compact = await uiTest.execute("split-compact-state", { action: "state", width: 109, height: 26 });
  assert.equal(compact.details.state.screen, "QUOTE");
  assert.equal(compact.details.state.tickerSplitAvailable, false);

  await uiTest.execute("split-short-open", { action: "open_ticker", symbol: "AAPL", width: 110, height: 25 });
  const short = await uiTest.execute("split-short-state", { action: "state", width: 110, height: 25 });
  assert.equal(short.details.state.screen, "QUOTE");
  assert.equal(short.details.state.tickerSplitAvailable, false);

  await uiTest.execute("split-wide-open", { action: "open_ticker", symbol: "AAPL", width: 110, height: 26 });
  const wide = await uiTest.execute("split-wide-state", { action: "state", width: 110, height: 26 });
  assert.equal(wide.details.state.screen, "SPLIT");
  assert.equal(wide.details.state.tickerSplitAvailable, true);
});

test("dossier regression paths preserve blocks, citations, and source identity", async () => {
  const uiTest = registeredTools().get("market_ui_test");
  assert.ok(uiTest, "market_ui_test should be registered");

  const overflow = await uiTest.execute("dossier-overflow", {
    action: "dossier_regression",
    scenario: "overflow",
  });
  assert.equal(overflow.details.dossierRegression?.blockCount, 12);
  assert.ok(!overflow.details.dossierRegression?.blockIds?.includes("sources"));
  assert.ok(overflow.details.dossierRegression?.blockIds?.includes("verified-sources"));

  const citations = await uiTest.execute("dossier-citation-reset", {
    action: "dossier_regression",
    scenario: "citation_reset",
  });
  assert.equal(citations.details.dossierRegression?.preservedCitationCount, 1);
  assert.equal(citations.details.dossierRegression?.clearedCitationCount, 0);

  const rediscovery = await uiTest.execute("dossier-rediscovery", {
    action: "dossier_regression",
    scenario: "rediscovery",
  });
  assert.equal(rediscovery.details.dossierRegression?.sameSourceId, true);
  assert.equal(rediscovery.details.dossierRegression?.differentSourceId, true);
  assert.equal(rediscovery.details.dossierRegression?.packetCount, 1);
  assert.equal(
    rediscovery.details.dossierRegression?.latestPacketUrl,
    "https://source.example/report",
  );
});
