/**
 * Deterministic tests for the ResearchWorkerCoordinator.
 *
 * Tests use a FakeWorker that never forks a real process. All timing is
 * controlled via injected timer stubs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ResearchWorkerCoordinator,
  readResearchWorkerConcurrency,
  type EnqueueResult,
  type CancelResult,
  type WorkerHandle,
  type WorkerFactory,
  type ResearchWorkerCoordinatorOptions,
} from "../server/research-worker-coordinator.js";
import {
  isWorkerStartedEvent,
  isWorkerJobEvent,
  isWorkerCanvasEvent,
  isWorkerSettledEvent,
  isWorkerFatalEvent,
  isParentMessage,
  makeRunMessage,
  makeCancelMessage,
  type WorkerEvent,
  type ParentMessage,
  type ResearchRequestContext,
} from "../server/research-worker-protocol.js";

// ── Test helpers ──────────────────────────────────────────────────────────

const sampleRequest: ResearchRequestContext = {
  symbol: "AAPL",
  question: "Why did Apple move today?",
  chartScope: "day",
  researchKey: "v1/ticker/why",
  intent: "why",
  contextLabel: "AAPL WHY",
};

let nextAttemptCounter = 0;
function sequentialAttemptId(): string {
  nextAttemptCounter += 1;
  return `attempt-${nextAttemptCounter}`;
}

/** Fake `setTimeout` / `clearTimeout` pair for deterministic testing. */
function createFakeTimers() {
  const pending = new Map<number, { dueAt: number; fn: () => void }>();
  let nextId = 0;
  let now = 0;
  return {
    setTimeout: (fn: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
      const id = nextId++;
      pending.set(id, { dueAt: now + Math.max(0, ms), fn });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: (id: ReturnType<typeof globalThis.setTimeout> | undefined): void => {
      if (typeof id === "number") pending.delete(id);
    },
    /** Advance virtual time and run due callbacks in deadline order. */
    advance(ms: number): void {
      const target = now + Math.max(0, ms);
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0])[0];
        if (!due) break;
        const [id, timer] = due;
        pending.delete(id);
        now = timer.dueAt;
        timer.fn();
      }
      now = target;
    },
  };
}

/** A fake worker that never forks a process. */
class FakeWorker implements WorkerHandle {
  private messageHandler: ((msg: unknown) => void) | null = null;
  private exitHandler: ((code: number | null, signal: string | null) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  public sentMessages: ParentMessage[] = [];
  public killed = false;
  public killSignal: string | null = null;
  public throwOnSend = false;

  send(message: ParentMessage): void {
    if (this.throwOnSend) throw new Error("IPC disconnected");
    this.sentMessages.push(message);
  }

  onMessage(handler: (msg: unknown) => void): void {
    this.messageHandler = handler;
  }

  onExit(handler: (code: number | null, signal: string | null) => void): void {
    this.exitHandler = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignal = signal ?? "SIGTERM";
  }

  // ── Test-facing helpers ────────────────────────────────────────────────

  emitMessage(msg: unknown): void {
    this.messageHandler?.(msg);
  }

  emitExit(code: number | null, signal: string | null): void {
    this.exitHandler?.(code, signal);
  }

  emitError(err: Error): void {
    this.errorHandler?.(err);
  }
}

/** Build a coordinator with fake worker factory and deterministic IDs. */
function createTestCoordinator(
  overrides: Partial<ResearchWorkerCoordinatorOptions> = {},
): {
  coordinator: ResearchWorkerCoordinator;
  workers: FakeWorker[];
  timers: ReturnType<typeof createFakeTimers>;
  events: WorkerEvent[];
  errors: Array<{ jobId: string; error: Error }>;
} {
  nextAttemptCounter = 0;
  const workers: FakeWorker[] = [];
  const timers = createFakeTimers();
  const events: WorkerEvent[] = [];
  const errors: Array<{ jobId: string; error: Error }> = [];

  const workerFactory: WorkerFactory = (_env) => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  };

  const coordinator = new ResearchWorkerCoordinator({
    concurrency: 2,
    maxQueueSize: 6,
    workerFactory,
    generateAttemptId: sequentialAttemptId,
    graceMs: 0,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onEvent: (e) => events.push(e),
    onError: (jobId, err) => errors.push({ jobId, error: err }),
    ...overrides,
  });

