import assert from "node:assert/strict";
import test from "node:test";
import {
  terminalPaneAtPosition,
  terminalPaneHitTarget,
  terminalRowHasPointerTarget,
  terminalRowHitTarget,
  terminalRowText,
} from "../web/src/terminal-hit-targets.js";

test("terminal row text removes trusted web-theme markup", () => {
  assert.equal(
    terminalRowText('<span class="tc tc-accent">Earnings &amp; guidance</span>&nbsp;'),
    "Earnings & guidance ",
  );
});

test("screen and chart scope selector spans map to validated actions", () => {
  const market = {
    mode: "market" as const,
    screen: "MARKET",
    chartScope: "day" as const,
    available: ["SPY"],
    selectedIndex: 0,
    selected: "SPY",
  };
  const screenRow = " MARKET   SIGNALS   EVENTS   MOVERS   WATCH ";
  const scopeRow = " 1:DAY  2:WEEK  3:MONTH  4:YEAR  5:TOTAL ";

  assert.deepEqual(
    terminalRowHitTarget(market, screenRow, { targetText: " MOVERS " }),
    { action: { action: "navigate-screen", screen: "MOVERS" }, label: "Open MOVERS" },
  );
  assert.equal(
    terminalRowHitTarget(market, screenRow, { targetText: " MARKET " }),
    undefined,
  );
  assert.deepEqual(
    terminalRowHitTarget(market, scopeRow, { targetText: " 3:MONTH " }),
    {
      action: { action: "set-chart-scope", scope: "month" },
      label: "Set month chart scope",
    },
  );
  assert.equal(terminalRowHasPointerTarget(market, screenRow), true);
  assert.equal(terminalRowHasPointerTarget(market, scopeRow), true);

  assert.deepEqual(
    terminalRowHitTarget(
      { mode: "ticker", screen: "QUOTE", symbol: "AAPL", chartScope: "week" },
      scopeRow,
      { targetText: " 5:TOTAL " },
    )?.action,
    { action: "set-chart-scope", scope: "max" },
  );
});

test("watch and movers rows select a new ticker, then open the selected one", () => {
  const watch = {
    mode: "market" as const,
    screen: "WATCH",
    available: ["SPY", "QQQ"],
    selectedIndex: 0,
    selected: "SPY",
  };
  assert.deepEqual(
    terminalRowHitTarget(watch, "  ▲ QQQ      +0.65% Invesco QQQ Trust"),
    {
      action: { action: "select", screen: "WATCH", index: 1, item: "QQQ" },
      label: "Select QQQ",
    },
  );
  assert.deepEqual(terminalRowHitTarget(watch, "> ▲ SPY      +0.72% State Street"), {
    action: {
      action: "primary",
      context: {
        mode: "market",
        screen: "WATCH",
        selectedIndex: 0,
        selected: "SPY",
        pane: null,
      },
    },
    label: "Open SPY",
  });
  assert.equal(terminalRowHitTarget(watch, "SPY $747.03 +0.72%"), undefined);

  const movers = {
    mode: "market" as const,
    screen: "MOVERS",
    available: ["AAPL", "MSFT"],
    selectedIndex: 1,
    selected: "MSFT",
  };
  assert.equal(
    terminalRowHitTarget(movers, "  #01 ▼ AAPL -7.35% VOL 45M")?.action.action,
    "select",
  );
  assert.equal(
    terminalRowHitTarget(movers, "> #02 ▲ MSFT +3.02% VOL 32M")?.action.action,
    "primary",
  );
  assert.equal(
    terminalRowHitTarget(
      movers,
      "> #02 ▲ MSFT +3.02% VOL 32M │ SELECTED MOVER",
      { columns: 120, rowCount: 30, xFraction: 0.8 },
    ),
    undefined,
  );
});

test("the selected Market quote opens from its stable detail row", () => {
  const market = {
    mode: "market" as const,
    screen: "MARKET",
    available: ["SPY", "QQQ"],
    selectedIndex: 0,
    selected: "SPY",
  };
  assert.deepEqual(
    terminalRowHitTarget(market, "> SPY SPDR S&P 500 ETF Trust +0.72%"),
    {
      action: {
        action: "primary",
        context: {
          mode: "market",
          screen: "MARKET",
          selectedIndex: 0,
          selected: "SPY",
          pane: null,
        },
      },
      label: "Open SPY",
    },
  );
  assert.equal(
    terminalRowHitTarget(
      market,
      "> SPY SPDR S&P 500 ETF Trust +0.72% │ ON THE MOVE",
      { columns: 120, rowCount: 30, xFraction: 0.8 },
    ),
    undefined,
  );
});

