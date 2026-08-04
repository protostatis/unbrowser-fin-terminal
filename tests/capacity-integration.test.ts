/**
 * Integration tests for warm-pool capacity and research-permit features
 * within the PublicSessionCoordinator.
 *
 * Tests:
 *  - admission-vs-drain race never assigns/stops drained seat
 *  - getSeatStatuses correctly reports phases for warm-pool planning
 *  - backward restore with existing Redis state (v1 compatibility)
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  PublicSessionCoordinator,
} from "../server/public-session-coordinator.js";
import { CapacityWarmPool } from "../server/capacity-warm-pool.js";

function createCoordinator(overrides: Partial<ConstructorParameters<typeof PublicSessionCoordinator>[0]> = {}) {
  let now = 1_700_000_000_000;
  return {
    coordinator: new PublicSessionCoordinator({
      workerIds: ["seat-01", "seat-02", "seat-03", "seat-04", "seat-05", "seat-06"],
      maxQueue: 3,
      ticketTtlMs: 10 * 60_000,
      reconnectGraceMs: 30_000,
      idleTimeoutMs: 5 * 60_000,
      absoluteTimeoutMs: 15 * 60_000,
      maxResearchRuns: 5,
      dailyBudgetMicroUsd: 10_000_000,
      researchRunReservationMicroUsd: 200_000,
      now: () => now,
      ...overrides,
    }),
    advance(ms: number) { now += ms; },
  };
}

/**
 * Full drain harness: the coordinator AND the warm pool share one clock, and
 * the helpers below mirror the gateway's atomic drain/activate mutations
 * (validation → warm-pool drain → coordinator fence, both halves applied in a
 * single synchronous operation exactly as under the gateway mutate chain).
 */
function createHarness() {
  let now = 1_700_000_000_000;
  const workerIds = ["seat-01", "seat-02", "seat-03", "seat-04", "seat-05", "seat-06"];
  const coordinator = new PublicSessionCoordinator({
    workerIds,
    maxQueue: 3,
    ticketTtlMs: 10 * 60_000,
    reconnectGraceMs: 30_000,
    idleTimeoutMs: 5 * 60_000,
    absoluteTimeoutMs: 15 * 60_000,
    maxResearchRuns: 5,
    dailyBudgetMicroUsd: 10_000_000,
    researchRunReservationMicroUsd: 200_000,
    now: () => now,
  });
  const warmPool = new CapacityWarmPool({
    totalSeats: 6,
    idleScaleDownMs: 5 * 60_000,
    warmSpares: 1,
    now: () => now,
  });
  return {
    coordinator,
    warmPool,
    advance(ms: number) { now += ms; },
  };
}

function seatWithDrain(coordinator: PublicSessionCoordinator, warmPool: CapacityWarmPool, workerId: string) {
  const seat = coordinator.getSeatStatuses().find((s) => s.workerId === workerId);
  if (!seat) return undefined;
  const drain = warmPool.getDrain(workerId);
  return {
    ...seat,
    drainRequested: warmPool.isDraining(workerId),
    drainId: drain?.drainId,
    drainGeneration: drain?.generation,
    drainSinceMs: drain ? Date.now() - drain.requestedAt : undefined,
  };
}

/** Mirrors POST /api/management/drain under the gateway mutate serialization. */
function drainSeat(
  coordinator: PublicSessionCoordinator,
  warmPool: CapacityWarmPool,
  workerId: string,
  drainId: string,
  expectedGeneration?: string,
): { accepted: boolean; drainId?: string; reason?: string } {
  const seat = seatWithDrain(coordinator, warmPool, workerId);
  if (!seat) return { accepted: false, reason: "unknown seat" };
  if (expectedGeneration && seat.generation !== expectedGeneration) {
    return { accepted: false, reason: "generation mismatch" };
  }
  const drain = warmPool.requestDrain(seat, drainId);
  if (!drain.accepted) return drain;
  if (!coordinator.setWorkerDrainIneligible(workerId, true)) {
    warmPool.forceReleaseDrain(workerId);
    return { accepted: false, reason: "seat unavailable" };
  }
  return drain;
}