  return { coordinator, workers, timers, events, errors };
}

/** Build a well-formed worker started event. */
function started(
  jobId: string,
  attemptId: string,
  seq: number,
): WorkerEvent {
  return { version: 1, type: "started", jobId, attemptId, sequence: seq };
}

/** Build a well-formed job event. */
function jobEvent(
  jobId: string,
  attemptId: string,
  seq: number,
): WorkerEvent {
  return {
    version: 1,
    type: "job",
    jobId,
    attemptId,
    sequence: seq,
    outcome: "running",
    activity: "fetching",
  };
}

/** Build a well-formed canvas event. */
function canvasEvent(
  jobId: string,
  attemptId: string,
  seq: number,
): WorkerEvent {
  return {
    version: 1,
    type: "canvas",
    jobId,
    attemptId,
    sequence: seq,
    canvas: {
      symbol: "AAPL",
      title: "Apple Inc research",
      content: "Some research content",
      updatedAt: Date.now(),
    },
  };
}

/** Build a well-formed settled event. */
function settled(
  jobId: string,
  attemptId: string,
  seq: number,
  outcome: "complete" | "failed" = "complete",
): WorkerEvent {
  return {
    version: 1,
    type: "settled",
    jobId,
    attemptId,
    sequence: seq,
    outcome,
  };
}

/** Build a well-formed fatal event. */
function fatal(
  jobId: string,
  attemptId: string,
  seq: number,
  error = "fatal error",
): WorkerEvent {
  return {
    version: 1,
    type: "fatal",
    jobId,
    attemptId,
    sequence: seq,
    error,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("enqueue dispatches immediately when a slot is free", () => {
  const { coordinator, workers, events } = createTestCoordinator();

  const result = coordinator.enqueue("job-1", sampleRequest);
  assert.equal(result.status, "dispatched");
  assert.equal(result.accepted, true);
  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.queuedCount, 0);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].sentMessages.length, 1);
  assert.ok(isParentMessage(workers[0].sentMessages[0]));
  assert.equal(workers[0].sentMessages[0].type, "run");
});

