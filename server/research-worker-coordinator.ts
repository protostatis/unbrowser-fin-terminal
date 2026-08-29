/**
 * Parent-side FIFO coordinator for research workers.
 *
 * Architecture:
 *  - Admits research jobs FIFO up to a configured concurrency cap (default 6,
 *    clamped 1–6).
 *  - Each dispatch forks a fresh child process (in production) and sends an
 *    immutable `WorkerRunMessage` snapshot.
 *  - Worker events are validated, sequenced, and fenced: the coordinator
 *    ignores stale, duplicate, out-of-order, post-cancellation, and foreign-
 *    attempt events.
 *  - A cancelled worker is told to stop; after a short grace period it is
 *    force-killed and its slot is released.
 *  - Worker crashes, exits, and protocol errors all release the slot and pump
 *    the FIFO queue.
 *
 * The coordinator is framework-independent. It does NOT import the Pi SDK
 * or the market-terminal extension. Workers do not write persistence.
 */

import { existsSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  isWorkerEvent,
  isValidResearchRequest,
  makeCancelMessage,
  makeRunMessage,
  type ResearchRequestContext,
  type WorkerEvent,
  type ParentMessage,
} from "./research-worker-protocol.js";

/**
 * Maximum wall-clock lifetime of a research child: the parent-enforced
 * deadline (default) plus the post-terminal cleanup grace the child still
 * owns its concurrency slot for. The gateway's acquired-permit TTL MUST
 * exceed this sum, or a permit could expire — and be regranted to another
 * queued job — while the original child is still running.
 */
export const RESEARCH_WORKER_MAX_DEADLINE_MS = 12 * 60_000;
export const RESEARCH_WORKER_TERMINAL_GRACE_MS = 5_000;

// ── Worker instance abstraction ───────────────────────────────────────────

/**
 * Abstract handle to a running worker. Production uses a forked child process;
 * tests provide a fake implementation so no real processes are launched.
 */
export interface WorkerHandle {
  send(message: ParentMessage): void;
  onMessage(handler: (msg: unknown) => void): void;
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  onError(handler: (err: Error) => void): void;
  kill(signal?: string): void;
}

/** Creates a `WorkerHandle` from the supplied env map. */
export type WorkerFactory = (env: Record<string, string>) => WorkerHandle;

// ── Research-permit gate (worker→gateway global concurrency) ───────────────

/** Identity under which a fork acquires a global research permit. */
export interface ResearchPermitIdentity {
  /** Public session that owns this research job (opaque, bounded). */
  sessionId: string;
  /** Worker process generation used for stale-permit reclamation. */
  workerGeneration: string;
}

export interface ResearchPermitAcquireOutcome {
  accepted: boolean;
  status: "acquired" | "queued" | "rejected";
  requestId?: string;
  reason?: string;
  queuePosition?: number;
}

/**
 * Private gateway permit surface used by the coordinator. When configured,
 * every fork is gated on `acquire` (called immediately before the worker
 * factory forks) and the permit is released only after the child exits.
 */
export interface ResearchPermitGate {
  acquire(identity: ResearchPermitIdentity): Promise<ResearchPermitAcquireOutcome>;
  status(requestId: string): Promise<{ requestId: string; status: string }>;
  heartbeat(requestId: string): Promise<void>;
  release(requestId: string): Promise<void>;
}

// ── Options ───────────────────────────────────────────────────────────────

