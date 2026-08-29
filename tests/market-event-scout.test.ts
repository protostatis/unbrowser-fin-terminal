import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_MARKET_EVENT_SOURCES,
  DEFAULT_MARKET_EVENT_TRIGGER_POLICY,
  evaluateMarketEvent,
  evaluateMarketEventTriggerCandidate,
  MarketEventScout,
  type MarketEventDecision,
  type MarketEventSource,
  type MarketEventTriggerPolicy,
  parsePublicFeed,
  proposeMarketEventTriggerRoute,
  readMarketEventScoutState,
} from "../shared/market-event-scout.js";
import type { UnbrowserDocument } from "../shared/unbrowser-mcp.js";

const HALT_SOURCE: MarketEventSource = {
  id: "test-halts",
  label: "Test Exchange Halts",
  url: "https://exchange.example/halts.xml",
  family: "halt",
  format: "rss",
  pollIntervalMs: 60_000,
  symbolTags: ["ex:IssueSymbol"],
};

function rssItem(options: {
  guid: string;
  symbol?: string;
  title?: string;
  published?: string;
  link?: string;
}): string {
  return `<item>
    <guid>${options.guid}</guid>
    <title><![CDATA[${options.title ?? "Trading Halt"}]]></title>
    <link>${options.link ?? `https://exchange.example/events/${options.guid}`}</link>
    <description>Exchange event for ${options.symbol ?? "the market"}</description>
    <pubDate>${options.published ?? "Fri, 07 Aug 2026 12:00:00 GMT"}</pubDate>
    ${options.symbol ? `<ex:IssueSymbol>${options.symbol}</ex:IssueSymbol>` : ""}
  </item>`;
}

function rss(...items: string[]): string {
  return `<?xml version="1.0"?><rss xmlns:ex="urn:test" version="2.0"><channel>${items.join("")}</channel></rss>`;
}

function document(body: string, truncated = false): UnbrowserDocument {
  return {
    requestedUrl: HALT_SOURCE.url,
    finalUrl: HALT_SOURCE.url,
    httpStatus: 200,
    contentType: "application/rss+xml",
    headers: { "content-type": "application/rss+xml" },
    retrievalStatus: "fetched",
    body,
    truncated,
  };
}

test("RSS parser extracts namespaced symbols, decodes text, and rejects unsafe item links", () => {
  const body = rss(
    rssItem({ guid: "halt-1", symbol: "brk/b", title: "A &amp; B trading halt" }),
    rssItem({ guid: "halt-2", symbol: "NVDA", link: "javascript:alert(1)" }),
    rssItem({ guid: "halt-3", symbol: "AAPL", link: "https://exchange.example/event?token=secret" }),
  );
  const items = parsePublicFeed(HALT_SOURCE, body);

  assert.equal(items.length, 3);
  assert.equal(items[0]?.title, "A & B trading halt");
  assert.deepEqual(items[0]?.structuredSymbols, ["BRK.B"]);
  assert.equal(items[0]?.url, "https://exchange.example/events/halt-1");
  assert.equal(items[1]?.url, undefined);
  assert.equal(items[2]?.url, undefined);
  assert.throws(() => parsePublicFeed(HALT_SOURCE, "<html>bot wall</html>"), /non-feed document/);
});

test("feed parser rejects incomplete, oversized, and item-overflow documents", () => {
  assert.throws(() => parsePublicFeed(HALT_SOURCE, "<rss><channel>"), /incomplete feed document/);
  assert.throws(
    () => parsePublicFeed(HALT_SOURCE, `<rss><channel>${"x".repeat(512 * 1024)}</channel></rss>`),
    /document safety limit/,
  );
  const overflow = rss(...Array.from({ length: 201 }, (_, index) => rssItem({
    guid: `halt-${index}`,
    symbol: "NVDA",
  })));
  assert.throws(() => parsePublicFeed(HALT_SOURCE, overflow), /200-item safety limit/);
});

test("feed parser rejects a malformed or title-less sibling instead of returning a partial poll", () => {
  const valid = rssItem({ guid: "halt-valid", symbol: "NVDA" });
  const malformed = `<?xml version="1.0"?><rss><channel>${valid}<item><guid>halt-broken</guid></channel></rss>`;
  assert.throws(() => parsePublicFeed(HALT_SOURCE, malformed), /malformed feed document/);

  const titleless = rss(valid, `<item><guid>halt-titleless</guid><link>https://exchange.example/events/titleless</link></item>`);
  assert.throws(() => parsePublicFeed(HALT_SOURCE, titleless), /missing a title/);
});

test("Atom parser chooses alternate links and preserves stable entry IDs", () => {
  const source: MarketEventSource = {
    id: "test-filings",
    label: "Test Filings",
    url: "https://regulator.example/current.atom",
    family: "filing",
    format: "atom",
    pollIntervalMs: 300_000,
  };
  const items = parsePublicFeed(source, `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>urn:filing:1</id>
        <title>8-K - Example Corp (CIK 0000123456)</title>
        <updated>2026-08-07T12:00:00Z</updated>
        <link rel="self" href="/current.atom" />
        <link rel="alternate" href="https://regulator.example/filing/1#document" />
        <summary type="html"><![CDATA[Material &amp; current report]]></summary>
        <category term="8-K" />
      </entry>
    </feed>`);

  assert.equal(items.length, 1);
  assert.match(items[0]?.id ?? "", /^evt-[a-f0-9]{32}$/);
  assert.equal(parsePublicFeed(source, `<?xml version="1.0"?><feed><entry><id>urn:filing:1</id><title>8-K - Example Corp</title></entry></feed>`)[0]?.id, items[0]?.id);
  assert.equal(items[0]?.url, "https://regulator.example/filing/1");
  assert.equal(items[0]?.summary, "Material & current report");
  assert.deepEqual(items[0]?.categories, ["8-K"]);
});