test("scout requests select a model in the isolated worker without changing parent config", () => {
  let workerEnv: Record<string, string> | undefined;
  const worker = new FakeWorker();
  const { coordinator } = createTestCoordinator({
    workerFactory: (env) => {
      workerEnv = env;
      return worker;
    },
  });
  const result = coordinator.enqueue("job-scout", {
    ...sampleRequest,
    origin: "scout",
    modelProvider: "openrouter",
    modelId: "nvidia/nemotron-3.5-lightning:free",
    scoutCandidateId: `trg-${"a".repeat(32)}`,
    intent: "brief",
    researchKey: "v1/ticker/brief",
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(workerEnv, {
    MARKET_RESEARCH_WORKER: "1",
    MARKET_MODEL_PROVIDER: "openrouter",
    MARKET_MODEL_ID: "nvidia/nemotron-3.5-lightning:free",
    OPENROUTER_MODEL: "nvidia/nemotron-3.5-lightning:free",
  });
});

test("coordinator rejects a paid or otherwise non-pinned scout model", () => {
  const { coordinator, workers } = createTestCoordinator();
  const result = coordinator.enqueue("job-scout-paid", {
    ...sampleRequest,
    origin: "scout",
    modelProvider: "openrouter",
    modelId: "openai/gpt-5",
    scoutCandidateId: `trg-${"b".repeat(32)}`,
    intent: "brief",
    researchKey: "v1/ticker/brief",
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "invalid-research-request");
  assert.equal(workers.length, 0);
});

test("worker concurrency defaults to six and rejects unsafe environment values", () => {
  assert.equal(readResearchWorkerConcurrency({}), 6);
  assert.equal(readResearchWorkerConcurrency({ MARKET_RESEARCH_CONCURRENCY: "1" }), 1);
  assert.equal(readResearchWorkerConcurrency({ MARKET_RESEARCH_CONCURRENCY: "6" }), 6);
  assert.throws(
    () => readResearchWorkerConcurrency({ MARKET_RESEARCH_CONCURRENCY: "0" }),
    /must be an integer from 1 to 6/,
  );
  assert.throws(
    () => readResearchWorkerConcurrency({ MARKET_RESEARCH_CONCURRENCY: "7" }),
    /must be an integer from 1 to 6/,
  );
  assert.throws(
    () => readResearchWorkerConcurrency({ MARKET_RESEARCH_CONCURRENCY: "two" }),
    /must be an integer from 1 to 6/,
  );
});

test("max-two concurrent workers with FIFO queueing", () => {
  const { coordinator, workers, events } = createTestCoordinator();

  // First two are dispatched immediately.
  const r1 = coordinator.enqueue("job-1", sampleRequest);
  const r2 = coordinator.enqueue("job-2", sampleRequest);
  assert.equal(r1.status, "dispatched");
  assert.equal(r2.status, "dispatched");
  assert.equal(coordinator.activeCount, 2);
  assert.equal(workers.length, 2);

  // Third goes to the waitlist.
  const r3 = coordinator.enqueue("job-3", { ...sampleRequest, question: "Q3" });
  assert.equal(r3.status, "queued");
  assert.equal(r3.accepted, true);
  assert.equal(coordinator.activeCount, 2);
  assert.equal(coordinator.queuedCount, 1);
});

test("queued work uses an immutable request snapshot", () => {
  const { coordinator, workers } = createTestCoordinator({ concurrency: 1, maxQueueSize: 3 });
  coordinator.enqueue("job-1", sampleRequest);
  const queuedRequest = { ...sampleRequest, question: "Original queued question" };
  coordinator.enqueue("job-2", queuedRequest);
  queuedRequest.question = "Mutated after enqueue";

  workers[0].emitMessage(started("job-1", "attempt-1", 0));
  workers[0].emitMessage(settled("job-1", "attempt-1", 1));
  workers[0].emitExit(0, null);

  const run = workers[1].sentMessages[0];
  assert.equal(run.type, "run");
  if (run.type === "run") assert.equal(run.request.question, "Original queued question");
});

test("duplicate jobId is rejected while active or queued", () => {
  const { coordinator } = createTestCoordinator();

  // Fill both slots + queue one.
  coordinator.enqueue("job-1", sampleRequest);
  coordinator.enqueue("job-2", { ...sampleRequest, question: "Q2" });
  coordinator.enqueue("job-3", { ...sampleRequest, question: "Q3" });

  // Duplicate active
  let dup = coordinator.enqueue("job-1", sampleRequest);
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, "job-id-already-active");

  // Duplicate queued
  dup = coordinator.enqueue("job-3", sampleRequest);
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, "job-id-already-queued");
});

test("queue size is capped", () => {
  const { coordinator } = createTestCoordinator({ concurrency: 1, maxQueueSize: 3 });

  coordinator.enqueue("job-0", sampleRequest);
  coordinator.enqueue("job-1", { ...sampleRequest, question: "Q1" });
  coordinator.enqueue("job-2", { ...sampleRequest, question: "Q2" });
  const rejected = coordinator.enqueue("job-3", { ...sampleRequest, question: "Q3" });
  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.queuedCount, 2);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "queue-full");
});

test("disposed coordinator rejects enqueue and cancel", () => {
  const { coordinator } = createTestCoordinator();
  coordinator.dispose();

  const r = coordinator.enqueue("job-1", sampleRequest);
  assert.equal(r.accepted, false);
  assert.equal(r.status, "rejected");
  assert.equal(r.reason, "disposed");

  const c = coordinator.cancel("job-1");
  assert.equal(c.cancelled, false);
  assert.equal(c.status, "not-found");
});

test("cancel removes a queued job", () => {
  const { coordinator } = createTestCoordinator({ concurrency: 1 });
  coordinator.enqueue("job-1", sampleRequest); // dispatched
  coordinator.enqueue("job-2", { ...sampleRequest, question: "Q2" }); // queued
  coordinator.enqueue("job-3", { ...sampleRequest, question: "Q3" }); // queued

  assert.equal(coordinator.queuedCount, 2);

  const result = coordinator.cancel("job-2");
  assert.equal(result.cancelled, true);
  assert.equal(result.status, "queued-removed");
  assert.equal(coordinator.queuedCount, 1);
});