test("event and headline rows select without starting research", () => {
  const events = {
    mode: "market" as const,
    screen: "EVENTS",
    available: [
      "Earnings & guidance monitor",
      "Macro policy & data monitor",
      "Global handoff monitor",
    ],
    selectedIndex: 0,
    selected: "Earnings & guidance monitor",
    eventsFocus: "lanes" as const,
  };
  assert.deepEqual(terminalRowHitTarget(events, "  MACRO  BRIEF -- · WHY --"), {
    action: {
      action: "select",
      screen: "EVENTS",
      index: 1,
      item: "Macro policy & data monitor",
    },
    label: "Select Macro policy & data monitor",
  });
  assert.equal(
    terminalRowHitTarget(
      events,
      "ON-DEMAND RESEARCH · NOT A LIVE CALENDAR │ Macro policy & data monitor",
      { columns: 120, rowCount: 30, xFraction: 0.8 },
    ),
    undefined,
  );

  const signals = {
    mode: "market" as const,
    screen: "SIGNALS",
    available: ["Technology leadership broadens as index futures advance"],
    selectedIndex: 0,
    selected: "Technology leadership broadens as index futures advance",
    signalsFocus: "headlines" as const,
  };
  assert.equal(
    terminalRowHitTarget(
      signals,
      "  demo.news   Technology leadership broadens as index futures advance",
    )?.action.action,
    "select",
  );
});

test("pane headings and wide pane bodies change focus without changing selection", () => {
  const signals = {
    mode: "market" as const,
    screen: "SIGNALS",
    available: ["Headline"],
    selectedIndex: 0,
    selected: "Headline",
    signalsFocus: "headlines" as const,
  };
  assert.deepEqual(terminalRowHitTarget(signals, " MARKET STORY FOCUS ")?.action, {
    action: "focus-pane",
    pane: "story",
  });
  assert.deepEqual(
    terminalPaneHitTarget(signals, 120, 10, 30, 0.8)?.action,
    { action: "focus-pane", pane: "story" },
  );

  const events = {
    mode: "market" as const,
    screen: "EVENTS",
    available: ["Earnings & guidance monitor"],
    selectedIndex: 0,
    selected: "Earnings & guidance monitor",
    eventsFocus: "lanes" as const,
  };
  assert.deepEqual(
    terminalPaneHitTarget(events, 120, 10, 30, 0.7)?.action,
    { action: "focus-pane", pane: "briefing" },
  );
  assert.equal(terminalPaneAtPosition(events, 120, 10, 30, 0.7), "briefing");
  assert.deepEqual(
    terminalRowHitTarget(
      events,
      "CATALYST LANES FOCUS │ BRIEFING FOCUS",
      { columns: 120, rowCount: 30, xFraction: 0.7 },
    )?.action,
    { action: "focus-pane", pane: "briefing" },
  );
  assert.equal(terminalPaneHitTarget(events, 80, 10, 30, 0.7), undefined);
});

test("pane geometry follows the live layout block from debugState", () => {
  // The extension now publishes headerRows/footerRows/splitPane in its
  // debugState layout block. When the header reclaims rows (e.g. 3 instead of
  // the legacy 5), a click on row 3 must land in the pane body, not be treated
  // as chrome. Old servers without `layout` keep the 5/4 fallback.
  const signalsCompact = {
    mode: "market" as const,
    screen: "SIGNALS",
    available: ["Headline"],
    selectedIndex: 0,
    selected: "Headline",
    signalsFocus: "headlines" as const,
    layout: { headerRows: 3, footerRows: 3, width: 120, totalRows: 30, splitPane: true },
  };
  assert.equal(terminalPaneAtPosition(signalsCompact, 120, 3, 30, 0.8), "story");
  // Footer now starts at rowCount - footerRows = 30 - 3 = 27.
  assert.equal(terminalPaneAtPosition(signalsCompact, 120, 26, 30, 0.8), "story");
  assert.equal(terminalPaneAtPosition(signalsCompact, 120, 27, 30, 0.8), undefined);

  // splitPane false (single-pane screen) suppresses pane clicks entirely.
  const marketLayout = { ...signalsCompact, screen: "MARKET", layout: { headerRows: 3, footerRows: 3, width: 120, totalRows: 30, splitPane: false } };
  assert.equal(terminalPaneAtPosition(marketLayout, 120, 10, 30, 0.2), undefined);
});

test("locked terminal rows expose no pointer action", () => {
  assert.equal(
    terminalRowHitTarget(
      {
        mode: "market",
        screen: "WATCH",
        available: ["SPY"],
        selectedIndex: 0,
        selected: "SPY",
        cacheDecision: {},
      },
      "> ▲ SPY",
    ),
    undefined,
  );
});