export interface ResearchWorkerCoordinatorOptions {
  /** Maximum concurrent workers (1–6, default 6). */
  concurrency?: number;
  /**
   * Maximum total active-or-queued jobs (default 24, clamped ≥ 1).
   * Counts both running workers AND the FIFO waitlist.
   */
  maxQueueSize?: number;
  /** Creates a worker for a dispatch. Injected for testability. */
  workerFactory: WorkerFactory;
  /** Generates a unique attempt ID for each dispatch. Injected for deterministic tests. */
  generateAttemptId?: () => string;
  /**
   * Milliseconds to wait after sending `cancel` before force-killing a worker.
   * Default 5 000 ms. Set to 0 in tests to fire synchronously.
   */
  graceMs?: number;
  /**
   * Hard wall-clock limit from fork through terminal IPC or child exit.
   * Default 12 minutes, which leaves room for the worker's 10-minute model
   * deadline plus dispatch overhead.
   */
  deadlineMs?: number;
  /**
   * How long to wait for a terminal child to exit before SIGKILL. Terminal
   * workers continue to consume a concurrency slot until their exit event.
   */
  terminalGraceMs?: number;
  /**
   * Global research-permit gate. When present (and `permitIdentity` is also
   * present), every fork is gated on the gateway permit immediately before
   * `workerFactory` runs, and the permit is released only after child exit.
   * When absent the coordinator keeps its previous ungated behavior.
   */
  permitGate?: ResearchPermitGate;
  /** Supplies the session/generation identity used for permit acquisition. */
  permitIdentity?: () => ResearchPermitIdentity;
  /**
   * How long a job may wait for a queued global permit before it settles as
   * failed (ms, default 10 minutes). Bounds permit waits under the public
   * session's absolute limit.
   */
  permitWaitTimeoutMs?: number;
  /**
   * Poll/heartbeat interval while a permit is queued (ms, default 30 s).
   * The heartbeat keeps the owning public session from idle-expiring.
   */
  permitPollIntervalMs?: number;
  /** Called with every validated, in-scope worker event. */
  onEvent?: (event: WorkerEvent) => void;
  /** Called when the coordinator observes a non-recoverable worker fault. */
  onError?: (jobId: string, error: Error) => void;
  /** Override for deterministic tests. */
  setTimeout?: typeof globalThis.setTimeout;
  /** Override for deterministic tests. */
  clearTimeout?: typeof globalThis.clearTimeout;
}

export function readResearchWorkerConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.MARKET_RESEARCH_CONCURRENCY?.trim();
  if (!raw) return 6;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 6) {
    throw new Error("MARKET_RESEARCH_CONCURRENCY must be an integer from 1 to 6");
  }
  return value;
}

// ── Internal state per active attempt ─────────────────────────────────────

interface ActiveAttempt {
  jobId: string;
  attemptId: string;
  worker: WorkerHandle;
  /** True once a settled/fatal event has been forwarded. */
  terminal: boolean;
  /** Greatest sequence number seen so far. Initialised to −1 so seq 0 is accepted. */
  lastSequence: number;
  /** True when cancellation has been requested for this attempt. */
  cancelled: boolean;
  /** Global research permit held for the lifetime of this child (released on exit). */
  permitRequestId?: string;
  /** Handle returned by `setTimeout` for the force-kill. */
  cancelTimer: ReturnType<typeof globalThis.setTimeout> | null;
  /** Parent-enforced deadline that covers worker boot, model work, and IPC. */
  deadlineTimer: ReturnType<typeof globalThis.setTimeout> | null;
  /** Post-terminal cleanup deadline; the child still owns its slot until exit. */
  terminalTimer: ReturnType<typeof globalThis.setTimeout> | null;
}

interface QueuedJob {
  jobId: string;
  request: ResearchRequestContext;
}

/** A job waiting for a global research permit before it may fork. */
interface PermitPendingJob {
  jobId: string;
  request: ResearchRequestContext;
  requestId?: string;
  /** Bound on the total wait for a queued permit. */
  waitTimer: ReturnType<typeof globalThis.setTimeout> | null;
  /** Heartbeat/poll interval while the permit is queued. */
  pollTimer: ReturnType<typeof globalThis.setTimeout> | null;
}

// ── Result shapes ─────────────────────────────────────────────────────────

export interface EnqueueResult {
  accepted: boolean;
  status: "dispatched" | "queued" | "rejected";
  reason?: string;
}

