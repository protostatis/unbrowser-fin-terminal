/**
 * Global research-permit coordinator.
 *
 * Policy:
 *   - Up to 6 browser sessions, globally max 2 concurrent one-shot research
 *     child processes.
 *   - Excess research is FIFO queued and remains visibly queued in the existing
 *     terminal UI.
 *   - Gateway owns/persists permits; workers do not gain Redis access.
 *   - Acquire immediately before workerFactory/fork, release only after actual
 *     child exit.
 *   - Idempotent request IDs, generation/session binding, heartbeats,
 *     cancellation/grant race handling, gateway restart restore, and stale
 *     worker-generation reclamation.
 *   - A queued research wait heartbeat must keep an otherwise active session
 *     from idle-expiring, while the 15-minute absolute limit remains.
 *   - Current per-session run authorization must be invoked exactly once per
 *     logical job.
 */

export type ResearchPermitStatus =
  | "queued"
  | "acquired"
  | "released"
  | "cancelled"
  | "expired";

export interface ResearchPermitRequest {
  /** Unique idempotency key for this permit acquisition. */
  requestId: string;
  /** Session that owns this research job. */
  sessionId: string;
  /** Worker generation at time of request (for stale reclamation). */
  workerGeneration: string;
  /** Max time this permit can remain queued before expiry (ms). */
  queueTtlMs: number;
  /** Max time a queued permit will heartbeat to keep session alive (ms). */
  heartbeatIntervalMs: number;
}

export interface ResearchPermit {
  requestId: string;
  sessionId: string;
  status: ResearchPermitStatus;
  workerGeneration: string;
  queuedAt: number;
  acquiredAt?: number;
  expiresAt: number;    // queue TTL expiry
  heartbeatAt: number;  // last heartbeat time
}

export interface ResearchPermitOptions {
  /** Max concurrent research jobs (default 2). */
  maxConcurrent: number;
  /** Max queued permits (default 24). */
  maxQueue: number;
  /** Default queue TTL (ms). */
  defaultQueueTtlMs: number;
  /** Heartbeat interval (ms). */
  heartbeatIntervalMs: number;
  /** Permit TTL after acquisition before release (ms, hard timeout). */
  acquireTtlMs: number;
  now?: () => number;
  createId?: () => string;
}

export interface AcquireResult {
  accepted: boolean;
  status: "acquired" | "queued" | "rejected";
  reason?: string;
  permit?: ResearchPermit;
  queuePosition?: number;
}

export interface ReleaseResult {
  released: boolean;
  reason?: string;
}

export interface CancelResult {
  cancelled: boolean;
  status: "queued-removed" | "running-released" | "already-released" | "not-found";
}

export interface HeartbeatResult {
  alive: boolean;
  reason?: string;
}

export interface ResearchPermitState {
  version: 1;
  permits: Array<{
    requestId: string;
    sessionId: string;
    status: ResearchPermitStatus;
    workerGeneration: string;
    queuedAt: number;
    acquiredAt?: number;
    expiresAt: number;
    heartbeatAt: number;
  }>;
}

const MAX_RECENTLY_SETTLED = 128;

export class ResearchPermitCoordinator {
  private readonly now: () => number;
  private readonly createId: () => string;
  private permits = new Map<string, ResearchPermit>();
  private queue: string[] = [];  // requestIds in FIFO order
  private readonly recentlySettled = new Set<string>();
  private readonly recentlySettledOrder: string[] = [];
  private _disposed = false;

