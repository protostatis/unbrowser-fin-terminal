/**
 * Tests for CapacityWarmPool — admission-vs-drain race, sticky drain,
 * desired plan math, 5-minute idle eligibility, one warm spare.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  CapacityWarmPool,
  type SeatStatus,
  type WarmPoolState,
} from "../server/capacity-warm-pool.js";

function seats(overrides: Partial<SeatStatus>[]): SeatStatus[] {
  return overrides.map((partial, index) => ({
    workerId: partial.workerId ?? `seat-${index + 1}`,
    phase: "absent",
    drainRequested: false,
    ...partial,
  }));
}

function createPool(totalSeats = 6, idleScaleDownMs = 5 * 60_000) {
  const pool = new CapacityWarmPool({
    totalSeats,
    idleScaleDownMs,
    warmSpares: 1,
    now: () => 1_700_000_000_000,
  });
  return pool;
}

test("desired running = min(6, protected + queued + 1) with starting seats counted", () => {
  const pool = createPool(6);

  // 3 protected (active/admitted/starting), 0 absent, 1 warm spare
  const s = seats([
    { workerId: "s1", phase: "active", generation: "g1" },
    { workerId: "s2", phase: "admitted", generation: "g2" },
    { workerId: "s3", phase: "starting", generation: "g3" },
    { workerId: "s4", phase: "absent" },
    { workerId: "s5", phase: "absent" },
    { workerId: "s6", phase: "absent" },
  ]);

  // protected = 3 (active, admitted, starting), absent = 3, warmSpares = 1
  // desired = min(6, 3 + 3 + 1) = 6
  const plan = pool.plan(s);
  assert.equal(plan.desiredRunning, 6);
});

test("desired running caps at total seats", () => {
  const pool = createPool(6);
  const s = seats([
    { workerId: "s1", phase: "active", generation: "g1" },
    { workerId: "s2", phase: "active", generation: "g2" },
    { workerId: "s3", phase: "admitted", generation: "g3" },
    { workerId: "s4", phase: "starting", generation: "g4" },
    { workerId: "s5", phase: "ready-idle", generation: "g5", idleSinceMs: 0 },
    { workerId: "s6", phase: "ready-idle", generation: "g6", idleSinceMs: 0 },
  ]);
  // protected = 4, absent = 0, warmSpares = 1 → desired = min(6, 4+0+1) = 5
  // current = 4 + 2 = 6, excess = 1
  const plan = pool.plan(s);
  assert.equal(plan.desiredRunning, 5);
  assert.equal(plan.scaleDownCandidates.length, 0); // none idle long enough
});

test("excess ready-idle seats become scale-down candidates after 5 idle minutes", () => {
  const pool = createPool(6);

  // 0 protected, 3 ready-idle, 3 absent
  // protected = 0, absent = 3, warmSpares = 1
  // desired = min(6, 0+3+1) = 4, current = 3
  // No excess here. We need more ready-idle than desired for excess.

  // Scenario: 0 protected, 5 ready-idle, 1 absent
  // protected = 0, absent = 1, warmSpares = 1
  // desired = min(6, 0+1+1) = 2, current = 5, excess = 3
  const s = seats([
    { workerId: "s1", phase: "ready-idle", generation: "g1", idleSinceMs: 500_000 },
    { workerId: "s2", phase: "ready-idle", generation: "g2", idleSinceMs: 400_000 },
    { workerId: "s3", phase: "ready-idle", generation: "g3", idleSinceMs: 350_000 },
    { workerId: "s4", phase: "ready-idle", generation: "g4", idleSinceMs: 200_000 },
    { workerId: "s5", phase: "ready-idle", generation: "g5", idleSinceMs: 100_000 },
    { workerId: "s6", phase: "absent" },
  ]);

  const plan = pool.plan(s);
  assert.equal(plan.desiredRunning, 2);
  // excess = 3, but only s1, s2, s3 exceed 5 minutes
  assert.equal(plan.scaleDownCandidates.length, 3);
  assert.ok(plan.scaleDownCandidates.includes("s1"));
  assert.ok(plan.scaleDownCandidates.includes("s2"));
  assert.ok(plan.scaleDownCandidates.includes("s3"));
  assert.ok(!plan.scaleDownCandidates.includes("s4")); // only 200s idle
});

test("never drain protected seats (active, admitted, starting, disconnected, recycling)", () => {
  const pool = createPool(6);

  // Try to drain various protected phases
  const phases = ["active", "admitted", "starting", "disconnected", "recycling"] as const;
  for (const phase of phases) {
    const result = pool.requestDrain(
      { workerId: `seat-${phase}`, phase, generation: "g1", drainRequested: false },
      "drain-1",
    );
    assert.equal(result.accepted, false);
    assert.ok((result as { reason: string }).reason.includes("protected"));
  }
});

test("drain only accepted for ready-idle seats", () => {
  const pool = createPool(6);
  const result = pool.requestDrain(
    { workerId: "s6", phase: "ready-idle", generation: "g1", drainRequested: false, idleSinceMs: 400_000 },
    "drain-1",
  );
  assert.equal(result.accepted, true);
  assert.equal((result as { drainId: string }).drainId, "drain-1");
  assert.ok(pool.isDraining("s6"));
});

test("five-minute eligibility is exact: drain rejected at 299999ms, accepted at 300000ms", () => {
  const pool = createPool(6, 5 * 60_000);
  const before = pool.requestDrain(
    { workerId: "s1", phase: "ready-idle", generation: "g1", drainRequested: false, idleSinceMs: 299_999 },
    "drain-before",
  );
  assert.equal(before.accepted, false);
  assert.ok((before as { reason: string }).reason.includes("not idle long enough"));

  const at = pool.requestDrain(
    { workerId: "s1", phase: "ready-idle", generation: "g1", drainRequested: false, idleSinceMs: 300_000 },
    "drain-at",
  );
  assert.equal(at.accepted, true);
});

test("a ready-idle seat with no tracked idle clock cannot be drained", () => {
  const pool = createPool(6, 5 * 60_000);
  const result = pool.requestDrain(
    { workerId: "s1", phase: "ready-idle", generation: "g1", drainRequested: false },
    "drain-unknown-idle",
  );
  // An unknown idle clock is treated as zero (conservative current-time from
  // old Redis state) — never eligible for immediate drain.
  assert.equal(result.accepted, false);
  assert.ok((result as { reason: string }).reason.includes("not idle long enough"));
});

test("scale-down candidates require the exact five-minute idle threshold", () => {
  const pool = createPool(6);
  // 0 protected, 5 ready-idle, 1 absent → desired 2, current 5, excess 3.
  const below = seats([
    { workerId: "s1", phase: "ready-idle", generation: "g1", idleSinceMs: 299_999 },
    { workerId: "s2", phase: "ready-idle", generation: "g2", idleSinceMs: 299_999 },
    { workerId: "s3", phase: "ready-idle", generation: "g3", idleSinceMs: 299_999 },
    { workerId: "s4", phase: "ready-idle", generation: "g4", idleSinceMs: 299_999 },
    { workerId: "s5", phase: "ready-idle", generation: "g5", idleSinceMs: 299_999 },
    { workerId: "s6", phase: "absent" },
  ]);
  const belowPlan = pool.plan(below);
  assert.equal(belowPlan.scaleDownCandidates.length, 0);

  const at = seats([
    { workerId: "s1", phase: "ready-idle", generation: "g1", idleSinceMs: 300_000 },
    { workerId: "s2", phase: "ready-idle", generation: "g2", idleSinceMs: 300_000 },
    { workerId: "s3", phase: "ready-idle", generation: "g3", idleSinceMs: 300_000 },
    { workerId: "s4", phase: "ready-idle", generation: "g4", idleSinceMs: 300_000 },
    { workerId: "s5", phase: "ready-idle", generation: "g5", idleSinceMs: 300_000 },
    { workerId: "s6", phase: "absent" },
  ]);
  const atPlan = pool.plan(at);
  assert.equal(atPlan.scaleDownCandidates.length, 3);
});

test("drain is idempotent with same drainId and generation", () => {
  const pool = createPool(6);
  const first = pool.requestDrain(
    { workerId: "s1", phase: "ready-idle", generation: "g1", drainRequested: false, idleSinceMs: 400_000 },
    "drain-1",
  );
  assert.equal(first.accepted, true);

  const second = pool.requestDrain(
    { workerId: "s1", phase: "ready-idle", generation: "g1", drainRequested: false, idleSinceMs: 400_000 },
    "drain-1",
  );
  assert.equal(second.accepted, true);
  assert.equal((second as { drainId: string }).drainId, "drain-1");
});

test("drain rejects with different drainId (CAS conflict)", () => {
  const pool = createPool(6);
  const first = pool.requestDrain(
    { workerId: "s1", phase: "ready-idle", generation: "g1", drainRequested: false, idleSinceMs: 400_000 },
    "drain-1",
  );
  assert.equal(first.accepted, true);

  const second = pool.requestDrain(
    { workerId: "s1", phase: "ready-idle", generation: "g1", drainRequested: false, idleSinceMs: 400_000 },
    "drain-2",
  );
  assert.equal(second.accepted, false);
});

test("drain is sticky — release fails while generation is unchanged", () => {
  const pool = createPool(6);
  pool.requestDrain(
    { workerId: "s1", phase: "ready-idle", generation: "g1", drainRequested: false, idleSinceMs: 400_000 },
    "drain-1",
  );
  assert.ok(pool.isDraining("s1"));

  const release = pool.releaseDrain("s1", "g1");
  assert.equal(release.released, false);
  assert.equal((release as { reason: string }).reason, "generation unchanged; drain is sticky");

  // Force release works regardless
  pool.forceReleaseDrain("s1");
  assert.ok(!pool.isDraining("s1"));
});

test("drain releases when generation changes", () => {
  const pool = createPool(6);
  pool.requestDrain(
    { workerId: "s1", phase: "ready-idle", generation: "g1", drainRequested: false, idleSinceMs: 400_000 },
    "drain-1",
  );
  const release = pool.releaseDrain("s1", "g2");
  assert.equal(release.released, true);
  assert.ok(!pool.isDraining("s1"));
});

test("persistence round-trips drain state", () => {
  const pool = createPool(6);
  pool.requestDrain(
    { workerId: "s1", phase: "ready-idle", generation: "g1", drainRequested: false, idleSinceMs: 400_000 },
    "drain-1",
  );

  const state = pool.exportState();
  assert.equal(state.version, 1);
  assert.equal(state.drains.length, 1);
  assert.equal(state.drains[0].workerId, "s1");

  const restored = createPool(6);
  restored.restore(state);
  assert.ok(restored.isDraining("s1"));
  assert.equal(restored.getDrain("s1")?.drainId, "drain-1");
});

test("activate candidates suggest releasing drains with new generations", () => {
  const pool = createPool(6);
  pool.requestDrain(
    { workerId: "s3", phase: "ready-idle", generation: "g-old", drainRequested: false, idleSinceMs: 400_000 },
    "drain-1",
  );

  // The seat now has a new generation but is still draining
  const s = seats([
    { workerId: "s1", phase: "active", generation: "g1", idleSinceMs: 1000 },
    { workerId: "s2", phase: "ready-idle", generation: "g2", idleSinceMs: 1000 },
    { workerId: "s3", phase: "ready-idle", generation: "g-new", drainRequested: true, drainId: "drain-1" },
    { workerId: "s4", phase: "absent" },
    { workerId: "s5", phase: "absent" },
    { workerId: "s6", phase: "absent" },
  ]);

  const plan = pool.plan(s);
  assert.ok(plan.activateCandidates.includes("s3"));
});

test("never returns an activate candidate whose sticky-generation activation would reject it", () => {
  const pool = createPool(6);
  pool.requestDrain(
    { workerId: "s3", phase: "ready-idle", generation: "g-same", drainRequested: false, idleSinceMs: 400_000 },
    "drain-same",
  );

  // The seat is draining with an UNCHANGED generation. The activate endpoint
  // would reject this as "drain sticky; generation unchanged", so the plan
  // must not propose it — even when the plan is short of desired capacity.
  const s = seats([
    { workerId: "s1", phase: "active", generation: "g1", idleSinceMs: 1000 },
    { workerId: "s2", phase: "active", generation: "g2", idleSinceMs: 1000 },
    { workerId: "s3", phase: "ready-idle", generation: "g-same", drainRequested: true, drainId: "drain-same" },
    { workerId: "s4", phase: "absent" },
    { workerId: "s5", phase: "absent" },
    { workerId: "s6", phase: "absent" },
  ]);

  const plan = pool.plan(s);
  assert.ok(!plan.activateCandidates.includes("s3"), "same-generation draining seat must not be an activate candidate");
  assert.equal(plan.activateCandidates.length, 0);
});

test("one warm spare: desired = protected + absent + 1", () => {
  const pool = createPool(6);
  // 2 assigned + 1 warm spare from absent
  const s = seats([
    { workerId: "s1", phase: "active", generation: "g1" },
    { workerId: "s2", phase: "admitted", generation: "g2" },
    { workerId: "s3", phase: "absent" },
    { workerId: "s4", phase: "absent" },
    { workerId: "s5", phase: "absent" },
    { workerId: "s6", phase: "absent" },
  ]);

  const plan = pool.plan(s);
  // protected = 2, absent = 4, warmSpares = 1 → desired = min(6, 2+4+1) = 6
  assert.equal(plan.desiredRunning, 6);
});

test("0 assigned → desired = min(6, 0+6+1) = 6 (all can run)", () => {
  const pool = createPool(6);
  const s = seats(Array.from({ length: 6 }, (_, i) => ({
    workerId: `s${i + 1}`,
    phase: "absent" as const,
  })));
  const plan = pool.plan(s);
  assert.equal(plan.desiredRunning, 6);
});

test("disconnected seats are protected and count toward running", () => {
  const pool = createPool(6);
  const s = seats([
    { workerId: "s1", phase: "disconnected", generation: "g1" },
    { workerId: "s2", phase: "absent" },
    { workerId: "s3", phase: "absent" },
    { workerId: "s4", phase: "absent" },
    { workerId: "s5", phase: "absent" },
    { workerId: "s6", phase: "absent" },
  ]);
  const plan = pool.plan(s);
  // protected = 1, absent = 5, warmSpares = 1 → desired = min(6, 1+5+1) = 6
  assert.equal(plan.desiredRunning, 6);
});

test("recycling seats are protected and count toward running", () => {
  const pool = createPool(6);
  const s = seats([
    { workerId: "s1", phase: "recycling", generation: "g1" },
    { workerId: "s2", phase: "absent" },
    { workerId: "s3", phase: "absent" },
    { workerId: "s4", phase: "absent" },
    { workerId: "s5", phase: "absent" },
    { workerId: "s6", phase: "absent" },
  ]);
  const plan = pool.plan(s);
  assert.equal(plan.desiredRunning, 6);
});

test("drained ready-idle seat does not count toward running", () => {
  const pool = createPool(6);
  pool.requestDrain(
    { workerId: "s3", phase: "ready-idle", generation: "g3", drainRequested: false, idleSinceMs: 400_000 },
    "drain-1",
  );

  // After drain, s3 is in ready-idle phase but drainRequested=true
  const s = seats([
    { workerId: "s1", phase: "active", generation: "g1" },
    { workerId: "s2", phase: "active", generation: "g2" },
    { workerId: "s3", phase: "ready-idle", generation: "g3", drainRequested: true, idleSinceMs: 400_000 },
    { workerId: "s4", phase: "absent" },
    { workerId: "s5", phase: "absent" },
    { workerId: "s6", phase: "absent" },
  ]);

  const plan = pool.plan(s);
  // protected = 2, s3 is draining(not counted), absent = 3, warmSpares = 1
  // desired = min(6, 2+3+1) = 6
  assert.equal(plan.desiredRunning, 6);
});

test("invalid warm-pool state version throws on restore", () => {
  const pool = createPool(6);
  assert.throws(() => {
    pool.restore({ version: 2 as unknown as 1, drains: [] });
  }, /unsupported warm-pool state version/);
});

test("invalid drain entry in state throws on restore", () => {
  const pool = createPool(6);
  assert.throws(() => {
    pool.restore({
      version: 1,
      drains: [{ workerId: "s1", drainId: "x", generation: "g", requestedAt: "not-a-number" } as unknown as WarmPoolState["drains"][0]],
    });
  }, /invalid drain entry/);
});
