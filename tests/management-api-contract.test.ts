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
    // Overlay drain flags from the warm pool, mirroring the gateway wiring.
    drainAwareSeats: (): SeatStatus[] => seats.map((s) => ({
      ...s,
      drainRequested: warmPool.isDraining(s.workerId),
      drainId: warmPool.getDrain(s.workerId)?.drainId,
      drainGeneration: warmPool.getDrain(s.workerId)?.generation,
      drainSinceMs: warmPool.getDrain(s.workerId)
        ? Date.now() - (warmPool.getDrain(s.workerId)?.requestedAt ?? Date.now())
        : undefined,
    })),
  };
}

async function startApi(t: { after(fn: () => Promise<void> | void): void }) {
  const port = await getFreePort();
  const deps = createDeps();
  const api: ManagementApi | undefined = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.drainAwareSeats(),
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      getQueueCount: () => 2,
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

test("reconcile-snapshot returns the versioned seat map, totals, and plan", async (t) => {
  const { port } = await startApi(t);
  const result = await fetchJson(`http://${HOST}:${port}/api/management/reconcile-snapshot`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.version, 1);
  // Exactly six named seat records, keyed by workerId.
  const seats = result.body.seats as Record<string, Record<string, unknown>>;
  assert.ok(seats && typeof seats === "object" && !Array.isArray(seats));
  assert.equal(Object.keys(seats).length, 6);
  assert.deepEqual(Object.keys(seats).sort(), ["seat-01", "seat-02", "seat-03", "seat-04", "seat-05", "seat-06"]);

  // Normalized reconciler fields.
  const seat01 = seats["seat-01"]!;
  assert.equal(seat01.workerId, "seat-01");
  assert.equal(seat01.status, "healthy");
  assert.equal(seat01.assigned, true);
  assert.equal(seat01.generation, "gen-a");
  assert.equal(seat01.containerId, "");
  const seat02 = seats["seat-02"]!;
  assert.equal(seat02.status, "healthy");
  assert.equal(seat02.assigned, false);
  assert.equal(seat02.idleSeconds, 400);
  const seat04 = seats["seat-04"]!;
  assert.equal(seat04.status, "absent");
  assert.equal(seat04.assigned, false);
  assert.equal(seat04.generation, null);

  assert.equal(result.body.totalAssigned, 1);
  assert.equal(result.body.totalQueued, 2);
  const plan = result.body.plan as Record<string, unknown>;
  assert.equal(typeof plan.desiredRunning, "number");
  assert.ok(Array.isArray(plan.scaleDownCandidates));
  assert.ok(Array.isArray(plan.activateCandidates));
});

test("reconcile-snapshot reports accurate idleSeconds for ready-idle seats and zero for draining seats", async (t) => {
  const { port, deps } = await startApi(t);

  // seat-02 ready-idle at 400s idle → idleSeconds 400 (floored, monotonic).
  const snapshot = await fetchJson(`http://${HOST}:${port}/api/management/reconcile-snapshot`, {
    method: "POST",
    headers: auth,
  });
  const seats = snapshot.body.seats as Record<string, Record<string, unknown>>;
  assert.equal(seats["seat-02"]?.idleSeconds, 400);
  assert.equal(seats["seat-03"]?.idleSeconds, 350);

  // After a drain, the same ready-idle seat reports idleSeconds 0 (it is no
  // longer an idle scale-down candidate).
  deps.warmPool.requestDrain(
    { workerId: "seat-02", phase: "ready-idle", generation: "gen-b", drainRequested: false, idleSinceMs: 400_000 },
    "drain-idle-report",
  );
  const afterDrain = await fetchJson(`http://${HOST}:${port}/api/management/reconcile-snapshot`, {
    method: "POST",
    headers: auth,
  });
  const afterSeats = afterDrain.body.seats as Record<string, Record<string, unknown>>;
  assert.equal(afterSeats["seat-02"]?.idleSeconds, 0);
  assert.equal(afterSeats["seat-02"]?.drainRequested, true);
});

test("drain rejects a ready-idle seat before the five-minute idle threshold", async (t) => {
  const { port, deps } = await startApi(t);
  deps.seats[1] = { ...deps.seats[1]!, idleSinceMs: 299_999 };
  const early = await fetchJson(`http://${HOST}:${port}/api/management/drain`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "seat-02", drainId: "drain-early", expectedGeneration: "gen-b" }),
  });
  assert.equal(early.status, 409);
  assert.equal(early.body.accepted, false);
  assert.ok((early.body.reason as string).includes("not idle long enough"));
});

