import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  globalCacheKey,
  isGlobalCacheEntryEligible,
  resolveGlobalCacheExpiry,
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

test("global cache eligibility treats expired entries as misses", () => {
  const valid = entry();
  assert.equal(isGlobalCacheEntryEligible(valid, valid.generatedAt + 1_000), true);
  assert.equal(isGlobalCacheEntryEligible(valid, valid.expiresAt), false);
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