test("cancel an unknown job returns not-found", () => {
  const { coordinator } = createTestCoordinator();
  const result = coordinator.cancel("nonexistent");
  assert.equal(result.cancelled, false);
  assert.equal(result.status, "not-found");
});

test("cancel fences a running worker and sends cancel message", () => {
  const { coordinator, workers, timers } = createTestCoordinator({ concurrency: 2 });
  coordinator.enqueue("job-1", sampleRequest);
  const w = workers[0];
  assert.ok(w);

  // Simulate the worker sending "started" and "job" events.
  w.emitMessage(started("job-1", "attempt-1", 0));
  w.emitMessage(jobEvent("job-1", "attempt-1", 1));

  // Cancel the running job.
  const result = coordinator.cancel("job-1");
  assert.equal(result.cancelled, true);
  assert.equal(result.status, "running-cancelled");

  // The worker should have received a cancel message.
  const cancelMsg = w.sentMessages[w.sentMessages.length - 1];
  assert.ok(isParentMessage(cancelMsg));
  assert.equal(cancelMsg.type, "cancel");
  assert.equal(cancelMsg.jobId, "job-1");
  assert.equal(cancelMsg.attemptId, "attempt-1");

  // Cancel timer is set; flush it to force-kill.
  timers.advance(0);
  assert.equal(w.killed, true);
  assert.equal(w.killSignal, "SIGKILL");
});

test("cancel handles a disconnected IPC channel without leaking a slot", () => {
  const { coordinator, workers } = createTestCoordinator({ concurrency: 1 });
  coordinator.enqueue("job-1", sampleRequest);
  const worker = workers[0];
  worker.throwOnSend = true;

  const result = coordinator.cancel("job-1");
  assert.equal(result.cancelled, true);
  assert.equal(result.status, "running-cancelled");
  assert.equal(worker.killed, true);
  assert.equal(worker.killSignal, "SIGKILL");
  assert.equal(coordinator.activeCount, 0);
});

test("late events from a cancelled worker are ignored (fencing)", () => {
  const { coordinator, workers, timers, events } = createTestCoordinator({ concurrency: 1, maxQueueSize: 3 });
  coordinator.enqueue("job-1", sampleRequest);
  const w = workers[0];
  assert.ok(w);

  // Worker reports started, then a canvas.
  w.emitMessage(started("job-1", "attempt-1", 0));
  w.emitMessage(canvasEvent("job-1", "attempt-1", 1));
  assert.equal(events.length, 2);

  // Cancel the job.
  coordinator.cancel("job-1");
  timers.advance(0);

  // Now the worker sends more events (late delivery).
  const eventsBefore = events.length;
  w.emitMessage(canvasEvent("job-1", "attempt-1", 2));
  w.emitMessage(settled("job-1", "attempt-1", 3));
  // None of these should be forwarded.
  assert.equal(events.length, eventsBefore);
});

test("terminal worker retains its slot until exit, then pumps the queue", () => {
  const { coordinator, workers, events } = createTestCoordinator({ concurrency: 1, maxQueueSize: 4 });
  coordinator.enqueue("job-1", sampleRequest); // dispatched
  coordinator.enqueue("job-2", { ...sampleRequest, question: "Q2" }); // queued

  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.queuedCount, 1);

  const w1 = workers[0];
  assert.ok(w1);

  // Worker #1 sends started, then fatal.
  w1.emitMessage(started("job-1", "attempt-1", 0));
  w1.emitMessage(fatal("job-1", "attempt-1", 1, "bootstrap failed"));

  // Fatal should forward.
  const fatalEvents = events.filter((e) => e.type === "fatal");
  assert.equal(fatalEvents.length, 1);
  assert.equal((fatalEvents[0] as ReturnType<typeof fatal>).error, "bootstrap failed");

  // A terminal IPC is not enough to free a slot: the child must exit first.
  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.queuedCount, 1);
  assert.equal(workers.length, 1);

  w1.emitExit(0, null);
  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.queuedCount, 0);
  assert.equal(workers.length, 2);
});

