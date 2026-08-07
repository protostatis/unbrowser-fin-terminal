import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCanvasQuality,
  cacheEvidenceSuffix,
  canvasQualityTelemetry,
  coalesceSourceBlocks,
  decidePrecacheCanary,
  isIdentityPrecacheCooled,
  readPrecacheQualityGate,
  type CanvasQuality,
} from "../.pi/extensions/market-terminal.js";

type TestCanvas = {
  symbol: string;
  title: string;
  content: string;
  updatedAt: number;
  stage?: string;
  researchKey?: string;
  intent?: string;
  contextLabel?: string;
  chartScope?: string;
  evidencePackets?: unknown[];
  evidenceBlocker?: string;
  blocks?: unknown[];
};

const fetchedPacket = { sourceId: "S1", sourceTitle: "t", sourceDomain: "d", sourceUrl: "https://example.com/a", excerpt: "x", retrievalStatus: "fetched", extractedAt: Date.now(), extractionMode: "text_main", truncated: false };
const failedPacket = { sourceId: "S1", sourceTitle: "t", sourceDomain: "d", sourceUrl: "https://example.com/a", excerpt: "", retrievalStatus: "failed", extractedAt: Date.now(), extractionMode: "text_main", truncated: false };

function canvas(overrides: Partial<TestCanvas> = {}): TestCanvas {
  return {
    symbol: "AAPL",
    title: "AAPL Brief",
    content: "",
    updatedAt: Date.now(),
    stage: "complete",
    researchKey: "v1/ticker/brief",
    intent: "brief",
    contextLabel: "AAPL BRIEF",
    chartScope: "day",
    evidencePackets: [fetchedPacket],
    blocks: [{ id: "read", kind: "text", text: "sourced summary", sourceIds: ["S1"], dossierHint: "read" }],
    ...overrides,
  };
}

function quality(c: TestCanvas): CanvasQuality {
  return assessCanvasQuality(c as never);
}

test("assessCanvasQuality accepts a complete canvas whose read is supported by fetched evidence", () => {
  assert.deepEqual(quality(canvas()), { usable: true, reasons: [], codes: [] });
});

test("assessCanvasQuality rejects blocked, pending, and evidence-less canvases", () => {
  const blocked = quality(canvas({ evidencePackets: [failedPacket], evidenceBlocker: "Source retrieval is temporarily unavailable." }));
  assert.equal(blocked.usable, false);
  assert.match(blocked.reasons.join(","), /blocked/);

  const none = quality(canvas({ evidencePackets: undefined }));
  assert.equal(none.usable, false);

  const pending = quality(canvas({ stage: "partial" }));
  assert.equal(pending.usable, false, "partial canvases are not usable cache hits");
});

test("assessCanvasQuality requires exactly one read block with sourceIds", () => {
  const noRead = quality(canvas({ blocks: [{ id: "sources", kind: "sources", items: [{ id: "S1", label: "a", url: "https://example.com/a" }] }] }));
  assert.equal(noRead.usable, false);
  assert.match(noRead.reasons.join(","), /read/);

  const readNoSources = quality(canvas({ blocks: [{ id: "read", kind: "text", text: "summary", dossierHint: "read" }] }));
  assert.equal(readNoSources.usable, false);
  assert.match(readNoSources.reasons.join(","), /sourceIds/);

  // The deterministic ta-read block must NOT satisfy the read requirement.
  const taOnly = quality(canvas({
    blocks: [{ id: "ta-read", kind: "bullets", title: "Technical Read · DAY", items: [{ text: "neutral", role: "fact", sourceIds: ["TA1"] }] }],
  }));
  assert.equal(taOnly.usable, false);
  assert.match(taOnly.reasons.join(","), /expected exactly one read/);
});

test("assessCanvasQuality rejects a read that cites unfetched sources", () => {
  const unsupported = quality(canvas({
    blocks: [{ id: "read", kind: "text", text: "claims", sourceIds: ["S9"], dossierHint: "read" }],
  }));
  assert.equal(unsupported.usable, false);
  assert.match(unsupported.reasons.join(","), /S9/);
});

test("assessCanvasQuality rejects scenarios blocks in a brief", () => {
  const withScenarios = quality(canvas({
    intent: "brief",
    blocks: [
      { id: "read", kind: "text", text: "sourced summary", sourceIds: ["S1"], dossierHint: "read" },
      { id: "scenarios", kind: "bullets", title: "Scenarios", items: [{ text: "bull case" }], dossierHint: "scenarios" },
    ],
  }));
  assert.equal(withScenarios.usable, false);
  assert.match(withScenarios.reasons.join(","), /scenarios/);
});

