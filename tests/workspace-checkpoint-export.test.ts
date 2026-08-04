/**
 * Worker checkpoint-export tests: private authenticated endpoint, generation
 * authorization, and authoritative (never browser-sourced) checkpoint content.
 */

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import {
  mountWorkspaceCheckpointExport,
  type WorkerCheckpointExportContext,
} from "../server/workspace-checkpoint-handler.js";
import {
  buildAuthoritativeCheckpoint,
  createServerCheckpointEventLog,
  recordServerCheckpointEvent,
  resetServerCheckpointEventLog,
  workerGenerationEpoch,
} from "../server/workspace-checkpoint-export.js";
import { CHECKPOINT_EXPORT_PATH } from "../shared/financial-workspace-checkpoint.js";

const CONTROL_TOKEN = "test-control-token-0123456789012345678901";
const WORKER_PROXY_TOKEN = "test-worker-proxy-token-01234567890123456";
const HOST = "127.0.0.1";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    FINANCIAL_WORKSPACE_CHECKPOINTS: "1",
    FINANCIAL_WORKSPACE_CONTROL_TOKEN: CONTROL_TOKEN,
    PUBLIC_WORKER_PROXY_TOKEN: WORKER_PROXY_TOKEN,
    ...overrides,
  };
}

function workerContext(): WorkerCheckpointExportContext {
  const eventLog = createServerCheckpointEventLog();
  recordServerCheckpointEvent(eventLog, "command", { name: "market", args: "NKE" });
  recordServerCheckpointEvent(eventLog, "navigate", { screen: "MARKET", symbol: "NKE" });
  recordServerCheckpointEvent(eventLog, "research-complete", { symbol: "NKE" });
  return {
    sessionId: "public-session-123",
    generation: workerGenerationEpoch("gen-opaque-001"),
    sourceRevision: "gen-opaque-001",
    state: {
      screen: "MARKET",
      symbol: "NKE",
      chartScope: "day",
      available: ["NKE", "AAPL"],
      research: { active: false, phase: "settled", outcome: "complete", symbol: "NKE" },
      dossier: {
        title: "NKE Retail Brief",
        intent: "brief",
        stage: "complete",
        summary: "Nike Q3 results analysis",
        evidenceStatus: "available",
        packets: [
          {
            sourceId: "src-01",
            sourceTitle: "Nike Q3 Earnings",
            sourceDomain: "investors.nike.com",
            retrievalStatus: "fetched",
            extractedAt: 1_700_000_000_000,
            excerpt: "Q3 revenue beat expectations.",
          },
        ],
      },
    },
    eventLog,
  };
}

/**
 * The real live worker mounts its proxy-token route guard globally and then
 * mounts the checkpoint export with its route-scoped bounded JSON parser via
 * `mountWorkspaceCheckpointExport`. These integration tests exercise exactly
 * that composition — never a synthetic handler mounted next to a separately
 * added global JSON parser.
 */
async function startExportServer(options: {
  env?: NodeJS.ProcessEnv;
  getExportContext?: () => WorkerCheckpointExportContext | undefined;
}): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const app = express();
  app.use((request, response, next) => {
    if (request.headers["x-fin-terminal-proxy-token"] !== WORKER_PROXY_TOKEN) {
      response.status(403).type("text").send("Forbidden");
      return;
    }
    next();
  });
  mountWorkspaceCheckpointExport(app, {
    env: options.env ?? env(),
    getExportContext: options.getExportContext ?? (() => workerContext()),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, HOST, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function exportHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-fin-terminal-proxy-token": WORKER_PROXY_TOKEN,
    ...extra,
  };
}