export interface CancelResult {
  cancelled: boolean;
  status: "queued-removed" | "running-cancelled" | "already-settled" | "not-found";
}

// ── Implementation ────────────────────────────────────────────────────────

export class ResearchWorkerCoordinator {
  private readonly concurrency: number;
  private readonly maxQueueSize: number;
  private readonly workerFactory: WorkerFactory;
  private readonly generateAttemptId: () => string;
  private readonly graceMs: number;
  private readonly deadlineMs: number;
  private readonly terminalGraceMs: number;
  private readonly permitGate?: ResearchPermitGate;
  private readonly permitIdentity?: () => ResearchPermitIdentity;
  private readonly permitWaitTimeoutMs: number;
  private readonly permitPollIntervalMs: number;
  private readonly onEvent?: (event: WorkerEvent) => void;
  private readonly onError?: (jobId: string, error: Error) => void;
  private readonly _setTimeout: typeof globalThis.setTimeout;
  private readonly _clearTimeout: typeof globalThis.clearTimeout;

  /** Map from attemptId → active state. */
  private readonly active = new Map<string, ActiveAttempt>();
  /** FIFO waitlist. */
  private readonly queue: QueuedJob[] = [];
  /** Jobs waiting for a global research permit before they can fork. */
  private readonly permitPending = new Map<string, PermitPendingJob>();
  /** Set of jobIds currently active (for fast dedup). */
  private readonly activeJobIds = new Set<string>();
  /** Set of jobIds that have already settled (for `cancel()` idempotency). */
  private readonly settledJobIds = new Set<string>();
  private readonly settledJobOrder: string[] = [];

  private _disposed = false;

  constructor(options: ResearchWorkerCoordinatorOptions) {
    this.concurrency = clampConcurrency(options.concurrency ?? 6);
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? 24);
    this.workerFactory = options.workerFactory;
    this.generateAttemptId =
      options.generateAttemptId ?? defaultAttemptIdGenerator();
    this.graceMs = Math.max(0, options.graceMs ?? 5_000);
    this.deadlineMs = positiveTimeout(options.deadlineMs, RESEARCH_WORKER_MAX_DEADLINE_MS);
    this.terminalGraceMs = positiveTimeout(options.terminalGraceMs, RESEARCH_WORKER_TERMINAL_GRACE_MS);
    this.permitGate = options.permitGate;
    this.permitIdentity = options.permitIdentity;
    this.permitWaitTimeoutMs = positiveTimeout(options.permitWaitTimeoutMs, 10 * 60_000);
    this.permitPollIntervalMs = positiveTimeout(options.permitPollIntervalMs, 30_000);
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    // Keep the native timer receiver intact when this coordinator is bundled
    // into a browser session. Chromium treats some Window timer methods as
    // Web-IDL operations and can throw "Illegal invocation" when they are
    // called through an arbitrary object (`this._setTimeout(...)`). The Node
    // path is behaviorally identical; the explicit bind only preserves the
    // browser host's global receiver.
    this._setTimeout = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this._clearTimeout = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Enqueue a research job.
   *
   * If a free slot exists (and no global permit gate is configured) the job is
   * dispatched immediately. Otherwise it waits in a FIFO queue until a worker
   * slot opens. With a permit gate configured, the job additionally waits for a
   * global research permit before the fork; it stays visibly queued, is
   * heartbeated to keep the owning session alive, and is bounded by
   * `permitWaitTimeoutMs`.
   *
   * Rejects when the queue is full, the jobId is already active/queued, or the
   * coordinator is disposed.
   */
  enqueue(jobId: string, request: ResearchRequestContext): EnqueueResult {
    if (this._disposed) return { accepted: false, status: "rejected", reason: "disposed" };
    if (!isValidResearchRequest(request)) {
      return { accepted: false, status: "rejected", reason: "invalid-research-request" };
    }

    // Deduplicate by jobId.
    if (this.activeJobIds.has(jobId)) {
      return { accepted: false, status: "rejected", reason: "job-id-already-active" };
    }
    if (this.queue.some((j) => j.jobId === jobId)) {
      return { accepted: false, status: "rejected", reason: "job-id-already-queued" };
    }
    this.forgetSettledJob(jobId);

    const total = this.active.size + this.queue.length + this.permitPending.size;
    if (total >= this.maxQueueSize) {
      return { accepted: false, status: "rejected", reason: "queue-full" };
    }

    const snapshot = Object.freeze({ ...request });

    // Global permit gate: acquire the gateway permit before any fork. The job
    // stays visibly queued until the permit is granted, then dispatches.
    if (this.permitGate && this.permitIdentity) {
      const pending: PermitPendingJob = {
        jobId,
        request: snapshot,
        waitTimer: null,
        pollTimer: null,
      };
      this.permitPending.set(jobId, pending);
      this.activeJobIds.add(jobId);
      void this.acquirePermitAndDispatch(jobId);
      return { accepted: true, status: "queued" };
    }

    if (this.active.size < this.concurrency) {
      if (this.dispatch(jobId, snapshot)) {
        return { accepted: true, status: "dispatched" };
      }
      return { accepted: false, status: "rejected", reason: "worker-start-failed" };
    }

    this.queue.push({ jobId, request: snapshot });
    return { accepted: true, status: "queued" };
  }

