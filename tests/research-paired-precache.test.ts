import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  buildPairedPrecachePlan,
  isArchivedResearchCacheEligible,
  readPrecacheEnabled,
  splitPairedCanvas,
} from "../.pi/extensions/market-terminal.js";
import {
  isValidResearchRequest,
  isWorkerSettledEvent,
  type ResearchRequestContext,
} from "../server/research-worker-protocol.js";
import {
  collectSessionUsage,
  installTokenGuard,
} from "../server/research-worker.js";
import {
  dayRemainingBudget,
  getOrCreateDay,
  pairedPairKey,
  readPrecacheLedger,
  readPrecacheBudgetConfig,
  reservePrecacheEntries,
  settlePrecacheEntry,
  utcDayKey,
  wouldExceedTokenLimit,
  writeLedger,
  type PrecacheLedgerDay,
  type PrecacheLedgerFile,
} from "../shared/research-precache-ledger.js";
import {
  collectResearchWorkerUsage,
  setResearchWorkerUsageCollector,
} from "../shared/research-worker-usage.js";

const noFresh = () => false;

function pairKey(symbol: string): string {
  return pairedPairKey(symbol, "day", "v1/ticker/brief", "v1/ticker/why");
}

// ── Paired plan ───────────────────────────────────────────────────────────

test("paired plan follows story, lead headline, event lanes, then mover rank", () => {
  const plan = buildPairedPrecachePlan({
    isFresh: noFresh,
    leadHeadline: { title: "Fed raises rates", url: "https://example.com/1", source: "Wire" },
    moverSymbols: ["NVDA", "TSLA"],
  });

  assert.deepEqual(plan.map((item) => item.symbol), [
    "MARKET", "MARKET", "MARKET", "MARKET", "MARKET", "NVDA", "TSLA",
  ]);
  assert.equal(plan[0]!.pairedTarget!.brief.researchKey, "v1/market/story/brief");
  assert.match(plan[1]!.pairedTarget!.brief.researchKey, /^v1\/market\/headline\/[a-f0-9]{12}\/brief$/);
  assert.deepEqual(plan.slice(2, 5).map((item) => item.pairedTarget!.brief.researchKey), [
    "v1/market/events/earnings/brief",
    "v1/market/events/macro/brief",
    "v1/market/events/global-relay/brief",
  ]);
});

test("paired plan uses deterministic, context-unique synthetic identities", () => {
  const options = { isFresh: noFresh, moverSymbols: ["NVDA", "TSLA"] };
  const first = buildPairedPrecachePlan(options);
  const second = buildPairedPrecachePlan(options);
  assert.deepEqual(first.map((item) => item.researchKey), second.map((item) => item.researchKey));
  assert.equal(new Set(first.map((item) => item.researchKey)).size, first.length);
  for (const item of first) assert.match(item.researchKey, /^v1\/paired\/[a-f0-9]{32}$/);
  assert.notEqual(
    first.find((item) => item.symbol === "NVDA")!.researchKey,
    first.find((item) => item.symbol === "TSLA")!.researchKey,
    "shared ticker research keys must still produce symbol-specific pairs",
  );
});

test("paired plan skips only when both exact halves are fresh", () => {
  const skipped = buildPairedPrecachePlan({
    isFresh: (_symbol, researchKey) => researchKey.includes("/story/"),
  });
  assert.equal(skipped.some((item) => item.pairedTarget!.brief.researchKey.includes("/story/")), false);

  const partial = buildPairedPrecachePlan({
    isFresh: (_symbol, researchKey) => researchKey === "v1/ticker/brief",
    moverSymbols: ["NVDA"],
  });
  const ticker = partial.find((item) => item.symbol === "NVDA")!;
  assert.equal(ticker.pairedTarget!.neededBrief, false);
  assert.equal(ticker.pairedTarget!.neededWhy, true);
});

test("paired ticker selection is mover-only, normalized, deduped, and capped", () => {
  const plan = buildPairedPrecachePlan({
    isFresh: noFresh,
    moverSymbols: [" nvda ", "NVDA", "TSLA", "invalid!"],
    maxJobs: 5,
  });
  assert.deepEqual(plan.filter((item) => item.symbol !== "MARKET").map((item) => item.symbol), ["NVDA"]);
  assert.equal(plan.length, 5, "four market contexts consume the first four slots");

  const noMovers = buildPairedPrecachePlan({ isFresh: noFresh });
  assert.equal(noMovers.every((item) => item.symbol === "MARKET"), true, "watchlist is not a fallback");
});

