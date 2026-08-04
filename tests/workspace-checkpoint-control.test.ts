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
// The only auth URL the gateway may hand the browser for redirect.
const AUTH_URL_PREFIX = "https://workspace.internal/auth/";

// A real future moment (ms) used by the fake workspace service so cookie
// Max-Age assertions reflect actual conversion math.
const FIXTURE_EXPIRES_AT_MS = Date.now() + 3_600_000;

function controlEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    FINANCIAL_WORKSPACE_CHECKPOINTS: "1",
    FINANCIAL_WORKSPACE_CONTROL_TOKEN: CONTROL_TOKEN,
    FINANCIAL_WORKSPACE_SERVICE_URL: "http://workspace.internal:8700",
    FINANCIAL_WORKSPACE_AUTH_URL_PREFIX: AUTH_URL_PREFIX,
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

/** A fake workspace control service speaking the canonical snake_case wire. */
async function startWorkspaceService(overrides: Record<string, unknown> = {}, requestIds: string[] = []) {
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
    requestIds.push((request.body as { requestId?: string }).requestId ?? "");
    response.status(201).json({
      checkpoint_id: "checkpoint-1",
      // Canonical wire: `expires_at` is Unix epoch SECONDS. `FIXTURE_EXPIRES_AT_MS`
      // is a real future moment so cookie Max-Age assertions are meaningful.
      expires_at: Math.floor(FIXTURE_EXPIRES_AT_MS / 1000),
      handoff_id: "handoff-1",
      handoff_secret: "super-secret-handoff-0000000000000000",
      auth_url: "https://workspace.internal/auth/handoff-1",
      already_exists: false,
      status: "ready",
      ...overrides,
    });
  });
  return listen(app);
}

async function startHandoffGateway(
  workerUrl: string,
  serviceUrl: string,
  overrides: Record<string, string> = {},
  controllerOptions: Parameters<typeof createWorkspaceHandoffController>[0] = {},
) {
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
      ...controllerOptions,
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
    // The browser response uses epoch ms, normalized from the wire seconds
    // (floored to the second precision carried on the wire).
    assert.equal(body.expiresAt, Math.floor(FIXTURE_EXPIRES_AT_MS / 1000) * 1000);
    // The handoff secret must never reach JS.
    assert.ok(!("handoffSecret" in body));
    assert.ok(!("handoff_secret" in body));

    // The secret travels only in an HttpOnly cookie.
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes(`${HANDOFF_COOKIE_NAME}=super-secret-handoff-0000000000000000`));
    assert.ok(/HttpOnly/i.test(setCookie));
    assert.ok(/Secure/i.test(setCookie));
    assert.ok(/SameSite=Lax/i.test(setCookie));
    // Host-only: no Domain attribute by default (gateway and control plane
    // share the public terminal host).
    assert.ok(!/Domain=/i.test(setCookie));
    // Express maxAge is ms; the wire expires_at was epoch seconds and must be
    // converted, not divided. The fixture expires 3600s after now, so the
    // cookie must live ~3600s (not ~3.6s, not 0).
    const maxAgeMatch = /Max-Age=(\d+)/i.exec(setCookie);
    assert.ok(maxAgeMatch, `cookie must carry Max-Age: ${setCookie}`);
    const maxAgeSeconds = Number(maxAgeMatch![1]);
    assert.ok(maxAgeSeconds > 3_000 && maxAgeSeconds <= 3_600 + 60, `Max-Age=${maxAgeSeconds}s`);
  } finally {
    await closeServer(worker.server);
    await closeServer(service.server);
    await closeServer(gateway.server);
  }
});

test("handoff accepts the camelCase wire spelling during rollout (normalized identically)", async () => {
  const worker = await startWorkerServer();
  const service = await startWorkspaceService({
    checkpoint_id: undefined,
    expires_at: undefined,
    handoff_id: undefined,
    handoff_secret: undefined,
    auth_url: undefined,
    checkpointId: "checkpoint-2",
    expiresAt: Math.floor(FIXTURE_EXPIRES_AT_MS / 1000),
    handoffId: "handoff-2",
    handoffSecret: "camel-secret-0000000000000000000000",
    authUrl: "https://workspace.internal/auth/handoff-2",
  });
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
    assert.equal(body.checkpointId, "checkpoint-2");
    // The parser floors seconds→ms, so the exact expectation is the second
    // precision that was on the wire.
    assert.equal(body.expiresAt, Math.floor(FIXTURE_EXPIRES_AT_MS / 1000) * 1000);
    assert.ok(!("handoffSecret" in body));
  } finally {
    await closeServer(worker.server);
    await closeServer(service.server);
    await closeServer(gateway.server);
  }
});