  /**
   * Cancel a job by its public jobId.
   *
   * - Queued/permit-pending job → removed from the waitlist; its permit (if
   *   any) is released.
   * - Running job → the worker is sent a cancel message and force-killed
   *   after the grace period. Its slot and permit are released once the worker
   *   settles or the grace timer fires.
   * - Already settled → no-op.
   * - Unknown jobId → no-op.
   */
  cancel(jobId: string): CancelResult {
    if (this._disposed) return { cancelled: false, status: "not-found" };

    // 0. Permit-pending job: release its permit and remove the wait.
    const pending = this.permitPending.get(jobId);
    if (pending) {
      this.clearPermitWait(pending);
      this.permitPending.delete(jobId);
      this.activeJobIds.delete(jobId);
      if (pending.requestId) {
        void this.permitGate?.release(pending.requestId).catch(() => {});
      }
      return { cancelled: true, status: "queued-removed" };
    }

    // 1. Check the waitlist first.
    const queuedIndex = this.queue.findIndex((j) => j.jobId === jobId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      return { cancelled: true, status: "queued-removed" };
    }

    // 2. Check settled jobs (released from the active map but already complete).
    if (this.settledJobIds.has(jobId)) {
      return { cancelled: false, status: "already-settled" };
    }

    // 3. Check active attempts.
    for (const [attemptId, attempt] of this.active) {
      if (attempt.jobId !== jobId) continue;

      // Fence: all future events from this attempt are now ignored.
      attempt.cancelled = true;

      // Ask the worker to abort.
      try {
        attempt.worker.send(makeCancelMessage(jobId, attemptId));
      } catch {
        // The IPC channel may already be gone. The parent has fenced this
        // attempt, so terminate it immediately rather than leaking a slot.
        this.killAndRelease(attemptId, attempt);
        return { cancelled: true, status: "running-cancelled" };
      }

      // Force-kill after the grace period.
      if (attempt.cancelTimer !== null) {
        this._clearTimeout(attempt.cancelTimer);
      }
      attempt.cancelTimer = this._setTimeout(() => {
        attempt.cancelTimer = null;
        this.killAndRelease(attemptId, attempt);
      }, this.graceMs);

      return { cancelled: true, status: "running-cancelled" };
    }

    return { cancelled: false, status: "not-found" };
  }