/** Mirrors POST /api/management/activate under the gateway mutate serialization. */
function activateSeat(
  coordinator: PublicSessionCoordinator,
  warmPool: CapacityWarmPool,
  workerId: string,
): { accepted: boolean; reason?: string } {
  const seat = seatWithDrain(coordinator, warmPool, workerId);
  if (!seat) return { accepted: false, reason: "unknown seat" };
  const drain = warmPool.getDrain(workerId);
  if (drain && seat.generation && seat.generation === drain.generation) {
    return { accepted: false, reason: "drain sticky; generation unchanged" };
  }
  if (drain) {
    const released = warmPool.releaseDrain(workerId, seat.generation);
    if (!released.released) warmPool.forceReleaseDrain(workerId);
  }
  coordinator.setWorkerDrainIneligible(workerId, false);
  return { accepted: true };
}

test("admission before drain is unaffected; no session is assigned after drain accepted", () => {
  const { coordinator, warmPool, advance } = createHarness();

  // A visitor admitted BEFORE the drain takes the ready seat normally.
  coordinator.setWorkerReady("seat-01", true, "gen-a");
  const before = coordinator.admit("visitor-a");
  assert.equal(before.accepted, true);
  if (!before.accepted) return;
  assert.equal(before.session.state, "admitted");
  assert.equal(before.session.workerId, "seat-01");

  // The admitted visitor never opens a socket → no-show returns the pristine
  // seat to ready-idle. Now the operator drains it.
  advance(30_000);
  coordinator.sweep();
  assert.equal(coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01")?.phase, "ready-idle");
  advance(300_000);
  const drain = drainSeat(coordinator, warmPool, "seat-01", "drain-a", "gen-a");
  assert.equal(drain.accepted, true);

  // The drained seat is pinned: it reports draining and is never assigned.
  assert.equal(coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01")?.phase, "draining");

  // A visitor admitted AFTER the drain is queued — never assigned, even after
  // sweeps and repeated health probes.
  const after = coordinator.admit("visitor-b");
  assert.equal(after.accepted, true);
  if (!after.accepted) return;
  assert.equal(after.session.state, "queued");
  assert.equal(after.session.workerId, undefined);
  coordinator.sweep();
  coordinator.setWorkerReady("seat-01", true, "gen-a");
  assert.equal(coordinator.status(after.session.id)?.state, "queued");
  assert.equal(coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01")?.phase, "draining");
});

test("a drain is atomic under serialized admission: a concurrent visitor never lands on the drained seat", () => {
  const { coordinator, warmPool, advance } = createHarness();
  coordinator.setWorkerReady("seat-01", true, "gen-a");
  coordinator.setWorkerReady("seat-02", true, "gen-b");
  advance(400_000);

  // Serialized operations (the gateway mutate chain runs one at a time): an
  // admission takes seat-01, the drain fences seat-02, and a later admission
  // must queue instead of landing on the drained seat-02.
  const first = coordinator.admit("visitor-a");
  const drain = drainSeat(coordinator, warmPool, "seat-02", "drain-race", "gen-b");
  const second = coordinator.admit("visitor-b");
  assert.equal(first.accepted && drain.accepted && second.accepted, true);
  if (!first.accepted || !second.accepted) return;

  assert.equal(first.session.state, "admitted");
  assert.equal(first.session.workerId, "seat-01");
  assert.equal(second.session.state, "queued");
  assert.equal(second.session.workerId, undefined);

  // seat-02 stays draining and seat-01 keeps serving its session.
  assert.equal(coordinator.getSeatStatuses().find((s) => s.workerId === "seat-02")?.phase, "draining");
  assert.equal(coordinator.status(first.session.id)?.state, "admitted");
});

test("a drained seat survives gateway restart, restore, and fresh health probes", () => {
  const first = createHarness();
  first.coordinator.setWorkerReady("seat-01", true, "gen-a");
  first.advance(400_000);
  const drain = drainSeat(first.coordinator, first.warmPool, "seat-01", "drain-restart", "gen-a");
  assert.equal(drain.accepted, true);

  // Persist both halves (the gateway mutate serialization) and restart.
  const coordinatorState = first.coordinator.exportState();
  const capacityState = first.warmPool.exportState();
  const second = createHarness();
  second.coordinator.restore(coordinatorState);
  second.warmPool.restore(capacityState);
  // Startup reconciliation re-fences every warm-pool drain.
  for (const seat of second.coordinator.getSeatStatuses()) {
    if (second.warmPool.isDraining(seat.workerId)) {
      second.coordinator.setWorkerDrainIneligible(seat.workerId, true);
    }
  }

  // Still draining after the restart, even after fresh probes of the same and
  // of a NEW generation (a new generation alone never re-enables the seat).
  const seat1 = second.coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.equal(seat1?.phase, "draining");
  second.coordinator.setWorkerReady("seat-01", true, "gen-a");
  second.coordinator.setWorkerReady("seat-01", true, "gen-b");
  assert.equal(second.coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01")?.phase, "draining");

  const admitted = second.coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;
  assert.equal(admitted.session.state, "queued");
  assert.equal(admitted.session.workerId, undefined);
});

test("same-generation activate is rejected; a new generation activates only via explicit activate", () => {
  const { coordinator, warmPool, advance } = createHarness();
  coordinator.setWorkerReady("seat-01", true, "gen-a");
  advance(400_000);
  const drain = drainSeat(coordinator, warmPool, "seat-01", "drain-sticky", "gen-a");
  assert.equal(drain.accepted, true);

  // Same-generation activation is rejected and leaves BOTH halves in force.
  const sticky = activateSeat(coordinator, warmPool, "seat-01");
  assert.equal(sticky.accepted, false);
  assert.equal(coordinator.isWorkerDrainIneligible("seat-01"), true);
  assert.ok(warmPool.isDraining("seat-01"));

  // A probe with a new generation keeps the seat ineligible but records the
  // generation so the warm-pool plan proposes an activation.
  coordinator.setWorkerReady("seat-01", true, "gen-b");
  assert.equal(coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01")?.phase, "draining");
  const seats = coordinator.getSeatStatuses().map((s) => ({
    ...s,
    drainRequested: warmPool.isDraining(s.workerId),
    drainId: warmPool.getDrain(s.workerId)?.drainId,
  }));
  const plan = warmPool.plan(seats);
  assert.ok(plan.activateCandidates.includes("seat-01"));

  // Explicit activation with the changed generation clears BOTH halves.
  const released = activateSeat(coordinator, warmPool, "seat-01");
  assert.equal(released.accepted, true);
  assert.equal(coordinator.isWorkerDrainIneligible("seat-01"), false);
  assert.ok(!warmPool.isDraining("seat-01"));

  // The seat needs a fresh probe before it is assignable again.
  assert.notEqual(coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01")?.phase, "ready-idle");
  coordinator.setWorkerReady("seat-01", true, "gen-b");
  assert.equal(coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01")?.phase, "ready-idle");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;
  assert.equal(admitted.session.state, "admitted");
  assert.equal(admitted.session.workerId, "seat-01");
});

test("a health probe already in flight when a drain is accepted cannot re-enable the seat", () => {
  const { coordinator, warmPool, advance } = createHarness();
  coordinator.setWorkerReady("seat-01", true, "gen-a");
  advance(400_000);

  // The maintenance loop captured the probe epoch, then the drain lands (the
  // fence bumps the epoch), then the stale probe response arrives.
  const staleEpoch = coordinator.workerProbeEpoch("seat-01");
  const drain = drainSeat(coordinator, warmPool, "seat-01", "drain-probe", "gen-a");
  assert.equal(drain.accepted, true);
  assert.equal(coordinator.setWorkerReady("seat-01", true, "gen-a", staleEpoch), false);

  const seat1 = coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.equal(seat1?.phase, "draining");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (admitted.accepted) assert.equal(admitted.session.state, "queued");
});

test("getSeatStatuses reports correct phases for all 6 seats", () => {
  const { coordinator } = createCoordinator();

  // No workers ready yet — all absent
  const initial = coordinator.getSeatStatuses();
  assert.equal(initial.length, 6);
  assert.ok(initial.every((s) => s.phase === "absent"));

  // Ready one worker
  coordinator.setWorkerReady("seat-01", true, "gen-a");
  const ready = coordinator.getSeatStatuses();
  const seat1 = ready.find((s) => s.workerId === "seat-01");
  assert.equal(seat1?.phase, "ready-idle");
  assert.equal(seat1?.generation, "gen-a");

  // Admit a visitor (auto-assigns seat-01)
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;

  const admittedStatus = coordinator.getSeatStatuses();
  const seat1Admitted = admittedStatus.find((s) => s.workerId === "seat-01");
  assert.equal(seat1Admitted?.phase, "admitted");
  assert.equal(seat1Admitted?.sessionId, admitted.session.id);

  // Attach → active
  const assignment = coordinator.attach(admitted.session.id);
  assert.ok(assignment);
  const activeStatus = coordinator.getSeatStatuses();
  const seat1Active = activeStatus.find((s) => s.workerId === "seat-01");
  assert.equal(seat1Active?.phase, "active");

  // Detach → disconnected
  coordinator.detach(admitted.session.id, assignment!.connectionVersion);
  const disconnected = coordinator.getSeatStatuses();
  const seat1Disc = disconnected.find((s) => s.workerId === "seat-01");
  assert.equal(seat1Disc?.phase, "disconnected");
});

test("getSeatStatuses idleSinceMs tracks time since last activity", () => {
  const { coordinator, advance } = createCoordinator();

  coordinator.setWorkerReady("seat-01", true, "gen-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;

  const assignment = coordinator.attach(admitted.session.id);
  assert.ok(assignment);

  // Right after attach, idleSinceMs should be near 0
  let status = coordinator.getSeatStatuses();
  let seat1 = status.find((s) => s.workerId === "seat-01");
  assert.ok((seat1?.idleSinceMs ?? 0) < 1000);

  // Advance 3 minutes
  advance(3 * 60_000);
  status = coordinator.getSeatStatuses();
  seat1 = status.find((s) => s.workerId === "seat-01");
  assert.ok((seat1?.idleSinceMs ?? 0) >= 3 * 60_000);

  // Touch the session
  coordinator.touch(admitted.session.id);
  status = coordinator.getSeatStatuses();
  seat1 = status.find((s) => s.workerId === "seat-01");
  assert.ok((seat1?.idleSinceMs ?? 0) < 1000);
});

test("ready-idle seats report an idleSinceMs clock from startup that is monotonic and nonnegative", () => {
  const { coordinator, advance } = createCoordinator();

  // A fresh worker reports ready at t0 — idle clock starts at t0.
  coordinator.setWorkerReady("seat-01", true, "gen-a");
  let seat1 = coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.equal(seat1?.phase, "ready-idle");
  assert.ok((seat1?.idleSinceMs ?? -1) >= 0);
  assert.ok((seat1?.idleSinceMs ?? 1_000_000) < 1000);

  // The clock grows monotonically as wall time advances.
  advance(4 * 60_000);
  seat1 = coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.ok((seat1?.idleSinceMs ?? 0) >= 4 * 60_000);

  // Repeated health probes of the same generation must not reset the clock.
  coordinator.setWorkerReady("seat-01", true, "gen-a");
  advance(30_000);
  seat1 = coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.ok((seat1?.idleSinceMs ?? 0) >= 4 * 60_000 + 30_000);
});

test("assignment clears the idle clock and no-show recovery restarts it", () => {
  const { coordinator, advance } = createCoordinator();
  coordinator.setWorkerReady("seat-01", true, "gen-a");
  advance(3 * 60_000);

  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;

  // Assigned seats never report an idle clock (and are never scale-down candidates).
  const assigned = coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.equal(assigned?.phase, "admitted");
  assert.equal(assigned?.idleSinceMs, undefined);

  // No-show recovery returns the pristine worker to ready-idle with a fresh clock.
  advance(30_000);
  coordinator.sweep();
  const recovered = coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.equal(recovered?.phase, "ready-idle");
  assert.ok((recovered?.idleSinceMs ?? 1_000_000) < 1000);
});

test("session end with tenant state recycles without idle clock; replacement restarts it", () => {
  const { coordinator, advance } = createCoordinator();
  coordinator.setWorkerReady("seat-01", true, "gen-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;
  const assignment = coordinator.attach(admitted.session.id);
  assert.ok(assignment);
  if (!assignment) return;
  coordinator.markWorkerConnectionStarted(admitted.session.id, assignment.connectionVersion);

  // End the session: the worker recycles (no idle clock while awaiting replacement).
  coordinator.terminate(admitted.session.id, "protocol-violation");
  const recycling = coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.equal(recycling?.phase, "recycling");
  assert.equal(recycling?.idleSinceMs, undefined);

  // A replacement generation reporting healthy+unassigned restarts the clock.
  advance(60_000);
  coordinator.setWorkerReady("seat-01", true, "gen-b");
  const ready = coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.equal(ready?.phase, "ready-idle");
  assert.ok((ready?.idleSinceMs ?? 1_000_000) < 1000);
});

test("gateway restart restore preserves the ready-idle idle clock", () => {
  const first = createCoordinator();
  first.coordinator.setWorkerReady("seat-01", true, "gen-a");
  first.advance(4 * 60_000);

  // The worker remains healthy+unassigned across the gateway restart; the
  // persisted idleSince must continue (not restart at zero).
  const second = createCoordinator();
  second.coordinator.restore(first.coordinator.exportState());
  assert.equal(second.coordinator.metrics().readyWorkers, 0); // re-probe required

  // The restart happens at the same wall-clock instant the first gateway
  // observed; the persisted idleSince continues from before the restart.
  second.advance(4 * 60_000);
  second.coordinator.setWorkerReady("seat-01", true, "gen-a");
  const seat1 = second.coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.equal(seat1?.phase, "ready-idle");
  assert.ok((seat1?.idleSinceMs ?? 0) >= 4 * 60_000);
});

test("old Redis state without idleSince restores conservatively and cannot trigger immediate drain", () => {
  const first = createCoordinator();
  first.coordinator.setWorkerReady("seat-01", true, "gen-a");
  first.advance(10 * 60_000);
  const state = first.coordinator.exportState();

  // Strip the additive field to emulate pre-upgrade Redis state.
  const oldState = {
    ...state,
    workers: state.workers.map(({ idleSince, ...rest }) => rest),
  };

  const second = createCoordinator();
  second.coordinator.restore(oldState as typeof state);
  second.coordinator.setWorkerReady("seat-01", true, "gen-a");
  const seat1 = second.coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.equal(seat1?.phase, "ready-idle");
  // Conservative current-time restore: idleSinceMs is 0, so the seat is far
  // below the 5-minute scale-down threshold and cannot be drained immediately.
  assert.equal(seat1?.idleSinceMs, 0);
});

test("clock skew never produces a negative or false-positive idle clock", () => {
  const { coordinator } = createCoordinator();
  // A persisted idleSince in the future (clock moved backwards) restores to a
  // clamped current-time value, keeping idleSinceMs at zero.
  const state: ReturnType<typeof coordinator.exportState> = {
    version: 1,
    dailyBudgetDay: "2026-08-03",
    dailyReservedMicroUsd: 0,
    queue: [],
    sessions: [],
    workers: [
      { id: "seat-01", generation: "gen-a", idleSince: 1_700_000_000_000 + 3_600_000 },
      { id: "seat-02", generation: "gen-b", idleSince: 1_700_000_000_000 + 3_600_000 },
      { id: "seat-03", generation: "gen-c", idleSince: 1_700_000_000_000 + 3_600_000 },
      { id: "seat-04", generation: "gen-d", idleSince: 1_700_000_000_000 + 3_600_000 },
      { id: "seat-05", generation: "gen-e", idleSince: 1_700_000_000_000 + 3_600_000 },
      { id: "seat-06", generation: "gen-f", idleSince: 1_700_000_000_000 + 3_600_000 },
    ],
  };
  const restored = createCoordinator();
  restored.coordinator.restore(state);
  restored.coordinator.setWorkerReady("seat-01", true, "gen-a");
  const seat1 = restored.coordinator.getSeatStatuses().find((s) => s.workerId === "seat-01");
  assert.equal(seat1?.phase, "ready-idle");
  assert.ok((seat1?.idleSinceMs ?? -1) >= 0);
  assert.equal(seat1?.idleSinceMs, 0);
});

test("warm-pool plan only scales down a ready-idle seat at the exact 5-minute boundary", () => {
  const { coordinator, advance } = createCoordinator();
  // Five ready-idle seats (excess 3 over desired) and one absent.
  for (const id of ["seat-01", "seat-02", "seat-03", "seat-04", "seat-05"]) {
    coordinator.setWorkerReady(id, true, `gen-${id}`);
  }
  const warmPool = new CapacityWarmPool({
    totalSeats: 6,
    idleScaleDownMs: 5 * 60_000,
    warmSpares: 1,
  });

  const planAt = (ms: number) => {
    advance(ms);
    const seats = coordinator.getSeatStatuses().map((s) => ({
      ...s,
      drainRequested: warmPool.isDraining(s.workerId),
    }));
    return warmPool.plan(seats);
  };

  // 299999ms of idle: no candidate may be drained yet.
  const below = planAt(299_999);
  assert.equal(below.scaleDownCandidates.length, 0);

  // Exactly 300000ms: candidates appear (excess = current - desired).
  const at = planAt(1);
  assert.equal(at.scaleDownCandidates.length, 3);
  assert.ok(at.scaleDownCandidates.every((id) => id.startsWith("seat-")));

  // A drain requested before the threshold is rejected by the app.
  const early = warmPool.requestDrain(
    { workerId: "seat-01", phase: "ready-idle", generation: "gen-seat-01", drainRequested: false, idleSinceMs: 299_999 },
    "drain-early",
  );
  assert.equal(early.accepted, false);
  const eligible = warmPool.requestDrain(
    { workerId: "seat-01", phase: "ready-idle", generation: "gen-seat-01", drainRequested: false, idleSinceMs: 300_000 },
    "drain-ok",
  );
  assert.equal(eligible.accepted, true);
});

test("exportState/restore backward compatibility with existing v1 state", () => {  const { coordinator } = createCoordinator();

  coordinator.setWorkerReady("seat-01", true, "gen-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;

  const assignment = coordinator.attach(admitted.session.id);
  assert.ok(assignment);

  const state = coordinator.exportState();
  assert.equal(state.version, 1);
  assert.ok(Array.isArray(state.sessions));
  assert.ok(Array.isArray(state.workers));
  assert.ok(Array.isArray(state.queue));

  // Restore into a new coordinator with matching worker IDs
  const second = createCoordinator();
  second.coordinator.restore(state);

  // Session should be preserved
  const restoredSession = second.coordinator.status(admitted.session.id);
  assert.equal(restoredSession?.state, "active");
  assert.equal(restoredSession?.visitorId, "visitor-a");

  // Workers should be re-probed (not marked ready)
  const metrics = second.coordinator.metrics();
  assert.equal(metrics.readyWorkers, 0);
});

test("restore with mismatched worker IDs throws", () => {
  const { coordinator } = createCoordinator();

  coordinator.setWorkerReady("seat-01", true, "gen-a");
  coordinator.admit("visitor-a");
  const state = coordinator.exportState();

  // Modify worker id
  const badWorkers = state.workers.map((w) => ({
    ...w,
    id: w.id === "seat-01" ? "different-seat" : w.id,
  }));

  const second = createCoordinator();
  assert.throws(() => {
    second.coordinator.restore({ ...state, workers: badWorkers });
  }, /persisted public worker set does not match/);
});

test("warm-pool plan integration: seat statuses flow correctly from coordinator", () => {
  const { coordinator } = createCoordinator();

  // Ready 3 workers, admit 2 visitors → 2 admitted + 1 ready-idle
  coordinator.setWorkerReady("seat-01", true, "gen-a");
  coordinator.setWorkerReady("seat-02", true, "gen-b");
  coordinator.setWorkerReady("seat-03", true, "gen-c");

  const a = coordinator.admit("visitor-a");
  const b = coordinator.admit("visitor-b");
  assert.equal(a.accepted && b.accepted, true);
  if (!a.accepted || !b.accepted) return;

  const seatStatuses = coordinator.getSeatStatuses();
  const warmPool = new CapacityWarmPool({
    totalSeats: 6,
    idleScaleDownMs: 5 * 60_000,
    warmSpares: 1,
  });

  const seatsWithDrain = seatStatuses.map((s) => ({
    ...s,
    drainRequested: warmPool.isDraining(s.workerId),
  }));
  const plan = warmPool.plan(seatsWithDrain);

  // protected: seat-01(admitted), seat-02(admitted)
  // absent: seat-04, seat-05, seat-06 = 3
  // ready-idle: seat-03 (counts as running)
  // desired = min(6, 2+3+1) = 6, current = 3
  // No scale-down needed (already below desired)
  assert.equal(plan.desiredRunning, 6);
  assert.equal(plan.scaleDownCandidates.length, 0);
});

test("recycling phase reflects ended sessions awaiting replacement", () => {
  const { coordinator } = createCoordinator();

  coordinator.setWorkerReady("seat-01", true, "gen-a");
  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;

  const assignment = coordinator.attach(admitted.session.id);
  assert.ok(assignment);

  // Worker connection started — on end, worker becomes recycling
  coordinator.markWorkerConnectionStarted(admitted.session.id, assignment!.connectionVersion);
  coordinator.terminate(admitted.session.id, "protocol-violation");

  const statuses = coordinator.getSeatStatuses();
  const seat1 = statuses.find((s) => s.workerId === "seat-01");
  assert.equal(seat1?.phase, "recycling");
});

test("a drain pins only its own seat and never disturbs an independent active session", () => {
  const { coordinator, warmPool, advance } = createHarness();

  coordinator.setWorkerReady("seat-01", true, "gen-a");
  coordinator.setWorkerReady("seat-02", true, "gen-b");

  const admitted = coordinator.admit("visitor-a");
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) return;

  const assignment = coordinator.attach(admitted.session.id);
  assert.ok(assignment);
  assert.equal(assignment?.workerId, "seat-01");

  // seat-02 is ready-idle; idle it long enough, then drain it atomically
  // (warm-pool drain + coordinator fence applied together).
  advance(400_000);
  const drain = drainSeat(coordinator, warmPool, "seat-02", "drain-1", "gen-b");
  assert.equal(drain.accepted, true);

  // seat-02 is pinned out of the pool, while seat-01's active session is
  // completely unaffected.
  assert.equal(coordinator.status(admitted.session.id)?.state, "active");
  assert.equal(coordinator.getSeatStatuses().find((s) => s.workerId === "seat-02")?.phase, "draining");
  assert.ok(warmPool.isDraining("seat-02"));
  assert.equal(coordinator.isWorkerDrainIneligible("seat-02"), true);
});