test("source-owned trailing-parenthesis convention extracts corporate-action symbols", () => {
  const source: MarketEventSource = {
    id: "test-corporate-actions",
    label: "Test Corporate Actions",
    url: "https://exchange.example/actions.xml",
    family: "corporate-action",
    format: "rss",
    pollIntervalMs: 300_000,
    symbolFromTitle: "trailing-parentheses",
  };
  const [item] = parsePublicFeed(source, rss(rssItem({
    guid: "action-1",
    title: "Information Regarding the Reverse Stock Split for Example Corp (EXMP)",
  })));
  assert.deepEqual(item?.structuredSymbols, ["EXMP"]);
});

test("representative snippets for all default sources preserve source contracts", () => {
  const now = Date.parse("2026-08-07T12:05:00Z");
  const fixtures: Record<string, { body: string; expectedClass: string; symbol?: string }> = {
    "nasdaq-trade-halts": {
      body: `<?xml version="1.0"?><rss xmlns:ndaq="urn:ndaq"><channel><item><title>NVDA</title><pubDate>Fri, 07 Aug 2026 12:00:00 GMT</pubDate><ndaq:HaltDate>08/07/2026</ndaq:HaltDate><ndaq:HaltTime>12:00:00</ndaq:HaltTime><ndaq:IssueSymbol>NVDA</ndaq:IssueSymbol><ndaq:ReasonCode>T1</ndaq:ReasonCode></item></channel></rss>`,
      expectedClass: "halt",
      symbol: "NVDA",
    },
    "nasdaq-corporate-actions": {
      body: rss(rssItem({ guid: "ECA2026-1", title: "Information Regarding a Reverse Stock Split (AAPL)" })),
      expectedClass: "corporate-action",
      symbol: "AAPL",
    },
    "sec-current-filings": {
      body: `<feed><entry><id>urn:sec:1</id><title>8-K - Example Corp (CIK 0000123456)</title><updated>2026-08-07T12:00:00Z</updated></entry></feed>`,
      expectedClass: "filing",
    },
    "federal-reserve-monetary": {
      body: rss(rssItem({ guid: "fed-1", title: "FOMC issues monetary policy statement" })),
      expectedClass: "macro",
    },
    "bea-news": {
      body: rss(rssItem({ guid: "bea-1", title: "Gross Domestic Product, Second Quarter" })),
      expectedClass: "macro",
    },
    "ftc-press-releases": {
      body: rss(rssItem({ guid: "ftc-1", title: "FTC challenges anticompetitive merger" })),
      expectedClass: "regulatory",
    },
    "doj-news": {
      body: rss(rssItem({ guid: "doj-1", title: "Justice Department files antitrust lawsuit" })),
      expectedClass: "regulatory",
    },
  };

  for (const source of DEFAULT_MARKET_EVENT_SOURCES) {
    const fixture = fixtures[source.id]!;
    const [item] = parsePublicFeed(source, fixture.body);
    assert.ok(item, `${source.id} should parse one item`);
    if (fixture.symbol) assert.deepEqual(item.structuredSymbols, [fixture.symbol]);
    assert.equal(evaluateMarketEvent(source, item, now, ["NVDA", "AAPL"]).eventClass, fixture.expectedClass);
  }
});

test("deterministic evaluation admits strong associations and suppresses weak classes", () => {
  const now = Date.parse("2026-08-07T12:05:00Z");
  const halt = evaluateMarketEvent(HALT_SOURCE, {
    id: "halt-1",
    title: "Trading halt",
    summary: "",
    publishedAt: now - 60_000,
    categories: [],
    structuredSymbols: ["NVDA"],
  }, now, ["NVDA"]);
  assert.equal(halt.disposition, "admit-shadow");
  assert.equal(halt.association, "structured-symbol");
  assert.deepEqual(halt.target, { kind: "ticker", symbol: "NVDA" });
  assert.equal(halt.priority, 100);

  const structuredWins = evaluateMarketEvent(HALT_SOURCE, {
    id: "halt-structured",
    title: "Trading halt with incidental NASDAQ: TSLA reference",
    summary: "",
    publishedAt: now,
    categories: [],
    structuredSymbols: ["NVDA"],
  }, now, ["NVDA", "TSLA"]);
  assert.equal(structuredWins.disposition, "admit-shadow");
  assert.deepEqual(structuredWins.symbols, ["NVDA"]);
  assert.deepEqual(structuredWins.target, { kind: "ticker", symbol: "NVDA" });

  const ambiguousStructured = evaluateMarketEvent(HALT_SOURCE, {
    id: "halt-multiple",
    title: "Multi-security trading halt",
    summary: "",
    publishedAt: now,
    categories: [],
    structuredSymbols: ["NVDA", "AAPL"],
  }, now, ["NVDA", "AAPL"]);
  assert.equal(ambiguousStructured.disposition, "watch");
  assert.equal(ambiguousStructured.target, undefined);

  const macroSource: MarketEventSource = {
    id: "test-macro",
    label: "Test Macro",
    url: "https://central-bank.example/feed.xml",
    family: "macro",
    format: "rss",
    pollIntervalMs: 600_000,
    marketLane: "macro",
  };
  const macro = evaluateMarketEvent(macroSource, {
    id: "macro-1",
    title: "FOMC interest rate statement mentions NASDAQ: NVDA",
    summary: "",
    publishedAt: now,
    categories: [],
    structuredSymbols: [],
  }, now, ["NVDA"]);
  assert.equal(macro.disposition, "admit-shadow");
  assert.equal(macro.association, "market-wide");
  assert.deepEqual(macro.symbols, []);
  assert.deepEqual(macro.target, { kind: "market", lane: "macro" });

  const regulator: MarketEventSource = {
    id: "test-regulator",
    label: "Test Regulator",
    url: "https://regulator.example/feed.xml",
    family: "regulatory",
    format: "rss",
    pollIntervalMs: 600_000,
    marketLane: "story",
  };
  const outsideUniverse = evaluateMarketEvent(regulator, {
    id: "case-1",
    title: "Antitrust charges filed against NASDAQ: ABCD",
    summary: "",
    publishedAt: now,
    categories: [],
    structuredSymbols: [],
  }, now, ["NVDA"]);
  assert.equal(outsideUniverse.disposition, "watch");
  assert.deepEqual(outsideUniverse.reasonCodes, ["outside-tracked-universe"]);

  const routine = evaluateMarketEvent(regulator, {
    id: "routine-1",
    title: "Agency announces workshop schedule",
    summary: "",
    publishedAt: now,
    categories: [],
    structuredSymbols: [],
  }, now, ["NVDA"]);
  assert.equal(routine.disposition, "suppress");
  assert.deepEqual(routine.reasonCodes, ["unsupported-event-class"]);
});

