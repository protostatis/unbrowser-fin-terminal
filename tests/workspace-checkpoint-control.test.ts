/**
 * Gateway workspace-handoff control + private import-boot tests.
 *
 * The browser only initiates opt-in. This suite verifies:
 *  - the handoff controller calls the assigned worker's private export for the
 *    active session/generation and then the workspace control service,
 *  - the handoff secret is set as an HttpOnly cookie and NEVER returned to JS,
 *  - a fresh private workspace boots from a validated checkpoint via
 *    SessionManager.inMemory with a custom state entry and bounded
 *    continuation seed, and never restores raw transcript/process state.
 */

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import {
  createWorkspaceHandoffController,
  HANDOFF_COOKIE_NAME,
  type WorkspaceHandoffAssignment,
} from "../server/workspace-checkpoint-control.js";
import { workerGenerationEpoch } from "../server/workspace-checkpoint-export.js";
import {
  importCheckpointIntoFreshSession,
  WORKSPACE_CHECKPOINT_CUSTOM_TYPE,
  WORKSPACE_CHECKPOINT_SEED_TYPE,
  WORKSPACE_CHECKPOINT_SEED_MAX_CHARS,
} from "../server/workspace-checkpoint-import.js";
import {
  CHECKPOINT_CREATE_PATH,
  CHECKPOINT_EXPORT_PATH,
  validateCheckpoint,
  type FinancialTerminalCheckpoint,
} from "../shared/financial-workspace-checkpoint.js";

const HOST = "127.0.0.1";
const CONTROL_TOKEN = "test-control-token-0123456789012345678901";
const WORKER_PROXY_TOKEN = "test-worker-proxy-token-01234567890123456";
const GENERATION = "gen-opaque-001";

function controlEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    FINANCIAL_WORKSPACE_CHECKPOINTS: "1",
    FINANCIAL_WORKSPACE_CONTROL_TOKEN: CONTROL_TOKEN,
    FINANCIAL_WORKSPACE_SERVICE_URL: "http://workspace.internal:8700",
    PUBLIC_WORKER_PROXY_TOKEN: WORKER_PROXY_TOKEN,
    ...overrides,
  };
}

function validCheckpointPayload(): FinancialTerminalCheckpoint {
  return {
    version: 1,
    id: "test-checkpoint-001",
    source: { sessionId: "public-session-123", generation: workerGenerationEpoch(GENERATION) },
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 3_600_000,
    eventLog: [],
    context: { symbol: "NKE" },
    canvases: [],
    continuationSummary: "Continue from a saved checkpoint: NKE.",
  };
}

async function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, HOST, () => resolve(s));
  });
  return { server, port: (server.address() as { port: number }).port };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A fake worker serving the private export endpoint. */
async function startWorkerServer() {
  const app = express();
  app.use(express.json());
  app.post(CHECKPOINT_EXPORT_PATH, (request, response) => {
    const control = request.headers["x-fin-terminal-control-token"];
    const proxy = request.headers["x-fin-terminal-proxy-token"];
    if (control !== CONTROL_TOKEN || proxy !== WORKER_PROXY_TOKEN) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    const { sessionId, generation } = request.body as { sessionId?: string; generation?: number };
    if (sessionId !== "public-session-123" || generation !== workerGenerationEpoch(GENERATION)) {
      response.status(409).json({ error: "session_generation_mismatch" });
      return;
    }
    const checkpoint = validCheckpointPayload();
    response.status(200).json({ checkpoint });
  });
  return listen(app);
}

/** A fake workspace control service. */
async function startWorkspaceService() {
  const app = express();
  app.use(express.json());
  app.post(CHECKPOINT_CREATE_PATH, (request, response) => {
    if (request.headers.authorization !== `Bearer ${CONTROL_TOKEN}`) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    const source = (request.body as { source?: unknown }).source as Record<string, unknown> | undefined;
    assert.equal(source?.sessionId, "public-session-123");
    assert.equal(source?.generation, workerGenerationEpoch(GENERATION));
    response.status(201).json({
      checkpointId: "checkpoint-1",
      expiresAt: 1_700_000_000_000 + 3_600_000,
      handoffId: "handoff-1",
      handoffSecret: "super-secret-handoff-0000000000000000",
      authUrl: "https://workspace.internal/auth/handoff-1",
    });
  });
  return listen(app);
}

async function startHandoffGateway(workerUrl: string, serviceUrl: string, overrides: Record<string, string> = {}) {
  const app = express();
  app.use(express.json());
  app.post(
    "/api/public/workspace-handoff",
    createWorkspaceHandoffController({
      env: controlEnv({ FINANCIAL_WORKSPACE_SERVICE_URL: serviceUrl, ...overrides }),
      ticketFromRequest: (request) => {
        const visitor = request.headers["x-public-visitor-token"];
        const ticket = request.headers["x-public-ticket-token"];
        if (visitor === "visitor-1" && ticket === "public-session-123") {
          return { visitorId: "visitor-1", ticketId: "public-session-123" };
        }
        return undefined;
      },
      activeAssignmentFor: (ticketId, visitorId) => {
        if (ticketId !== "public-session-123" || visitorId !== "visitor-1") return undefined;
        const assignment: WorkspaceHandoffAssignment = {
          workerId: "seat-01",
          workerUrl,
          workerGeneration: GENERATION,
        };
        return assignment;
      },
    }),
  );
  return listen(app);
}