test("assessCanvasQuality is indifferent to scenarios in a WHY canvas", () => {
  const why = quality(canvas({
    intent: "why",
    blocks: [
      { id: "read", kind: "text", text: "sourced summary", sourceIds: ["S1"], dossierHint: "read" },
      { id: "scenarios", kind: "bullets", title: "Scenarios", items: [{ text: "bull case" }], dossierHint: "scenarios" },
    ],
  }));
  assert.equal(why.usable, true);
});

test("assessCanvasQuality rejects a read whose items are not all fetched-supported", () => {
  const mixed = quality(canvas({
    blocks: [{
      id: "read",
      kind: "bullets",
      items: [
        { text: "cited fact", role: "fact", sourceIds: ["S1"] },
        { text: "uncited claim", role: "fact" },
      ],
      dossierHint: "read",
    }],
  }));
  assert.equal(mixed.usable, false);
  assert.match(mixed.reasons.join(","), /without fetched source support/);
});

test("assessCanvasQuality rejects unsupported evidence blocks", () => {
  const withEvidence = quality(canvas({
    blocks: [
      { id: "read", kind: "text", text: "sourced summary", sourceIds: ["S1"], dossierHint: "read" },
      { id: "facts", kind: "bullets", title: "Evidence", items: [{ text: "unsourced fact" }], dossierHint: "evidence" },
    ],
  }));
  assert.equal(withEvidence.usable, false);
  assert.match(withEvidence.reasons.join(","), /evidence block/);
});

test("assessCanvasQuality accepts partial evidence but labels it", () => {
  const failedPacket = { sourceId: "S2", sourceTitle: "t", sourceDomain: "d", sourceUrl: "https://example.com/b", excerpt: "", retrievalStatus: "failed", extractedAt: Date.now(), extractionMode: "text_main", truncated: false };
  const partial = quality(canvas({ evidencePackets: [fetchedPacket, failedPacket] }));
  assert.equal(partial.usable, true, "partial evidence is freshness-usable by policy");
  assert.equal(cacheEvidenceSuffix(canvas({ evidencePackets: [fetchedPacket, failedPacket] }) as never), " · EVIDENCE PARTIAL");
});

test("cacheEvidenceSuffix labels degraded hits without duplicating the EVIDENCE word", () => {
  const blocked = canvas({ evidencePackets: [failedPacket], evidenceBlocker: "Source retrieval is temporarily unavailable." });
  const usable = canvas();
  assert.equal(cacheEvidenceSuffix(blocked as never), " · EVIDENCE BLOCKED");
  assert.equal(cacheEvidenceSuffix(usable as never), "");
});

test("classifyDossierHint: Market Breadth is not a read, ta-read wins over hints, legacy ids work", () => {
  // "Market Breadth" contains the substring "read" but must not classify as one.
  const breadth = quality(canvas({ blocks: [{ id: "breadth", kind: "metrics", title: "Market Breadth", items: [{ label: "adv", value: "100" }] }] }));
  assert.equal(breadth.usable, false);
  assert.match(breadth.reasons.join(","), /expected exactly one read/);

  // A model mislabeling ta-read with dossierHint "read" must not count it.
  const taMislabeled = quality(canvas({
    blocks: [{ id: "ta-read", kind: "bullets", title: "Technical Read · DAY", dossierHint: "read", items: [{ text: "neutral", role: "fact", sourceIds: ["TA1"] }] }],
  }));
  assert.equal(taMislabeled.usable, false);
  assert.match(taMislabeled.reasons.join(","), /expected exactly one read/);

  // A legacy block identified only by id="read" is still recognized.
  const legacyId = quality(canvas({ blocks: [{ id: "read", kind: "text", text: "sourced summary", sourceIds: ["S1"] }] }));
  assert.equal(legacyId.usable, true);
});

test("coalesceSourceBlocks lets a later fetched entry replace an earlier search-only one", () => {
  const seed = { id: "sources", kind: "sources", items: [{ id: "S1", label: "a", url: "https://a.com", status: "search-only" }] };
  const fetched = { kind: "sources", items: [{ id: "S1", label: "a", url: "https://a.com", status: "fetched" }] };
  const coalesced = coalesceSourceBlocks([seed, fetched] as never);
  const merged = coalesced.find((block) => block.kind === "sources") as { items: Array<{ id: string; status: string }> };
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0]!.status, "fetched", "fetched outranks search-only");
});

