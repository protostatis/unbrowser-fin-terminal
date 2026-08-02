import assert from "node:assert/strict";
import test from "node:test";
import {
  PublicSessionCoordinator,
  type PublicSessionEndReason,
} from "../server/public-session-coordinator.js";

function createCoordinator(overrides: Partial<ConstructorParameters<typeof PublicSessionCoordinator>[0]> = {}) {
  let now = 1_700_000_000_000;
  const ended: Array<{ id: string; reason: PublicSessionEndReason }> = [];
  const coordinator = new PublicSessionCoordinator({
    workerIds: ["seat-01", "seat-02"],
    maxQueue: 3,
    ticketTtlMs: 10 * 60_000,
    reconnectGraceMs: 30_000,
    idleTimeoutMs: 5 * 60_000,
    absoluteTimeoutMs: 15 * 60_000,
    maxResearchRuns: 5,
    dailyBudgetMicroUsd: 10_000_000,
    researchRunReservationMicroUsd: 200_000,
    now: () => now,
    createId: (() => {
      let sequence = 0;
      return () => `ticket-${++sequence}`;
    })(),
    onSessionEnded: (session, reason) => ended.push({ id: session.id, reason }),
    ...overrides,
  });
  return {
    coordinator,
    ended,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

test("verified visitors enter FIFO order and attach only after an available worker is assigned", () => {
  const { coordinator } = createCoordinator();
  const first = coordinator.admit("visitor-a");
  const second = coordinator.admit("visitor-b");
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  if (!first.accepted || !second.accepted) return;
  assert.equal(first.session.state, "queued");
  assert.equal(second.session.queuePosition, 2);

  coordinator.setWorkerReady("seat-01", true, "instance-a");
  assert.equal(coordinator.status(first.session.id)?.state, "admitted");
  assert.equal(coordinator.status(second.session.id)?.queuePosition, 1);
  const assignment = coordinator.attach(first.session.id);
  assert.equal(assignment?.workerId, "seat-01");
  assert.equal(coordinator.status(first.session.id)?.state, "active");
});

test("the queue is bounded and does not issue duplicate tickets to one visitor", () => {
  const { coordinator } = createCoordinator({ workerIds: ["seat-01"], maxQueue: 2 });
  const first = coordinator.admit("same-visitor");
  const duplicate = coordinator.admit("same-visitor");
  const second = coordinator.admit("visitor-b");
  const rejected = coordinator.admit("visitor-c");
  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, true);
  if (first.accepted && duplicate.accepted) assert.equal(duplicate.session.id, first.session.id);
  assert.equal(second.accepted, true);
  assert.deepEqual(rejected, { accepted: false, reason: "queue-full" });
});

test("ticket, idle, absolute, and disconnect leases end sessions and require a fresh worker health check", () => {
  const { coordinator, advance, ended } = createCoordinator({ workerIds: ["seat-01"] });
  const queued = coordinator.admit("ticket-expiry");
  assert.equal(queued.accepted, true);
  if (!queued.accepted) return;
  advance(10 * 60_000);
  coordinator.sweep();
  assert.equal(coordinator.status(queued.session.id)?.endReason, "ticket-expired");

  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const active = coordinator.admit("active");
  assert.equal(active.accepted, true);
  if (!active.accepted) return;
  const assignment = coordinator.attach(active.session.id);
  assert.ok(assignment);
  advance(5 * 60_000);
  coordinator.sweep();
  assert.equal(coordinator.status(active.session.id)?.endReason, "idle-timeout");
  assert.equal(coordinator.metrics().readyWorkers, 0);
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  assert.equal(coordinator.metrics().readyWorkers, 0);
  coordinator.setWorkerReady("seat-01", true, "instance-b");
  assert.equal(coordinator.metrics().readyWorkers, 1);
  assert.deepEqual(ended.map(({ reason }) => reason), ["ticket-expired", "idle-timeout"]);
});

test("an admitted visitor who never opens a socket releases the pristine worker without a restart", () => {
  const { coordinator, advance } = createCoordinator({ workerIds: ["seat-01"] });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const absent = coordinator.admit("visitor-a");
  assert.equal(absent.accepted, true);
  if (!absent.accepted) return;
  assert.equal(coordinator.status(absent.session.id)?.state, "admitted");
  advance(30_000);
  coordinator.sweep();
  assert.equal(coordinator.status(absent.session.id)?.endReason, "no-show");
  assert.equal(coordinator.metrics().readyWorkers, 1);
  const next = coordinator.admit("visitor-b");
  assert.equal(next.accepted, true);
  if (next.accepted) assert.equal(next.session.state, "admitted");
});

test("research reservations make the daily public budget a hard conservative cap", () => {
  const { coordinator } = createCoordinator({
    workerIds: ["seat-01", "seat-02"],
    dailyBudgetMicroUsd: 1_000_000,
    researchRunReservationMicroUsd: 100_000,
    maxResearchRuns: 5,
  });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  coordinator.setWorkerReady("seat-02", true, "instance-b");
  const first = coordinator.admit("visitor-a");
  const second = coordinator.admit("visitor-b");
  const third = coordinator.admit("visitor-c");
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(third.accepted, true);
  if (!first.accepted || !second.accepted || !third.accepted) return;
  assert.equal(coordinator.status(first.session.id)?.state, "admitted");
  assert.equal(coordinator.status(second.session.id)?.state, "admitted");
  assert.equal(coordinator.status(third.session.id)?.state, "queued");
  assert.equal(coordinator.metrics().dailyReservedMicroUsd, 1_000_000);

  const firstAssignment = coordinator.attach(first.session.id);
  assert.ok(firstAssignment);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(coordinator.authorizeResearch(first.session.id).allowed, true);
  }
  assert.deepEqual(coordinator.authorizeResearch(first.session.id), {
    allowed: false,
    reason: "research-limit-reached",
  });
});

test("UTC day rollover resets only the conservative daily reservation counter", () => {
  const { coordinator, advance } = createCoordinator({
    workerIds: ["seat-01"],
    dailyBudgetMicroUsd: 1_000_000,
    researchRunReservationMicroUsd: 200_000,
  });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const first = coordinator.admit("visitor-a");
  assert.equal(first.accepted, true);
  assert.equal(coordinator.metrics().dailyReservedMicroUsd, 1_000_000);
  advance(24 * 60 * 60_000);
  coordinator.sweep();
  assert.equal(coordinator.metrics().dailyReservedMicroUsd, 0);
});

test("persisted admission state restores opaque tickets but re-probes worker health", () => {
  const first = createCoordinator({ workerIds: ["seat-01"] });
  first.coordinator.setWorkerReady("seat-01", true, "instance-a");
  const admitted = first.coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;
  const assignment = first.coordinator.attach(admitted.session.id);
  assert.ok(assignment);

  const second = createCoordinator({ workerIds: ["seat-01"] });
  second.coordinator.restore(first.coordinator.exportState());
  assert.equal(second.coordinator.status(admitted.session.id)?.state, "active");
  assert.equal(second.coordinator.metrics().readyWorkers, 0);
  assert.equal(second.coordinator.attach(admitted.session.id)?.workerId, "seat-01");
});