test("terminal cleanup force-kills a child but still waits for its exit", () => {
  const { coordinator, workers, timers } = createTestCoordinator({
    concurrency: 1,
    terminalGraceMs: 10,
  });
  coordinator.enqueue("job-1", sampleRequest);
  const worker = workers[0];
  worker.emitMessage(started("job-1", "attempt-1", 0));
  worker.emitMessage(settled("job-1", "attempt-1", 1));

  timers.advance(10);
  assert.equal(worker.killed, true);
  assert.equal(worker.killSignal, "SIGKILL");
  assert.equal(coordinator.activeCount, 1);

  worker.emitExit(null, "SIGKILL");
  assert.equal(coordinator.activeCount, 0);
});

test("worker exit without settled event releases slot and continues queue", () => {
  const { coordinator, workers, events, errors } = createTestCoordinator({
    concurrency: 1,
    maxQueueSize: 4,
  });
  coordinator.enqueue("job-1", sampleRequest); // dispatched
  coordinator.enqueue("job-2", { ...sampleRequest, question: "Q2" }); // queued

  const w1 = workers[0];
  assert.ok(w1);

  // Worker sends started then job, then exits unexpectedly (code 1).
  w1.emitMessage(started("job-1", "attempt-1", 0));
  w1.emitMessage(jobEvent("job-1", "attempt-1", 1));
  w1.emitExit(1, null);

  // An error should be recorded.
  assert.ok(errors.length >= 1);
  const crashError = errors.find((e) => e.jobId === "job-1");
  assert.ok(crashError);
  assert.ok(crashError.error.message.includes("exited unexpectedly"));

  // Slot is released.
  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.queuedCount, 0);
  assert.equal(workers.length, 2);
});

test("parent deadline fences, kills, and releases a nonresponsive worker", () => {
  const { coordinator, workers, timers, errors } = createTestCoordinator({
    concurrency: 1,
    maxQueueSize: 3,
    deadlineMs: 100,
  });
  coordinator.enqueue("job-1", sampleRequest);
  coordinator.enqueue("job-2", { ...sampleRequest, question: "Q2" });

  timers.advance(100);

  assert.ok(errors.some((entry) => entry.jobId === "job-1" && entry.error.message.includes("parent deadline")));
  assert.equal(workers[0].killed, true);
  assert.equal(workers[0].killSignal, "SIGKILL");
  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.queuedCount, 0);
  assert.equal(workers.length, 2);
});

test("worker error event fails the attempt and releases its slot", () => {
  const { coordinator, workers, errors } = createTestCoordinator({ concurrency: 1 });
  coordinator.enqueue("job-1", sampleRequest);
  const w1 = workers[0];
  assert.ok(w1);

  w1.emitMessage(started("job-1", "attempt-1", 0));
  w1.emitError(new Error("IPC broken"));

  // Error recorded.
  assert.ok(errors.some((e) => e.jobId === "job-1"));
  assert.equal(w1.killed, true);
  assert.equal(coordinator.activeCount, 0);
});

test("out-of-order sequence is rejected", () => {
  const { coordinator, workers, events } = createTestCoordinator({ concurrency: 1 });
  coordinator.enqueue("job-1", sampleRequest);
  const w = workers[0];
  assert.ok(w);

  w.emitMessage(started("job-1", "attempt-1", 0));
  w.emitMessage(canvasEvent("job-1", "attempt-1", 3)); // seq 3 accepted (3 > 0)
  assert.equal(events.filter((e) => e.type === "canvas").length, 1);

  w.emitMessage(canvasEvent("job-1", "attempt-1", 1)); // seq 1 rejected (1 ≤ 3)
  assert.equal(events.filter((e) => e.type === "canvas").length, 1);
});

test("duplicate sequence is rejected", () => {
  const { coordinator, workers, events } = createTestCoordinator({ concurrency: 1 });
  coordinator.enqueue("job-1", sampleRequest);
  const w = workers[0];
  assert.ok(w);

  w.emitMessage(started("job-1", "attempt-1", 0));
  w.emitMessage(jobEvent("job-1", "attempt-1", 1));
  w.emitMessage(jobEvent("job-1", "attempt-1", 1)); // duplicate seq
  assert.equal(events.filter((e) => e.type === "job").length, 1);
});