test("coalesceSourceBlocks merges duplicate agent source blocks and preserves ta-* sources", () => {
  const taSources = { id: "ta-sources", kind: "sources", title: "TA Source", items: [{ id: "TA1", label: "ta", url: "https://finance.yahoo.com/quote/AAPL", status: "fetched" }] };
  const agentA = { id: "sources", kind: "sources", items: [{ id: "S1", label: "a", url: "https://a.com", status: "search-only" }, { id: "S2", label: "b", url: "https://b.com", status: "search-only" }] };
  const agentB = { kind: "sources", items: [{ id: "S1", label: "a", url: "https://a.com", status: "search-only" }, { id: "S3", label: "c", url: "https://c.com", status: "search-only" }] };
  const read = { id: "read", kind: "text", text: "summary", dossierHint: "read" };

  const coalesced = coalesceSourceBlocks([taSources, agentA, read, agentB] as never);

  assert.equal(coalesced.length, 3, "one agent sources block, ta-sources, and the read block");
  const agentSources = coalesced.filter((block) => block.kind === "sources" && (block.id ?? "") !== "ta-sources");
  assert.equal(agentSources.length, 1);
  const items = (agentSources[0] as { items: Array<{ id: string }> }).items;
  assert.deepEqual(items.map((item) => item.id), ["S1", "S2", "S3"], "deduplicated by source id+url");
  const ta = coalesced.find((block) => block.id === "ta-sources");
  assert.equal(ta, taSources, "deterministic ta-* sources preserved untouched");
});

test("coalesceSourceBlocks leaves a single sources block alone", () => {
  const single = [{ id: "sources", kind: "sources", items: [{ id: "S1", label: "a", url: "https://a.com" }] }];
  assert.deepEqual(coalesceSourceBlocks(single as never), single);
});

test("readPrecacheQualityGate defaults on and accepts explicit values", () => {
  const previous = process.env.MARKET_PRECACHE_QUALITY_GATE;
  try {
    delete process.env.MARKET_PRECACHE_QUALITY_GATE;
    assert.equal(readPrecacheQualityGate(), true, "default is enabled");
    process.env.MARKET_PRECACHE_QUALITY_GATE = "0";
    assert.equal(readPrecacheQualityGate(), false);
    process.env.MARKET_PRECACHE_QUALITY_GATE = "off";
    assert.equal(readPrecacheQualityGate(), false);
    process.env.MARKET_PRECACHE_QUALITY_GATE = "true";
    assert.equal(readPrecacheQualityGate(), true);
    process.env.MARKET_PRECACHE_QUALITY_GATE = "banana";
    assert.throws(() => readPrecacheQualityGate(), /MARKET_PRECACHE_QUALITY_GATE/);
  } finally {
    if (previous === undefined) delete process.env.MARKET_PRECACHE_QUALITY_GATE;
    else process.env.MARKET_PRECACHE_QUALITY_GATE = previous;
  }
});

test("assessCanvasQuality returns stable typed failure codes", () => {
  assert.deepEqual(quality(canvas()).codes, [], "usable canvas has no codes");
  assert.deepEqual(quality(canvas({ evidencePackets: [failedPacket], evidenceBlocker: "blocked" })).codes, ["EVIDENCE_BLOCKED"]);
  assert.deepEqual(quality(canvas({ evidencePackets: undefined })).codes, ["EVIDENCE_NONE"], "no packets + no sources ⇒ evidence none");
  assert.deepEqual(quality(canvas({ blocks: [{ id: "x", kind: "text", text: "summary" }] })).codes, ["READ_COUNT"]);
  assert.deepEqual(quality(canvas({ blocks: [{ id: "read", kind: "text", text: "summary", dossierHint: "read" }] })).codes, ["READ_NO_SOURCEIDS"]);
  assert.deepEqual(quality(canvas({
    intent: "brief",
    blocks: [
      { id: "read", kind: "text", text: "sourced", sourceIds: ["S1"], dossierHint: "read" },
      { id: "scenarios", kind: "bullets", title: "Scenarios", items: [{ text: "x" }], dossierHint: "scenarios" },
    ],
  })).codes, ["SCENARIO_IN_BRIEF"]);
  assert.deepEqual(quality(canvas({ stage: "partial" })).codes, ["NOT_COMPLETE"]);
});

test("canvasQualityTelemetry produces the versioned ledger shape", () => {
  const telemetry = canvasQualityTelemetry(canvas() as never);
  assert.equal(telemetry.usable, true);
  assert.deepEqual(telemetry.codes, []);
  assert.equal(telemetry.evidenceStatus, "available");
  assert.equal(telemetry.fetchedCount, 1);
  assert.equal(telemetry.qualityVersion, 1);

  const blocked = canvasQualityTelemetry(canvas({ evidencePackets: [failedPacket], evidenceBlocker: "blocked" }) as never);
  assert.equal(blocked.usable, false);
  assert.deepEqual(blocked.codes, ["EVIDENCE_BLOCKED"]);
  assert.equal(blocked.evidenceStatus, "blocked");
  assert.equal(blocked.fetchedCount, 0);
});