test("the export route is mounted with a route-scoped bounded JSON parser (real composition)", async () => {
  const { server, port, close } = await startExportServer({});
  try {
    // Without the proxy token the worker's global route guard rejects first.
    const unauthenticated = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "public-session-123", generation: workerGenerationEpoch("gen-opaque-001") }),
    });
    assert.equal(unauthenticated.status, 403);

    // A real JSON body parses through the route-scoped parser and returns 200.
    const response = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: exportHeaders({ "x-fin-terminal-control-token": CONTROL_TOKEN }),
      body: JSON.stringify({ sessionId: "public-session-123", generation: workerGenerationEpoch("gen-opaque-001") }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { checkpoint?: Record<string, unknown> };
    assert.equal(body.checkpoint?.version, 1);
  } finally {
    await close();
  }
});

test("the route-scoped parser rejects an oversized export body", async () => {
  const { port, close } = await startExportServer({});
  try {
    const oversized = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: exportHeaders(),
      body: JSON.stringify({ sessionId: "public-session-123", generation: 1, blob: "x".repeat(64 * 1024) }),
    });
    assert.ok(oversized.status >= 400 && oversized.status < 500);
  } finally {
    await close();
  }
});

test("the route-scoped parser rejects malformed JSON", async () => {
  const { port, close } = await startExportServer({});
  try {
    const malformed = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: exportHeaders(),
      body: "{not-json",
    });
    assert.ok(malformed.status >= 400 && malformed.status < 500);
  } finally {
    await close();
  }
});

test("worker export requires the control token (401 without / with wrong token)", async () => {
  const { port, close } = await startExportServer({});
  try {
    const noToken = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: exportHeaders(),
      body: JSON.stringify({ sessionId: "public-session-123", generation: workerGenerationEpoch("gen-opaque-001") }),
    });
    assert.equal(noToken.status, 401);

    const wrongToken = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: exportHeaders({ "x-fin-terminal-control-token": "wrong-token" }),
      body: JSON.stringify({ sessionId: "public-session-123", generation: workerGenerationEpoch("gen-opaque-001") }),
    });
    assert.equal(wrongToken.status, 401);
  } finally {
    await close();
  }
});

test("worker export returns an authoritative checkpoint for the exact session/generation", async () => {
  const { port, close } = await startExportServer({});
  try {
    const response = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: exportHeaders({ "x-fin-terminal-control-token": CONTROL_TOKEN }),
      body: JSON.stringify({ sessionId: "public-session-123", generation: workerGenerationEpoch("gen-opaque-001") }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { checkpoint?: unknown };
    const checkpoint = body.checkpoint as Record<string, unknown> | undefined;
    assert.ok(checkpoint);
    assert.equal(checkpoint.version, 1);
    assert.equal((checkpoint.source as Record<string, unknown>).sessionId, "public-session-123");
    assert.equal((checkpoint.source as Record<string, unknown>).generation, workerGenerationEpoch("gen-opaque-001"));
    // Checkpoint content is authoritative worker state (dossier), not browser data.
    assert.ok(Array.isArray(checkpoint.canvases));
    const canvas = (checkpoint.canvases as Array<Record<string, unknown>>)[0];
    assert.equal(canvas.title, "NKE Retail Brief");
    assert.ok(Array.isArray(canvas.packets));
    assert.equal((canvas.packets as Array<Record<string, unknown>>)[0].sourceDomain, "investors.nike.com");
    assert.equal((checkpoint.context as Record<string, unknown>).symbol, "NKE");
    assert.ok((checkpoint.context as Record<string, unknown>).watchlist);
    // 1-hour handoff retention.
    assert.equal(
      (checkpoint.expiresAt as number) - (checkpoint.createdAt as number),
      60 * 60 * 1000,
    );
    // Continuation summary is built from the codec.
    assert.match(String(checkpoint.continuationSummary), /Continue from a saved checkpoint/);
  } finally {
    await close();
  }
});

test("worker export rejects a generation mismatch (authorization)", async () => {
  const { port, close } = await startExportServer({});
  try {
    const response = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: exportHeaders({ "x-fin-terminal-control-token": CONTROL_TOKEN }),
      body: JSON.stringify({ sessionId: "public-session-123", generation: workerGenerationEpoch("gen-OTHER") }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error?: string };
    assert.match(String(body.error), /generation_mismatch/);
  } finally {
    await close();
  }
});

test("worker export rejects when no public session is attached", async () => {
  const { port, close } = await startExportServer({ getExportContext: () => undefined });
  try {
    const response = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: exportHeaders({ "x-fin-terminal-control-token": CONTROL_TOKEN }),
      body: JSON.stringify({ sessionId: "public-session-123", generation: workerGenerationEpoch("gen-opaque-001") }),
    });
    assert.equal(response.status, 409);
  } finally {
    await close();
  }
});

