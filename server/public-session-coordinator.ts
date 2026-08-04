/**
 * In-memory admission state machine for the public live-terminal gateway.
 *
 * Redis persistence is supplied by the deployment adapter; keeping the state
 * machine dependency-free makes its queue, lease, and budget invariants easy
 * to test. A worker is never returned to the available pool until its fresh
 * replacement reports ready.
 */

export type PublicSessionState = "queued" | "admitted" | "active" | "ended";

export type PublicSessionEndReason =
  | "ticket-expired"
  | "no-show"
  | "idle-timeout"
  | "absolute-timeout"
  | "disconnect-timeout"
  | "worker-unavailable"
  | "rate-limited"
  | "protocol-violation"
  | "daily-budget-exhausted";

export interface PublicSessionSnapshot {
  id: string;
  visitorId: string;
  state: PublicSessionState;
  queuePosition?: number;
  workerId?: string;
  ticketExpiresAt: number;
  sessionExpiresAt?: number;
  idleExpiresAt?: number;
  researchRunsRemaining: number;
  endReason?: PublicSessionEndReason;
}

export interface PublicWorkerAssignment {
  id: string;
  visitorId: string;
  workerId: string;
  workerGeneration: string;
  connectionVersion: number;
  previousConnectionVersion?: number;
  sessionExpiresAt: number;
  idleExpiresAt: number;
  researchRunsRemaining: number;
}

export interface PublicSessionCoordinatorOptions {
  workerIds: readonly string[];
  maxQueue: number;
  ticketTtlMs: number;
  reconnectGraceMs: number;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  maxResearchRuns: number;
  dailyBudgetMicroUsd: number;
  researchRunReservationMicroUsd: number;
  now?: () => number;
  createId?: () => string;
  onSessionEnded?: (session: PublicSessionSnapshot, reason: PublicSessionEndReason) => void;
}

/** Serializable state for the single active public gateway lease. */
export interface PublicSessionCoordinatorState {
  version: 1;
  dailyBudgetDay: string;
  dailyReservedMicroUsd: number;
  queue: string[];
  sessions: Array<{
    id: string;
    visitorId: string;
    state: PublicSessionState;
    createdAt: number;
    ticketExpiresAt: number;
    workerId?: string;
    workerGeneration?: string;
    assignedAt?: number;
    startedAt?: number;
    lastActivityAt?: number;
    disconnectedAt?: number;
    connectionVersion: number;
    nextConnectionVersion?: number;
    pendingConnectionVersion?: number;
    pendingConnectionReservedAt?: number;
    connectionAttempts?: number;
    workerConnectionStarted?: boolean;
    researchRuns: number;
    researchReservedMicroUsd: number;
    endedAt?: number;
    endReason?: PublicSessionEndReason;
  }>;
  workers: Array<{
    id: string;
    sessionId?: string;
    generation?: string;
    replacementOfGeneration?: string;
    requiresUnavailable?: boolean;
    quarantinedGeneration?: string;
    unavailableAfterQuarantine?: boolean;
    /** Epoch ms when the slot last became healthy + unassigned (ready-idle). */
    idleSince?: number;
  }>;
}

export type AdmissionResult =
  | { accepted: true; session: PublicSessionSnapshot }
  | { accepted: false; reason: "queue-full" };

export type ResearchAuthorization =
  | { allowed: true; remaining: number }
  | { allowed: false; reason: "session-unavailable" | "research-limit-reached" };

type Session = {
  id: string;
  visitorId: string;
  state: PublicSessionState;
  createdAt: number;
  ticketExpiresAt: number;
  workerId?: string;
  workerGeneration?: string;
  assignedAt?: number;
  startedAt?: number;
  lastActivityAt?: number;
  disconnectedAt?: number;
  connectionVersion: number;
  nextConnectionVersion: number;
  pendingConnectionVersion?: number;
  pendingConnectionReservedAt?: number;
  connectionAttempts: number;
  workerConnectionStarted: boolean;
  researchRuns: number;
  researchReservedMicroUsd: number;
  endedAt?: number;
  endReason?: PublicSessionEndReason;
};

type WorkerSlot = {
  id: string;
  ready: boolean;
  sessionId?: string;
  generation?: string;
  replacementOfGeneration?: string;
  requiresUnavailable: boolean;
  quarantinedGeneration?: string;
  unavailableAfterQuarantine: boolean;
  probeEpoch: number;
  /** Epoch ms when the slot last became healthy + unassigned (ready-idle). */
  idleSince?: number;
};