  /**
   * Terminate all workers, clear the queue, and release all resources.
   * Idempotent — safe to call more than once.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // Clear waitlist.
    this.queue.length = 0;

    // Release any permits held by permit-pending jobs.
    for (const [, pending] of this.permitPending) {
      this.clearPermitWait(pending);
      if (pending.requestId) {
        try {
          void this.permitGate?.release(pending.requestId).catch(() => {});
        } catch {
          // best-effort release during shutdown
        }
      }
    }
    this.permitPending.clear();

    // Kill every active worker and release its held permit.
    for (const [, attempt] of this.active) {
      this.clearAttemptTimers(attempt);
      try {
        attempt.worker.kill("SIGTERM");
      } catch {
        // Worker may already be dead.
      }
      if (attempt.permitRequestId) {
        try {
          void this.permitGate?.release(attempt.permitRequestId).catch(() => {});
        } catch {
          // best-effort release during shutdown
        }
        attempt.permitRequestId = undefined;
      }
    }
    this.active.clear();
    this.activeJobIds.clear();
    this.settledJobIds.clear();
    this.settledJobOrder.length = 0;
  }

  // ── Read-only introspection (for tests) ─────────────────────────────────

  get activeCount(): number {
    return this.active.size;
  }

  get queuedCount(): number {
    return this.queue.length + this.permitPending.size;
  }

  /** Number of jobs still waiting for a global research permit. */
  get permitPendingCount(): number {
    return this.permitPending.size;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  // ── Internal: dispatch ──────────────────────────────────────────────────

  private dispatch(
    jobId: string,
    request: ResearchRequestContext,
    permitRequestId?: string,
  ): boolean {
    const attemptId = this.generateAttemptId();

    let worker: WorkerHandle;
    try {
      const workerEnv: Record<string, string> = { MARKET_RESEARCH_WORKER: "1" };
      if (request.modelProvider === "openrouter" && request.modelId) {
        // Scout jobs may use a free, request-scoped model without changing the
        // process-global model used by interactive and pre-cache research.
        workerEnv.MARKET_MODEL_PROVIDER = "openrouter";
        workerEnv.MARKET_MODEL_ID = request.modelId;
        workerEnv.OPENROUTER_MODEL = request.modelId;
      }
      worker = this.workerFactory(workerEnv);
    } catch (err) {
      // The caller (dispatchWithPermit) returns a held permit on `false`.
      this.emitError(
        jobId,
        err instanceof Error ? err : new Error(String(err)),
      );
      return false;
    }

    const attempt: ActiveAttempt = {
      jobId,
      attemptId,
      worker,
      terminal: false,
      lastSequence: -1,
      cancelled: false,
      permitRequestId,
      cancelTimer: null,
      deadlineTimer: null,
      terminalTimer: null,
    };

    this.active.set(attemptId, attempt);
    this.activeJobIds.add(jobId);
    attempt.deadlineTimer = this._setTimeout(() => {
      this.expireAttempt(attemptId, attempt);
    }, this.deadlineMs);

    // ── Wire worker lifecycle ───────────────────────────────────────────

    worker.onMessage((raw) => {
      if (this._disposed) return;
      const current = this.active.get(attemptId);

      // Guard: attempt is gone (already released) or fenced.
      if (!current || current.cancelled || current.terminal) return;

      if (!isWorkerEvent(raw)) return;

      // Only accept events matching the registered pair.
      if (raw.jobId !== jobId || raw.attemptId !== attemptId) return;

      // Enforce strictly-increasing sequence.
      if (raw.sequence <= current.lastSequence) return;
      current.lastSequence = raw.sequence;

      // Forward.
      try {
        this.onEvent?.(raw);
      } catch {
        // Consumer callback must not crash the coordinator.
      }

      // A terminal event means the parent may finalize the job, but the child
      // still owns its slot until it exits. This prevents process-count drift
      // when cleanup stalls after an otherwise valid terminal IPC message.
      if (raw.type === "settled" || raw.type === "fatal") {
        current.terminal = true;
        this.clearDeadlineTimer(current);
        current.terminalTimer = this._setTimeout(() => {
          this.killTerminalWorker(attemptId, current);
        }, this.terminalGraceMs);
      }
    });

    worker.onExit((code, signal) => {
      if (this._disposed) return;
      const current = this.active.get(attemptId);
      if (!current) return;

      if (!current.terminal && !current.cancelled) {
        // Worker exited without a settled/fatal event → treat as crash.
        this.emitError(
          jobId,
          new Error(
            `Worker exited unexpectedly with code ${code ?? "null"} signal ${signal ?? "null"}`,
          ),
        );
      }
      this.releaseSlot(attemptId);
    });

    worker.onError((err) => {
      if (this._disposed) return;
      const current = this.active.get(attemptId);
      if (current && !current.terminal) {
        this.emitError(jobId, err);
        this.killAndRelease(attemptId, current);
      }
    });

    // ── Send the immutable run snapshot ──────────────────────────────────

    try {
      worker.send(makeRunMessage(jobId, attemptId, request));
    } catch (err) {
      this.emitError(
        jobId,
        err instanceof Error ? err : new Error(String(err)),
      );
      this.killAndRelease(attemptId, attempt);
      return false;
    }
    return true;
  }

  // ── Internal: slot management ───────────────────────────────────────────

  private releaseSlot(attemptId: string): void {
    const attempt = this.active.get(attemptId);
    if (!attempt) return;

    this.clearAttemptTimers(attempt);

    this.active.delete(attemptId);
    this.activeJobIds.delete(attempt.jobId);

    // A globally-gated permit is held for the lifetime of the child process.
    // Release it only now that the child has actually exited.
    if (attempt.permitRequestId) {
      try {
        void this.permitGate?.release(attempt.permitRequestId).catch(() => {});
      } catch {
        // best-effort release; the gateway TTL still frees the slot
      }
      attempt.permitRequestId = undefined;
    }

    // Track settled job IDs so cancel() can distinguish "already-settled" from
    // "not-found" even after the attempt record is gone.
    this.rememberSettledJob(attempt.jobId);

    this.pumpQueue();
  }

  private killAndRelease(attemptId: string, attempt: ActiveAttempt): void {
    // Only act if this exact attempt is still registered.
    const current = this.active.get(attemptId);
    if (current !== attempt) return;

    try {
      attempt.worker.kill("SIGKILL");
    } catch {
      // Already dead.
    }

    this.releaseSlot(attemptId);
  }

  private expireAttempt(attemptId: string, attempt: ActiveAttempt): void {
    const current = this.active.get(attemptId);
    if (current !== attempt || current.terminal || current.cancelled) return;
    current.cancelled = true;
    this.emitError(
      current.jobId,
      new Error(`Research worker exceeded its ${Math.round(this.deadlineMs / 1_000)}s parent deadline`),
    );
    this.killAndRelease(attemptId, current);
  }

  private killTerminalWorker(attemptId: string, attempt: ActiveAttempt): void {
    const current = this.active.get(attemptId);
    if (current !== attempt || !current.terminal) return;
    current.terminalTimer = null;
    try {
      current.worker.kill("SIGKILL");
    } catch {
      // If the process is already gone, its exit listener will release the slot.
    }
  }

  private clearDeadlineTimer(attempt: ActiveAttempt): void {
    if (attempt.deadlineTimer === null) return;
    this._clearTimeout(attempt.deadlineTimer);
    attempt.deadlineTimer = null;
  }

  private clearAttemptTimers(attempt: ActiveAttempt): void {
    if (attempt.cancelTimer !== null) {
      this._clearTimeout(attempt.cancelTimer);
      attempt.cancelTimer = null;
    }
    this.clearDeadlineTimer(attempt);
    if (attempt.terminalTimer !== null) {
      this._clearTimeout(attempt.terminalTimer);
      attempt.terminalTimer = null;
    }
  }

  private pumpQueue(): void {
    while (
      !this._disposed &&
      this.active.size < this.concurrency &&
      this.queue.length > 0
    ) {
      const next = this.queue.shift()!;
      this.dispatch(next.jobId, next.request);
    }
  }

  // ── Internal: global permit gate ────────────────────────────────────────

  /** Acquire the gateway permit, then fork once granted (or fail the job). */
  private async acquirePermitAndDispatch(jobId: string): Promise<void> {
    const pending = this.permitPending.get(jobId);
    if (!pending || this._disposed || !this.permitGate || !this.permitIdentity) return;

    let outcome: ResearchPermitAcquireOutcome;
    try {
      outcome = await this.permitGate.acquire(this.permitIdentity());
    } catch {
      this.settlePermitFailure(jobId, "permit-acquire-error");
      return;
    }
    if (this._disposed) {
      if (outcome.requestId) {
        try {
          void this.permitGate.release(outcome.requestId).catch(() => {});
        } catch {
          // best-effort release
        }
      }
      return;
    }
    const current = this.permitPending.get(jobId);
    if (!current) {
      // Cancelled while the acquire call was in flight.
      if (outcome.requestId) {
        try {
          void this.permitGate.release(outcome.requestId).catch(() => {});
        } catch {
          // best-effort release
        }
      }
      return;
    }
    if (!outcome.accepted || !outcome.requestId) {
      this.settlePermitFailure(jobId, outcome.reason ?? "permit-rejected");
      return;
    }
    current.requestId = outcome.requestId;
    if (outcome.status === "acquired") {
      this.dispatchWithPermit(jobId);
      return;
    }
    // Queued: heartbeat/poll until granted or the bounded wait expires.
    this.startPermitWait(jobId);
  }

  /** Poll the gateway while a permit is queued; heartbeat keeps the session alive. */
  private startPermitWait(jobId: string): void {
    const pending = this.permitPending.get(jobId);
    if (!pending || this._disposed || !this.permitGate || !pending.requestId) return;

    const poll = () => {
      if (this._disposed) return;
      const current = this.permitPending.get(jobId);
      if (!current || !current.requestId) return;
      const requestId = current.requestId;
      void this.permitGate!.status(requestId).then((status) => {
        if (this._disposed) return;
        const latest = this.permitPending.get(jobId);
        if (!latest || latest.requestId !== requestId) return;
        if (status.status === "acquired") {
          this.dispatchWithPermit(jobId);
          return;
        }
        if (status.status === "expired" || status.status === "cancelled" || status.status === "released") {
          this.settlePermitFailure(jobId, `permit-${status.status}`);
          return;
        }
        // Still queued: extend the owning session's idle lease.
        void this.permitGate!.heartbeat(requestId).catch(() => {});
        latest.pollTimer = this._setTimeout(poll, this.permitPollIntervalMs);
        if (latest.pollTimer && typeof latest.pollTimer !== "number") latest.pollTimer.unref?.();
      }).catch(() => {
        const latest = this.permitPending.get(jobId);
        if (!latest) return;
        latest.pollTimer = this._setTimeout(poll, this.permitPollIntervalMs);
        if (latest.pollTimer && typeof latest.pollTimer !== "number") latest.pollTimer.unref?.();
      });
    };

    pending.waitTimer = this._setTimeout(() => {
      const current = this.permitPending.get(jobId);
      if (!current || this._disposed) return;
      if (current.requestId) {
        try {
          void this.permitGate?.release(current.requestId).catch(() => {});
        } catch {
          // best-effort release
        }
      }
      this.settlePermitFailure(jobId, "permit-wait-timeout");
    }, this.permitWaitTimeoutMs);
    if (pending.waitTimer && typeof pending.waitTimer !== "number") pending.waitTimer.unref?.();

    poll();
  }

  /** Fork the child once the permit is granted (slot availability permitting). */
  private dispatchWithPermit(jobId: string): void {
    const pending = this.permitPending.get(jobId);
    if (!pending || this._disposed) return;
    if (!pending.requestId) {
      this.settlePermitFailure(jobId, "permit-rejected");
      return;
    }
    const requestId = pending.requestId;
    this.clearPermitWait(pending);
    if (this.active.size >= this.concurrency) {
      // A local slot opened late; return to the bounded wait.
      this.startPermitWait(jobId);
      return;
    }
    this.permitPending.delete(jobId);
    this.activeJobIds.delete(jobId);
    if (this.dispatch(jobId, pending.request, requestId)) {
      // The attempt now owns the permit; it is released on child exit.
    } else {
      try {
        void this.permitGate?.release(requestId).catch(() => {});
      } catch {
        // best-effort release
      }
    }
  }

  private clearPermitWait(pending: PermitPendingJob): void {
    if (pending.waitTimer !== null) {
      this._clearTimeout(pending.waitTimer);
      pending.waitTimer = null;
    }
    if (pending.pollTimer !== null) {
      this._clearTimeout(pending.pollTimer);
      pending.pollTimer = null;
    }
  }

  private settlePermitFailure(jobId: string, reason: string): void {
    const pending = this.permitPending.get(jobId);
    if (!pending) return;
    this.clearPermitWait(pending);
    this.permitPending.delete(jobId);
    this.activeJobIds.delete(jobId);
    this.emitError(jobId, new Error(`Research worker could not acquire a global permit: ${reason}`));
  }

  private emitError(jobId: string, error: Error): void {
    try {
      this.onError?.(jobId, error);
    } catch {
      // Consumer callback must not crash the coordinator.
    }
  }

  private rememberSettledJob(jobId: string): void {
    if (this.settledJobIds.has(jobId)) return;
    this.settledJobIds.add(jobId);
    this.settledJobOrder.push(jobId);
    while (this.settledJobOrder.length > 64) {
      const expired = this.settledJobOrder.shift();
      if (expired) this.settledJobIds.delete(expired);
    }
  }

  private forgetSettledJob(jobId: string): void {
    if (!this.settledJobIds.delete(jobId)) return;
    const index = this.settledJobOrder.indexOf(jobId);
    if (index >= 0) this.settledJobOrder.splice(index, 1);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function clampConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1) return 6;
  return Math.min(value, 6);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function defaultAttemptIdGenerator(): () => string {
  let counter = 0;
  const pidPrefix = typeof process !== "undefined" && process.pid
    ? `w${process.pid}-`
    : "w-";
  return () => {
    counter += 1;
    return `${pidPrefix}${counter}-${Math.random().toString(36).slice(2, 8)}`;
  };
}

// ── Default production worker factory ─────────────────────────────────────

function defaultWorkerScriptPath(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(__dirname, "research-worker.js");
  if (existsSync(compiled)) return compiled;
  return path.join(__dirname, "research-worker.ts");
}

export function createDefaultWorkerFactory(): WorkerFactory {
  return (env) => {
    const scriptPath = defaultWorkerScriptPath();
    const compiledReady = scriptPath.endsWith(".js");
    const execArgv = compiledReady ? [] : ["--import", "tsx"];

    let child: ChildProcess;
    try {
      child = fork(scriptPath, [], {
        env: {
          ...process.env,
          ...env,
          MARKET_RESEARCH_WORKER: "1",
          // The extension also fails archive operations closed in worker mode.
          // Clearing this prevents accidental future code from targeting the
          // parent's persistent data directory.
          MARKET_DATA_DIR: "",
        },
        execArgv,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "advanced",
      });
    } catch (err) {
      throw new Error(
        `Failed to fork research worker at ${scriptPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Suppress worker stdout/stderr in production (they go through IPC).
    child.stdout?.resume();
    child.stderr?.resume();

    return {
      send(message) {
        child.send(message);
      },
      onMessage(handler) {
        child.on("message", handler);
      },
      onExit(handler) {
        child.on("exit", handler);
      },
      onError(handler) {
        child.on("error", handler);
      },
      kill(signal) {
        child.kill((signal as NodeJS.Signals) ?? "SIGTERM");
      },
    };
  };
}