test("handoff requires an authenticated ticket", async () => {
  const worker = await startWorkerServer();
  const service = await startWorkspaceService();
  const gateway = await startHandoffGateway(`http://${HOST}:${worker.port}`, `http://${HOST}:${service.port}`);
  try {
    const response = await fetch(`http://${HOST}:${gateway.port}/api/public/workspace-handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
  } finally {
    await closeServer(worker.server);
    await closeServer(service.server);
    await closeServer(gateway.server);
  }
});

test("handoff is feature-gated (404 when disabled)", async () => {
  const worker = await startWorkerServer();
  const service = await startWorkspaceService();
  const gateway = await startHandoffGateway(
    `http://${HOST}:${worker.port}`,
    `http://${HOST}:${service.port}`,
    { FINANCIAL_WORKSPACE_CHECKPOINTS: "0" },
  );
  try {
    const response = await fetch(`http://${HOST}:${gateway.port}/api/public/workspace-handoff`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-public-visitor-token": "visitor-1",
        "x-public-ticket-token": "public-session-123",
      },
      body: "{}",
    });
    assert.equal(response.status, 404);
  } finally {
    await closeServer(worker.server);
    await closeServer(service.server);
    await closeServer(gateway.server);
  }
});

test("handoff calls worker export + workspace control, sets HttpOnly cookie, never leaks the secret to JS", async () => {
  const worker = await startWorkerServer();
  const service = await startWorkspaceService();
  const gateway = await startHandoffGateway(`http://${HOST}:${worker.port}`, `http://${HOST}:${service.port}`);
  try {
    const response = await fetch(`http://${HOST}:${gateway.port}/api/public/workspace-handoff`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-public-visitor-token": "visitor-1",
        "x-public-ticket-token": "public-session-123",
      },
      body: "{}",
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.checkpointId, "checkpoint-1");
    assert.equal(body.handoffId, "handoff-1");
    assert.equal(body.authUrl, "https://workspace.internal/auth/handoff-1");
    // The handoff secret must never reach JS.
    assert.ok(!("handoffSecret" in body));

    // The secret travels only in an HttpOnly cookie.
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes(`${HANDOFF_COOKIE_NAME}=super-secret-handoff-0000000000000000`));
    assert.ok(/HttpOnly/i.test(setCookie));
    assert.ok(/Secure/i.test(setCookie));
  } finally {
    await closeServer(worker.server);
    await closeServer(service.server);
    await closeServer(gateway.server);
  }
});

test("handoff surfaces a 502 when the worker export fails", async () => {
  const worker = await startWorkerServer();
  const service = await startWorkspaceService();
  const gateway = await startHandoffGateway(
    `http://${HOST}:1${worker.port}`, // unreachable port
    `http://${HOST}:${service.port}`,
  );
  try {
    const response = await fetch(`http://${HOST}:${gateway.port}/api/public/workspace-handoff`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-public-visitor-token": "visitor-1",
        "x-public-ticket-token": "public-session-123",
      },
      body: "{}",
    });
    assert.equal(response.status, 502);
  } finally {
    await closeServer(worker.server);
    await closeServer(service.server);
    await closeServer(gateway.server);
  }
});

// ── Private import boot ──────────────────────────────────────────────────────

test("import boots a fresh in-memory session with custom entry + bounded seed", () => {
  const result = importCheckpointIntoFreshSession({
    checkpoint: validCheckpointPayload(),
    cwd: "/tmp/private-workspace",
  });

  const entries = result.sessionManager.getBranch();
  const custom = entries.find(
    (entry) => entry.type === "custom" && entry.customType === WORKSPACE_CHECKPOINT_CUSTOM_TYPE,
  );
  assert.ok(custom, "custom checkpoint entry must exist");
  const seedEntry = entries.find(
    (entry) => entry.type === "custom_message" && entry.customType === WORKSPACE_CHECKPOINT_SEED_TYPE,
  );
  assert.ok(seedEntry, "continuation seed entry must exist");

  // The seed is bounded.
  assert.ok(result.continuationSeed.length <= WORKSPACE_CHECKPOINT_SEED_MAX_CHARS);
  assert.equal(result.checkpoint.source.sessionId, "public-session-123");

  // The custom entry is NOT part of LLM context; the seed is.
  const contextMessages = result.sessionManager.buildSessionContext().messages;
  const contextText = contextMessages.map((m) => m.content ?? "").join(" ");
  assert.ok(contextText.includes("Continue from a saved checkpoint: NKE."));
});

test("import never restores raw transcript or process state", () => {
  // Even if the payload carries an event log, only the canonical checkpoint
  // and seed are written into the fresh session.
  const checkpoint = validCheckpointPayload();
  checkpoint.eventLog = [{ at: 1, type: "prompt", data: { text: "internal transcript line" } }];
  const result = importCheckpointIntoFreshSession({ checkpoint, cwd: "/tmp/private-workspace" });

  const entries = result.sessionManager.getBranch();
  const messageEntries = entries.filter((entry) => entry.type === "message");
  // No raw transcript messages are restored.
  assert.equal(messageEntries.length, 0);
  const custom = entries.find((entry) => entry.type === "custom");
  assert.equal((custom as { customType?: string } | undefined)?.customType, WORKSPACE_CHECKPOINT_CUSTOM_TYPE);
});

test("import rejects an invalid checkpoint", () => {
  assert.throws(() => {
    importCheckpointIntoFreshSession({
      checkpoint: { version: 1, id: "bad" },
      cwd: "/tmp/private-workspace",
    });
  }, /invalid checkpoint/);
});

test("valid checkpoint payload passes the shared codec", () => {
  const validation = validateCheckpoint(validCheckpointPayload());
  assert.equal(validation.valid, true);
});