test("handoff rejects a millisecond expires_at (units are epoch seconds on the wire)", async () => {
  const worker = await startWorkerServer();
  // A naive client that forwards its own ms epoch is rejected, not silently
  // converted into a ~1000x-longer cookie.
  const service = await startWorkspaceService({
    expires_at: 1_700_000_000_000 + 3_600_000,
  });
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
    assert.equal(response.status, 502);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, "workspace_service_invalid_response");
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

test("handoff sends a deterministic idempotent request ID per session+generation", async () => {
  const worker = await startWorkerServer();
  const requestIds: string[] = [];
  const service = await startWorkspaceService({}, requestIds);
  const gateway = await startHandoffGateway(`http://${HOST}:${worker.port}`, `http://${HOST}:${service.port}`);
  try {
    const call = () => fetch(`http://${HOST}:${gateway.port}/api/public/workspace-handoff`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-public-visitor-token": "visitor-1",
        "x-public-ticket-token": "public-session-123",
      },
      body: "{}",
    });
    // A retry after a gateway/timeout ordering race must re-send the SAME
    // idempotency key so the workspace service cannot create a duplicate.
    const first = await call();
    const second = await call();
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(requestIds.length, 2);
    assert.equal(requestIds[0], requestIds[1]);
    assert.match(requestIds[0], /^handoff:public-session-123:/);
  } finally {
    await closeServer(worker.server);
    await closeServer(service.server);
    await closeServer(gateway.server);
  }
});

test("handoff rejects an authUrl that is not HTTPS on the allowed origin/prefix", async () => {
  for (const authUrl of [
    "http://workspace.internal/auth/handoff-1",      // not HTTPS
    "https://evil.example/auth/handoff-1",           // foreign origin
    "https://workspace.internal/other/handoff-1",    // wrong path prefix
  ]) {
    const worker = await startWorkerServer();
    const service = await startWorkspaceService({ auth_url: authUrl });
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
      assert.equal(response.status, 502, `authUrl ${authUrl} must be rejected`);
      const body = (await response.json()) as { error?: string };
      assert.equal(body.error, "workspace_service_invalid_response");
    } finally {
      await closeServer(worker.server);
      await closeServer(service.server);
      await closeServer(gateway.server);
    }
  }
});

test("handoff fails closed when the auth URL prefix is not configured", async () => {
  const worker = await startWorkerServer();
  const service = await startWorkspaceService();
  const gateway = await startHandoffGateway(
    `http://${HOST}:${worker.port}`,
    `http://${HOST}:${service.port}`,
    { FINANCIAL_WORKSPACE_AUTH_URL_PREFIX: "" },
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
    assert.equal(response.status, 503);
  } finally {
    await closeServer(worker.server);
    await closeServer(service.server);
    await closeServer(gateway.server);
  }
});

test("handoff rate-limits per session", async () => {
  const worker = await startWorkerServer();
  const service = await startWorkspaceService();
  const gateway = await startHandoffGateway(
    `http://${HOST}:${worker.port}`,
    `http://${HOST}:${service.port}`,
    {},
    { handoffRateLimit: 2, handoffRateWindowMs: 60_000 },
  );
  try {
    const call = () => fetch(`http://${HOST}:${gateway.port}/api/public/workspace-handoff`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-public-visitor-token": "visitor-1",
        "x-public-ticket-token": "public-session-123",
      },
      body: "{}",
    });
    assert.equal((await call()).status, 201);
    assert.equal((await call()).status, 201);
    const limited = await call();
    assert.equal(limited.status, 429);
    const body = (await limited.json()) as { error?: string };
    assert.equal(body.error, "handoff_limited");
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
