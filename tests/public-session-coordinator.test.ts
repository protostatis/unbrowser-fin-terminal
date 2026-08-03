import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_ENDED_SESSION_RETENTION_MS,
  PUBLIC_MAX_CONNECTION_ATTEMPTS,
  PublicSessionCoordinator,
  type PublicSessionEndReason,
} from "../server/public-session-coordinator.js";

function createCoordinator(
  overrides: Partial<ConstructorParameters<typeof PublicSessionCoordinator>[0]> = {},
  initialNow = 1_700_000_000_000,
) {
  let now = initialNow;
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

test("UTC day rollover carries active reservations into the new daily ceiling", () => {
  const { coordinator, advance } = createCoordinator({
    workerIds: ["seat-01", "seat-02"],
    dailyBudgetMicroUsd: 1_000_000,
    researchRunReservationMicroUsd: 200_000,
  }, Date.parse("2026-08-02T23:59:50.000Z"));
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  coordinator.setWorkerReady("seat-02", true, "instance-b");
  const first = coordinator.admit("visitor-a");
  assert.equal(first.accepted, true);
  if (!first.accepted) return;
  assert.ok(coordinator.attach(first.session.id));
  assert.equal(coordinator.metrics().dailyReservedMicroUsd, 1_000_000);
  advance(20_000);
  coordinator.sweep();
  assert.equal(coordinator.metrics().dailyReservedMicroUsd, 1_000_000);

  const second = coordinator.admit("visitor-b");
  assert.equal(second.accepted, true);
  if (second.accepted) {
    assert.equal(coordinator.status(second.session.id)?.endReason, "daily-budget-exhausted");
  }
});

test("a stale socket detach cannot disconnect its newer replacement", () => {
  const { coordinator, advance } = createCoordinator({ workerIds: ["seat-01"] });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;

  const first = coordinator.attach(admitted.session.id);
  const replacement = coordinator.attach(admitted.session.id);
  assert.ok(first && replacement);
  if (!first || !replacement) return;
  assert.ok(replacement.connectionVersion > first.connectionVersion);

  coordinator.detach(admitted.session.id, first.connectionVersion);
  advance(30_000);
  coordinator.sweep();
  assert.equal(coordinator.status(admitted.session.id)?.state, "active");

  coordinator.detach(admitted.session.id, replacement.connectionVersion);
  advance(30_000);
  coordinator.sweep();
  assert.equal(coordinator.status(admitted.session.id)?.endReason, "disconnect-timeout");
});

test("an aborted upgrade never activates or contaminates its assigned worker", () => {
  const { coordinator, advance } = createCoordinator({ workerIds: ["seat-01"] });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;

  const reservation = coordinator.reserveAttachment(admitted.session.id);
  assert.ok(reservation);
  if (!reservation) return;
  assert.equal(coordinator.status(admitted.session.id)?.state, "admitted");
  coordinator.cancelAttachment(admitted.session.id, reservation.connectionVersion);
  advance(30_000);
  coordinator.sweep();
  assert.equal(coordinator.status(admitted.session.id)?.endReason, "no-show");
  assert.equal(coordinator.metrics().readyWorkers, 1);
});

test("a replacement that closes during activation restores the live connection version", () => {
  const { coordinator, advance } = createCoordinator({ workerIds: ["seat-01"] });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;
  const first = coordinator.attach(admitted.session.id);
  assert.ok(first);
  if (!first) return;

  const replacement = coordinator.reserveAttachment(admitted.session.id);
  assert.ok(replacement);
  if (!replacement) return;
  const activated = coordinator.activateAttachment(
    admitted.session.id,
    replacement.connectionVersion,
  );
  assert.ok(activated);
  if (!activated) return;
  coordinator.markWorkerConnectionStarted(admitted.session.id, activated.connectionVersion);
  coordinator.rollbackAttachment(
    admitted.session.id,
    activated.connectionVersion,
    first.connectionVersion,
  );

  coordinator.detach(admitted.session.id, first.connectionVersion);
  advance(30_000);
  coordinator.sweep();
  assert.equal(coordinator.status(admitted.session.id)?.endReason, "disconnect-timeout");
});

test("connection attempts are capped across repeated attachment reservations", () => {
  const { coordinator } = createCoordinator({ workerIds: ["seat-01"] });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;

  for (let attempt = 0; attempt < PUBLIC_MAX_CONNECTION_ATTEMPTS; attempt += 1) {
    const reservation = coordinator.reserveAttachment(admitted.session.id);
    assert.ok(reservation);
    if (!reservation) return;
    coordinator.cancelAttachment(admitted.session.id, reservation.connectionVersion);
  }
  assert.equal(coordinator.reserveAttachment(admitted.session.id), undefined);
  assert.equal(coordinator.status(admitted.session.id)?.endReason, "rate-limited");
});

test("a worker generation reached after assignment is fenced until replacement", () => {
  const { coordinator } = createCoordinator({ workerIds: ["seat-01"] });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;
  const assignment = coordinator.attach(admitted.session.id);
  assert.ok(assignment);
  if (!assignment) return;
  assert.equal(assignment.workerGeneration, "instance-a");

  assert.equal(coordinator.confirmWorkerGeneration(
    assignment.id,
    assignment.connectionVersion,
    "instance-b",
  ), false);
  assert.equal(coordinator.status(assignment.id)?.endReason, "worker-unavailable");
  coordinator.setWorkerReady("seat-01", true, "instance-b");
  assert.equal(coordinator.metrics().readyWorkers, 0);
  coordinator.setWorkerReady("seat-01", true, "instance-c");
  assert.equal(coordinator.metrics().readyWorkers, 1);
});

test("a health result started before generation fencing is discarded", () => {
  const { coordinator } = createCoordinator({ workerIds: ["seat-01"] });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;
  const staleProbeEpoch = coordinator.workerProbeEpoch("seat-01");
  const assignment = coordinator.attach(admitted.session.id);
  assert.ok(assignment);
  if (!assignment) return;
  coordinator.confirmWorkerGeneration(
    assignment.id,
    assignment.connectionVersion,
    "instance-b",
  );

  assert.equal(coordinator.setWorkerReady(
    "seat-01",
    true,
    "instance-a",
    staleProbeEpoch,
  ), false);
  assert.equal(coordinator.metrics().readyWorkers, 0);
  coordinator.setWorkerReady("seat-01", true, "instance-b");
  assert.equal(coordinator.metrics().readyWorkers, 0);
  coordinator.setWorkerReady("seat-01", true, "instance-c");
  assert.equal(coordinator.metrics().readyWorkers, 1);
});

test("a missing worker generation header requires an unavailable transition", () => {
  const { coordinator } = createCoordinator({ workerIds: ["seat-01"] });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;
  const assignment = coordinator.attach(admitted.session.id);
  assert.ok(assignment);
  if (!assignment) return;

  assert.equal(coordinator.confirmWorkerGeneration(
    assignment.id,
    assignment.connectionVersion,
    undefined,
  ), false);
  coordinator.setWorkerReady("seat-01", true, "instance-b");
  assert.equal(coordinator.metrics().readyWorkers, 0);
  coordinator.setWorkerReady("seat-01", false);
  coordinator.setWorkerReady("seat-01", true, "instance-b");
  assert.equal(coordinator.metrics().readyWorkers, 0);
  coordinator.setWorkerReady("seat-01", false);
  coordinator.setWorkerReady("seat-01", true, "instance-c");
  assert.equal(coordinator.metrics().readyWorkers, 1);
});

test("an unvisited assignment safely follows a newly probed worker generation", () => {
  const { coordinator } = createCoordinator({ workerIds: ["seat-01"] });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;

  coordinator.setWorkerReady("seat-01", true, "instance-b");
  const assignment = coordinator.attach(admitted.session.id);
  assert.equal(assignment?.workerGeneration, "instance-b");
});

test("ended ticket tombstones expire from persisted admission state", () => {
  const { coordinator, advance } = createCoordinator({ workerIds: ["seat-01"] });
  coordinator.setWorkerReady("seat-01", true, "instance-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;
  const assignment = coordinator.attach(admitted.session.id);
  assert.ok(assignment);
  if (!assignment) return;
  coordinator.terminate(admitted.session.id, "protocol-violation");
  assert.equal(coordinator.status(admitted.session.id)?.state, "ended");

  advance(PUBLIC_ENDED_SESSION_RETENTION_MS);
  coordinator.sweep();
  assert.equal(coordinator.status(admitted.session.id), undefined);
  assert.equal(coordinator.exportState().sessions.length, 0);
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