test("decidePrecacheCanary opens the circuit only on a complete zero-reach canary", () => {
  const cancelled = { outcome: "cancelled", usable: false, fetched: 0, challenged: 0, limited: 0, failed: 2 };
  assert.deepEqual(decidePrecacheCanary(cancelled), { openCircuit: false, canaryPassed: true, degraded: false });

  const fetched = { outcome: "complete", usable: true, fetched: 2, challenged: 0, limited: 0, failed: 1 };
  assert.deepEqual(decidePrecacheCanary(fetched), { openCircuit: false, canaryPassed: true, degraded: false });

  const challenged = { outcome: "complete", usable: false, fetched: 0, challenged: 3, limited: 0, failed: 0 };
  assert.deepEqual(decidePrecacheCanary(challenged), { openCircuit: false, canaryPassed: true, degraded: true }, "bot walls prove the extractor was reached");

  const limited = { outcome: "complete", usable: false, fetched: 0, challenged: 0, limited: 2, failed: 1 };
  assert.deepEqual(decidePrecacheCanary(limited), { openCircuit: false, canaryPassed: true, degraded: true }, "JS-limited pages prove the extractor was reached");

  const transport = { outcome: "complete", usable: false, fetched: 0, challenged: 0, limited: 0, failed: 3 };
  assert.deepEqual(decidePrecacheCanary(transport), { openCircuit: true, canaryPassed: false, degraded: true }, "complete + zero reached = systemic extractor failure");

  const modelFailed = { outcome: "failed", usable: false, fetched: 0, challenged: 0, limited: 0, failed: 0 };
  assert.deepEqual(decidePrecacheCanary(modelFailed), { openCircuit: false, canaryPassed: true, degraded: true }, "a failed worker is not an extractor outage");
});

test("decidePrecacheCanary treats a fetched-but-unusable canary as passed (structural, not extractor)", () => {
  const unusableFetched = { outcome: "complete", usable: false, fetched: 1, challenged: 0, limited: 0, failed: 1 };
  assert.deepEqual(decidePrecacheCanary(unusableFetched), { openCircuit: false, canaryPassed: true, degraded: true });
});

test("isIdentityPrecacheCooled applies a bounded cooldown after repeated infrastructure-class failures", () => {
  const blocked = (archivedAt: number, usable = false, codes: string[] = ["EVIDENCE_BLOCKED"]) => ({
    archivedAt,
    quality: { usable, codes: codes as never, evidenceStatus: "blocked" as const, fetchedCount: 0, qualityVersion: 1 },
  });
  const now = 1_800_000_000_000;

  // Two recent blocked attempts in a row => in cooldown.
  assert.equal(isIdentityPrecacheCooled([blocked(now - 3_600_000), blocked(now - 86_400_000)], { now }), true);

  // A usable recent attempt breaks the streak.
  assert.equal(isIdentityPrecacheCooled([blocked(now - 3_600_000), blocked(now - 86_400_000, true, [])], { now }), false);

  // Structural codes (READ_COUNT) do not cool down.
  assert.equal(isIdentityPrecacheCooled(
    [blocked(now - 3_600_000, false, ["READ_COUNT"]), blocked(now - 86_400_000, false, ["READ_COUNT"])], { now }), false);

  // Mixed infra + structural does not cool down (need every attempt infra-class).
  assert.equal(isIdentityPrecacheCooled(
    [blocked(now - 3_600_000, false, ["READ_COUNT"]), blocked(now - 86_400_000)], { now }), false);

  // One attempt is not enough with the default streak of 2.
  assert.equal(isIdentityPrecacheCooled([blocked(now - 3_600_000)], { now }), false);

  // Attempts older than the window do not count.
  assert.equal(isIdentityPrecacheCooled([blocked(now - 3_600_000), blocked(now - 100 * 86_400_000)], { now }), false);

  // Records without quality telemetry are ignored.
  assert.equal(isIdentityPrecacheCooled([{ archivedAt: now - 3_600_000 }, blocked(now - 86_400_000)], { now }), false);

  // The cooldown is bounded: after cooldownMs the identity is probed again.
  assert.equal(isIdentityPrecacheCooled([blocked(now - 3_600_000), blocked(now - 3_600_000 - 3_600_000)], { now, cooldownMs: 1_000 }), false, "cooldown expired => re-probe");

  // Invalid options are rejected (no surprise blacklist).
  assert.equal(isIdentityPrecacheCooled([blocked(now - 3_600_000), blocked(now - 86_400_000)], { now, streak: 0 }), false);
  assert.equal(isIdentityPrecacheCooled([blocked(now - 3_600_000), blocked(now - 86_400_000)], { now, cooldownMs: -5 }), false);
  assert.equal(isIdentityPrecacheCooled([blocked(now - 3_600_000), blocked(now - 86_400_000)], { now, codes: [] }), false);
});
