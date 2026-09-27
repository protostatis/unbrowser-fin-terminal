import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildGlobalCacheEntry,
  globalCacheKey,
  isGlobalCacheEntryEligible,
  resolveGlobalCacheExpiry,
  sanitizeGlobalCacheCanvas,
  validateGlobalCacheEntry,
  validateGlobalCacheIdentity,
  type GlobalCacheEntry,
} from "../shared/global-research-cache.js";
import { createGlobalCacheStore } from "../server/global-cache-store.js";

const CANDIDATE = `trg-${"a".repeat(32)}`;
const DECISION = `evt-${"b".repeat(32)}`;

function canvas(symbol = "AAPL") {
  return {
    symbol,
    title: "AAPL Brief",
    content: "",
    stage: "complete" as const,
    updatedAt: 1_700_000_000_000,
    chartScope: "day" as const,
    researchKey: "v1/ticker/brief",
    intent: "brief" as const,
    contextLabel: "AAPL BRIEF",
    blocks: [
      {
        kind: "bullets" as const,
        title: "Read",
        dossierHint: "read" as const,
        items: [{ text: "verified fact", sourceIds: ["S1"] }],
      },
    ],
    evidencePackets: [
      {
        sourceId: "S1",
        sourceTitle: "Example",
        sourceDomain: "example.com",
        sourceUrl: "https://example.com/report",
        excerpt: "verified fact",
        retrievalStatus: "fetched" as const,
        extractedAt: 1_700_000_000_000,
        extractionMode: "mcp",
        truncated: false,
      },
    ],
  };
}

function entry(overrides: Partial<GlobalCacheEntry> = {}): GlobalCacheEntry {
  const identity = {
    symbol: "AAPL",
    chartScope: "day" as const,
    researchKey: "v1/ticker/brief",
    intent: "brief" as const,
  };
  const generatedAt = 1_700_000_000_000;
  return {
    schema: 1,
    producer: "global-scout-runner/v1",
    cacheKey: globalCacheKey(identity),
    identity,
    kind: "ticker-brief",
    canvas: canvas(),
    quality: { usable: true, codes: [], fetchedCount: 1, qualityVersion: 1 },
    provenance: {
      candidateId: CANDIDATE,
      decisionId: DECISION,
      sourceId: "nasdaq-trade-halts",
      sourceUrl: "https://example.com/report",
      title: "Trading halt",
      observedAt: generatedAt,
      publishedAt: generatedAt,
    },
    asOf: generatedAt,
    generatedAt,
    expiresAt: generatedAt + 2 * 60 * 60_000,
    promptContract: "scout-canonical-brief/v1",
    policyVersion: "quality-public/v1",
    ...overrides,
  };
}

test("global cache identity accepts only canonical brief identities", () => {
  assert.equal(
    validateGlobalCacheIdentity({ symbol: "AAPL", chartScope: "day", researchKey: "v1/ticker/brief", intent: "brief" }),
    true,
  );
  assert.equal(
    validateGlobalCacheIdentity({ symbol: "MARKET", chartScope: "day", researchKey: "v1/market/events/macro/brief", intent: "brief" }),
    true,
  );
  assert.equal(
    validateGlobalCacheIdentity({ symbol: "AAPL", chartScope: "day", researchKey: "v1/ticker/why", intent: "why" }),
    false,
  );
  assert.equal(
    validateGlobalCacheIdentity({ symbol: "MARKET", chartScope: "day", researchKey: "v1/ticker/brief", intent: "brief" }),
    false,
  );
  assert.equal(
    validateGlobalCacheIdentity({ symbol: "AAPL", chartScope: "day", researchKey: "v1/market/story/brief", intent: "brief" }),
    false,
  );
});

test("global cache expiry caps ticker and macro TTLs by trigger validity", () => {
  const generatedAt = 1_700_000_000_000;
  assert.equal(
    resolveGlobalCacheExpiry({ generatedAt, kind: "ticker-brief", candidateExpiresAt: generatedAt + 10 * 60 * 60_000 }),
    generatedAt + 2 * 60 * 60_000,
  );
  assert.equal(
    resolveGlobalCacheExpiry({ generatedAt, kind: "macro-event-brief", candidateExpiresAt: generatedAt + 10 * 60 * 60_000 }),
    generatedAt + 4 * 60 * 60_000,
  );
  assert.equal(
    resolveGlobalCacheExpiry({ generatedAt, kind: "ticker-brief", candidateExpiresAt: generatedAt + 30 * 60_000 }),
    generatedAt + 30 * 60_000,
  );
});

