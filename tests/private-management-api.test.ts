/**
 * Tests for private management API — auth, input bounds, public non-exposure.
 * Tests the HTTP endpoints directly on a running server.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { Server } from "node:http";
import { startManagementApi, type ManagementApiConfig } from "../server/private-management-api.js";
import { CapacityWarmPool, type SeatStatus } from "../server/capacity-warm-pool.js";
import { ResearchPermitCoordinator } from "../server/research-permit-coordinator.js";

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

async function fetchJson(url: string, options: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, options);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // not JSON
  }
  return { status: response.status, body };
}

function createManagementApi(port: number) {
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

  // Acquire a permit for testing
  researchPermits.acquire("s1", "g1", "req-1");

  const seats: SeatStatus[] = [
    { workerId: "seat-01", phase: "active", generation: "gen-a", sessionId: "ticket-1", drainRequested: false, idleSinceMs: 1000 },
    { workerId: "seat-02", phase: "ready-idle", generation: "gen-b", drainRequested: false, idleSinceMs: 400_000 },
    { workerId: "seat-03", phase: "ready-idle", generation: "gen-c", drainRequested: false, idleSinceMs: 350_000 },
    { workerId: "seat-04", phase: "absent", drainRequested: false },
    { workerId: "seat-05", phase: "absent", drainRequested: false },
    { workerId: "seat-06", phase: "absent", drainRequested: false },
  ];

  let mutations = Promise.resolve();
  const mutate = <T>(operation: () => T): Promise<T> => {
    const result = mutations.then(operation);
    mutations = result.then(() => undefined);
    return result;
  };
  const inspect = <T>(operation: () => T): Promise<T> => mutations.then(operation);

  return {
    warmPool,
    researchPermits,
    seats,
    mutate,
    inspect,
  };
}

test("management API returns 401 without auth token", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);
  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(`http://${HOST}:${port}/api/management/seats`);
  assert.equal(result.status, 401);

  await api!.close();
});

test("management API returns 401 with bad token", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);
  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(`http://${HOST}:${port}/api/management/seats`, {
    headers: { "x-management-token": "wrong-token" },
  });
  assert.equal(result.status, 401);

  await api!.close();
});

test("GET /api/management/seats returns per-seat status and plan", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);
  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(`http://${HOST}:${port}/api/management/seats`, {
    headers: { "x-management-token": TOKEN },
  });

  assert.equal(result.status, 200);
  const body = result.body as Record<string, unknown>;
  assert.ok(Array.isArray(body.seats));
  assert.equal((body.seats as unknown[]).length, 6);
  assert.ok(body.plan != null);
  assert.equal(typeof (body.plan as Record<string, unknown>).desiredRunning, "number");

  await api!.close();
});

test("POST /api/management/seats/:id/drain accepts valid drain request", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);
  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(
    `http://${HOST}:${port}/api/management/seats/seat-02/drain`,
    {
      method: "POST",
      headers: {
        "x-management-token": TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ drainId: "drain-test-1" }),
    },
  );

  assert.equal(result.status, 200);
  const body = result.body as Record<string, unknown>;
  assert.equal(body.accepted, true);

  await api!.close();
});

test("POST /api/management/seats/:id/drain rejects protected seat", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);
  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(
    `http://${HOST}:${port}/api/management/seats/seat-01/drain`, // active seat
    {
      method: "POST",
      headers: {
        "x-management-token": TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ drainId: "drain-test-1" }),
    },
  );

  assert.equal(result.status, 409);
  const body = result.body as Record<string, unknown>;
  assert.equal(body.accepted, false);

  await api!.close();
});

test("POST /api/management/seats/:id/drain rejects missing drainId", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);
  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(
    `http://${HOST}:${port}/api/management/seats/seat-02/drain`,
    {
      method: "POST",
      headers: {
        "x-management-token": TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );

  // 400 Bad Request because no drainId
  assert.ok(result.status >= 400);
  assert.ok(result.status < 500);

  await api!.close();
});

test("POST /api/management/seats/:id/activate activates a drained seat", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);

  // Pre-drain the seat
  deps.warmPool.requestDrain(
    { workerId: "seat-02", phase: "ready-idle", generation: "gen-b", drainRequested: false },
    "drain-test-pre",
  );

  // Change generation to allow release
  deps.seats[1] = { ...deps.seats[1], generation: "gen-b-new" };

  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(
    `http://${HOST}:${port}/api/management/seats/seat-02/activate`,
    {
      method: "POST",
      headers: {
        "x-management-token": TOKEN,
      },
    },
  );

  assert.equal(result.status, 200);
  const body = result.body as Record<string, unknown>;
  assert.equal(body.activated, true);

  await api!.close();
});

test("POST /api/management/reconcile returns warm-pool plan", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);
  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(
    `http://${HOST}:${port}/api/management/reconcile`,
    {
      method: "POST",
      headers: { "x-management-token": TOKEN },
    },
  );

  assert.equal(result.status, 200);
  const body = result.body as Record<string, unknown>;
  assert.equal(body.reconciled, true);
  assert.ok(body.plan != null);

  await api!.close();
});

test("GET /api/management/research returns permit metrics", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);
  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(`http://${HOST}:${port}/api/management/research`, {
    headers: { "x-management-token": TOKEN },
  });

  assert.equal(result.status, 200);
  const body = result.body as Record<string, unknown>;
  assert.ok(body.research != null);
  const research = body.research as Record<string, unknown>;
  assert.equal(research.acquired, 1); // req-1 pre-acquired
  assert.equal(typeof research.maxConcurrent, "number");

  await api!.close();
});

test("management API returns 404 for unknown endpoints", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);
  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(`http://${HOST}:${port}/api/management/secrets`, {
    headers: { "x-management-token": TOKEN },
  });
  assert.equal(result.status, 404);

  await api!.close();
});

test("management API does not start when disabled", () => {
  const deps = createManagementApi(0);
  const api = startManagementApi(
    { host: HOST, port: 0, token: TOKEN, enabled: false },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.equal(api, undefined);
});

test("invalid body (not JSON) returns 400", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);
  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(
    `http://${HOST}:${port}/api/management/seats/seat-02/drain`,
    {
      method: "POST",
      headers: {
        "x-management-token": TOKEN,
        "content-type": "application/json",
      },
      body: "not-json",
    },
  );

  assert.ok(result.status >= 400 && result.status < 500);

  await api!.close();
});

test("seat id with special characters is rejected", async () => {
  const port = await getFreePort();
  const deps = createManagementApi(port);
  const api = startManagementApi(
    { host: HOST, port, token: TOKEN, enabled: true },
    {
      getSeatStatuses: () => deps.seats,
      getWarmPool: () => deps.warmPool,
      getResearchCoordinator: () => deps.researchPermits,
      mutate: deps.mutate,
      inspect: deps.inspect,
    },
  );
  assert.ok(api);

  const result = await fetchJson(
    `http://${HOST}:${port}/api/management/seats/../../../etc/drain`,
    {
      method: "POST",
      headers: {
        "x-management-token": TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ drainId: "x" }),
    },
  );

  assert.equal(result.status, 404); // doesn't match the route pattern

  await api!.close();
});
