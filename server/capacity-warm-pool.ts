/**
 * Application-side warm-pool capacity manager for the 6 public terminal seats.
 *
 * Policy:
 *   - Six static logical worker IDs/endpoints remain configured.
 *   - Keep one ready idle worker whenever assigned capacity is below six.
 *   - Desired running = min(6, protected assigned + effective queued + 1),
 *     counting STARTING seats.
 *   - Excess READY_IDLE workers become scale-down candidates after 5 continuous
 *     idle minutes.
 *   - Never drain admitted, active, disconnected/reconnect-grace, assigned,
 *     starting, or recycling workers.
 *   - Drain must be atomic, generation-checked, persisted before success,
 *     sticky until explicit activation, and immediately remove assignment
 *     eligibility.
 *
 * The warm pool owns the drain lifecycle; the coordinator owns assignment. The
 * management API applies BOTH halves in one serialized mutation — this pool's
 * drain flag plus the coordinator's ineligibility fence (see
 * `PublicSessionCoordinator.setWorkerDrainIneligible`) — so an accepted drain
 * can never be assigned by `pump()`, and an activation clears both halves.
 *
 * Docker authority stays host-side. This module only computes desired state
 * and manages drain flags — never touches containers.
 */

/** The lifecycle phase of a logical seat. */
export type SeatPhase =
  | "absent"           // No health probe has confirmed a running process.
  | "starting"         // Process reported ready but generation is still changing.
  | "ready-idle"       // Process is healthy and unassigned.
  | "assigned"         // A visitor ticket is bound to this seat.
  | "admitted"         // Ticket admitted, no browser has connected yet.
  | "active"           // Browser connected, session in progress.
  | "disconnected"     // Browser disconnected, within reconnect grace.
  | "draining"         // Explicitly drained by operator; not assignable.
  | "recycling"        // Process was terminated, awaiting replacement.
  ;

/** Snapshot of a single seat's current state from the coordinator's perspective. */
export interface SeatStatus {
  workerId: string;
  phase: SeatPhase;
  generation?: string;
  sessionId?: string;
  idleSinceMs?: number;   // ms since this seat last had meaningful activity
  drainRequested: boolean;
  drainId?: string;        // idempotency key for the drain operation
  drainSinceMs?: number;   // ms since drain was first requested
  /** Generation that was observed when drain was requested (CAS guard). */
  drainGeneration?: string;
}

export interface WarmPoolConfig {
  /** Total number of logical seats (fixed at 6). */
  totalSeats: number;
  /** How long a seat must be continuously READY_IDLE before scale-down (ms). */
  idleScaleDownMs: number;
  /** Minimum number of warm (ready-idle) spares when not at capacity. */
  warmSpares: number;
  now?: () => number;
}

export interface WarmPoolPlan {
  /** Total running count (starting + ready-idle + assigned + admitted + active + disconnected). */
  desiredRunning: number;
  /** Seats that should be scaled down. */
  scaleDownCandidates: string[];
  /** Seats that should be activated (released from drain). */
  activateCandidates: string[];
}

export interface WarmPoolState {
  version: 1;
  drains: Array<{
    workerId: string;
    drainId: string;
    generation: string;
    requestedAt: number;
  }>;
}

/**
 * Pure-logic capacity planner. It receives per-seat snapshots from the
 * coordinator and returns a plan. Persistence and drain lifecycle are also
 * managed here via export/restore.
 */
export class CapacityWarmPool {
  private readonly drains = new Map<string, { drainId: string; generation: string; requestedAt: number }>();
  private readonly now: () => number;

  constructor(private readonly config: WarmPoolConfig) {
    this.now = config.now ?? Date.now;
  }

  // ── Plan computation ───────────────────────────────────────────────────

  /**
   * Given current seat statuses, compute the desired running count and which
   * seats should be scaled down.
   */
  plan(seats: SeatStatus[]): WarmPoolPlan {
    // Count truly protected seats (cannot be drained).
    let protectedRunning = 0;
    let readyIdleCount = 0;
    const readyIdleSeats: SeatStatus[] = [];
    const drainingSeats: SeatStatus[] = [];

    for (const seat of seats) {
      switch (seat.phase) {
        case "starting":
        case "assigned":
        case "admitted":
        case "active":
        case "disconnected":
        case "recycling":
          protectedRunning += 1;
          break;
        case "ready-idle":
          if (seat.drainRequested) {
            drainingSeats.push(seat);
          } else {
            readyIdleCount += 1;
            readyIdleSeats.push(seat);
          }
          break;
        case "draining":
          // Already draining; does not count toward running.
          drainingSeats.push(seat);
          break;
        case "absent":
          // Not running at all.
          break;
      }
    }

    // Effective queued: seats that could become assigned (absent + draining).
    const absentCount = seats.filter((s) => s.phase === "absent").length;

    // desiredRunning = protected + effectiveQueued + warmSpares
    // (ready-idle seats are NOT pre-counted; they are the surplus we may scale down)
    const desiredRunning = Math.min(
      this.config.totalSeats,
      protectedRunning + absentCount + this.config.warmSpares,
    );

    const now = this.now();
    const scaleDownCandidates: string[] = [];

    // Sort ready-idle by idle duration (longest first).
    const sortedIdle = [...readyIdleSeats].sort(
      (a, b) => (b.idleSinceMs ?? 0) - (a.idleSinceMs ?? 0),
    );

    // Current running = protected + ready-idle (non-draining)
    const currentRunning = protectedRunning + readyIdleCount;

    // If we have more running than desired, idle the longest-idle seats
    // that have exceeded the scale-down threshold.
    const excess = currentRunning - desiredRunning;
    if (excess > 0) {
      for (const seat of sortedIdle) {
        if (scaleDownCandidates.length >= excess) break;
        if ((seat.idleSinceMs ?? 0) >= this.config.idleScaleDownMs) {
          scaleDownCandidates.push(seat.workerId);
        }
      }
    }

    // Activate candidates: seats that are draining whose process generation
    // has changed since the drain was requested (the operator replaced the
    // container). This is the ONLY activate source: a same-generation
    // draining seat would be rejected by the sticky-generation activation
    // endpoint, so returning it as an activate candidate would make the plan
    // and the activation contract disagree.
    const activateCandidates: string[] = [];
    for (const seat of drainingSeats) {
      if (seat.drainRequested && seat.drainId) {
        const drain = this.drains.get(seat.workerId);
        if (drain && seat.generation && seat.generation !== drain.generation) {
          activateCandidates.push(seat.workerId);
        }
      }
    }

    return { desiredRunning, scaleDownCandidates, activateCandidates };
  }