  constructor(private readonly options: ResearchPermitOptions) {
    if (options.maxConcurrent < 1 || options.maxConcurrent > 6) {
      throw new Error("maxConcurrent must be 1–6");
    }
    if (options.maxQueue < 1) throw new Error("maxQueue must be >= 1");
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => {
      const seq = Math.random().toString(36).slice(2, 10);
      return `rperm-${this.now().toString(36)}-${seq}`;
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Acquire a research permit. Returns immediately if below concurrency cap,
   * otherwise queues. Idempotent on requestId.
   */
  acquire(sessionId: string, workerGeneration: string, requestId?: string): AcquireResult {
    if (this._disposed) return { accepted: false, status: "rejected", reason: "disposed" };

    this.sweep();

    const key = requestId ?? this.createId();

    // Idempotent: if requestId already exists, return its current status.
    const existing = this.permits.get(key);
    if (existing) {
      if (existing.sessionId !== sessionId) {
        return { accepted: false, status: "rejected", reason: "request-id-collision" };
      }
      // Idle-expiry heartbeat for queued permits.
      if (existing.status === "queued") {
        existing.heartbeatAt = this.now();
      }
      const queuePos = this.queue.indexOf(key);
      return {
        accepted: existing.status === "acquired" || existing.status === "queued",
        status: existing.status === "acquired" ? "acquired" : "queued",
        permit: this.toPermit(existing),
        ...(queuePos >= 0 ? { queuePosition: queuePos + 1 } : {}),
      };
    }

    if (this.queue.length >= this.options.maxQueue) {
      return { accepted: false, status: "rejected", reason: "queue-full" };
    }

    // Check concurrent acquired count.
    const acquiredCount = this.countAcquired();
    const now = this.now();

    const permit: ResearchPermit = {
      requestId: key,
      sessionId,
      status: acquiredCount < this.options.maxConcurrent ? "acquired" : "queued",
      workerGeneration,
      queuedAt: now,
      expiresAt: now + this.options.defaultQueueTtlMs,
      heartbeatAt: now,
    };

    if (permit.status === "acquired") {
      permit.acquiredAt = now;
    }

    this.permits.set(key, permit);

    if (permit.status === "queued") {
      this.queue.push(key);
    }

    const queuePosition = permit.status === "queued"
      ? this.queue.indexOf(key) + 1
      : undefined;

    return {
      accepted: true,
      status: permit.status as "acquired" | "queued",
      permit: this.toPermit(permit),
      ...(queuePosition ? { queuePosition } : {}),
    };
  }

  /**
   * Release a permit after the child process has exited.
   */
  release(requestId: string): ReleaseResult {
    if (this._disposed) return { released: false, reason: "disposed" };

    const permit = this.permits.get(requestId);
    if (!permit) {
      if (this.recentlySettled.has(requestId)) {
        return { released: false, reason: "already-released" };
      }
      return { released: false, reason: "not-found" };
    }

    if (permit.status === "released" || permit.status === "expired") {
      return { released: false, reason: `already-${permit.status}` };
    }

    if (permit.status === "queued") {
      this.removeFromQueue(requestId);
    }

    permit.status = "released";
    this.rememberSettled(requestId);
    this.permits.delete(requestId);
    this.pumpQueue();
    return { released: true };
  }

  /**
   * Cancel a queued or acquired permit.
   */
  cancel(requestId: string): CancelResult {
    if (this._disposed) return { cancelled: false, status: "not-found" };

    const permit = this.permits.get(requestId);
    if (!permit) {
      if (this.recentlySettled.has(requestId)) {
        return { cancelled: false, status: "already-released" };
      }
      return { cancelled: false, status: "not-found" };
    }

    if (permit.status === "released" || permit.status === "expired") {
      return { cancelled: false, status: "already-released" };
    }

    if (permit.status === "queued") {
      this.removeFromQueue(requestId);
      permit.status = "cancelled";
      this.rememberSettled(requestId);
      this.permits.delete(requestId);
      return { cancelled: true, status: "queued-removed" };
    }

    // Running/acquried → release the slot.
    permit.status = "cancelled";
    this.rememberSettled(requestId);
    this.permits.delete(requestId);
    this.pumpQueue();
    return { cancelled: true, status: "running-released" };
  }

  /**
   * Heartbeat a queued permit to keep the session from idle-expiring.
   */
  heartbeat(requestId: string): HeartbeatResult {
    if (this._disposed) return { alive: false, reason: "disposed" };

    const permit = this.permits.get(requestId);
    if (!permit) {
      return { alive: false, reason: "not-found" };
    }

    if (permit.status !== "queued") {
      return { alive: false, reason: "not-queued" };
    }

    const now = this.now();
    if (now >= permit.expiresAt) {
      return { alive: false, reason: "expired" };
    }

    permit.heartbeatAt = now;
    return { alive: true };
  }

  /**
   * Reclaim permits belonging to a stale worker generation (after restart).
   */
  reclaimStaleGeneration(sessionId: string, currentWorkerGeneration: string): number {
    let reclaimed = 0;
    for (const [key, permit] of this.permits) {
      if (permit.sessionId === sessionId && permit.workerGeneration !== currentWorkerGeneration) {
        this.cancel(key);
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  /**
   * Status of a specific permit.
   */
  status(requestId: string): ResearchPermit | undefined {
    const permit = this.permits.get(requestId);
    return permit ? this.toPermit(permit) : undefined;
  }

  /**
   * Get current metrics.
   */
  metrics(): { acquired: number; queued: number; maxConcurrent: number } {
    return {
      acquired: this.countAcquired(),
      queued: this.queue.length,
      maxConcurrent: this.options.maxConcurrent,
    };
  }

  /**
   * Get all active permits for a session.
   */
  sessionPermits(sessionId: string): ResearchPermit[] {
    const result: ResearchPermit[] = [];
    for (const permit of this.permits.values()) {
      if (permit.sessionId === sessionId) {
        result.push(this.toPermit(permit));
      }
    }
    return result;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  sweep(): void {
    const now = this.now();
    for (const [key, permit] of this.permits) {
      if (permit.status === "queued" && now >= permit.expiresAt) {
        permit.status = "expired";
        this.removeFromQueue(key);
        this.rememberSettled(key);
        this.permits.delete(key);
      }
      if (
        permit.status === "acquired" &&
        permit.acquiredAt &&
        now - permit.acquiredAt >= this.options.acquireTtlMs
      ) {
        permit.status = "expired";
        this.rememberSettled(key);
        this.permits.delete(key);
        this.pumpQueue();
      }
    }
  }

  dispose(): void {
    this._disposed = true;
    this.permits.clear();
    this.queue.length = 0;
    this.recentlySettled.clear();
    this.recentlySettledOrder.length = 0;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  exportState(): ResearchPermitState {
    return {
      version: 1,
      permits: [...this.permits.values()].map((p) => ({ ...p })),
    };
  }

  restore(state: ResearchPermitState): void {
    if (state.version !== 1) throw new Error("unsupported research-permit state version");
    if (!Array.isArray(state.permits)) throw new Error("invalid research-permit state");

    this.permits.clear();
    this.queue.length = 0;

    for (const raw of state.permits) {
      if (
        typeof raw.requestId !== "string" ||
        typeof raw.sessionId !== "string" ||
        typeof raw.workerGeneration !== "string" ||
        typeof raw.status !== "string" ||
        !Number.isFinite(raw.queuedAt) ||
        !Number.isFinite(raw.expiresAt) ||
        !Number.isFinite(raw.heartbeatAt)
      ) {
        throw new Error("invalid permit entry in research-permit state");
      }
      const permit: ResearchPermit = {
        requestId: raw.requestId,
        sessionId: raw.sessionId,
        status: raw.status as ResearchPermitStatus,
        workerGeneration: raw.workerGeneration,
        queuedAt: raw.queuedAt,
        acquiredAt: raw.acquiredAt,
        expiresAt: raw.expiresAt,
        heartbeatAt: raw.heartbeatAt,
      };
      this.permits.set(permit.requestId, permit);
      if (permit.status === "queued") {
        this.queue.push(permit.requestId);
      }
    }
    this.sweep();
  }

  get disposed(): boolean {
    return this._disposed;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private countAcquired(): number {
    let count = 0;
    for (const p of this.permits.values()) {
      if (p.status === "acquired") count += 1;
    }
    return count;
  }

  private removeFromQueue(requestId: string): void {
    const idx = this.queue.indexOf(requestId);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  private pumpQueue(): void {
    while (!this._disposed && this.countAcquired() < this.options.maxConcurrent && this.queue.length > 0) {
      const nextId = this.queue.shift()!;
      const permit = this.permits.get(nextId);
      if (!permit || permit.status !== "queued") continue;
      const now = this.now();
      if (now >= permit.expiresAt) {
        permit.status = "expired";
        this.rememberSettled(nextId);
        this.permits.delete(nextId);
        continue;
      }
      permit.status = "acquired";
      permit.acquiredAt = now;
    }
  }

  private rememberSettled(requestId: string): void {
    if (this.recentlySettled.has(requestId)) return;
    this.recentlySettled.add(requestId);
    this.recentlySettledOrder.push(requestId);
    while (this.recentlySettledOrder.length > MAX_RECENTLY_SETTLED) {
      const expired = this.recentlySettledOrder.shift();
      if (expired) this.recentlySettled.delete(expired);
    }
  }

  private toPermit(p: ResearchPermit): ResearchPermit {
    return { ...p };
  }
}
