/**
 * Private-workspace runtime tests: env alignment with the host-side provider,
 * the private-workspace runtime mode contract, and the local (in-process)
 * research permit gate used instead of the public gateway's shared surface.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeMode } from "../server/runtime-mode.js";
import {
  resolveCheckpointImportFile,
  importCheckpointIntoFreshSession,
} from "../server/workspace-checkpoint-import.js";
import {
  isWorkspaceCheckpointEnabled,
  workspaceControlToken,
} from "../shared/financial-workspace-checkpoint.js";
import {
  LocalResearchPermitGate,
  readLocalResearchConcurrency,
  createResearchPermitGateForRuntime,
} from "../server/research-permit-client.js";

test("workspaceControlToken reads the canonical FIN_WORKSPACE_CONTROL_TOKEN spelling", () => {
  const long = "t".repeat(40);
  assert.equal(workspaceControlToken({ FIN_WORKSPACE_CONTROL_TOKEN: long }), long);
  // The gateway deployment's FINANCIAL_ alias is also accepted.
  assert.equal(workspaceControlToken({ FINANCIAL_WORKSPACE_CONTROL_TOKEN: long }), long);
  // Short/missing tokens fail closed.
  assert.equal(workspaceControlToken({ FIN_WORKSPACE_CONTROL_TOKEN: "short" }), undefined);
  assert.equal(workspaceControlToken({}), undefined);
});

// ---------------------------------------------------------------------------
// Blocker 1 — the shared flag helper must read process.env when called bare
// (server/index.ts calls isWorkspaceCheckpointEnabled() with no argument).
// ---------------------------------------------------------------------------

test("isWorkspaceCheckpointEnabled() bare call reads process.env", () => {
  const saved = process.env.FINANCIAL_WORKSPACE_CHECKPOINTS;
  try {
    delete process.env.FINANCIAL_WORKSPACE_CHECKPOINTS;
    assert.equal(isWorkspaceCheckpointEnabled(), false);
    process.env.FINANCIAL_WORKSPACE_CHECKPOINTS = "1";
    assert.equal(isWorkspaceCheckpointEnabled(), true);
    process.env.FINANCIAL_WORKSPACE_CHECKPOINTS = "0";
    assert.equal(isWorkspaceCheckpointEnabled(), false);
  } finally {
    if (saved === undefined) delete process.env.FINANCIAL_WORKSPACE_CHECKPOINTS;
    else process.env.FINANCIAL_WORKSPACE_CHECKPOINTS = saved;
  }
});

// ---------------------------------------------------------------------------
// Blocker 1 — provider env alignment: FIN_WORKSPACE_CHECKPOINT_FILE is the
// canonical file env the host-side workspace runtime provider provisions; the
// legacy TERMINAL_WORKSPACE_IMPORT_FILE spelling must keep working.
// ---------------------------------------------------------------------------

test("resolveCheckpointImportFile prefers FIN_WORKSPACE_CHECKPOINT_FILE (provider contract)", () => {
  const env = {
    FINANCIAL_WORKSPACE_CHECKPOINTS: "1",
    FIN_WORKSPACE_CHECKPOINT_FILE: "/data/checkpoint.json",
    TERMINAL_WORKSPACE_IMPORT_FILE: "/data/legacy.json",
  };
  assert.equal(resolveCheckpointImportFile(env), "/data/checkpoint.json");
});

test("resolveCheckpointImportFile falls back to the legacy TERMINAL_WORKSPACE_IMPORT_FILE alias", () => {
  const env = {
    FINANCIAL_WORKSPACE_CHECKPOINTS: "true",
    TERMINAL_WORKSPACE_IMPORT_FILE: "/data/legacy.json",
  };
  assert.equal(resolveCheckpointImportFile(env), "/data/legacy.json");
});

test("resolveCheckpointImportFile returns undefined without the feature flag (fail closed)", () => {
  assert.equal(
    resolveCheckpointImportFile({ FIN_WORKSPACE_CHECKPOINT_FILE: "/data/checkpoint.json" }),
    undefined,
  );
  assert.equal(
    resolveCheckpointImportFile({
      FINANCIAL_WORKSPACE_CHECKPOINTS: "0",
      FIN_WORKSPACE_CHECKPOINT_FILE: "/data/checkpoint.json",
    }),
    undefined,
  );
});

test("resolveCheckpointImportFile returns undefined when no file is provisioned", () => {
  assert.equal(resolveCheckpointImportFile({ FINANCIAL_WORKSPACE_CHECKPOINTS: "yes" }), undefined);
});

test("importCheckpointIntoFreshSession seeds a fresh session from a valid checkpoint", () => {
  const checkpoint = {
    version: 1,
    id: "fcp-e2e-import",
    source: { sessionId: "public-session-1", generation: 3, sourceRevision: "gen-x" },
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 86_400_000,
    eventLog: [
      { at: 1_700_000_000_000, type: "command", data: { name: "market", args: "NKE" } },
      { at: 1_700_000_000_001, type: "navigate", data: { screen: "MARKET", symbol: "NKE" } },
    ],
    context: { screen: "MARKET", symbol: "NKE" },
    canvases: [],
    continuationSummary: "Continue from a saved checkpoint: NKE.",
  };
  const result = importCheckpointIntoFreshSession({ checkpoint, cwd: process.cwd() });
  assert.ok(result.sessionManager);
  assert.equal(result.checkpoint.id, "fcp-e2e-import");
  assert.match(result.continuationSeed, /NKE/);
});

// ---------------------------------------------------------------------------
// Blocker 1/5 — TERMINAL_RUNTIME_MODE=private-workspace runtime mode contract
// ---------------------------------------------------------------------------

test("resolveRuntimeMode accepts private-workspace", () => {
  assert.equal(
    resolveRuntimeMode({ TERMINAL_RUNTIME_MODE: "private-workspace" }),
    "private-workspace",
  );
  assert.equal(
    resolveRuntimeMode({ TERMINAL_RUNTIME_MODE: "private-workspace", PUBLIC_DEMO: "0" }),
    "private-workspace",
  );
});

test("resolveRuntimeMode rejects invalid modes", () => {
  assert.throws(() => resolveRuntimeMode({ TERMINAL_RUNTIME_MODE: "bogus" }));
});

// ---------------------------------------------------------------------------
// Blocker 10 — local research permit gate (never the public gateway budget)
// ---------------------------------------------------------------------------

test("readLocalResearchConcurrency defaults to 1 and bounds 1..2", () => {
  assert.equal(readLocalResearchConcurrency({}), 1);
  assert.equal(readLocalResearchConcurrency({ FIN_WORKSPACE_LOCAL_RESEARCH_CONCURRENCY: "2" }), 2);
  assert.throws(() => readLocalResearchConcurrency({ FIN_WORKSPACE_LOCAL_RESEARCH_CONCURRENCY: "0" }));
  assert.throws(() => readLocalResearchConcurrency({ FIN_WORKSPACE_LOCAL_RESEARCH_CONCURRENCY: "3" }));
  assert.throws(() => readLocalResearchConcurrency({ FIN_WORKSPACE_LOCAL_RESEARCH_CONCURRENCY: "x" }));
});

test("local gate grants one permit and rejects the second with local_research_busy", async () => {
  const gate = new LocalResearchPermitGate(1);
  const identity = { sessionId: "account-abc", workerGeneration: "gen-1" };
  const first = await gate.acquire(identity);
  assert.equal(first.accepted, true);
  assert.equal(first.status, "acquired");
  assert.ok(first.requestId);
  const second = await gate.acquire(identity);
  assert.equal(second.accepted, false);
  assert.equal(second.status, "rejected");
  assert.equal(second.reason, "local_research_busy");
  await gate.release(first.requestId!);
  const third = await gate.acquire(identity);
  assert.equal(third.accepted, true);
});

test("createResearchPermitGateForRuntime uses the local gate in private-workspace mode", async () => {
  const gate = createResearchPermitGateForRuntime({
    TERMINAL_RUNTIME_MODE: "private-workspace",
    FIN_WORKSPACE_SESSION_ID: "aaaaaaaaaaaaaaaaaaaaaaaa",
    TERMINAL_RUNTIME_WORKER_GENERATION: "gen-pw-1",
  });
  assert.ok(gate);
  const identity = gate.permitIdentity();
  assert.equal(identity.sessionId, "aaaaaaaaaaaaaaaaaaaaaaaa");
  const outcome = await gate.permitGate.acquire(identity);
  assert.equal(outcome.accepted, true);
  await gate.permitGate.release(outcome.requestId!);
});

test("createResearchPermitGateForRuntime keeps public gateway gate behavior elsewhere", () => {
  // No management URL/token → undefined (same as the previous public behavior).
  assert.equal(createResearchPermitGateForRuntime({ TERMINAL_RUNTIME_FEATURE_ENABLED: "1" }), undefined);
  assert.equal(createResearchPermitGateForRuntime({}), undefined);
});
