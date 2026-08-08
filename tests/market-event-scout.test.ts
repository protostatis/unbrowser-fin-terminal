import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_MARKET_EVENT_SOURCES,
  evaluateMarketEvent,
  MarketEventScout,
  type MarketEventSource,
  parsePublicFeed,
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

    now += 2 * 60_000;
    const duplicate = await scout.run({ force: true });
    assert.equal(duplicate.newItems, 0);
    assert.equal(duplicate.admitted, 0);

    const state = await readMarketEventScoutState(statePath, now);
    assert.equal(state.sources[0]?.baselineComplete, true);
    assert.equal(state.sources[0]?.newItems, 1);
    assert.equal(state.sources[0]?.admitted, 1);
    assert.equal(state.decisions.length, 1);
    assert.equal(client.calls, 3);
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

    const restarted = new MarketEventScout(options);
    now += 60_000;
    assert.equal((await restarted.run({ force: true })).newItems, 0);
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