const NOOP = () => {};
export const PUBLIC_ENDED_SESSION_RETENTION_MS = 2 * 60_000;
export const PUBLIC_MAX_CONNECTION_ATTEMPTS = 32;
const MAX_ENDED_SESSION_TOMBSTONES = 1_000;

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Serializes public admission decisions. Callers must persist the same state
 * transitions in Redis before horizontally scaling the gateway.
 */
export class PublicSessionCoordinator {
  private readonly workers = new Map<string, WorkerSlot>();
  private readonly sessions = new Map<string, Session>();
  private readonly visitorSessions = new Map<string, string>();
  private readonly queue: string[] = [];
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly onSessionEnded: NonNullable<PublicSessionCoordinatorOptions["onSessionEnded"]>;
  private dailyBudgetDay: string;
  private dailyReservedMicroUsd = 0;

  constructor(private readonly options: PublicSessionCoordinatorOptions) {
    if (options.workerIds.length === 0) throw new Error("at least one public worker is required");
    if (new Set(options.workerIds).size !== options.workerIds.length) {
      throw new Error("public worker ids must be unique");
    }
    assertPositiveInteger("maxQueue", options.maxQueue);
    assertPositiveInteger("ticketTtlMs", options.ticketTtlMs);
    assertPositiveInteger("reconnectGraceMs", options.reconnectGraceMs);
    assertPositiveInteger("idleTimeoutMs", options.idleTimeoutMs);
    assertPositiveInteger("absoluteTimeoutMs", options.absoluteTimeoutMs);
    assertPositiveInteger("maxResearchRuns", options.maxResearchRuns);
    assertPositiveInteger("dailyBudgetMicroUsd", options.dailyBudgetMicroUsd);
    assertPositiveInteger("researchRunReservationMicroUsd", options.researchRunReservationMicroUsd);

    for (const id of options.workerIds) {
      this.workers.set(id, {
        id,
        ready: false,
        requiresUnavailable: false,
        unavailableAfterQuarantine: false,
        probeEpoch: 0,
      });
    }
    this.now = options.now ?? Date.now;
    let sequence = 0;
    this.createId = options.createId ?? (() => `public-${this.now().toString(36)}-${(++sequence).toString(36)}`);
    this.onSessionEnded = options.onSessionEnded ?? NOOP;
    this.dailyBudgetDay = utcDay(this.now());
  }