test("paired questions exactly match interactive BRIEF and WHY requests", () => {
  const plan = buildPairedPrecachePlan({ isFresh: noFresh, moverSymbols: ["AAPL"] });
  const story = plan[0]!.pairedTarget!;
  assert.equal(
    story.brief.question,
    "Build a source-verified factual market brief: current leadership, cross-asset moves, consequential developments, verified upcoming catalysts, and explicit unknowns.",
  );
  assert.equal(
    story.why.question,
    "Explain the current market regime: separate evidence from inference, map leadership and cross-asset transmission, provide bull/base/bear scenarios, and identify triggers and disconfirming evidence.",
  );
  const ticker = plan.find((item) => item.symbol === "AAPL")!.pairedTarget!;
  assert.equal(
    ticker.brief.question,
    "Build a source-verified factual brief of the latest company developments and catalysts: what happened, when, key reported numbers, upcoming verified dates, and explicit unknowns.",
  );
  assert.equal(
    ticker.why.question,
    "Explain why AAPL is moving and what matters next: separate evidence from inference, map causal drivers, give bull/base/bear scenarios, and identify triggers and disconfirming evidence.",
  );
});

test("disposable public workers stay cold even when pre-cache is explicitly enabled", () => {
  const previousWorker = process.env.PUBLIC_SESSION_WORKER;
  const previousMode = process.env.TERMINAL_RUNTIME_MODE;
  const previousEnabled = process.env.MARKET_PRECACHE_ENABLED;
  try {
    process.env.MARKET_PRECACHE_ENABLED = "1";
    process.env.PUBLIC_SESSION_WORKER = "1";
    delete process.env.TERMINAL_RUNTIME_MODE;
    assert.equal(readPrecacheEnabled(), false);
    delete process.env.PUBLIC_SESSION_WORKER;
    process.env.TERMINAL_RUNTIME_MODE = "public-gateway";
    assert.equal(readPrecacheEnabled(), false);
    process.env.TERMINAL_RUNTIME_MODE = "private-workspace";
    assert.equal(readPrecacheEnabled(), true);
  } finally {
    if (previousWorker === undefined) delete process.env.PUBLIC_SESSION_WORKER;
    else process.env.PUBLIC_SESSION_WORKER = previousWorker;
    if (previousMode === undefined) delete process.env.TERMINAL_RUNTIME_MODE;
    else process.env.TERMINAL_RUNTIME_MODE = previousMode;
    if (previousEnabled === undefined) delete process.env.MARKET_PRECACHE_ENABLED;
    else process.env.MARKET_PRECACHE_ENABLED = previousEnabled;
  }
});

test("quality-gated degraded pre-cache attempts remain archive-only", () => {
  assert.equal(isArchivedResearchCacheEligible({ quality: { usable: false } }), true, "interactive degraded archives retain existing behavior");
  assert.equal(isArchivedResearchCacheEligible({ generation: { origin: "precache", qualityGate: true }, quality: { usable: false } }), false);
  assert.equal(isArchivedResearchCacheEligible({ generation: { origin: "precache", qualityGate: true }, quality: { usable: true } }), true);
  assert.equal(isArchivedResearchCacheEligible({ generation: { origin: "precache", qualityGate: false }, quality: { usable: false } }), true);
});

// ── Strict split ──────────────────────────────────────────────────────────

const BRIEF_ID = { researchKey: "v1/ticker/brief", intent: "brief" as const, contextLabel: "AAPL BRIEF", question: "brief" };
const WHY_ID = { researchKey: "v1/ticker/why", intent: "why" as const, contextLabel: "AAPL WHY", question: "why" };

function pairedCanvas() {
  return {
    symbol: "AAPL",
    title: "AAPL paired",
    content: "",
    updatedAt: 1_786_089_600_000,
    stage: "complete" as const,
    chartScope: "day" as const,
    blocks: [
      { id: "brief-read", kind: "text" as const, text: "brief", sourceIds: ["S1"], dossierHint: "read" as const },
      { id: "why-read", kind: "bullets" as const, items: [{ text: "why", sourceIds: ["S2"] }], dossierHint: "read" as const },
      { id: "shared-sources", kind: "sources" as const, items: [{ id: "S1", label: "one", url: "https://one.example", status: "fetched" as const }] },
      { id: "ta-read", kind: "text" as const, text: "technical" },
      { id: "ignored", kind: "text" as const, text: "drop me" },
    ],
    evidencePackets: [
      { sourceId: "S1", sourceTitle: "One", sourceDomain: "one.example", sourceUrl: "https://one.example", excerpt: "one", retrievalStatus: "fetched" as const, extractedAt: 1, extractionMode: "text_main", truncated: false },
      { sourceId: "S2", sourceTitle: "Two", sourceDomain: "two.example", sourceUrl: "https://two.example", excerpt: "two", retrievalStatus: "fetched" as const, extractedAt: 1, extractionMode: "text_main", truncated: false },
    ],
    evidenceCitations: [
      { sourceId: "S1", quote: "brief quote" },
      { sourceId: "S2", quote: "why quote" },
      { sourceId: "S3", quote: "unused quote" },
    ],
  };
}