test("trigger dry run maps validated ticker, macro EVENT, and story routes without dispatching", () => {
  const now = Date.parse("2026-08-07T12:05:00Z");
  const ticker = evaluateMarketEvent(HALT_SOURCE, {
    id: "halt-route",
    title: "Trading halt",
    summary: "",
    publishedAt: now,
    categories: [],
    structuredSymbols: ["NVDA"],
  }, now, ["NVDA"]);
  const macroSource: MarketEventSource = {
    id: "test-macro-route",
    label: "Test Macro Route",
    url: "https://central-bank.example/feed.xml",
    family: "macro",
    format: "rss",
    pollIntervalMs: 600_000,
    marketLane: "macro",
  };
  const macro = evaluateMarketEvent(macroSource, {
    id: "macro-route",
    title: "FOMC issues monetary policy statement",
    summary: "",
    publishedAt: now,
    categories: [],
    structuredSymbols: [],
  }, now);
  const storySource: MarketEventSource = {
    id: "test-story-route",
    label: "Test Story Route",
    url: "https://regulator.example/feed.xml",
    family: "regulatory",
    format: "rss",
    pollIntervalMs: 600_000,
    marketLane: "story",
  };
  const story = evaluateMarketEvent(storySource, {
    id: "story-route",
    title: "Agency files antitrust lawsuit",
    summary: "",
    publishedAt: now,
    categories: [],
    structuredSymbols: [],
  }, now);

  assert.deepEqual(proposeMarketEventTriggerRoute(ticker), { kind: "ticker-brief", symbol: "NVDA" });
  assert.deepEqual(proposeMarketEventTriggerRoute(macro), { kind: "macro-event-brief" });
  assert.deepEqual(proposeMarketEventTriggerRoute(story), { kind: "market-story-brief" });

  const tickerCandidate = evaluateMarketEventTriggerCandidate(ticker, { evaluatedAt: now });
  const macroCandidate = evaluateMarketEventTriggerCandidate(macro, { evaluatedAt: now });
  const storyCandidate = evaluateMarketEventTriggerCandidate(story, { evaluatedAt: now });
  assert.equal(tickerCandidate.outcome, "would-trigger");
  assert.equal(tickerCandidate.targetKey, "ticker:NVDA");
  assert.equal(macroCandidate.outcome, "would-trigger");
  assert.equal(macroCandidate.targetKey, "event:macro");
  assert.equal(storyCandidate.outcome, "gated", "current story decisions remain watch-only");
  assert.equal(storyCandidate.targetKey, "market-story");
  assert.deepEqual(storyCandidate.gateReasonCodes, ["not-admitted", "below-priority"]);
  assert.deepEqual(tickerCandidate.policy, DEFAULT_MARKET_EVENT_TRIGGER_POLICY);
});

test("trigger dry-run gates have explicit TTL, cooldown, cap, and stateless precedence", () => {
  const observedAt = Date.parse("2026-08-07T12:00:00Z");
  const policy: MarketEventTriggerPolicy = {
    version: 1,
    minPriority: 80,
    ttlMs: 2 * 60_000,
    targetCooldownMs: 60_000,
    dailyCap: 1,
  };
  const admitted = evaluateMarketEvent(HALT_SOURCE, {
    id: "halt-gates",
    title: "Trading halt",
    summary: "",
    publishedAt: observedAt,
    categories: [],
    structuredSymbols: ["NVDA"],
  }, observedAt, ["NVDA"]);

  const cooldown = evaluateMarketEventTriggerCandidate(admitted, {
    evaluatedAt: observedAt + 30_000,
    policy,
    lastWouldTriggerAt: observedAt,
  });
  assert.deepEqual(cooldown.gateReasonCodes, ["target-cooldown"]);

  const cooldownBoundary = evaluateMarketEventTriggerCandidate(admitted, {
    evaluatedAt: observedAt + 60_000,
    policy,
    lastWouldTriggerAt: observedAt,
  });
  assert.equal(cooldownBoundary.outcome, "would-trigger", "cooldown ends exactly at its boundary");

  const capped = evaluateMarketEventTriggerCandidate(admitted, {
    evaluatedAt: observedAt + 60_000,
    policy,
    wouldTriggerToday: 1,
  });
  assert.deepEqual(capped.gateReasonCodes, ["daily-cap"]);

  const expired = evaluateMarketEventTriggerCandidate(admitted, {
    evaluatedAt: observedAt + policy.ttlMs,
    policy,
    lastWouldTriggerAt: observedAt + policy.ttlMs - 1,
    wouldTriggerToday: 1,
  });
  assert.deepEqual(expired.gateReasonCodes, ["expired"], "stateless failures do not add cooldown or cap noise");

  const lowPriority = evaluateMarketEventTriggerCandidate({ ...admitted, priority: 79 }, {
    evaluatedAt: observedAt,
    policy,
    lastWouldTriggerAt: observedAt,
    wouldTriggerToday: 1,
  });
  assert.deepEqual(lowPriority.gateReasonCodes, ["below-priority"]);

  const missingPublication = evaluateMarketEventTriggerCandidate({ ...admitted, publishedAt: undefined }, {
    evaluatedAt: observedAt,
    policy,
  });
  assert.equal(missingPublication.expiresAt, admitted.observedAt + policy.ttlMs);
});

