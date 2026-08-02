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
    researchRuns: number;
    researchReservedMicroUsd: number;
    endReason?: PublicSessionEndReason;
  }>;
  workers: Array<{
    id: string;
    sessionId?: string;
    generation?: string;
    replacementOfGeneration?: string;
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
  researchRuns: number;
  researchReservedMicroUsd: number;
  endReason?: PublicSessionEndReason;
};

type WorkerSlot = {
  id: string;
  ready: boolean;
  sessionId?: string;
  generation?: string;
  replacementOfGeneration?: string;
};

const NOOP = () => {};

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

    for (const id of options.workerIds) this.workers.set(id, { id, ready: false });
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
  setWorkerReady(workerId: string, ready: boolean, generation?: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`unknown public worker "${workerId}"`);
    if (!ready) {
      worker.ready = false;
    } else if (!worker.sessionId) {
      if (worker.replacementOfGeneration && generation === worker.replacementOfGeneration) {
        // A stale health response from the terminated tenant process must never
        // return its slot to the queue before Compose has replaced it.
        worker.ready = false;
      } else {
        worker.ready = true;
        if (generation) worker.generation = generation;
        worker.replacementOfGeneration = undefined;
      }
    }
    if (!ready && worker.sessionId) {
      const session = this.sessions.get(worker.sessionId);
      if (session && session.state !== "ended") this.end(session, "worker-unavailable");
    }
    this.pump();
  }

  /** Attach a browser WebSocket to an admitted session. */
  attach(sessionId: string): PublicWorkerAssignment | undefined {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session || !session.workerId || session.state === "ended") return undefined;
    const now = this.now();
    if (session.state === "admitted") {
      session.state = "active";
      session.startedAt = now;
    }
    session.lastActivityAt = now;
    session.disconnectedAt = undefined;
    return this.assignment(session);
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
  detach(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.state === "active") session.disconnectedAt = this.now();
  }

  /** Get a pollable status snapshot without exposing internal credentials. */
  status(sessionId: string): PublicSessionSnapshot | undefined {
    this.sweep();
    const session = this.sessions.get(sessionId);
    return session ? this.snapshot(session) : undefined;
  }

  /** Run expiry checks and assign newly healthy seats to queued visitors. */
  sweep(): void {
    const now = this.now();
    this.resetDailyBudgetIfNeeded(now);
    for (const session of this.sessions.values()) {
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
    this.sweep();
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
      }) => ({
        id,
        ...(sessionId ? { sessionId } : {}),
        ...(generation ? { generation } : {}),
        ...(replacementOfGeneration ? { replacementOfGeneration } : {}),
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
      const session: Session = { ...raw };
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
      worker.ready = false;
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
    }
  }

  private end(session: Session, reason: PublicSessionEndReason): void {
    if (session.state === "ended") return;
    const hadConnectedBrowser = session.startedAt !== undefined;
    session.state = "ended";
    session.endReason = reason;
    this.visitorSessions.delete(session.visitorId);
    if (session.workerId) {
      const worker = this.workers.get(session.workerId);
      if (worker?.sessionId === session.id) {
        worker.sessionId = undefined;
        if (hadConnectedBrowser) {
          // The worker process is terminated after a visitor reaches it. Its
          // replacement must pass a health check before this slot becomes ready.
          worker.ready = false;
          worker.replacementOfGeneration = session.workerGeneration ?? worker.generation;
        } else {
          // An admitted visitor never opened a browser socket, so the worker
          // has no tenant panel or agent state to discard.
          worker.ready = true;
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
    if (!session.workerId || session.startedAt === undefined || session.lastActivityAt === undefined) {
      throw new Error("cannot assign a session without a worker and active lease");
    }
    return {
      id: session.id,
      visitorId: session.visitorId,
      workerId: session.workerId,
      sessionExpiresAt: session.startedAt + this.options.absoluteTimeoutMs,
      idleExpiresAt: session.lastActivityAt + this.options.idleTimeoutMs,
      researchRunsRemaining: this.options.maxResearchRuns - session.researchRuns,
    };
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
    this.dailyReservedMicroUsd = 0;
  }
}