test("splitPairedCanvas uses only strict prefixes and filters citations per half", () => {
  const result = splitPairedCanvas(pairedCanvas(), BRIEF_ID, WHY_ID);
  if ("error" in result) assert.fail(result.error);
  assert.deepEqual(result.brief.blocks!.map((block) => block.id), ["read", "sources", "ta-read"]);
  assert.deepEqual(result.why.blocks!.map((block) => block.id), ["read", "sources", "ta-read"]);
  assert.deepEqual(result.brief.evidenceCitations, [{ sourceId: "S1", quote: "brief quote" }]);
  assert.deepEqual(result.why.evidenceCitations, [{ sourceId: "S2", quote: "why quote" }]);
  assert.equal(result.brief.researchKey, BRIEF_ID.researchKey);
  assert.equal(result.why.researchKey, WHY_ID.researchKey);
});

test("splitPairedCanvas rejects duplicate post-prefix IDs and partial canvases", () => {
  const duplicate = pairedCanvas();
  duplicate.blocks.push({ id: "shared-read", kind: "text", text: "duplicate" });
  assert.ok("error" in splitPairedCanvas(duplicate, BRIEF_ID, WHY_ID));
  assert.ok("error" in splitPairedCanvas({ ...pairedCanvas(), stage: "partial" }, BRIEF_ID, WHY_ID));
});

// ── Durable budget primitives ─────────────────────────────────────────────

test("pairedPairKey includes symbol and chart scope", () => {
  const aapl = pairKey("AAPL");
  assert.match(aapl, /^pair-[a-f0-9]{32}$/);
  assert.equal(aapl, pairKey("aapl"), "symbol normalization is stable");
  assert.notEqual(aapl, pairKey("MSFT"));
  assert.notEqual(aapl, pairedPairKey("AAPL", "week", "v1/ticker/brief", "v1/ticker/why"));
});

test("reservePrecacheEntries admits the highest-priority budget prefix", () => {
  const day: PrecacheLedgerDay = { date: "2026-08-07", budget: 250_000, perRunLimit: 100_000, entries: [] };
  const keys = [pairKey("AAPL"), pairKey("MSFT"), pairKey("NVDA")];
  const result = reservePrecacheEntries(day, keys, 1234);
  assert.deepEqual(result.reservedPairKeys, keys.slice(0, 2));
  assert.deepEqual(day.entries.map((entry) => entry.pairKey), keys.slice(0, 2));
  assert.equal(dayRemainingBudget(day), 50_000);
});

test("reservePrecacheEntries never redispatches an unresolved reservation", () => {
  const existing = pairKey("AAPL");
  const fresh = pairKey("MSFT");
  const day: PrecacheLedgerDay = {
    date: "2026-08-07",
    budget: 300_000,
    perRunLimit: 100_000,
    entries: [{ pairKey: existing, attempt: 1, reservation: 100_000, reservedAt: 1 }],
  };
  const result = reservePrecacheEntries(day, [existing, fresh]);
  assert.deepEqual(result.existingPairKeys, [existing]);
  assert.deepEqual(result.reservedPairKeys, [fresh]);
  assert.equal(day.entries.length, 2);
});

test("a settled pair can be reserved again after freshness/cooldown planning admits it", () => {
  const key = pairKey("AAPL");
  const day: PrecacheLedgerDay = {
    date: "2026-08-07",
    budget: 300_000,
    perRunLimit: 100_000,
    entries: [{ pairKey: key, attempt: 1, reservation: 100_000, reservedAt: 1, outcome: "failed", actualTokens: 20_000 }],
  };
  const result = reservePrecacheEntries(day, [key], 2);
  assert.deepEqual(result.reservedPairKeys, [key]);
  assert.equal(day.entries.length, 2);
  assert.equal(day.entries[1]!.attempt, 2);
  assert.equal(settlePrecacheEntry(day, key, 2, "complete", 30_000), true);
  assert.equal(day.entries[1]!.outcome, "complete");
});