test("shadow scout baselines first, records only unseen actionable events, and persists dedupe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-test-"));
  const statePath = join(directory, "scout.json");
  let now = Date.parse("2026-08-07T12:05:00Z");
  const first = rss(rssItem({ guid: "halt-1", symbol: "NVDA" }));
  const second = rss(
    rssItem({ guid: "halt-2", symbol: "AAPL", published: "Fri, 07 Aug 2026 12:06:00 GMT" }),
    rssItem({ guid: "halt-1", symbol: "NVDA" }),
  );
  const bodies = [first, second, second];
  const client = {
    calls: 0,
    async readDocument(): Promise<UnbrowserDocument> {
      this.calls += 1;
      return document(bodies.shift() ?? second);
    },
  };
  const scout = new MarketEventScout({
    client,
    statePath,
    sources: [HALT_SOURCE],
    getTrackedSymbols: () => ["NVDA", "AAPL"],
    now: () => now,
  });

  try {
    const baseline = await scout.run({ force: true });
    assert.equal(baseline.baselineItems, 1);
    assert.equal(baseline.newItems, 0);
    assert.deepEqual(baseline.decisions, []);

    now += 2 * 60_000;
    const observed = await scout.run({ force: true });
    assert.equal(observed.newItems, 1);
    assert.equal(observed.admitted, 1);
    assert.equal(observed.decisions[0]?.title, "Trading Halt");
    assert.deepEqual(observed.decisions[0]?.symbols, ["AAPL"]);
    assert.equal(observed.candidateEvaluated, 1);
    assert.equal(observed.wouldTrigger, 1);
    assert.equal(observed.gated, 0);
    assert.deepEqual(observed.triggerCandidates[0]?.route, { kind: "ticker-brief", symbol: "AAPL" });

    now += 2 * 60_000;
    const duplicate = await scout.run({ force: true });
    assert.equal(duplicate.newItems, 0);
    assert.equal(duplicate.admitted, 0);
    assert.equal(duplicate.candidateEvaluated, 0);

    const incompatiblePolicy = new MarketEventScout({
      client,
      statePath,
      sources: [HALT_SOURCE],
      getTrackedSymbols: () => ["NVDA", "AAPL"],
      now: () => now,
      triggerPolicy: { ...DEFAULT_MARKET_EVENT_TRIGGER_POLICY, dailyCap: 9 },
    });
    await assert.rejects(
      incompatiblePolicy.run({ force: true }),
      /policy changed without a versioned migration/,
    );

    const state = await readMarketEventScoutState(statePath, now);
    assert.equal(state.version, 3);
    assert.equal(state.sources[0]?.baselineComplete, true);
    assert.equal(state.sources[0]?.newItems, 1);
    assert.equal(state.sources[0]?.admitted, 1);
    assert.equal(state.decisions.length, 1);
    assert.equal(state.triggerDryRun.candidates.length, 1);
    assert.equal(state.triggerDryRun.totals.evaluated, 1);
    assert.equal(state.triggerDryRun.totals.wouldTrigger, 1);
    assert.equal(state.triggerDryRun.days[0]?.aggregate.wouldTrigger, 1);
    assert.equal(client.calls, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real trigger dispatch is opt-in, durable, capped, and settles by candidate ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-dispatch-test-"));
  const statePath = join(directory, "scout.json");
  let now = Date.parse("2026-08-07T12:05:00Z");
  const repeat = rss(
      rssItem({ guid: "dispatch-1", symbol: "AAPL", published: "Fri, 07 Aug 2026 12:06:00 GMT" }),
      rssItem({ guid: "dispatch-2", symbol: "MSFT", published: "Fri, 07 Aug 2026 12:06:30 GMT" }),
    );
  const bodies = [rss(rssItem({ guid: "dispatch-baseline", symbol: "NVDA" })), repeat, repeat];
  const dispatched: string[] = [];
  const client = { async readDocument() { return document(bodies.shift() ?? repeat); } };
  const makeScout = (accept = true) => new MarketEventScout({
    client,
    statePath,
    sources: [HALT_SOURCE],
    getTrackedSymbols: () => ["NVDA", "AAPL", "MSFT"],
    now: () => now,
    dispatch: {
      modelId: "nvidia/nemotron-3.5-lightning:free",
      policy: { perRunCap: 1, dailyCap: 4 },
      dispatch(candidate) {
        dispatched.push(candidate.id);
        return accept
          ? { accepted: true, jobId: `job-${dispatched.length}` }
          : { accepted: false, error: "free endpoint unavailable" };
      },
    },
  });

  try {
    const scout = makeScout();
    await scout.run({ force: true });
    now += 2 * 60_000;
    const first = await scout.run({ force: true });
    assert.equal(first.dispatchEnqueued, 1, "per-run cap admits one job");
    assert.equal(first.dispatchPending, 1, "the second eligible candidate remains in the outbox");
    let state = await readMarketEventScoutState(statePath, now);
    assert.equal(state.triggerDispatches.filter((record) => record.status === "enqueued").length, 1);
    assert.equal(state.triggerDispatches.filter((record) => record.status === "pending").length, 1);

    const firstCandidate = state.triggerDispatches.find((record) => record.status === "enqueued")!;
    await scout.settleDispatch(firstCandidate.candidateId, "complete");
    state = await readMarketEventScoutState(statePath, now);
    assert.equal(state.triggerDispatches.find((record) => record.candidateId === firstCandidate.candidateId)?.status, "settled");

    now += 2 * 60_000;
    const second = await scout.run({ force: true });
    assert.equal(second.dispatchEnqueued, 1, "the next poll drains one pending candidate");
    assert.equal(dispatched.length, 2);

    const restarted = makeScout();
    now += 2 * 60_000;
    await restarted.run({ force: true });
    assert.equal(dispatched.length, 3, "an enqueued record is recovered once after a parent restart");
    assert.equal(new Set(dispatched).size, 2, "recovery dispatches the previously pending candidate, not the settled one");

    const restartStorm = makeScout();
    now += 2 * 60_000;
    await restartStorm.run({ force: true });
    assert.equal(dispatched.length, 4, "a second restart consumes the next bounded daily attempt");
    const cappedRestart = makeScout();
    now += 2 * 60_000;
    const capped = await cappedRestart.run({ force: true });
    assert.equal(capped.dispatchEnqueued, 0, "restart storms cannot bypass the daily attempt cap");
    assert.equal(dispatched.length, 4);
    state = await readMarketEventScoutState(statePath, now);
    const retried = state.triggerDispatches.find((record) => record.candidateId !== firstCandidate.candidateId)!;
    assert.equal(retried.dispatchDays?.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retryable dispatch contention stays pending without becoming terminal loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-dispatch-defer-test-"));
  const statePath = join(directory, "scout.json");
  let now = Date.parse("2026-08-07T12:05:00Z");
  const bodies = [
    rss(rssItem({ guid: "defer-baseline", symbol: "NVDA" })),
    rss(rssItem({ guid: "defer-1", symbol: "AAPL", published: "Fri, 07 Aug 2026 12:06:00 GMT" })),
    rss(rssItem({ guid: "defer-1", symbol: "AAPL", published: "Fri, 07 Aug 2026 12:06:00 GMT" })),
  ];
  let attempts = 0;
  const client = { async readDocument() { return document(bodies.shift() ?? bodies.at(-1)!); } };
  try {
    const scout = new MarketEventScout({
      client,
      statePath,
      sources: [HALT_SOURCE],
      getTrackedSymbols: () => ["NVDA", "AAPL"],
      now: () => now,
      dispatch: {
        modelId: "nvidia/nemotron-3.5-lightning:free",
        dispatch() {
          attempts += 1;
          return attempts === 1
            ? { accepted: false, retryable: true, error: "research queue busy" }
            : { accepted: true, jobId: `deferred-job-${attempts}` };
        },
      },
    });
    await scout.run({ force: true });
    now += 2 * 60_000;
    const deferred = await scout.run({ force: true });
    assert.equal(deferred.dispatchFailed, 0);
    assert.equal(deferred.dispatchPending, 1);
    assert.equal((await readMarketEventScoutState(statePath, now)).triggerDispatches[0]?.status, "pending");
    now += 2 * 60_000;
    const retried = await scout.run({ force: true });
    assert.equal(retried.dispatchEnqueued, 1);
    assert.equal(attempts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dispatch rejection is recorded as a terminal failed outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-dispatch-failure-test-"));
  const statePath = join(directory, "scout.json");
  let now = Date.parse("2026-08-07T12:05:00Z");
  const bodies = [
    rss(rssItem({ guid: "failure-baseline", symbol: "NVDA" })),
    rss(rssItem({ guid: "failure-1", symbol: "AAPL", published: "Fri, 07 Aug 2026 12:06:00 GMT" })),
  ];
  const client = { async readDocument() { return document(bodies.shift()!); } };
  try {
    const scout = new MarketEventScout({
      client,
      statePath,
      sources: [HALT_SOURCE],
      getTrackedSymbols: () => ["NVDA", "AAPL"],
      now: () => now,
      dispatch: {
        modelId: "nvidia/nemotron-3.5-lightning:free",
        dispatch: () => ({ accepted: false, error: "rate limited" }),
      },
    });
    await scout.run({ force: true });
    now += 2 * 60_000;
    const result = await scout.run({ force: true });
    assert.equal(result.dispatchFailed, 1);
    const state = await readMarketEventScoutState(statePath, now);
    assert.equal(state.triggerDispatches[0]?.status, "failed");
    assert.equal(state.triggerDispatches[0]?.error, "rate limited");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded seen/decision retention remains restart-safe for the retained window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-retention-test-"));
  const statePath = join(directory, "scout.json");
  let now = Date.parse("2026-08-07T12:05:00Z");
  const bodies = [
    rss(rssItem({ guid: "halt-1", symbol: "NVDA" }), rssItem({ guid: "halt-2", symbol: "AAPL" })),
    rss(rssItem({ guid: "halt-3", symbol: "MSFT" }), rssItem({ guid: "halt-2", symbol: "AAPL" })),
    rss(rssItem({ guid: "halt-4", symbol: "AMZN" }), rssItem({ guid: "halt-3", symbol: "MSFT" })),
    rss(rssItem({ guid: "halt-4", symbol: "AMZN" }), rssItem({ guid: "halt-3", symbol: "MSFT" })),
  ];
  const client = { async readDocument() { return document(bodies.shift()!); } };
  const options = {
    client,
    statePath,
    sources: [HALT_SOURCE],
    getTrackedSymbols: () => ["NVDA", "AAPL", "MSFT", "AMZN"],
    now: () => now,
    maxSeenPerSource: 2,
    maxStoredDecisions: 1,
    maxStoredTriggerCandidates: 1,
  };

  try {
    const first = new MarketEventScout(options);
    await first.run({ force: true });
    now += 60_000;
    assert.equal((await first.run({ force: true })).newItems, 1);
    now += 60_000;
    assert.equal((await first.run({ force: true })).newItems, 1);

    const state = await first.getState();
    assert.equal(state.sources[0]?.seenEventIds.length, 2);
    assert.equal(state.decisions.length, 1);
    assert.deepEqual(state.decisions[0]?.symbols, ["AMZN"]);
    assert.equal(state.triggerDryRun.candidates.length, 1);
    assert.equal(state.triggerDryRun.totals.evaluated, 2, "aggregate evidence survives candidate eviction");

    const restarted = new MarketEventScout(options);
    now += 60_000;
    assert.equal((await restarted.run({ force: true })).newItems, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v1 journals migrate without replaying retained decisions as trigger candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-migration-test-"));
  const statePath = join(directory, "scout.json");
  const now = Date.parse("2026-08-07T12:05:00Z");
  const retainedDecision: MarketEventDecision = evaluateMarketEvent(HALT_SOURCE, {
    id: "migration-retained",
    title: "Trading halt",
    summary: "",
    publishedAt: now,
    categories: [],
    structuredSymbols: ["NVDA"],
  }, now, ["NVDA"]);

  try {
    await writeFile(statePath, JSON.stringify({
      version: 1,
      updatedAt: now,
      sources: [],
      decisions: [retainedDecision],
    }), "utf8");
    const migrated = await readMarketEventScoutState(statePath, now);
    assert.equal(migrated.version, 3);
    assert.equal(migrated.decisions.length, 1);
    assert.equal(migrated.triggerDryRun.candidates.length, 0);
    assert.equal(migrated.triggerDryRun.totals.evaluated, 0);

    const scout = new MarketEventScout({
      client: { async readDocument() { return document(rss(rssItem({ guid: "migration-baseline", symbol: "NVDA" }))); } },
      statePath,
      sources: [HALT_SOURCE],
      now: () => now,
    });
    const baseline = await scout.run({ force: true });
    assert.equal(baseline.candidateEvaluated, 0);
    const raw = JSON.parse(await readFile(statePath, "utf8")) as { version: number };
    assert.equal(raw.version, 3, "the next atomic scout write persists v3");
    assert.equal((await scout.getState()).triggerDryRun.candidates.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v2 journals preserve dry-run evidence but never backfill the dispatch outbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-v2-migration-test-"));
  const statePath = join(directory, "scout.json");
  let now = Date.parse("2026-08-07T12:05:00Z");
  const bodies = [
    rss(rssItem({ guid: "v2-baseline", symbol: "NVDA" })),
    rss(rssItem({ guid: "v2-event", symbol: "AAPL", published: "Fri, 07 Aug 2026 12:06:00 GMT" })),
  ];
  const client = { async readDocument() { return document(bodies.shift()!); } };
  try {
    const seed = new MarketEventScout({
      client,
      statePath,
      sources: [HALT_SOURCE],
      getTrackedSymbols: () => ["NVDA", "AAPL"],
      now: () => now,
    });
    await seed.run({ force: true });
    now += 2 * 60_000;
    await seed.run({ force: true });
    const raw = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    delete raw.triggerDispatches;
    raw.version = 2;
    await writeFile(statePath, JSON.stringify(raw), "utf8");

    const migrated = await readMarketEventScoutState(statePath, now);
    assert.equal(migrated.version, 3);
    assert.equal(migrated.triggerDryRun.candidates.length, 1);
    assert.equal(migrated.triggerDryRun.totals.wouldTrigger, 1);
    assert.deepEqual(migrated.triggerDispatches, []);

    const dispatched: string[] = [];
    const dispatchingScout = new MarketEventScout({
      client,
      statePath,
      sources: [HALT_SOURCE],
      getTrackedSymbols: () => ["NVDA", "AAPL"],
      now: () => now,
      dispatch: {
        modelId: "nvidia/nemotron-3.5-lightning:free",
        dispatch(candidate) {
          dispatched.push(candidate.id);
          return { accepted: true, jobId: "v2-migration-job" };
        },
      },
    });
    const result = await dispatchingScout.run({ force: true });
    assert.equal(result.dispatchEnqueued, 0, "retained v2 candidates are not replayed as new dispatches");
    assert.deepEqual(dispatched, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted dispatch records reject a paid or alternate model ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-model-journal-test-"));
  const statePath = join(directory, "scout.json");
  try {
    await writeFile(statePath, JSON.stringify({
      version: 3,
      updatedAt: Date.parse("2026-08-07T12:00:00Z"),
      sources: [],
      decisions: [],
      triggerDryRun: {
        policy: DEFAULT_MARKET_EVENT_TRIGGER_POLICY,
        candidates: [],
        days: [],
        cooldowns: [],
        totals: {
          evaluated: 0,
          mapped: 0,
          wouldTrigger: 0,
          gated: 0,
          missingPublishedAt: 0,
          routes: { tickerBrief: 0, macroEventBrief: 0, marketStoryBrief: 0, unsupported: 0 },
          associations: { structuredSymbol: 0, explicitSymbol: 0, marketWide: 0, unresolved: 0 },
          gates: { notAdmitted: 0, unsupportedRoute: 0, belowPriority: 0, expired: 0, targetCooldown: 0, dailyCap: 0 },
        },
      },
      triggerDispatches: [{
        candidateId: `trg-${"a".repeat(32)}`,
        status: "enqueued",
        attempt: 1,
        createdAt: Date.parse("2026-08-07T12:00:00Z"),
        updatedAt: Date.parse("2026-08-07T12:00:00Z"),
        modelId: "openai/gpt-5",
        dispatchDays: ["2026-08-07"],
        jobId: "paid-model-job",
      }],
    }), "utf8");
    await assert.rejects(readMarketEventScoutState(statePath), /invalid record/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dry-run target cooldown survives restart and opens exactly at the boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-cooldown-test-"));
  const statePath = join(directory, "scout.json");
  let now = Date.parse("2026-08-07T12:00:00Z");
  const policy: MarketEventTriggerPolicy = {
    version: 1,
    minPriority: 80,
    ttlMs: 10 * 60_000,
    targetCooldownMs: 60_000,
    dailyCap: 8,
  };
  const bodies = [
    rss(rssItem({ guid: "cooldown-baseline", symbol: "NVDA", published: "Fri, 07 Aug 2026 12:00:00 GMT" })),
    rss(
      rssItem({ guid: "cooldown-1", symbol: "NVDA", published: "Fri, 07 Aug 2026 12:01:00 GMT" }),
      rssItem({ guid: "cooldown-2", symbol: "NVDA", published: "Fri, 07 Aug 2026 12:01:00 GMT" }),
    ),
    rss(rssItem({ guid: "cooldown-3", symbol: "NVDA", published: "Fri, 07 Aug 2026 12:02:00 GMT" })),
  ];
  const client = { async readDocument() { return document(bodies.shift()!); } };
  const options = {
    client,
    statePath,
    sources: [HALT_SOURCE],
    getTrackedSymbols: () => ["NVDA"],
    now: () => now,
    triggerPolicy: policy,
  };

  try {
    await new MarketEventScout(options).run({ force: true });
    now += 60_000;
    const sameTarget = await new MarketEventScout(options).run({ force: true });
    assert.equal(sameTarget.candidateEvaluated, 2);
    assert.equal(sameTarget.wouldTrigger, 1);
    assert.equal(sameTarget.gated, 1);
    assert.deepEqual(
      sameTarget.triggerCandidates.find((candidate) => candidate.outcome === "gated")?.gateReasonCodes,
      ["target-cooldown"],
    );

    now += 60_000;
    const restarted = await new MarketEventScout(options).run({ force: true });
    assert.equal(restarted.wouldTrigger, 1, "the persisted cooldown permits the exact boundary");
    assert.equal((await readMarketEventScoutState(statePath, now)).triggerDryRun.totals.wouldTrigger, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dry-run daily cap survives restart and resets on the UTC day boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-daily-cap-test-"));
  const statePath = join(directory, "scout.json");
  let now = Date.parse("2026-08-07T23:58:00Z");
  const policy: MarketEventTriggerPolicy = {
    version: 1,
    minPriority: 80,
    ttlMs: 10 * 60_000,
    targetCooldownMs: 60_000,
    dailyCap: 1,
  };
  const bodies = [
    rss(rssItem({ guid: "cap-baseline", symbol: "NVDA", published: "Fri, 07 Aug 2026 23:58:00 GMT" })),
    rss(
      rssItem({ guid: "cap-1", symbol: "AAPL", published: "Fri, 07 Aug 2026 23:59:00 GMT" }),
      rssItem({ guid: "cap-2", symbol: "MSFT", published: "Fri, 07 Aug 2026 23:59:00 GMT" }),
    ),
    rss(rssItem({ guid: "cap-3", symbol: "TSLA", published: "Sat, 08 Aug 2026 00:00:00 GMT" })),
  ];
  const client = { async readDocument() { return document(bodies.shift()!); } };
  const options = {
    client,
    statePath,
    sources: [HALT_SOURCE],
    getTrackedSymbols: () => ["NVDA", "AAPL", "MSFT", "TSLA"],
    now: () => now,
    triggerPolicy: policy,
  };

  try {
    await new MarketEventScout(options).run({ force: true });
    now = Date.parse("2026-08-07T23:59:00Z");
    const capped = await new MarketEventScout(options).run({ force: true });
    assert.equal(capped.wouldTrigger, 1);
    assert.equal(capped.gated, 1);
    assert.deepEqual(
      capped.triggerCandidates.find((candidate) => candidate.outcome === "gated")?.gateReasonCodes,
      ["daily-cap"],
    );

    now = Date.parse("2026-08-08T00:00:00Z");
    const nextDay = await new MarketEventScout(options).run({ force: true });
    assert.equal(nextDay.wouldTrigger, 1);
    const state = await readMarketEventScoutState(statePath, now);
    assert.deepEqual(state.triggerDryRun.days.map((day) => day.day), ["2026-08-08", "2026-08-07"]);
    assert.deepEqual(state.triggerDryRun.days.map((day) => day.aggregate.wouldTrigger), [1, 1]);
    assert.equal(state.triggerDryRun.totals.evaluated, 3);
    assert.equal(state.triggerDryRun.totals.wouldTrigger, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shadow scout respects due times and malformed persisted state fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-state-test-"));
  const statePath = join(directory, "scout.json");
  const now = Date.parse("2026-08-07T12:05:00Z");
  let calls = 0;
  const scout = new MarketEventScout({
    client: {
      async readDocument(): Promise<UnbrowserDocument> {
        calls += 1;
        return document(rss(rssItem({ guid: "halt-1", symbol: "NVDA" })));
      },
    },
    statePath,
    sources: [HALT_SOURCE],
    now: () => now,
  });

  try {
    await scout.run();
    const notDue = await scout.run();
    assert.equal(notDue.polledSources, 0);
    assert.equal(calls, 1);

    await writeFile(statePath, "{not-json", "utf8");
    await assert.rejects(scout.run({ force: true }), /Malformed market event scout state/);
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("truncated and item-overflow documents never establish or advance a baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-truncation-test-"));
  const statePath = join(directory, "scout.json");
  const overflow = rss(...Array.from({ length: 201 }, (_, index) => rssItem({ guid: `halt-${index}`, symbol: "NVDA" })));
  const responses = [document(rss(rssItem({ guid: "halt-1", symbol: "NVDA" })), true), document(overflow)];
  const scout = new MarketEventScout({
    client: { async readDocument() { return responses.shift()!; } },
    statePath,
    sources: [HALT_SOURCE],
  });

  try {
    const truncated = await scout.run({ force: true });
    assert.equal(truncated.failedSources, 1);
    let state = await scout.getState();
    assert.equal(state.sources[0]?.baselineComplete, false);
    assert.deepEqual(state.sources[0]?.seenEventIds, []);

    const overflowed = await scout.run({ force: true });
    assert.equal(overflowed.failedSources, 1);
    state = await scout.getState();
    assert.equal(state.sources[0]?.baselineComplete, false);
    assert.deepEqual(state.sources[0]?.seenEventIds, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed poll cannot consume a valid unseen event from dedupe state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-malformed-test-"));
  const statePath = join(directory, "scout.json");
  let now = Date.parse("2026-08-07T12:05:00Z");
  const first = rss(rssItem({ guid: "halt-1", symbol: "NVDA" }));
  const secondItem = rssItem({ guid: "halt-2", symbol: "AAPL", published: "Fri, 07 Aug 2026 12:06:00 GMT" });
  const malformed = `<?xml version="1.0"?><rss><channel>${secondItem}<item><guid>halt-broken</guid></channel></rss>`;
  const recovered = rss(secondItem, rssItem({ guid: "halt-1", symbol: "NVDA" }));
  const responses = [document(first), document(malformed), document(recovered)];
  const scout = new MarketEventScout({
    client: { async readDocument() { return responses.shift()!; } },
    statePath,
    sources: [HALT_SOURCE],
    getTrackedSymbols: () => ["NVDA", "AAPL"],
    now: () => now,
  });

  try {
    assert.equal((await scout.run({ force: true })).baselineItems, 1);
    now += 60_000;
    const failed = await scout.run({ force: true });
    assert.equal(failed.failedSources, 1);
    let state = await scout.getState();
    assert.equal(state.sources[0]?.newItems, 0);
    assert.equal(state.sources[0]?.seenEventIds.length, 1);

    now += 60_000;
    const retried = await scout.run({ force: true });
    assert.equal(retried.newItems, 1);
    assert.equal(retried.admitted, 1);
    state = await scout.getState();
    assert.equal(state.sources[0]?.seenEventIds.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("next due time preserves the exact configured source cadence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-cadence-test-"));
  const statePath = join(directory, "scout.json");
  let now = Date.parse("2026-08-07T12:00:00Z");
  let calls = 0;
  const scout = new MarketEventScout({
    client: {
      async readDocument() {
        calls += 1;
        return document(rss(rssItem({ guid: "halt-1", symbol: "NVDA" })));
      },
    },
    statePath,
    sources: [HALT_SOURCE],
    now: () => now,
  });

  try {
    await scout.run();
    assert.equal(await scout.nextDueAt(), now + 60_000);
    now += 59_999;
    assert.equal((await scout.run()).polledSources, 0);
    now += 1;
    assert.equal((await scout.run()).polledSources, 1);
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a per-source deadline prevents one stalled source from starving the run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-timeout-test-"));
  const statePath = join(directory, "scout.json");
  const healthySource: MarketEventSource = { ...HALT_SOURCE, id: "healthy-halts", url: "https://exchange.example/healthy.xml" };
  const scout = new MarketEventScout({
    client: {
      async readDocument(url, signal) {
        if (url === HALT_SOURCE.url) {
          return new Promise<UnbrowserDocument>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return document(rss(rssItem({ guid: "halt-healthy", symbol: "AAPL" })));
      },
    },
    statePath,
    sources: [HALT_SOURCE, healthySource],
    sourceTimeoutMs: 10,
  });

  try {
    const result = await scout.run({ force: true });
    assert.equal(result.failedSources, 1);
    assert.equal(result.successfulSources, 1);
    assert.equal(result.baselineItems, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate scout instances serialize writes for the same state path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-lock-test-"));
  const statePath = join(directory, "scout.json");
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const client = {
    async readDocument() {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        markFirstEntered();
        await firstGate;
      }
      active -= 1;
      return document(rss(rssItem({ guid: "halt-1", symbol: "NVDA" })));
    },
  };
  const first = new MarketEventScout({ client, statePath, sources: [HALT_SOURCE] });
  const second = new MarketEventScout({ client, statePath, sources: [HALT_SOURCE] });
  const firstRun = first.run({ force: true });
  const secondRun = second.run({ force: true });

  try {
    await firstEntered;
    assert.equal(calls, 1);
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
    assert.equal(firstResult.baselineItems, 1);
    assert.equal(secondResult.baselineItems, 0);
    assert.equal(secondResult.newItems, 0);
    assert.equal(maxActive, 1);
  } finally {
    releaseFirst();
    await Promise.allSettled([firstRun, secondRun]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted state rejects missing timestamps and inconsistent admitted targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-validation-test-"));
  const statePath = join(directory, "scout.json");
  const now = Date.parse("2026-08-07T12:05:00Z");
  const admitted = evaluateMarketEvent(HALT_SOURCE, {
    id: "evt-00000000000000000000000000000000",
    title: "Trading halt",
    summary: "",
    publishedAt: now,
    categories: [],
    structuredSymbols: ["NVDA"],
  }, now, ["NVDA"]);

  try {
    await writeFile(statePath, JSON.stringify({ version: 1, sources: [], decisions: [] }), "utf8");
    await assert.rejects(readMarketEventScoutState(statePath), /invalid updatedAt/);

    await writeFile(statePath, JSON.stringify({
      version: 1,
      updatedAt: now,
      sources: [],
      decisions: [{ ...admitted, target: undefined }],
    }), "utf8");
    await assert.rejects(readMarketEventScoutState(statePath), /invalid record/);

    await rm(statePath, { force: true });
    const invalidV2 = await readMarketEventScoutState(statePath, now);
    invalidV2.triggerDryRun.policy.dailyCap = 0;
    await writeFile(statePath, JSON.stringify(invalidV2), "utf8");
    await assert.rejects(readMarketEventScoutState(statePath), /invalid record/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborting a run before persistence leaves no baseline or dedupe state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-scout-abort-test-"));
  const statePath = join(directory, "scout.json");
  const controller = new AbortController();
  const scout = new MarketEventScout({
    client: {
      async readDocument(_url, signal) {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return document(rss(rssItem({ guid: "halt-1", symbol: "NVDA" })));
      },
    },
    statePath,
    sources: [HALT_SOURCE],
  });

  try {
    const run = scout.run({ force: true, signal: controller.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("test stop"));
    await assert.rejects(run, /test stop/);
    const state = await readMarketEventScoutState(statePath);
    assert.deepEqual(state.sources, []);
    assert.deepEqual(state.decisions, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