test("reconcile-plan returns the warm-pool plan only", async (t) => {
  const { port } = await startApi(t);
  const result = await fetchJson(`http://${HOST}:${port}/api/management/reconcile-plan`, {
    method: "POST",
    headers: auth,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.version, 1);
  assert.equal(result.body.reconciled, true);
  const plan = result.body.plan as Record<string, unknown>;
  assert.ok(Array.isArray(plan.scaleDownCandidates));
  assert.ok(Array.isArray(plan.activateCandidates));
});

test("drain accepts a ready-idle seat with a matching generation (CAS) and rejects a protected seat", async (t) => {
  const { port } = await startApi(t);
  const drain = await fetchJson(`http://${HOST}:${port}/api/management/drain`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "seat-02", drainId: "drain-1", expectedGeneration: "gen-b" }),
  });
  assert.equal(drain.status, 200);
  assert.equal(drain.body.accepted, true);
  assert.equal(drain.body.drainId, "drain-1");

  const protectedSeat = await fetchJson(`http://${HOST}:${port}/api/management/drain`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "seat-01", drainId: "drain-2", expectedGeneration: "gen-a" }),
  });
  assert.equal(protectedSeat.status, 409);
  assert.equal(protectedSeat.body.accepted, false);
});

test("drain performs a generation CAS and rejects a stale expectedGeneration", async (t) => {
  const { port } = await startApi(t);
  const stale = await fetchJson(`http://${HOST}:${port}/api/management/drain`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "seat-02", drainId: "drain-stale", expectedGeneration: "gen-stale" }),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.accepted, false);
  assert.equal(stale.body.reason, "generation mismatch");

  // Without an expectedGeneration the CAS is skipped (legacy callers).
  const noCas = await fetchJson(`http://${HOST}:${port}/api/management/drain`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "seat-02", drainId: "drain-nocas" }),
  });
  assert.equal(noCas.status, 200);
  assert.equal(noCas.body.accepted, true);
});

test("activate reports {accepted} and releases a drained seat only when the generation changed", async (t) => {
  const { port, deps } = await startApi(t);
  deps.warmPool.requestDrain(
    { workerId: "seat-02", phase: "ready-idle", generation: "gen-b", drainRequested: false, idleSinceMs: 400_000 },
    "drain-pre",
  );

  // Same generation → sticky; activation is rejected.
  const sticky = await fetchJson(`http://${HOST}:${port}/api/management/activate`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "seat-02" }),
  });
  assert.equal(sticky.status, 409);
  assert.equal(sticky.body.accepted, false);
  assert.ok(deps.warmPool.isDraining("seat-02"));

  // Generation moved (the reconciler restarted the container) → accepted.
  deps.seats[1] = { ...deps.seats[1]!, generation: "gen-b2" };
  const released = await fetchJson(`http://${HOST}:${port}/api/management/activate`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "seat-02" }),
  });
  assert.equal(released.status, 200);
  assert.equal(released.body.accepted, true);
  assert.ok(!deps.warmPool.isDraining("seat-02"));
});

test("activate on a non-draining seat is an accepted no-op", async (t) => {
  const { port } = await startApi(t);
  const result = await fetchJson(`http://${HOST}:${port}/api/management/activate`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId: "seat-04" }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.accepted, true);
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
      getQueueCount: () => 0,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.equal(disabled, undefined);
});