test("global cache entry rejects non-public or incomplete evidence", () => {
  assert.equal(validateGlobalCacheEntry(entry()), true);
  const httpEntry = entry({
    canvas: {
      ...canvas(),
      evidencePackets: [{ ...canvas().evidencePackets![0]!, sourceUrl: "http://example.com/report" }],
    },
  });
  assert.equal(validateGlobalCacheEntry(httpEntry), false);
  const privateEntry = entry({
    canvas: {
      ...canvas(),
      evidencePackets: [{ ...canvas().evidencePackets![0]!, sourceUrl: "https://example.com/report?token=secret-value" }],
    },
  });
  assert.equal(validateGlobalCacheEntry(privateEntry), false);
  const partialEntry = entry({ canvas: { ...canvas(), stage: "partial" as const } });
  assert.equal(validateGlobalCacheEntry(partialEntry), false);
  const wrongKey = entry({ cacheKey: "wrong" });
  assert.equal(validateGlobalCacheEntry(wrongKey), false);
});

test("global cache canvas projection drops internal fields and requires cited evidence", () => {
  const publishable = sanitizeGlobalCacheCanvas(canvas());
  assert.ok(publishable);
  assert.deepEqual(Object.keys(publishable).sort(), [
    "blocks",
    "chartScope",
    "content",
    "contextLabel",
    "evidencePackets",
    "intent",
    "researchKey",
    "stage",
    "symbol",
    "title",
    "updatedAt",
  ]);
  assert.equal(sanitizeGlobalCacheCanvas({ ...canvas(), researchId: "job-1" }), undefined);
  assert.equal(sanitizeGlobalCacheCanvas({ ...canvas(), evidenceBlocker: "blocked" }), undefined);
  assert.equal(
    sanitizeGlobalCacheCanvas({
      ...canvas(),
      blocks: [{ kind: "bullets" as const, items: [{ text: "uncited claim" }] }],
    }),
    undefined,
  );
  assert.equal(
    sanitizeGlobalCacheCanvas({
      ...canvas(),
      blocks: [{ kind: "bullets" as const, items: [{ text: "bad cite", sourceIds: ["S9"] }] }],
    }),
    undefined,
  );
  // Hostile nested fields and off-evidence URLs never publish.
  assert.equal(
    sanitizeGlobalCacheCanvas({
      ...canvas(),
      blocks: [
        {
          kind: "news" as const,
          title: "News",
          dossierHint: "read" as const,
          items: [{ headline: "trap", sourceIds: ["S1"], url: "https://evil.example/phish", note: "x" }],
        },
      ],
    }),
    undefined,
  );
  assert.equal(
    sanitizeGlobalCacheCanvas({
      ...canvas(),
      blocks: [
        {
          kind: "bullets" as const,
          title: "Read",
          dossierHint: "read" as const,
          items: [{ text: "ok", sourceIds: ["S1"] }],
          backdoor: "drop table",
        } as unknown as Record<string, unknown>,
      ],
    }),
    undefined,
  );
  // No read block means no publish, even with fetched evidence present.
  assert.equal(
    sanitizeGlobalCacheCanvas({
      ...canvas(),
      blocks: [{ kind: "metrics" as const, title: "Metrics", items: [] }],
    }),
    undefined,
  );
  // Free-form text blocks are not publishable at all.
  assert.equal(
    sanitizeGlobalCacheCanvas({
      ...canvas(),
      blocks: [
        {
          kind: "text" as const,
          title: "Read",
          dossierHint: "read" as const,
          text: "cited prose claim",
          sourceIds: ["S1"],
        },
      ],
    }),
    undefined,
  );
  // Nested extra fields on an otherwise valid item never publish.
  assert.equal(
    sanitizeGlobalCacheCanvas({
      ...canvas(),
      blocks: [
        {
          kind: "bullets" as const,
          title: "Read",
          dossierHint: "read" as const,
          items: [{ text: "ok", sourceIds: ["S1"], researchId: "private-job" }],
        },
      ],
    }),
    undefined,
  );
  // One cited sibling cannot launder an uncited item in the same block.
  assert.equal(
    sanitizeGlobalCacheCanvas({
      ...canvas(),
      blocks: [
        {
          kind: "bullets" as const,
          title: "Read",
          dossierHint: "read" as const,
          items: [
            { text: "cited", sourceIds: ["S1"] },
            { text: "uncited" },
          ],
        },
      ],
    }),
    undefined,
  );
  // Free-form content prose never publishes, even with cited blocks.
  assert.equal(sanitizeGlobalCacheCanvas({ ...canvas(), content: "uncited summary prose" }), undefined);
  // Allowed keys with attacker-shaped values never publish: an object id on
  // an otherwise valid cited read block.
  assert.equal(
    sanitizeGlobalCacheCanvas({
      ...canvas(),
      blocks: [
        {
          id: { researchId: "private-job" },
          kind: "bullets" as const,
          title: "Read",
          dossierHint: "read" as const,
          items: [{ text: "cited", sourceIds: ["S1"] }],
        },
      ],
    }),
    undefined,
  );
  // Rogue chart session entries never publish.
  assert.equal(
    sanitizeGlobalCacheCanvas({
      ...canvas(),
      blocks: [
        {
          kind: "chart" as const,
          title: "Price",
          points: [1, 2],
          pointSessions: ["regular", { session: "evil" }],
          sourceIds: ["S1"],
        },
      ],
    }),
    undefined,
  );
  // Unknown dossier hints never publish.
  assert.equal(
    sanitizeGlobalCacheCanvas({
      ...canvas(),
      blocks: [
        {
          kind: "bullets" as const,
          title: "Read",
          dossierHint: "exfiltrate",
          items: [{ text: "cited", sourceIds: ["S1"] }],
        },
      ],
    }),
    undefined,
  );
});

