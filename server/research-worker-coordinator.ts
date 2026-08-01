/**
 * Parent-side FIFO coordinator for research workers.
 *
 * Architecture:
 *  - Admits research jobs FIFO up to a configured concurrency cap (default 2,
 *    clamped 1–4).
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
  makeCancelMessage,
  makeRunMessage,
  type ResearchRequestContext,
  type WorkerEvent,
  type ParentMessage,
} from "./research-worker-protocol.js";

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

// ── Options ───────────────────────────────────────────────────────────────

export interface ResearchWorkerCoordinatorOptions {
  /** Maximum concurrent workers (1–4, default 2). */
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
  if (!raw) return 2;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new Error("MARKET_RESEARCH_CONCURRENCY must be an integer from 1 to 4");
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
  private readonly onEvent?: (event: WorkerEvent) => void;
  private readonly onError?: (jobId: string, error: Error) => void;
  private readonly _setTimeout: typeof globalThis.setTimeout;
  private readonly _clearTimeout: typeof globalThis.clearTimeout;

  /** Map from attemptId → active state. */
  private readonly active = new Map<string, ActiveAttempt>();
  /** FIFO waitlist. */
  private readonly queue: QueuedJob[] = [];
  /** Set of jobIds currently active (for fast dedup). */
  private readonly activeJobIds = new Set<string>();
  /** Set of jobIds that have already settled (for `cancel()` idempotency). */
  private readonly settledJobIds = new Set<string>();
  private readonly settledJobOrder: string[] = [];

  private _disposed = false;

  constructor(options: ResearchWorkerCoordinatorOptions) {
    this.concurrency = clampConcurrency(options.concurrency ?? 2);
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? 24);
    this.workerFactory = options.workerFactory;
    this.generateAttemptId =
      options.generateAttemptId ?? defaultAttemptIdGenerator();
    this.graceMs = Math.max(0, options.graceMs ?? 5_000);
    this.deadlineMs = positiveTimeout(options.deadlineMs, 12 * 60_000);
    this.terminalGraceMs = positiveTimeout(options.terminalGraceMs, 5_000);
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this._setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this._clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Enqueue a research job.
   *
   * If a free slot exists the job is dispatched immediately. Otherwise it
   * waits in a FIFO queue until a worker slot opens.
   *
   * Rejects when the queue is full, the jobId is already active/queued, or the
   * coordinator is disposed.
   */
  enqueue(jobId: string, request: ResearchRequestContext): EnqueueResult {
    if (this._disposed) return { accepted: false, status: "rejected", reason: "disposed" };

    // Deduplicate by jobId.
    if (this.activeJobIds.has(jobId)) {
      return { accepted: false, status: "rejected", reason: "job-id-already-active" };
    }
    if (this.queue.some((j) => j.jobId === jobId)) {
      return { accepted: false, status: "rejected", reason: "job-id-already-queued" };
    }
    this.forgetSettledJob(jobId);

    const total = this.active.size + this.queue.length;
    if (total >= this.maxQueueSize) {
      return { accepted: false, status: "rejected", reason: "queue-full" };
    }

    const snapshot = Object.freeze({ ...request });
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
   * - Queued job → removed from the waitlist.
   * - Running job → the worker is sent a cancel message and force-killed
   *   after the grace period. Its slot is released once the worker settles
   *   or the grace timer fires.
   * - Already settled → no-op.
   * - Unknown jobId → no-op.
   */
  cancel(jobId: string): CancelResult {
    if (this._disposed) return { cancelled: false, status: "not-found" };

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

    // Kill every active worker.
    for (const [, attempt] of this.active) {
      this.clearAttemptTimers(attempt);
      try {
        attempt.worker.kill("SIGTERM");
      } catch {
        // Worker may already be dead.
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
    return this.queue.length;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  // ── Internal: dispatch ──────────────────────────────────────────────────

  private dispatch(jobId: string, request: ResearchRequestContext): boolean {
    const attemptId = this.generateAttemptId();

    let worker: WorkerHandle;
    try {
      worker = this.workerFactory({ MARKET_RESEARCH_WORKER: "1" });
    } catch (err) {
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
  if (!Number.isInteger(value) || value < 1) return 2;
  return Math.min(value, 4);
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