test("foreign attemptId events are rejected", () => {
  const { coordinator, workers, events } = createTestCoordinator({ concurrency: 1 });
  coordinator.enqueue("job-1", sampleRequest);
  const w = workers[0];
  assert.ok(w);

  // Event with wrong attemptId.
  w.emitMessage(started("job-1", "wrong-attempt", 0));
  assert.equal(events.length, 0);
});

test("events with wrong jobId for a registered attempt are rejected", () => {
  const { coordinator, workers, events } = createTestCoordinator({ concurrency: 1 });
  coordinator.enqueue("job-1", sampleRequest);
  const w = workers[0];
  assert.ok(w);

  // The attempt was registered for job-1; sending for job-2 should be rejected.
  w.emitMessage(started("job-2", "attempt-1", 0));
  assert.equal(events.length, 0);
});

test("malformed / non-protocol messages are silently dropped", () => {
  const { coordinator, workers, events } = createTestCoordinator({ concurrency: 1 });
  coordinator.enqueue("job-1", sampleRequest);
  const w = workers[0];
  assert.ok(w);

  // Accept the started event first so we're past the header check.
  w.emitMessage(started("job-1", "attempt-1", 0));
  assert.equal(events.length, 1);

  // Now send garbage.
  w.emitMessage(null);
  w.emitMessage(undefined);
  w.emitMessage("string");
  w.emitMessage(42);
  w.emitMessage({});
  w.emitMessage({ type: "started" }); // missing fields
  w.emitMessage({ version: 1, type: "started", jobId: "job-1", attemptId: "attempt-1" }); // no sequence
  w.emitMessage({ ...jobEvent("job-1", "attempt-1", 1), error: 42 });
  w.emitMessage({
    ...canvasEvent("job-1", "attempt-1", 2),
    canvas: { symbol: "AAPL", title: "Too large", content: "x".repeat(12_001), updatedAt: Date.now() },
  });

  // None forwarded.
  assert.equal(events.length, 1);
});

test("settled event releases its slot only after worker exit", () => {
  const { coordinator, workers, events } = createTestCoordinator({ concurrency: 1, maxQueueSize: 4 });
  coordinator.enqueue("job-1", sampleRequest); // dispatched
  coordinator.enqueue("job-2", { ...sampleRequest, question: "Q2" }); // queued

  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.queuedCount, 1);

  const w1 = workers[0];
  assert.ok(w1);

  // Worker #1 completes normally.
  w1.emitMessage(started("job-1", "attempt-1", 0));
  w1.emitMessage(jobEvent("job-1", "attempt-1", 1));
  w1.emitMessage(canvasEvent("job-1", "attempt-1", 2));
  w1.emitMessage(settled("job-1", "attempt-1", 3, "complete"));

  assert.equal(events.length, 4);

  // The terminal child remains counted until it exits.
  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.queuedCount, 1);
  assert.equal(workers.length, 1);

  w1.emitExit(0, null);
  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.queuedCount, 0);
  assert.equal(workers.length, 2); // second worker forked for job-2
});

test("enqueue resumes queue after multiple workers finish", () => {
  const { coordinator, workers, events } = createTestCoordinator({
    concurrency: 2,
    maxQueueSize: 6,
  });

  // Dispatch 3 jobs: first 2 active, third queued.
  coordinator.enqueue("job-1", { ...sampleRequest, question: "Q1" });
  coordinator.enqueue("job-2", { ...sampleRequest, question: "Q2" });
  coordinator.enqueue("job-3", { ...sampleRequest, question: "Q3" });
  coordinator.enqueue("job-4", { ...sampleRequest, question: "Q4" });

  assert.equal(coordinator.activeCount, 2);
  assert.equal(coordinator.queuedCount, 2);
  assert.equal(workers.length, 2);

  // Worker #1 finishes.
  const w1 = workers[0];
  w1.emitMessage(started("job-1", "attempt-1", 0));
  w1.emitMessage(settled("job-1", "attempt-1", 1, "complete"));
  w1.emitExit(0, null);

  // Queue pumps: job-3 dispatched.
  assert.equal(coordinator.activeCount, 2);
  assert.equal(coordinator.queuedCount, 1);
  assert.equal(workers.length, 3); // third worker forked

  // Worker #2 finishes.
  const w2 = workers[1];
  w2.emitMessage(started("job-2", "attempt-2", 0));
  w2.emitMessage(settled("job-2", "attempt-2", 1, "complete"));
  w2.emitExit(0, null);

  // Queue pumps: job-4 dispatched.
  assert.equal(coordinator.activeCount, 2);
  assert.equal(coordinator.queuedCount, 0);
  assert.equal(workers.length, 4); // fourth worker forked
});