  // ── Drain management ───────────────────────────────────────────────────

  /**
   * Request a drain for a seat. Returns the drain id if successful.
   * Fails if the seat is in a protected phase.
   */
  requestDrain(
    seat: SeatStatus,
    drainId: string,
  ): { accepted: true; drainId: string } | { accepted: false; reason: string } {
    switch (seat.phase) {
      case "absent":
      case "draining":
        return { accepted: false, reason: `cannot drain seat in ${seat.phase} phase` };
      case "starting":
      case "assigned":
      case "admitted":
      case "active":
      case "disconnected":
      case "recycling":
        return { accepted: false, reason: `seat ${seat.workerId} is protected (${seat.phase})` };
      case "ready-idle":
        break; // drainable
    }

    if (!seat.generation) {
      return { accepted: false, reason: "cannot drain seat with unknown generation" };
    }

    const existing = this.drains.get(seat.workerId);
    if (existing) {
      // Idempotent: same drainId and generation → already done.
      if (existing.drainId === drainId && existing.generation === seat.generation) {
        return { accepted: true, drainId };
      }
      // Different drainId or generation → conflict.
      return { accepted: false, reason: "seat is already draining with a different drain-id" };
    }

    // Five-minute eligibility is exact: a ready-idle seat may only be drained
    // after it has been continuously idle for the configured scale-down
    // threshold. A seat without a tracked idle clock (e.g. restored from old
    // Redis state before the idleSince field existed) reports zero idle time
    // and cannot be drained until the coordinator stamps a fresh idleSince.
    if ((seat.idleSinceMs ?? 0) < this.config.idleScaleDownMs) {
      return { accepted: false, reason: `seat ${seat.workerId} is not idle long enough for scale-down` };
    }

    this.drains.set(seat.workerId, {
      drainId,
      generation: seat.generation,
      requestedAt: this.now(),
    });

    return { accepted: true, drainId };
  }

  /**
   * Release a drain, allowing the seat to be assignable again.
   * Fails if the seat's generation hasn't changed (sticky drain).
   */
  releaseDrain(
    workerId: string,
    currentGeneration?: string,
  ): { released: true } | { released: false; reason: string } {
    const drain = this.drains.get(workerId);
    if (!drain) {
      return { released: false, reason: "seat is not draining" };
    }

    // Drain is sticky: only release if the generation has changed
    // (indicating the process was replaced) or if explicitly activated.
    if (currentGeneration && currentGeneration === drain.generation) {
      return { released: false, reason: "generation unchanged; drain is sticky" };
    }

    this.drains.delete(workerId);
    return { released: true };
  }

  /**
   * Force-release a drain regardless of generation (explicit activation).
   */
  forceReleaseDrain(workerId: string): void {
    this.drains.delete(workerId);
  }

  /** Check if a seat is currently draining. */
  isDraining(workerId: string): boolean {
    return this.drains.has(workerId);
  }

  /** Get drain info for a seat. */
  getDrain(workerId: string): { drainId: string; generation: string; requestedAt: number } | undefined {
    return this.drains.get(workerId);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  exportState(): WarmPoolState {
    return {
      version: 1,
      drains: [...this.drains.entries()].map(([workerId, drain]) => ({
        workerId,
        drainId: drain.drainId,
        generation: drain.generation,
        requestedAt: drain.requestedAt,
      })),
    };
  }

  restore(state: WarmPoolState): void {
    if (state.version !== 1) throw new Error("unsupported warm-pool state version");
    this.drains.clear();
    for (const d of state.drains) {
      if (
        typeof d.workerId !== "string" ||
        typeof d.drainId !== "string" ||
        typeof d.generation !== "string" ||
        !Number.isFinite(d.requestedAt)
      ) {
        throw new Error("invalid drain entry in warm-pool state");
      }
      this.drains.set(d.workerId, {
        drainId: d.drainId,
        generation: d.generation,
        requestedAt: d.requestedAt,
      });
    }
  }
}
