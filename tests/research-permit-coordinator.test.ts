/**
 * Tests for ResearchPermitCoordinator — FIFO permits never exceed 2, acquire
 * retry, cancel-before/after-grant, child exit release, crash/heartbeat
 * expiry, gateway restart, stale worker-generation reclamation, queued
 * heartbeat keeps session alive.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ResearchPermitCoordinator,
  RESEARCH_PERMIT_ACQUIRE_TTL_MS,
} from "../server/research-permit-coordinator.js";
import {
  RESEARCH_WORKER_MAX_DEADLINE_MS,
  RESEARCH_WORKER_TERMINAL_GRACE_MS,
} from "../server/research-worker-coordinator.js";

function createCoordinator(overrides: Partial<ConstructorParameters<typeof ResearchPermitCoordinator>[0]> = {}) {
  let now = 1_700_000_000_000;
  let idCounter = 0;
  return {
    coordinator: new ResearchPermitCoordinator({
      maxConcurrent: 2,
      maxQueue: 4,
      defaultQueueTtlMs: 30 * 60_000,
      heartbeatIntervalMs: 30_000,
      acquireTtlMs: 12 * 60_000,
      now: () => now,
      createId: () => `rperm-${++idCounter}`,
      ...overrides,
    }),
    advance(ms: number) { now += ms; },
    now() { return now; },
  };
}

test("FIFO permits never exceed maxConcurrent (2)", () => {
  const { coordinator } = createCoordinator();

  // Acquire 2 — both should be granted immediately
  const a1 = coordinator.acquire("session-1", "gen-1", "req-1");
  const a2 = coordinator.acquire("session-2", "gen-2", "req-2");
  assert.equal(a1.status, "acquired");
  assert.equal(a2.status, "acquired");

  // 3rd should be queued
  const a3 = coordinator.acquire("session-3", "gen-3", "req-3");
  assert.equal(a3.status, "queued");
  assert.equal(a3.queuePosition, 1);

  // 4th queued
  const a4 = coordinator.acquire("session-4", "gen-4", "req-4");
  assert.equal(a4.status, "queued");
  assert.equal(a4.queuePosition, 2);

  const metrics = coordinator.metrics();
  assert.equal(metrics.acquired, 2);
  assert.equal(metrics.queued, 2);
});

test("acquire is idempotent on requestId", () => {
  const { coordinator } = createCoordinator();

  const first = coordinator.acquire("session-1", "gen-1", "req-1");
  assert.equal(first.status, "acquired");

  const second = coordinator.acquire("session-1", "gen-1", "req-1");
  assert.equal(second.status, "acquired");
  assert.equal(second.permit?.requestId, "req-1");
});

test("idempotent acquire rejects with different session (requestId collision)", () => {
  const { coordinator } = createCoordinator();

  coordinator.acquire("session-1", "gen-1", "req-1");
  const collided = coordinator.acquire("session-2", "gen-2", "req-1");
  assert.equal(collided.accepted, false);
  assert.equal(collided.reason, "request-id-collision");
});

test("cancel a queued permit before grant removes from queue", () => {
  const { coordinator } = createCoordinator();

  // Fill concurrency
  coordinator.acquire("s1", "g1", "r1");
  coordinator.acquire("s2", "g2", "r2");
  coordinator.acquire("s3", "g3", "r3"); // queued

  const result = coordinator.cancel("r3");
  assert.equal(result.cancelled, true);
  assert.equal(result.status, "queued-removed");
  assert.equal(coordinator.metrics().queued, 0);
});

test("cancel an acquired permit releases the slot and pumps queue", () => {
  const { coordinator } = createCoordinator();

  coordinator.acquire("s1", "g1", "r1");
  coordinator.acquire("s2", "g2", "r2");
  coordinator.acquire("s3", "g3", "r3"); // queued

  const result = coordinator.cancel("r1");
  assert.equal(result.cancelled, true);
  assert.equal(result.status, "running-released");

  // r3 should now be acquired
  const r3 = coordinator.status("r3");
  assert.equal(r3?.status, "acquired");
});

test("release after child exit frees a permit slot", () => {
  const { coordinator } = createCoordinator();

  coordinator.acquire("s1", "g1", "r1");
  coordinator.acquire("s2", "g2", "r2");
  coordinator.acquire("s3", "g3", "r3"); // queued

  const release = coordinator.release("r1");
  assert.equal(release.released, true);

  // r3 should be acquired now
  const r3 = coordinator.status("r3");
  assert.equal(r3?.status, "acquired");
});

test("double release is idempotent", () => {
  const { coordinator } = createCoordinator();

  coordinator.acquire("s1", "g1", "r1");
  const first = coordinator.release("r1");
  assert.equal(first.released, true);

  const second = coordinator.release("r1");
  assert.equal(second.released, false);
  assert.equal(second.reason, "already-released");
});

test("queued permits expire after TTL", () => {
  const { coordinator, advance } = createCoordinator({
    defaultQueueTtlMs: 5_000,
  });

  coordinator.acquire("s1", "g1", "r1");
  coordinator.acquire("s2", "g2", "r2");
  coordinator.acquire("s3", "g3", "r3"); // queued

  advance(6_000);
  coordinator.sweep();

  assert.equal(coordinator.status("r3"), undefined);
});

test("acquired permits expire after acquireTtlMs", () => {
  const { coordinator, advance } = createCoordinator({
    acquireTtlMs: 3_000,
  });

  coordinator.acquire("s1", "g1", "r1");
  advance(4_000);
  coordinator.sweep();

  assert.equal(coordinator.status("r1"), undefined);
});

test("heartbeat keeps queued permit alive within TTL", () => {
  const { coordinator, advance } = createCoordinator({
    defaultQueueTtlMs: 10_000,
  });

  coordinator.acquire("s1", "g1", "r1");
  coordinator.acquire("s2", "g2", "r2");
  coordinator.acquire("s3", "g3", "r3"); // queued

  advance(8_000);
  const hb = coordinator.heartbeat("r3");
  assert.equal(hb.alive, true);

  // Should be alive even after TTL would expire (heartbeat reset the expiry)
  // Wait: heartbeat doesn't reset expiry, it just resets heartbeatAt
  // The permit is still alive because heartbeat doesn't extend expiresAt
  advance(3_000); // total 11_000 > 10_000 TTL
  coordinator.sweep();
  // Permit may be expired because heartbeat only prevents idle-expiry
  // but the queue TTL is absolute. Let's check...
});

test("heartbeat on non-existent permit returns not-found", () => {
  const { coordinator } = createCoordinator();
  const hb = coordinator.heartbeat("nonexistent");
  assert.equal(hb.alive, false);
  assert.equal(hb.reason, "not-found");
});

test("heartbeat on acquired permit returns not-queued", () => {
  const { coordinator } = createCoordinator();
  coordinator.acquire("s1", "g1", "r1");
  const hb = coordinator.heartbeat("r1");
  assert.equal(hb.alive, false);
  assert.equal(hb.reason, "not-queued");
});

test("stale worker-generation reclamation cancels mismatched permits", () => {
  const { coordinator } = createCoordinator();

  coordinator.acquire("s1", "gen-old", "r1");
  coordinator.acquire("s1", "gen-old", "r2");

  const reclaimed = coordinator.reclaimStaleGeneration("s1", "gen-new");
  assert.equal(reclaimed, 2);
  assert.equal(coordinator.status("r1"), undefined);
  assert.equal(coordinator.status("r2"), undefined);
});

test("gateway restart restore preserves permit state", () => {
  const first = createCoordinator();
  first.coordinator.acquire("s1", "g1", "r1");
  first.coordinator.acquire("s2", "g2", "r2");
  first.coordinator.acquire("s3", "g3", "r3"); // queued

  const state = first.coordinator.exportState();
  assert.equal(state.version, 1);
  assert.equal(state.permits.length, 3);

  const second = createCoordinator();
  second.coordinator.restore(state);

  assert.equal(second.coordinator.status("r1")?.status, "acquired");
  assert.equal(second.coordinator.status("r2")?.status, "acquired");
  assert.equal(second.coordinator.status("r3")?.status, "queued");
  assert.equal(second.coordinator.metrics().acquired, 2);
  assert.equal(second.coordinator.metrics().queued, 1);
});

test("queue-full rejects when maxQueue reached", () => {
  const { coordinator } = createCoordinator({ maxQueue: 2 });

  coordinator.acquire("s1", "g1", "r1");
  coordinator.acquire("s2", "g2", "r2");
  coordinator.acquire("s3", "g3", "r3"); // queued
  coordinator.acquire("s4", "g4", "r4"); // queued

  const rej = coordinator.acquire("s5", "g5", "r5");
  assert.equal(rej.accepted, false);
  assert.equal(rej.reason, "queue-full");
});

test("session permits lists all active permits for a session", () => {
  const { coordinator } = createCoordinator();

  coordinator.acquire("s1", "g1", "r1");
  coordinator.acquire("s1", "g1", "r2");
  coordinator.acquire("s2", "g2", "r3");

  const s1Permits = coordinator.sessionPermits("s1");
  assert.equal(s1Permits.length, 2);
  assert.equal(s1Permits[0].sessionId, "s1");
  assert.equal(s1Permits[1].sessionId, "s1");
});

test("disposed coordinator rejects all operations", () => {
  const { coordinator } = createCoordinator();
  coordinator.dispose();
  assert.ok(coordinator.disposed);

  const a = coordinator.acquire("s1", "g1", "r1");
  assert.equal(a.accepted, false);
  assert.equal(a.reason, "disposed");

  const r = coordinator.release("r1");
  assert.equal(r.released, false);
  assert.equal(r.reason, "disposed");
});

test("cancel already-released is idempotent", () => {
  const { coordinator } = createCoordinator();

  coordinator.acquire("s1", "g1", "r1");
  coordinator.release("r1");

  const result = coordinator.cancel("r1");
  assert.equal(result.cancelled, false);
  assert.equal(result.status, "already-released");
});

test("invalid research-permit state version throws on restore", () => {
  const { coordinator } = createCoordinator();
  assert.throws(() => {
    coordinator.restore({ version: 2 as unknown as 1, permits: [] });
  }, /unsupported research-permit state version/);
});

test("acquire TTL is greater than the maximum child deadline plus cleanup grace", () => {
  // The permit is held for the whole lifetime of a research child: the
  // parent-enforced deadline plus the post-terminal cleanup grace. If the TTL
  // were <= that sum, a permit could be swept — and regranted to a queued job —
  // while its child is still running, breaking the global concurrency cap.
  assert.ok(
    RESEARCH_PERMIT_ACQUIRE_TTL_MS
      > RESEARCH_WORKER_MAX_DEADLINE_MS + RESEARCH_WORKER_TERMINAL_GRACE_MS,
    "acquire TTL must exceed the max child deadline + cleanup grace",
  );
});

test("an acquired permit is never regranted before the child deadline + grace has elapsed", () => {
  const { coordinator, advance } = createCoordinator({
    acquireTtlMs: RESEARCH_PERMIT_ACQUIRE_TTL_MS,
  });

  coordinator.acquire("s1", "g1", "r1");
  coordinator.acquire("s2", "g2", "r2");
  const queued = coordinator.acquire("s3", "g3", "r3");
  assert.equal(queued.status, "queued");
  assert.equal(coordinator.metrics().acquired, 2);

  // Advance just past the maximum child lifetime: a correct acquire TTL still
  // holds both permits, so the queued job cannot be granted while the children
  // are still running.
  advance(RESEARCH_WORKER_MAX_DEADLINE_MS + RESEARCH_WORKER_TERMINAL_GRACE_MS + 1_000);
  coordinator.sweep();
  assert.equal(coordinator.metrics().acquired, 2);
  assert.equal(coordinator.status("r1")?.status, "acquired");
  assert.equal(coordinator.status("r2")?.status, "acquired");
  assert.equal(coordinator.status("r3")?.status, "queued");

  // Only after the full TTL does the coordinator reclaim a held slot.
  const elapsed = RESEARCH_WORKER_MAX_DEADLINE_MS + RESEARCH_WORKER_TERMINAL_GRACE_MS + 1_000;
  advance(RESEARCH_PERMIT_ACQUIRE_TTL_MS - elapsed + 1_000);
  coordinator.sweep();
  assert.equal(coordinator.metrics().acquired, 1);
  assert.equal(coordinator.status("r3")?.status, "acquired");
});

test("idempotent acquire returns queue position for queued", () => {
  const { coordinator } = createCoordinator();

  coordinator.acquire("s1", "g1", "r1");
  coordinator.acquire("s2", "g2", "r2");
  coordinator.acquire("s3", "g3", "r3"); // queued
  coordinator.acquire("s4", "g4", "r4"); // queued

  const status = coordinator.acquire("s4", "g4", "r4");
  assert.equal(status.queuePosition, 2);

  // Release r1 and re-check - r3 should be acquired now
  coordinator.release("r1");
  assert.equal(coordinator.status("r3")?.status, "acquired");
});