test("cancel of a running job releases slot after grace timer", () => {
  const { coordinator, workers, timers } = createTestCoordinator({
    concurrency: 1,
    maxQueueSize: 4,
  });

  coordinator.enqueue("job-1", sampleRequest);
  coordinator.enqueue("job-2", { ...sampleRequest, question: "Q2" });

  assert.equal(coordinator.activeCount, 1);
  assert.equal(coordinator.queuedCount, 1);

  // Cancel job-1.
  coordinator.cancel("job-1");

  // Grace timer was set; flush it to force-kill.
  timers.advance(0);

  // Slot released, queue pumped.
  assert.equal(coordinator.activeCount, 1); // job-2 dispatched
  assert.equal(coordinator.queuedCount, 0);
  assert.equal(workers.length, 2);
});

test("cancel of an already-settled job returns already-settled", () => {
  const { coordinator, workers } = createTestCoordinator({ concurrency: 1 });
  coordinator.enqueue("job-1", sampleRequest);
  const w = workers[0];
  assert.ok(w);

  // Worker settles normally.
  w.emitMessage(started("job-1", "attempt-1", 0));
  w.emitMessage(settled("job-1", "attempt-1", 1, "complete"));
  w.emitExit(0, null);

  // Now cancel.
  const result = coordinator.cancel("job-1");
  assert.equal(result.cancelled, false);
  assert.equal(result.status, "already-settled");
});

test("dispose kills all active workers and clears queue", () => {
  const { coordinator, workers } = createTestCoordinator({ concurrency: 2, maxQueueSize: 6 });
  coordinator.enqueue("job-1", sampleRequest);
  coordinator.enqueue("job-2", { ...sampleRequest, question: "Q2" });
  coordinator.enqueue("job-3", { ...sampleRequest, question: "Q3" }); // queued

  assert.equal(workers.length, 2);

  coordinator.dispose();

  // All workers killed.
  for (const w of workers) {
    assert.ok(w.killed);
  }

  assert.equal(coordinator.activeCount, 0);
  assert.equal(coordinator.queuedCount, 0);
  assert.equal(coordinator.disposed, true);

  // Idempotent.
  coordinator.dispose();
  assert.equal(coordinator.disposed, true);
});

test("dispose is idempotent", () => {
  const { coordinator, workers } = createTestCoordinator({ concurrency: 1 });
  coordinator.enqueue("job-1", sampleRequest);

  coordinator.dispose();
  assert.equal(workers[0].killed, true);
  const killCount = workers.filter((w) => w.killed).length;

  // Second dispose should not re-kill.
  coordinator.dispose();
  // kill should still be called only once per worker (FakeWorker doesn't
  // guard against repeated kills, but dispose guards via _disposed flag).
  assert.equal(coordinator.disposed, true);
});

test("worker factory throwing an error does not crash coordinator", () => {
  let factoryCalls = 0;
  const failingFactory: WorkerFactory = (_env) => {
    factoryCalls++;
    throw new Error("fork failed");
  };

  const { coordinator, errors } = createTestCoordinator({
    concurrency: 2,
    workerFactory: failingFactory,
  });

  // Also queue a follow-up job to verify the queue pumps.
  coordinator.enqueue("job-1", sampleRequest);
  coordinator.enqueue("job-2", { ...sampleRequest, question: "Q2" });

  // Both dispatch attempts failed. Slot was never held, so queue pumps.
  // Actually, since the factory throws, dispatch fails, no slot is held,
  // and pumpQueue runs again — but it finds the queue empty because both
  // were consumed.
  assert.equal(coordinator.activeCount, 0);
  assert.equal(coordinator.queuedCount, 0);
  assert.equal(factoryCalls, 2); // both dispatch attempts tried
  assert.ok(errors.length >= 2);
});
