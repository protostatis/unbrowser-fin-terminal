/**
 * Worker checkpoint-export tests: private authenticated endpoint, generation
 * authorization, and authoritative (never browser-sourced) checkpoint content.
 */

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import {
  createWorkspaceCheckpointExportHandler,
  type WorkerCheckpointExportContext,
} from "../server/workspace-checkpoint-handler.js";
import {
  buildAuthoritativeCheckpoint,
  createServerCheckpointEventLog,
  recordServerCheckpointEvent,
  workerGenerationEpoch,
} from "../server/workspace-checkpoint-export.js";
import { CHECKPOINT_EXPORT_PATH } from "../shared/financial-workspace-checkpoint.js";

const CONTROL_TOKEN = "test-control-token-0123456789012345678901";
const HOST = "127.0.0.1";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    FINANCIAL_WORKSPACE_CHECKPOINTS: "1",
    FINANCIAL_WORKSPACE_CONTROL_TOKEN: CONTROL_TOKEN,
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

async function startExportServer(options: {
  env?: NodeJS.ProcessEnv;
  getExportContext?: () => WorkerCheckpointExportContext | undefined;
}): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.post(
    CHECKPOINT_EXPORT_PATH,
    createWorkspaceCheckpointExportHandler({
      env: options.env ?? env(),
      getExportContext: options.getExportContext ?? (() => workerContext()),
    }),
  );
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

test("worker export requires the control token (401 without / with wrong token)", async () => {
  const { port, close } = await startExportServer({});
  try {
    const noToken = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "public-session-123", generation: workerGenerationEpoch("gen-opaque-001") }),
    });
    assert.equal(noToken.status, 401);

    const wrongToken = await fetch(`http://${HOST}:${port}${CHECKPOINT_EXPORT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fin-terminal-control-token": "wrong-token" },
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
      headers: { "content-type": "application/json", "x-fin-terminal-control-token": CONTROL_TOKEN },
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
      headers: { "content-type": "application/json", "x-fin-terminal-control-token": CONTROL_TOKEN },
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
      headers: { "content-type": "application/json", "x-fin-terminal-control-token": CONTROL_TOKEN },
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
      headers: { "content-type": "application/json", "x-fin-terminal-control-token": CONTROL_TOKEN },
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