test("settlement is idempotent and missing usage stays unknown", () => {
  const key = pairKey("AAPL");
  const day: PrecacheLedgerDay = {
    date: "2026-08-07",
    budget: 2_000_000,
    perRunLimit: 100_000,
    entries: [{ pairKey: key, attempt: 1, reservation: 100_000, reservedAt: 1 }],
  };
  assert.equal(settlePrecacheEntry(day, key, 1, "cancelled"), true);
  assert.equal(day.entries[0]!.actualTokens, undefined);
  assert.equal(settlePrecacheEntry(day, key, 1, "complete", 12_000), false);
  assert.equal(day.entries[0]!.outcome, "cancelled");
});

test("invalid settlement telemetry fails without mutating the reservation", () => {
  const key = pairKey("AAPL");
  const day: PrecacheLedgerDay = {
    date: "2026-08-07",
    budget: 2_000_000,
    perRunLimit: 100_000,
    entries: [{ pairKey: key, attempt: 1, reservation: 100_000, reservedAt: 1 }],
  };
  assert.throws(() => settlePrecacheEntry(day, key, 1, "complete", -1), /token usage is invalid/);
  assert.equal(day.entries[0]!.outcome, undefined);
});

test("ledger reservations and settlement survive a file round trip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-precache-ledger-"));
  const path = join(directory, "ledger.json");
  try {
    const key = pairKey("AAPL");
    const file: PrecacheLedgerFile = {
      version: 1,
      updatedAt: 1,
      days: [{
        date: "2026-08-07",
        budget: 2_000_000,
        perRunLimit: 100_000,
        entries: [{ pairKey: key, attempt: 1, reservation: 100_000, reservedAt: 1, outcome: "complete", actualTokens: 42_000 }],
      }],
    };
    await writeLedger(path, file);
    assert.deepEqual((await readPrecacheLedger(path)).days[0]!.entries, file.days[0]!.entries);

    await writeFile(path, "{not-json", "utf8");
    await assert.rejects(() => readPrecacheLedger(path), /invalid JSON/);

    await writeFile(path, JSON.stringify({
      ...file,
      days: [{
        ...file.days[0]!,
        entries: [
          { pairKey: key, attempt: 1, reservation: 100_000, reservedAt: 1 },
          { pairKey: key, attempt: 2, reservation: 100_000, reservedAt: 2 },
        ],
      }],
    }), "utf8");
    await assert.rejects(() => readPrecacheLedger(path), /invalid day entry/, "only one attempt per pair may remain unresolved");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("UTC day/config helpers fail closed on an in-day config change", () => {
  const previousBudget = process.env.MARKET_PRECACHE_BUDGET;
  const previousLimit = process.env.MARKET_PRECACHE_RUN_LIMIT;
  try {
    process.env.MARKET_PRECACHE_BUDGET = "2000000";
    process.env.MARKET_PRECACHE_RUN_LIMIT = "100000";
    assert.deepEqual(readPrecacheBudgetConfig(), { budget: 2_000_000, perRunLimit: 100_000 });
    assert.equal(utcDayKey(Date.UTC(2026, 7, 7, 23, 59, 59)), "2026-08-07");
    const file: PrecacheLedgerFile = { version: 1, updatedAt: 1, days: [] };
    assert.equal(getOrCreateDay(file, "2026-08-07").budget, 2_000_000);
    process.env.MARKET_PRECACHE_BUDGET = "1000000";
    assert.throws(() => getOrCreateDay(file, "2026-08-07"), /cannot change within an existing UTC ledger day/);
  } finally {
    if (previousBudget === undefined) delete process.env.MARKET_PRECACHE_BUDGET;
    else process.env.MARKET_PRECACHE_BUDGET = previousBudget;
    if (previousLimit === undefined) delete process.env.MARKET_PRECACHE_RUN_LIMIT;
    else process.env.MARKET_PRECACHE_RUN_LIMIT = previousLimit;
  }
});

test("token projection rejects the first amount above the run ceiling", () => {
  assert.equal(wouldExceedTokenLimit({ usedTotal: 83_904, contextEstimate: 12_000, modelMaxTokens: 4_096, tokenLimit: 100_000 }), false);
  assert.equal(wouldExceedTokenLimit({ usedTotal: 83_905, contextEstimate: 12_000, modelMaxTokens: 4_096, tokenLimit: 100_000 }), true);
  assert.equal(wouldExceedTokenLimit({ usedTotal: Number.NaN, contextEstimate: 0, modelMaxTokens: 0, tokenLimit: 100_000 }), true);
});

// ── IPC and live token guard ──────────────────────────────────────────────

function pairedRequest(): ResearchRequestContext {
  const plan = buildPairedPrecachePlan({ isFresh: noFresh });
  const item = plan[0]!;
  return {
    symbol: item.symbol,
    question: item.question,
    chartScope: item.chartScope,
    researchKey: item.researchKey,
    intent: item.intent,
    contextLabel: item.contextLabel,
    pairedTarget: item.pairedTarget!,
    origin: "precache",
    tokenLimit: 100_000,
  };
}

test("paired IPC requests require an exact recomputed synthetic identity", () => {
  const request = pairedRequest();
  assert.equal(isValidResearchRequest(request), true);
  assert.equal(isValidResearchRequest({ ...request, researchKey: `v1/paired/${"0".repeat(32)}` }), false);
  assert.equal(isValidResearchRequest({ ...request, origin: undefined }), false);
  assert.equal(isValidResearchRequest({
    ...request,
    pairedTarget: { ...request.pairedTarget!, neededBrief: false, neededWhy: false },
  }), false);
});

test("settled IPC usage must equal Pi's exact token-component sum", () => {
  const event = {
    version: 1,
    type: "settled",
    jobId: "job",
    attemptId: "attempt",
    sequence: 1,
    outcome: "complete",
    usage: { inputTokens: 5_000, outputTokens: 1_000, cacheReadTokens: 200, cacheWriteTokens: 100, totalTokens: 6_300, cost: 0.01 },
  };
  assert.equal(isWorkerSettledEvent(event), true);
  assert.equal(isWorkerSettledEvent({ ...event, usage: { ...event.usage, totalTokens: 6_000 } }), false);
  assert.equal(isWorkerSettledEvent({ ...event, usage: { ...event.usage, inputTokens: -1 } }), false);
});

function fakeGuardSession(options: { used: number; context: number | null; maxOutput: number }) {
  let listener: ((event: { type: string }) => void) | undefined;
  let aborts = 0;
  const state = { ...options };
  const session = {
    subscribe(next: (event: { type: string }) => void) {
      listener = next;
      return () => { listener = undefined; };
    },
    getSessionStats() { return { tokens: { total: state.used } }; },
    getContextUsage() { return { tokens: state.context }; },
    model: { maxTokens: state.maxOutput },
    async abort() { aborts += 1; },
  } as unknown as AgentSession;
  return {
    session,
    state,
    emitTurn: () => listener?.({ type: "turn_start" }),
    aborts: () => aborts,
  };
}

test("installTokenGuard enforces the ceiling before the first provider turn", () => {
  const denied = fakeGuardSession({ used: 90_000, context: 8_000, maxOutput: 4_096 });
  installTokenGuard(denied.session, 100_000);
  denied.emitTurn();
  assert.equal(denied.aborts(), 1);

  const allowed = fakeGuardSession({ used: 0, context: 8_000, maxOutput: 4_096 });
  installTokenGuard(allowed.session, 100_000);
  allowed.emitTurn();
  assert.equal(allowed.aborts(), 0);
  allowed.state.used = 90_000;
  allowed.emitTurn();
  assert.equal(allowed.aborts(), 1);
});

test("installTokenGuard fails closed when context accounting is unknown", () => {
  const fake = fakeGuardSession({ used: 0, context: null, maxOutput: 4_096 });
  installTokenGuard(fake.session, 100_000);
  fake.emitTurn();
  assert.equal(fake.aborts(), 1);
});

test("collectSessionUsage reports the exact Pi component total", () => {
  const session = {
    getSessionStats() {
      return {
        tokens: { input: 5_000, output: 1_000, cacheRead: 200, cacheWrite: 100, total: 6_300 },
        cost: 0.01,
      };
    },
  } as unknown as AgentSession;
  assert.deepEqual(collectSessionUsage(session), {
    inputTokens: 5_000,
    outputTokens: 1_000,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    totalTokens: 6_300,
    cost: 0.01,
  });
});

test("worker usage collector is available through the cross-loader global bridge", () => {
  const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 10 };
  try {
    setResearchWorkerUsageCollector(() => usage);
    assert.deepEqual(collectResearchWorkerUsage(), usage);
  } finally {
    setResearchWorkerUsageCollector(undefined);
  }
});