test("global cache builder pins versions and caps expiry by trigger validity", () => {
  const generatedAt = 1_700_000_000_000;
  const built = buildGlobalCacheEntry({
    identity: { symbol: "AAPL", chartScope: "day", researchKey: "v1/ticker/brief", intent: "brief" },
    canvas: canvas(),
    quality: { usable: true, codes: [], fetchedCount: 1, qualityVersion: 1 },
    provenance: {
      candidateId: CANDIDATE,
      decisionId: DECISION,
      sourceId: "nasdaq-trade-halts",
      title: "Trading halt",
      observedAt: generatedAt,
    },
    generatedAt,
    candidateExpiresAt: generatedAt + 30 * 60_000,
  });
  assert.equal(built.expiresAt, generatedAt + 30 * 60_000);
  assert.equal(built.promptContract, "scout-canonical-brief/v1");
  assert.equal(built.policyVersion, "quality-public/v1");
  assert.equal(validateGlobalCacheEntry(built), true);
  assert.throws(
    () =>
      buildGlobalCacheEntry({
        identity: { symbol: "AAPL", chartScope: "day", researchKey: "v1/ticker/brief", intent: "brief" },
        canvas: canvas(),
        quality: { usable: false, codes: ["EVIDENCE_NONE"], fetchedCount: 0, qualityVersion: 1 },
        provenance: {
          candidateId: CANDIDATE,
          decisionId: DECISION,
          sourceId: "nasdaq-trade-halts",
          title: "Trading halt",
          observedAt: generatedAt,
        },
        generatedAt,
        candidateExpiresAt: generatedAt + 60_000,
      }),
    /not usable/,
  );
});

test("global cache entry rejects canvas identity mismatch and over-long TTL", () => {
  const valid = entry();
  assert.equal(validateGlobalCacheEntry(valid), true);
  assert.equal(
    validateGlobalCacheEntry({ ...valid, canvas: { ...valid.canvas, symbol: "MSFT" } }),
    false,
  );
  assert.equal(
    validateGlobalCacheEntry({
      ...valid,
      generatedAt: valid.generatedAt,
      expiresAt: valid.generatedAt + 5 * 60 * 60_000,
    }),
    false,
  );
});

test("global cache eligibility treats expired entries as misses", () => {
  const valid = entry();
  assert.equal(isGlobalCacheEntryEligible(valid, valid.generatedAt + 1_000), true);
  assert.equal(isGlobalCacheEntryEligible(valid, valid.expiresAt), false);
});