test("worker export is feature-gated (404 when disabled)", async () => {
  const { port, close } = await startExportServer({ env: env({ FINANCIAL_WORKSPACE_CHECKPOINTS: "0" }) });
  try {
    const response = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: exportHeaders({ "x-fin-terminal-control-token": CONTROL_TOKEN }),
      body: JSON.stringify({ sessionId: "public-session-123", generation: workerGenerationEpoch("gen-opaque-001") }),
    });
    assert.equal(response.status, 404);
  } finally {
    await close();
  }
});

test("buildAuthoritativeCheckpoint validates and the event log is server-recorded", () => {
  const eventLog = createServerCheckpointEventLog();
  recordServerCheckpointEvent(eventLog, "command", { name: "market", args: "NKE" });
  recordServerCheckpointEvent(eventLog, "research-start", { symbol: "NKE" });
  recordServerCheckpointEvent(eventLog, "research-complete", { symbol: "NKE" });
  assert.equal(eventLog.hasMeaningfulActivity, true);
  assert.equal(eventLog.researchRunCount, 1);

  const checkpoint = buildAuthoritativeCheckpoint({
    state: { screen: "MARKET", symbol: "NKE" },
    sessionId: "public-session-123",
    generation: 7,
    eventLog,
  });
  assert.equal(checkpoint.source.generation, 7);
  assert.equal(checkpoint.eventLog.length, 3);
});

test("workerGenerationEpoch is deterministic across processes", () => {
  const generation = "gen-opaque-abc-123";
  const a = workerGenerationEpoch(generation);
  const b = workerGenerationEpoch(generation);
  assert.equal(a, b);
  assert.ok(Number.isInteger(a) && a >= 0 && a < 2_000_000_000);
});

test("resetServerCheckpointEventLog clears all session-bound state", () => {
  const eventLog = createServerCheckpointEventLog();
  recordServerCheckpointEvent(eventLog, "command", { name: "market" });
  recordServerCheckpointEvent(eventLog, "research-complete", {});
  assert.equal(eventLog.events.length, 2);
  assert.equal(eventLog.researchRunCount, 1);
  assert.equal(eventLog.hasMeaningfulActivity, true);

  resetServerCheckpointEventLog(eventLog);
  assert.equal(eventLog.events.length, 0);
  assert.equal(eventLog.researchRunCount, 0);
  assert.equal(eventLog.hasMeaningfulActivity, false);
});

// ── Fix 4: contextual secret detection + field sanitization ─────────────────

test("a benign user prompt mentioning password exports through the builder", () => {
  const eventLog = createServerCheckpointEventLog();
  recordServerCheckpointEvent(eventLog, "prompt", { text: "Explain the password reset policy for my broker" });
  const checkpoint = buildAuthoritativeCheckpoint({
    state: { screen: "MARKET", symbol: "NKE" },
    sessionId: "public-session-123",
    generation: 7,
    eventLog,
  });
  assert.equal(checkpoint.eventLog.length, 1);
  assert.ok(String(checkpoint.continuationSummary).includes("Continue"));
});

