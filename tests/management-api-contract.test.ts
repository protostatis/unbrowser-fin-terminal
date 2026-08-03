/**
 * Infra reconciler contract tests for the private management API:
 *
 *   POST /api/management/reconcile-snapshot
 *   POST /api/management/reconcile-plan
 *   POST /api/management/drain
 *   POST /api/management/activate
 *   Header: X-Management-Token
 *
 * Plus the worker→gateway research-permit surface used to gate forks, and an
 * end-to-end check of the private ResearchPermitClient against a live API.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startManagementApi, type ManagementApi } from "../server/private-management-api.js";
import { CapacityWarmPool, type SeatStatus } from "../server/capacity-warm-pool.js";
import { ResearchPermitCoordinator } from "../server/research-permit-coordinator.js";
import { ResearchPermitClient } from "../server/research-permit-client.js";

const HOST = "127.0.0.1";
const TOKEN = "test-management-token-32chars-minimum!!";

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:http");
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, HOST, () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(
  url: string,
  options: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, options);
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return { status: response.status, body };
}

function createDeps() {
  const warmPool = new CapacityWarmPool({
    totalSeats: 6,
    idleScaleDownMs: 5 * 60_000,
    warmSpares: 1,
  });
  const researchPermits = new ResearchPermitCoordinator({
    maxConcurrent: 2,
    maxQueue: 4,
    defaultQueueTtlMs: 30 * 60_000,
    heartbeatIntervalMs: 30_000,
    acquireTtlMs: 12 * 60_000,
  });
  const touched: string[] = [];
  const seats: SeatStatus[] = [
    { workerId: "seat-01", phase: "active", generation: "gen-a", sessionId: "ticket-1", drainRequested: false, idleSinceMs: 1000 },
    { workerId: "seat-02", phase: "ready-idle", generation: "gen-b", drainRequested: false, idleSinceMs: 400_000 },
    { workerId: "seat-03", phase: "ready-idle", generation: "gen-c", drainRequested: false, idleSinceMs: 350_000 },
    { workerId: "seat-04", phase: "absent", drainRequested: false },
    { workerId: "seat-05", phase: "absent", drainRequested: false },
    { workerId: "seat-06", phase: "absent", drainRequested: false },
  ];
  let mutations = Promise.resolve();
  const mutate = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = mutations.then(async () => operation());
    mutations = result.then(() => undefined, () => undefined);
    return result;
  };
  const inspect = <T>(operation: () => T): Promise<T> => mutations.then(operation);
  return {
    warmPool,
    researchPermits,
    seats,
    touched,
    mutate,
    inspect,
  };
}

async function startApi(t: { after(fn: () => Promise<void> | void): void }) {
  const port = await getFreePort();
  const deps = createDeps();
  const api: ManagementApi | undefined = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      touchSession: (sessionId) => deps.touched.push(sessionId),
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);
  const running = api;
  t.after(() => running.close());
  return { port, deps, api: running };
}

const auth = { "x-management-token": TOKEN };

test("reconcile-snapshot returns per-seat statuses and plan (exact contract path)", async (t) => {
  const { port } = await startApi(t);
  const result = await fetchJson(`http://${HOST}:${port}/api/management/reconcile-snapshot`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.seats));
  assert.equal((result.body.seats as unknown[]).length, 6);
  assert.ok(result.body.plan);
  assert.equal(typeof (result.body.plan as Record<string, unknown>).desiredRunning, "number");
});

test("reconcile-plan returns the warm-pool plan only", async (t) => {
  const { port } = await startApi(t);
  const result = await fetchJson(`http://${HOST}:${port}/api/management/reconcile-plan`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.reconciled, true);
  const plan = result.body.plan as Record<string, unknown>;
  assert.ok(Array.isArray(plan.scaleDownCandidates));
  assert.ok(Array.isArray(plan.activateCandidates));
});

test("drain accepts a ready-idle seat and rejects a protected seat", async (t) => {
  const { port } = await startApi(t);
  const drain = await fetchJson(`http://${HOST}:${port}/api/management/drain`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "seat-02", drainId: "drain-1" }),
  });
  assert.equal(drain.status, 200);
  assert.equal(drain.body.accepted, true);

  const protectedSeat = await fetchJson(`http://${HOST}:${port}/api/management/drain`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "seat-01", drainId: "drain-2" }),
  });
  assert.equal(protectedSeat.status, 409);
});

test("activate releases a drained seat and reports force-release fallback", async (t) => {
  const { port, deps } = await startApi(t);
  deps.warmPool.requestDrain(
    { workerId: "seat-02", phase: "ready-idle", generation: "gen-b", drainRequested: false },
    "drain-pre",
  );
  // Same generation → sticky; the API force-releases.
  const result = await fetchJson(`http://${HOST}:${port}/api/management/activate`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "seat-02" }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.activated, true);
  assert.ok(!deps.warmPool.isDraining("seat-02"));
});

test("management contract rejects requests without X-Management-Token", async (t) => {
  const { port } = await startApi(t);
  const result = await fetchJson(`http://${HOST}:${port}/api/management/reconcile-plan`, {
    method: "POST",
  });
  assert.equal(result.status, 401);
});

test("research-permit acquire/status/release surface works over the private API", async (t) => {
  const { port } = await startApi(t);
  const acquire = await fetchJson(`http://${HOST}:${port}/api/management/research-permits/acquire`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "session-1", workerGeneration: "gen-1" }),
  });
  assert.equal(acquire.status, 200);
  assert.equal(acquire.body.accepted, true);
  assert.equal(acquire.body.status, "acquired");
  const requestId = acquire.body.requestId as string;
  assert.ok(requestId);

  const status = await fetchJson(`http://${HOST}:${port}/api/management/research-permits/status`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ requestId }),
  });
  assert.equal(status.body.status, "acquired");

  const release = await fetchJson(`http://${HOST}:${port}/api/management/research-permits/release`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ requestId }),
  });
  assert.equal(release.body.released, true);
});

test("research-permit heartbeat extends the owning session idle lease", async (t) => {
  const { port, deps } = await startApi(t);
  // Fill both global slots so the next acquire queues.
  deps.researchPermits.acquire("s1", "g1", "req-1");
  deps.researchPermits.acquire("s2", "g2", "req-2");
  const acquire = await fetchJson(`http://${HOST}:${port}/api/management/research-permits/acquire`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "session-waiting", workerGeneration: "gen-3" }),
  });
  assert.equal(acquire.body.status, "queued");
  const requestId = acquire.body.requestId as string;

  const hb = await fetchJson(`http://${HOST}:${port}/api/management/research-permits/heartbeat`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ requestId, sessionId: "session-waiting" }),
  });
  assert.equal(hb.body.alive, true);
  assert.ok(deps.touched.includes("session-waiting"));
});

test("ResearchPermitClient acquires and releases a permit end-to-end against the private API", async (t) => {
  const { port } = await startApi(t);
  const client = new ResearchPermitClient({
    baseUrl: `http://${HOST}:${port}`,
    token: TOKEN,
  });

  const outcome = await client.acquire({ sessionId: "session-1", workerGeneration: "gen-1" });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.status, "acquired");
  assert.ok(outcome.requestId);

  const status = await client.status(outcome.requestId!);
  assert.equal(status.status, "acquired");

  await client.heartbeat(outcome.requestId!);
  await client.release(outcome.requestId!);

  // A released permit is removed from active state.
  const after = await client.status(outcome.requestId!);
  assert.equal(after.status, "not-found");
});

test("ResearchPermitClient queues when the global cap is reached", async (t) => {
  const { port, deps } = await startApi(t);
  // Fill both global slots.
  deps.researchPermits.acquire("s1", "g1", "req-1");
  deps.researchPermits.acquire("s2", "g2", "req-2");
  const client = new ResearchPermitClient({
    baseUrl: `http://${HOST}:${port}`,
    token: TOKEN,
  });

  const outcome = await client.acquire({ sessionId: "s3", workerGeneration: "g3" });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.status, "queued");
  assert.ok(outcome.requestId);
  const status = await client.status(outcome.requestId!);
  assert.equal(status.status, "queued");
});

test("management API disabled when feature flag / token are absent (private-only gating)", async () => {
  const port = await getFreePort();
  const deps = createDeps();
  const disabled = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: false },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.equal(disabled, undefined);
});