test("global cache store resolves equal-timestamp conflicts by last writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "global-cache-conflict-"));
  try {
    const nowValue = 1_700_000_000_000 + 1_000;
    const store = createGlobalCacheStore({ filePath: path.join(root, "cache.sqlite"), now: () => nowValue });
    const lease = await store.acquireLease("runner-a");
    assert.ok(lease.lease);
    assert.equal((await store.putEntry(lease.lease.token, entry())).ok, true);
    const rival = entry({
      provenance: { ...entry().provenance, candidateId: `trg-${"d".repeat(32)}` },
    });
    // Same generation, different candidate: deterministic last-writer-wins.
    assert.equal((await store.putEntry(lease.lease.token, rival)).ok, true);
    const current = await store.getEntry(entry().cacheKey);
    assert.equal(current?.provenance.candidateId, `trg-${"d".repeat(32)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global cache store enforces single-writer lease and fencing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "global-cache-test-"));
  try {
    let now = 1_700_000_000_000;
    const store = createGlobalCacheStore({ filePath: path.join(root, "cache.sqlite"), now: () => now });
    const first = await store.acquireLease("runner-a");
    assert.equal(first.acquired, true);
    const second = await store.acquireLease("runner-b");
    assert.equal(second.acquired, false);
    const rejected = await store.putEntry("stale-token", entry());
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "stale-leader");
    assert.ok(first.lease);
    const published = await store.putEntry(first.lease.token, entry());
    assert.equal(published.ok, true);
    const hit = await store.getEntry(entry().cacheKey);
    assert.ok(hit);
    assert.equal(hit.provenance.candidateId, CANDIDATE);
    // Lease expiry lets another runner take over; old token stays fenced.
    now += 61_000;
    const takeover = await store.acquireLease("runner-b");
    assert.equal(takeover.acquired, true);
    assert.ok(takeover.lease);
    const staleWrite = await store.putEntry(first.lease.token, entry());
    assert.equal(staleWrite.ok, false);
    assert.equal(staleWrite.reason, "stale-leader");
    const released = await store.releaseLease("runner-b", takeover.lease.token);
    assert.equal(released, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global cache store renews its own lease and rejects foreign tokens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "global-cache-renew-"));
  try {
    let nowValue = 1_700_000_000_000;
    const store = createGlobalCacheStore({ filePath: path.join(root, "cache.sqlite"), now: () => nowValue, leaseTtlMs: 60_000 });
    const lease = await store.acquireLease("runner-a");
    assert.ok(lease.lease);
    assert.equal(await store.checkLease(lease.lease.token), true);
    assert.equal(await store.checkLease("deadbeef"), false);
    nowValue += 50_000;
    const renewed = await store.renewLease("runner-a", lease.lease.token);
    assert.equal(renewed.renewed, true);
    assert.ok(renewed.lease);
    assert.ok(renewed.lease.expiresAt > lease.lease.expiresAt);
    assert.equal(await store.checkLease(lease.lease.token), true);
    assert.equal((await store.renewLease("runner-b", lease.lease.token)).renewed, false);
    nowValue = renewed.lease.expiresAt + 1;
    assert.equal(await store.checkLease(lease.lease.token), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global cache store publication is idempotent and never regresses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "global-cache-idempotent-"));
  try {
    let nowValue = 1_700_000_000_000 + 1_000;
    const store = createGlobalCacheStore({ filePath: path.join(root, "cache.sqlite"), now: () => nowValue });
    const lease = await store.acquireLease("runner-a");
    assert.ok(lease.lease);
    const first = entry();
    assert.equal((await store.putEntry(lease.lease.token, first)).ok, true);
    const duplicate = await store.putEntry(lease.lease.token, first);
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.deduplicated, true);
    const older = entry({ generatedAt: first.generatedAt - 1, expiresAt: first.expiresAt - 1 });
    const stale = await store.putEntry(lease.lease.token, older);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "stale-entry");
    const newerCandidate = `trg-${"c".repeat(32)}`;
    const newer = entry({
      generatedAt: first.generatedAt + 60_000,
      expiresAt: first.expiresAt + 60_000,
      provenance: { ...first.provenance, candidateId: newerCandidate },
    });
    assert.equal((await store.putEntry(lease.lease.token, newer)).ok, true);
    nowValue = newer.generatedAt + 1_000;
    const current = await store.getEntry(first.cacheKey);
    assert.equal(current?.provenance.candidateId, newerCandidate);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