test("a tainted packet excerpt is sanitized away instead of failing the export", () => {
  const eventLog = createServerCheckpointEventLog();
  const checkpoint = buildAuthoritativeCheckpoint({
    state: {
      screen: "MARKET",
      symbol: "NKE",
      dossier: {
        title: "NKE Brief",
        intent: "brief",
        stage: "complete",
        summary: "Summary text",
        evidenceStatus: "available",
        packets: [
          {
            sourceId: "src-01",
            sourceTitle: "Nike Q3 Earnings",
            sourceDomain: "investors.nike.com",
            retrievalStatus: "fetched",
            extractedAt: 1_700_000_000_000,
            excerpt: "The portal exposes api_key=sk-abc123def456ghi789 in plaintext.",
          },
        ],
      },
    },
    sessionId: "public-session-123",
    generation: 7,
    eventLog,
  });
  const canvas = checkpoint.canvases[0];
  assert.equal(canvas.packets.length, 1);
  assert.equal(canvas.packets[0].excerpt, undefined, "tainted excerpt must be dropped");
  assert.ok(canvas.packets[0].sourceTitle.includes("Nike"), "clean packet fields survive");
});

test("a tainted event value is dropped but the event and rest of the log survive", () => {
  const eventLog = createServerCheckpointEventLog();
  recordServerCheckpointEvent(eventLog, "command", { name: "market", args: "leaked_token=abc123xyz789" });
  recordServerCheckpointEvent(eventLog, "navigate", { screen: "MARKET", symbol: "NKE" });
  const checkpoint = buildAuthoritativeCheckpoint({
    state: { screen: "MARKET", symbol: "NKE" },
    sessionId: "public-session-123",
    generation: 7,
    eventLog,
  });
  assert.equal(checkpoint.eventLog.length, 2);
  const command = checkpoint.eventLog.find((event) => event.type === "command");
  assert.ok(command);
  assert.ok(!("args" in command.data), "tainted event value must be dropped");
});

test("a canary in a watchlist entry is dropped while the clean symbols export", () => {
  const checkpoint = buildAuthoritativeCheckpoint({
    state: {
      screen: "MARKET",
      symbol: "NKE",
      available: ["NKE", "AAPL", "worker-a1b2c3d4-e5f6a7b8-c9d0e1f2-a3b4c5d6"],
    },
    sessionId: "public-session-123",
    generation: 7,
    eventLog: createServerCheckpointEventLog(),
  });
  assert.deepEqual(checkpoint.context.watchlist, ["NKE", "AAPL"]);
});

// ── Fix 7: aggregate size / per-field bounds are consistent ─────────────────

test("the builder caps the event log, watchlist, and packets at the shared constants", () => {
  const eventLog = createServerCheckpointEventLog();
  for (let index = 0; index < 2_000; index += 1) {
    recordServerCheckpointEvent(eventLog, "command", { name: "market", args: `args-${index}` });
  }
  const checkpoint = buildAuthoritativeCheckpoint({
    state: {
      screen: "MARKET",
      symbol: "NKE",
      available: Array.from({ length: 2_000 }, (_unused, index) => `SYM${index % 700}`),
    },
    sessionId: "public-session-123",
    generation: 7,
    eventLog,
  });
  assert.ok(checkpoint.eventLog.length <= 1_000, "event log respects the shared cap");
  assert.ok((checkpoint.context.watchlist?.length ?? 0) <= 500, "watchlist respects the shared cap");
  assert.ok(checkpoint.eventLog.length === 1_000);
});

test("an aggregate checkpoint at the field caps still passes the byte gate or is rejected consistently", () => {
  // 1000 events with 512-char values exceeds the 512 KB aggregate gate, so
  // the exporter must reject it deterministically — never emit it.
  const eventLog = createServerCheckpointEventLog();
  for (let index = 0; index < 1_000; index += 1) {
    recordServerCheckpointEvent(eventLog, "command", { name: "market", args: `x`.repeat(510) });
  }
  assert.throws(() => {
    buildAuthoritativeCheckpoint({
      state: { screen: "MARKET", symbol: "NKE" },
      sessionId: "public-session-123",
      generation: 7,
      eventLog,
    });
  }, /failed validation/);
});