  /** Enqueue a verified visitor or return their existing unexpired ticket. */
  admit(visitorId: string): AdmissionResult {
    this.sweep();
    const existingId = this.visitorSessions.get(visitorId);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing && existing.state !== "ended") {
        return { accepted: true, session: this.snapshot(existing) };
      }
      this.visitorSessions.delete(visitorId);
    }

    if (this.queue.length >= this.options.maxQueue) return { accepted: false, reason: "queue-full" };

    const now = this.now();
    const session: Session = {
      id: this.createId(),
      visitorId,
      state: "queued",
      createdAt: now,
      ticketExpiresAt: now + this.options.ticketTtlMs,
      connectionVersion: 0,
      nextConnectionVersion: 0,
      connectionAttempts: 0,
      workerConnectionStarted: false,
      researchRuns: 0,
      researchReservedMicroUsd: 0,
    };
    this.sessions.set(session.id, session);
    this.visitorSessions.set(visitorId, session.id);
    this.queue.push(session.id);
    this.pump();
    return { accepted: true, session: this.snapshot(session) };
  }

  /** Report a worker's lifecycle health. Only an idle ready worker can be assigned. */
  setWorkerReady(
    workerId: string,
    ready: boolean,
    generation?: string,
    probeEpoch?: number,
  ): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`unknown public worker "${workerId}"`);
    if (probeEpoch !== undefined && probeEpoch !== worker.probeEpoch) return false;
    this.bumpWorkerProbeEpoch(worker);
    if (worker.requiresUnavailable) {
      worker.ready = false;
      worker.idleSince = undefined;
      if (!ready || !generation) {
        if (worker.quarantinedGeneration) worker.unavailableAfterQuarantine = true;
        this.pump();
        return true;
      }
      if (!worker.quarantinedGeneration) {
        // The generation accepted by a missing-header handshake is unknowable.
        // Quarantine the first subsequently observed process, then require it
        // to become unavailable before a different generation can enter.
        worker.quarantinedGeneration = generation;
        worker.unavailableAfterQuarantine = false;
        this.pump();
        return true;
      }
      if (
        !worker.unavailableAfterQuarantine
        || generation === worker.quarantinedGeneration
      ) {
        this.pump();
        return true;
      }
      worker.requiresUnavailable = false;
      worker.quarantinedGeneration = undefined;
      worker.unavailableAfterQuarantine = false;
    }
    if (!ready || !generation) {
      worker.ready = false;
      worker.idleSince = undefined;
      if (worker.sessionId) {
        const session = this.sessions.get(worker.sessionId);
        if (session && session.state !== "ended") this.end(session, "worker-unavailable");
      }
    } else if (worker.sessionId) {
      const session = this.sessions.get(worker.sessionId);
      if (!session || session.state === "ended") {
        worker.sessionId = undefined;
        this.markIdleWorkerReady(worker, generation);
      } else if (generation === session.workerGeneration) {
        worker.generation = generation;
      } else if (session.startedAt === undefined) {
        // No browser has reached this seat, so rebinding an admitted ticket to
        // the newly observed pristine generation is safe.
        worker.generation = generation;
        session.workerGeneration = generation;
      } else if (session.disconnectedAt !== undefined) {
        // The old tenant connection is gone and no replacement attach is in
        // flight. End its ticket before making the pristine generation ready.
        this.end(session, "worker-unavailable");
        this.markIdleWorkerReady(worker, generation);
      } else {
        // An attachment is connected or in flight. Its authenticated upgrade
        // header decides whether this generation has received tenant state.
        worker.ready = false;
        worker.idleSince = undefined;
      }
    } else {
      this.markIdleWorkerReady(worker, generation);
    }
    this.pump();
    return true;
  }

  /** Snapshot used to discard health responses started before a seat transition. */
  workerProbeEpoch(workerId: string): number {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`unknown public worker "${workerId}"`);
    return worker.probeEpoch;
  }

  /** Confirm that the assigned internal WebSocket reached the probed process. */
  confirmWorkerGeneration(
    sessionId: string,
    connectionVersion: number,
    observedGeneration: string | undefined,
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (
      !session
      || session.state !== "active"
      || session.connectionVersion !== connectionVersion
      || !session.workerId
    ) {
      return false;
    }
    const worker = this.workers.get(session.workerId);
    if (!worker || worker.sessionId !== session.id) return false;
    this.bumpWorkerProbeEpoch(worker);
    if (observedGeneration && observedGeneration === session.workerGeneration) {
      worker.generation = observedGeneration;
      return true;
    }

    // A successful WebSocket handshake already initializes tenant state in
    // the worker. Fence the generation actually reached so it cannot be handed
    // to another visitor before that process is replaced.
    if (observedGeneration) {
      session.workerGeneration = observedGeneration;
      worker.generation = observedGeneration;
    } else {
      // Without an authenticated generation header, a preceding health probe
      // cannot identify the process that accepted the connection. Require an
      // observed unavailable transition before any process can re-enter.
      worker.requiresUnavailable = true;
      worker.quarantinedGeneration = undefined;
      worker.unavailableAfterQuarantine = false;
    }
    this.end(session, "worker-unavailable");
    return false;
  }

  private markIdleWorkerReady(worker: WorkerSlot, generation: string): void {
    if (
      worker.requiresUnavailable
      || (worker.replacementOfGeneration && generation === worker.replacementOfGeneration)
    ) {
      // A stale health response from the terminated tenant process must never
      // return its slot to the queue before Compose has replaced it.
      worker.ready = false;
      worker.idleSince = undefined;
    } else {
      const generationChanged = worker.generation !== generation;
      worker.ready = true;
      worker.generation = generation;
      worker.replacementOfGeneration = undefined;
      if (generationChanged || worker.idleSince === undefined) {
        // A slot enters ready-idle when it first reports healthy and unassigned,
        // when a replacement process takes over, or when a restored gateway
        // re-probes a slot with no persisted idle clock. Repeated probes of the
        // same generation keep the original idle timestamp so the clock is
        // monotonic and a restart does not restart the scale-down timer.
        worker.idleSince = this.now();
      }
    }
  }

  /** Reserve one browser upgrade without starting the active session lease. */
  reserveAttachment(sessionId: string): PublicWorkerAssignment | undefined {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session || !session.workerId || session.state === "ended") return undefined;
    if (session.pendingConnectionVersion !== undefined) return undefined;
    if (session.connectionAttempts >= PUBLIC_MAX_CONNECTION_ATTEMPTS) {
      this.end(session, "rate-limited");
      return undefined;
    }
    const now = this.now();
    session.connectionAttempts += 1;
    session.nextConnectionVersion += 1;
    session.pendingConnectionVersion = session.nextConnectionVersion;
    session.pendingConnectionReservedAt = now;
    this.bumpSessionWorkerProbeEpoch(session);
    return this.reservation(session, session.pendingConnectionVersion, now);
  }

  /** Activate a reservation only after the HTTP WebSocket upgrade succeeds. */
  activateAttachment(sessionId: string, connectionVersion: number): PublicWorkerAssignment | undefined {
    const session = this.sessions.get(sessionId);
    if (
      !session
      || !session.workerId
      || session.state === "ended"
      || session.pendingConnectionVersion !== connectionVersion
    ) {
      return undefined;
    }
    const now = this.now();
    session.pendingConnectionVersion = undefined;
    session.pendingConnectionReservedAt = undefined;
    if (session.state === "admitted") {
      session.state = "active";
      session.startedAt = now;
    }
    session.lastActivityAt = now;
    session.disconnectedAt = undefined;
    session.connectionVersion = connectionVersion;
    this.bumpSessionWorkerProbeEpoch(session);
    return this.assignment(session);
  }

  /** Persist the conservative tenant-exposure fence before dialing a worker. */
  markWorkerConnectionStarted(sessionId: string, connectionVersion: number): boolean {
    const session = this.sessions.get(sessionId);
    if (
      !session
      || session.state !== "active"
      || session.connectionVersion !== connectionVersion
      || !session.workerId
    ) {
      return false;
    }
    session.workerConnectionStarted = true;
    this.bumpSessionWorkerProbeEpoch(session);
    return true;
  }

  /** Restore the prior live bridge if its replacement closes during activation. */
  rollbackAttachment(
    sessionId: string,
    connectionVersion: number,
    previousConnectionVersion: number,
  ): void {
    const session = this.sessions.get(sessionId);
    if (
      session?.state !== "active"
      || session.connectionVersion !== connectionVersion
      || previousConnectionVersion <= 0
    ) {
      return;
    }
    session.connectionVersion = previousConnectionVersion;
    this.bumpSessionWorkerProbeEpoch(session);
  }

  /** Release an upgrade reservation that closed before WebSocket activation. */
  cancelAttachment(sessionId: string, connectionVersion: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.pendingConnectionVersion !== connectionVersion) return;
    session.pendingConnectionVersion = undefined;
    session.pendingConnectionReservedAt = undefined;
    this.bumpSessionWorkerProbeEpoch(session);
  }

  /** Convenience for non-network callers and coordinator unit tests. */
  attach(sessionId: string): PublicWorkerAssignment | undefined {
    const reservation = this.reserveAttachment(sessionId);
    if (!reservation) return undefined;
    const assignment = this.activateAttachment(sessionId, reservation.connectionVersion);
    if (assignment) this.markWorkerConnectionStarted(sessionId, assignment.connectionVersion);
    return assignment;
  }

  /** Count a meaningful user action toward the idle lease. */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.state === "active") session.lastActivityAt = this.now();
  }

  /** Allow a real research launch only while this visitor retains their quota. */
  authorizeResearch(sessionId: string): ResearchAuthorization {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== "active") {
      return { allowed: false, reason: "session-unavailable" };
    }
    if (session.researchRuns >= this.options.maxResearchRuns) {
      return { allowed: false, reason: "research-limit-reached" };
    }
    session.researchRuns += 1;
    this.touch(sessionId);
    return { allowed: true, remaining: this.options.maxResearchRuns - session.researchRuns };
  }

  /** Start disconnect grace instead of immediately reassigning an active seat. */
  detach(sessionId: string, connectionVersion: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.state === "active" && session.connectionVersion === connectionVersion) {
      session.disconnectedAt = this.now();
      this.bumpSessionWorkerProbeEpoch(session);
    }
  }

  /** End a browser capability after a public-boundary policy violation. */
  terminate(sessionId: string, reason: "rate-limited" | "protocol-violation"): void {
    const session = this.sessions.get(sessionId);
    if (session && session.state !== "ended") this.end(session, reason);
  }

  /** Get a pollable status snapshot without exposing internal credentials. */
  status(sessionId: string): PublicSessionSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.snapshot(session) : undefined;
  }

  /**
   * Private read: the worker identity behind an active session. Never part of
   * the public snapshot — used only by the workspace-handoff controller to
   * authorize a checkpoint export against the exact assigned worker/generation.
   */
  getAssignedWorker(sessionId: string): { workerId: string; workerGeneration: string } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== "active" || !session.workerId || !session.workerGeneration) {
      return undefined;
    }
    return { workerId: session.workerId, workerGeneration: session.workerGeneration };
  }

  /** Run expiry checks and assign newly healthy seats to queued visitors. */
  sweep(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (
        session.pendingConnectionVersion !== undefined
        && session.pendingConnectionReservedAt !== undefined
        && now - session.pendingConnectionReservedAt >= this.options.reconnectGraceMs
      ) {
        session.pendingConnectionVersion = undefined;
        session.pendingConnectionReservedAt = undefined;
        this.bumpSessionWorkerProbeEpoch(session);
      }
      if (session.state === "queued" && now >= session.ticketExpiresAt) {
        this.end(session, "ticket-expired");
        continue;
      }
      if (session.state === "admitted" && session.assignedAt !== undefined) {
        if (now - session.assignedAt >= this.options.reconnectGraceMs) this.end(session, "no-show");
        continue;
      }
      if (session.state !== "active" || session.startedAt === undefined) continue;
      if (now - session.startedAt >= this.options.absoluteTimeoutMs) {
        this.end(session, "absolute-timeout");
      } else if (session.disconnectedAt !== undefined) {
        if (now - session.disconnectedAt >= this.options.reconnectGraceMs) {
          this.end(session, "disconnect-timeout");
        }
      } else if (session.lastActivityAt !== undefined && now - session.lastActivityAt >= this.options.idleTimeoutMs) {
        this.end(session, "idle-timeout");
      }
    }
    this.resetDailyBudgetIfNeeded(now);
    this.pruneEndedSessions(now);
    this.pump();
  }

  /** A monitoring snapshot for aggregate capacity and conservative daily spend. */
  metrics(): {
    readyWorkers: number;
    assignedWorkers: number;
    queuedVisitors: number;
    dailyReservedMicroUsd: number;
    dailyBudgetMicroUsd: number;
  } {
    let readyWorkers = 0;
    let assignedWorkers = 0;
    for (const worker of this.workers.values()) {
      if (worker.sessionId) assignedWorkers += 1;
      else if (worker.ready) readyWorkers += 1;
    }
    return {
      readyWorkers,
      assignedWorkers,
      queuedVisitors: this.queue.filter((id) => this.sessions.get(id)?.state === "queued").length,
      dailyReservedMicroUsd: this.dailyReservedMicroUsd,
      dailyBudgetMicroUsd: this.options.dailyBudgetMicroUsd,
    };
  }

  /**
   * Export per-seat status for the warm-pool capacity planner. This is a pure
   * read: no mutations, no access to secrets or Docker.
   */
  getSeatStatuses(): Array<{
    workerId: string;
    phase: "absent" | "starting" | "ready-idle" | "assigned" | "admitted" | "active" | "disconnected" | "recycling";
    generation?: string;
    sessionId?: string;
    idleSinceMs?: number;
  }> {
    const now = this.now();
    return [...this.workers.values()].map((worker) => {
      let phase: ReturnType<typeof this.getSeatStatuses>[0]["phase"] = "absent";
      let sessionId: string | undefined;
      let idleSinceMs: number | undefined;

      if (worker.sessionId) {
        const session = this.sessions.get(worker.sessionId);
        sessionId = session?.id;
        if (session) {
          switch (session.state) {
            case "admitted":
              phase = session.startedAt === undefined ? "admitted" : "starting";
              break;
            case "active":
              if (session.disconnectedAt !== undefined) {
                phase = "disconnected";
              } else {
                phase = "active";
                if (session.lastActivityAt !== undefined) {
                  idleSinceMs = Math.max(0, now - session.lastActivityAt);
                }
              }
              break;
            case "ended":
              phase = "recycling";
              break;
            default:
              phase = "assigned";
              break;
          }
        }
      } else if (worker.ready && worker.generation) {
        phase = "ready-idle";
        idleSinceMs = worker.idleSince !== undefined
          ? Math.max(0, now - worker.idleSince)
          : 0;
      } else if (worker.replacementOfGeneration) {
        phase = "recycling";
      } else if (worker.requiresUnavailable) {
        phase = "recycling";
      }

      return {
        workerId: worker.id,
        phase,
        ...(worker.generation ? { generation: worker.generation } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(idleSinceMs !== undefined ? { idleSinceMs } : {}),
      };
    });
  }

  /** Persist only opaque ticket state; worker health is always re-probed after restart. */
  exportState(): PublicSessionCoordinatorState {
    return {
      version: 1,
      dailyBudgetDay: this.dailyBudgetDay,
      dailyReservedMicroUsd: this.dailyReservedMicroUsd,
      queue: [...this.queue],
      sessions: [...this.sessions.values()].map((session) => ({ ...session })),
      workers: [...this.workers.values()].map(({
        id,
        sessionId,
        generation,
        replacementOfGeneration,
        requiresUnavailable,
        quarantinedGeneration,
        unavailableAfterQuarantine,
        idleSince,
      }) => ({
        id,
        ...(sessionId ? { sessionId } : {}),
        ...(generation ? { generation } : {}),
        ...(replacementOfGeneration ? { replacementOfGeneration } : {}),
        ...(requiresUnavailable ? { requiresUnavailable: true } : {}),
        ...(quarantinedGeneration ? { quarantinedGeneration } : {}),
        ...(unavailableAfterQuarantine ? { unavailableAfterQuarantine: true } : {}),
        ...(idleSince !== undefined ? { idleSince } : {}),
      })),
    };
  }

  /** Restore a gateway lease after a process restart without trusting stale health. */
  restore(state: PublicSessionCoordinatorState): void {
    if (state.version !== 1) throw new Error("unsupported public session state version");
    if (!Array.isArray(state.sessions) || !Array.isArray(state.queue) || !Array.isArray(state.workers)) {
      throw new Error("invalid public session state");
    }
    const expectedWorkers = new Set(this.workers.keys());
    const restoredWorkers = new Set(state.workers.map(({ id }) => id));
    if (expectedWorkers.size !== restoredWorkers.size || [...expectedWorkers].some((id) => !restoredWorkers.has(id))) {
      throw new Error("persisted public worker set does not match configured workers");
    }
    if (!Number.isInteger(state.dailyReservedMicroUsd) || state.dailyReservedMicroUsd < 0) {
      throw new Error("invalid persisted public research budget");
    }
    this.sessions.clear();
    this.visitorSessions.clear();
    this.queue.splice(0, this.queue.length);
    const now = this.now();
    for (const raw of state.sessions) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.visitorId !== "string") {
        throw new Error("invalid persisted public session");
      }
      if (!["queued", "admitted", "active", "ended"].includes(raw.state)) {
        throw new Error("invalid persisted public session state");
      }
      const connectionVersion = Number.isInteger(raw.connectionVersion) && raw.connectionVersion >= 0
        ? raw.connectionVersion
        : 0;
      const session: Session = {
        ...raw,
        connectionVersion,
        nextConnectionVersion: Number.isInteger(raw.nextConnectionVersion)
          && (raw.nextConnectionVersion ?? -1) >= connectionVersion
          ? raw.nextConnectionVersion!
          : connectionVersion,
        connectionAttempts: Number.isInteger(raw.connectionAttempts) && (raw.connectionAttempts ?? -1) >= 0
          ? raw.connectionAttempts!
          : 0,
        workerConnectionStarted: raw.workerConnectionStarted === true || raw.startedAt !== undefined,
        pendingConnectionVersion: undefined,
        pendingConnectionReservedAt: undefined,
        ...(raw.state === "ended" && !Number.isFinite(raw.endedAt) ? { endedAt: now } : {}),
      };
      // A gateway restart severs browser proxy connections. Keep the original
      // absolute limit but make reconnect grace explicit until the browser
      // attaches through the replacement gateway.
      if (session.state === "active") session.disconnectedAt = now;
      this.sessions.set(session.id, session);
      if (session.state !== "ended") this.visitorSessions.set(session.visitorId, session.id);
    }
    for (const id of state.queue) {
      if (this.sessions.get(id)?.state === "queued") this.queue.push(id);
    }
    for (const worker of this.workers.values()) {
      const persisted = state.workers.find(({ id }) => id === worker.id);
      worker.sessionId = persisted?.sessionId;
      worker.generation = persisted?.generation;
      worker.replacementOfGeneration = persisted?.replacementOfGeneration;
      worker.requiresUnavailable = persisted?.requiresUnavailable === true;
      worker.quarantinedGeneration = persisted?.quarantinedGeneration;
      worker.unavailableAfterQuarantine = persisted?.unavailableAfterQuarantine === true;
      // Persisted idleSince continues a ready-idle seat's scale-down clock
      // across a gateway restart. Old Redis state predating the field gets a
      // conservative current-time stamp so idleSinceMs starts at zero and can
      // never trigger an immediate unsafe drain; the worker is re-probed
      // before it can become ready anyway. Assigned seats are never idle.
      const persistedIdleSince = persisted?.idleSince;
      worker.idleSince = worker.sessionId
        ? undefined
        : Number.isFinite(persistedIdleSince) && (persistedIdleSince ?? 0) >= 0
          ? Math.min(persistedIdleSince!, now)
          : now;
      worker.ready = false;
      worker.probeEpoch = 0;
    }
    this.dailyBudgetDay = state.dailyBudgetDay;
    this.dailyReservedMicroUsd = state.dailyReservedMicroUsd;
    this.sweep();
  }

  private pump(): void {
    this.removeEndedQueueEntries();
    for (const worker of this.workers.values()) {
      if (!worker.ready || worker.sessionId) continue;
      const nextId = this.queue.shift();
      if (!nextId) return;
      const session = this.sessions.get(nextId);
      if (!session || session.state !== "queued") continue;
      const reservation = this.options.maxResearchRuns * this.options.researchRunReservationMicroUsd;
      if (this.dailyReservedMicroUsd + reservation > this.options.dailyBudgetMicroUsd) {
        this.end(session, "daily-budget-exhausted");
        continue;
      }
      const now = this.now();
      session.state = "admitted";
      session.workerId = worker.id;
      session.workerGeneration = worker.generation;
      session.assignedAt = now;
      session.researchReservedMicroUsd = reservation;
      this.dailyReservedMicroUsd += reservation;
      worker.sessionId = session.id;
      worker.ready = false;
      worker.idleSince = undefined;
      this.bumpWorkerProbeEpoch(worker);
    }
  }

  private end(session: Session, reason: PublicSessionEndReason): void {
    if (session.state === "ended") return;
    const workerMayContainTenantState = session.workerConnectionStarted;
    session.state = "ended";
    session.endReason = reason;
    session.endedAt = this.now();
    session.pendingConnectionVersion = undefined;
    session.pendingConnectionReservedAt = undefined;
    this.visitorSessions.delete(session.visitorId);
    if (session.workerId) {
      const worker = this.workers.get(session.workerId);
      if (worker?.sessionId === session.id) {
        this.bumpWorkerProbeEpoch(worker);
        worker.sessionId = undefined;
        if (workerMayContainTenantState) {
          // The worker process is terminated after a visitor reaches it. Its
          // replacement must pass a health check before this slot becomes ready.
          worker.ready = false;
          worker.idleSince = undefined;
          worker.replacementOfGeneration = session.workerGeneration ?? worker.generation;
        } else if (reason !== "worker-unavailable") {
          // An admitted visitor never opened a browser socket, so the worker
          // has no tenant panel or agent state to discard. The slot returns to
          // the ready-idle pool and its idle clock restarts from the session end.
          worker.ready = true;
          worker.idleSince = this.now();
          worker.replacementOfGeneration = undefined;
        } else {
          // A failed health probe cannot return an unvisited seat to service.
          // Any later healthy generation may re-enter through setWorkerReady.
          worker.ready = false;
          worker.idleSince = undefined;
          worker.replacementOfGeneration = undefined;
        }
      }
    }
    this.onSessionEnded(this.snapshot(session), reason);
  }

  private snapshot(session: Session): PublicSessionSnapshot {
    const sessionExpiresAt = session.startedAt === undefined
      ? undefined
      : session.startedAt + this.options.absoluteTimeoutMs;
    const idleExpiresAt = session.lastActivityAt === undefined
      ? undefined
      : session.lastActivityAt + this.options.idleTimeoutMs;
    const queuePosition = session.state === "queued"
      ? this.queue.filter((id) => this.sessions.get(id)?.state === "queued").indexOf(session.id) + 1
      : undefined;
    return {
      id: session.id,
      visitorId: session.visitorId,
      state: session.state,
      ...(queuePosition && queuePosition > 0 ? { queuePosition } : {}),
      ...(session.workerId ? { workerId: session.workerId } : {}),
      ticketExpiresAt: session.ticketExpiresAt,
      ...(sessionExpiresAt ? { sessionExpiresAt } : {}),
      ...(idleExpiresAt ? { idleExpiresAt } : {}),
      researchRunsRemaining: Math.max(0, this.options.maxResearchRuns - session.researchRuns),
      ...(session.endReason ? { endReason: session.endReason } : {}),
    };
  }

  private assignment(session: Session): PublicWorkerAssignment {
    if (
      !session.workerId
      || !session.workerGeneration
      || session.startedAt === undefined
      || session.lastActivityAt === undefined
    ) {
      throw new Error("cannot assign a session without a worker and active lease");
    }
    return {
      id: session.id,
      visitorId: session.visitorId,
      workerId: session.workerId,
      workerGeneration: session.workerGeneration,
      connectionVersion: session.connectionVersion,
      sessionExpiresAt: session.startedAt + this.options.absoluteTimeoutMs,
      idleExpiresAt: session.lastActivityAt + this.options.idleTimeoutMs,
      researchRunsRemaining: this.options.maxResearchRuns - session.researchRuns,
    };
  }

  private reservation(session: Session, connectionVersion: number, now: number): PublicWorkerAssignment {
    if (!session.workerId || !session.workerGeneration) {
      throw new Error("cannot reserve a session without a worker generation");
    }
    const leaseStart = session.startedAt ?? now;
    const activityStart = session.lastActivityAt ?? now;
    return {
      id: session.id,
      visitorId: session.visitorId,
      workerId: session.workerId,
      workerGeneration: session.workerGeneration,
      connectionVersion,
      previousConnectionVersion: session.connectionVersion,
      sessionExpiresAt: leaseStart + this.options.absoluteTimeoutMs,
      idleExpiresAt: activityStart + this.options.idleTimeoutMs,
      researchRunsRemaining: this.options.maxResearchRuns - session.researchRuns,
    };
  }

  private bumpSessionWorkerProbeEpoch(session: Session): void {
    if (!session.workerId) return;
    const worker = this.workers.get(session.workerId);
    if (worker?.sessionId === session.id) this.bumpWorkerProbeEpoch(worker);
  }

  private bumpWorkerProbeEpoch(worker: WorkerSlot): void {
    worker.probeEpoch += 1;
  }

  private removeEndedQueueEntries(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.sessions.get(this.queue[index])?.state !== "queued") this.queue.splice(index, 1);
    }
  }

  private resetDailyBudgetIfNeeded(now: number): void {
    const day = utcDay(now);
    if (day === this.dailyBudgetDay) return;
    this.dailyBudgetDay = day;
    // An active session can launch its already-reserved research after UTC
    // midnight. Carry the full reservation forward so the new calendar day
    // cannot allocate the same budget a second time.
    this.dailyReservedMicroUsd = [...this.sessions.values()]
      .filter((session) => session.state === "admitted" || session.state === "active")
      .reduce((total, session) => total + session.researchReservedMicroUsd, 0);
  }

  private pruneEndedSessions(now: number): void {
    const retained: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.state !== "ended") continue;
      const endedAt = session.endedAt ?? now;
      if (now - endedAt >= PUBLIC_ENDED_SESSION_RETENTION_MS) {
        this.sessions.delete(session.id);
      } else {
        retained.push(session);
      }
    }
    if (retained.length <= MAX_ENDED_SESSION_TOMBSTONES) return;
    retained.sort((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0));
    for (const session of retained.slice(0, retained.length - MAX_ENDED_SESSION_TOMBSTONES)) {
      this.sessions.delete(session.id);
    }
  }
}
