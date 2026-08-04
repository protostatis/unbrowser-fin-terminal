/**
 * Integration tests for the research-permit gate: the coordinator must acquire
 * a global permit immediately before forking, stay visibly queued while the
 * permit is pending (with heartbeats), and release the permit only after the
 * child process exits. The gate is feature-optional: without it the previous
 * ungated behavior is unchanged.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ResearchWorkerCoordinator,
  type ResearchPermitGate,
  type ResearchPermitIdentity,
  type ResearchPermitAcquireOutcome,
  type WorkerHandle,
  type WorkerFactory,
  type ResearchWorkerCoordinatorOptions,
  type ResearchRequestContext,
} from "../server/research-worker-coordinator.js";

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

/** Fake worker that never forks a real process. */
class FakeWorker implements WorkerHandle {
  private exitHandler: ((code: number | null, signal: string | null) => void) | null = null;
  public killed = false;

  send(): void {}
  onMessage(): void {}
  onError(): void {}
  onExit(handler: (code: number | null, signal: string | null) => void): void {
    this.exitHandler = handler;
  }
  kill(): void {
    this.killed = true;
  }
  emitExit(code: number | null = 0, signal: string | null = null): void {
    this.exitHandler?.(code, signal);
  }
}

/** Deterministic fake permit gate enforcing a global concurrency cap. */
class FakePermitGate implements ResearchPermitGate {
  private readonly queue: string[] = [];
  public readonly holds = new Map<string, string>(); // requestId → sessionId
  public readonly releaseCalls: string[] = [];
  public readonly heartbeatCalls: string[] = [];
  public readonly acquireCalls: ResearchPermitIdentity[] = [];
  private readonly statuses = new Map<string, string>();
  private counter = 0;

  constructor(public maxConcurrent = 2) {}

  async acquire(identity: ResearchPermitIdentity): Promise<ResearchPermitAcquireOutcome> {
    this.acquireCalls.push(identity);
    const requestId = `permit-${++this.counter}`;
    if (this.holds.size < this.maxConcurrent) {
      this.holds.set(requestId, identity.sessionId);
      this.statuses.set(requestId, "acquired");
      return { accepted: true, status: "acquired", requestId };
    }
    this.statuses.set(requestId, "queued");
    this.queue.push(requestId);
    return { accepted: true, status: "queued", requestId, queuePosition: this.queue.length };
  }

  async status(requestId: string): Promise<{ requestId: string; status: string }> {
    return { requestId, status: this.statuses.get(requestId) ?? "not-found" };
  }

  async heartbeat(requestId: string): Promise<void> {
    this.heartbeatCalls.push(requestId);
  }

  async release(requestId: string): Promise<void> {
    this.releaseCalls.push(requestId);
    this.statuses.set(requestId, "released");
    this.holds.delete(requestId);
    // Grant the next FIFO waiter.
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (this.holds.size < this.maxConcurrent) {
        this.holds.set(next, "queued-session");
        this.statuses.set(next, "acquired");
      }
    }
  }

  /** Grant the next queued permit on demand (simulates a slot freeing). */
  grantNext(): void {
    if (this.queue.length === 0) return;
    const next = this.queue.shift()!;
    if (this.holds.size < this.maxConcurrent) {
      this.holds.set(next, "granted-session");
      this.statuses.set(next, "acquired");
    }
  }
}

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

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createTestCoordinator(
  gate: FakePermitGate,
  overrides: Partial<ResearchWorkerCoordinatorOptions> = {},
) {
  nextAttemptCounter = 0;
  const workers: FakeWorker[] = [];
  const timers = createFakeTimers();
  const errors: Array<{ jobId: string; error: Error }> = [];
  const workerFactory: WorkerFactory = () => {
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
    permitGate: gate,
    permitIdentity: () => ({ sessionId: "session-a", workerGeneration: "gen-1" }),
    permitPollIntervalMs: 1_000,
    permitWaitTimeoutMs: 60_000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onError: (jobId, error) => errors.push({ jobId, error }),
    ...overrides,
  });
  return { coordinator, workers, timers, errors };
}

test("permit gate: acquires before fork and releases only after child exit", async () => {
  const gate = new FakePermitGate(2);
  const { coordinator, workers } = createTestCoordinator(gate);

  const result = coordinator.enqueue("job-1", sampleRequest);
  // With a permit gate the job stays visibly queued until the permit round-trip.
  assert.equal(result.accepted, true);
  assert.equal(result.status, "queued");

  await flush();
  // Permit acquired and the worker forked immediately before it.
  assert.equal(gate.acquireCalls.length, 1);
  assert.equal(gate.acquireCalls[0].sessionId, "session-a");
  assert.equal(workers.length, 1);
  assert.equal(gate.releaseCalls.length, 0);

  // Child exits → permit released only now.
  workers[0].emitExit(0, null);
  await flush();
  assert.equal(gate.releaseCalls.length, 1);
});

test("permit gate: excess jobs wait FIFO at the global cap and heartbeat while queued", async () => {
  const gate = new FakePermitGate(1); // global max 1
  const { coordinator, workers, timers } = createTestCoordinator(gate, {
    concurrency: 2, // local concurrency higher than the global permit cap
  });

  coordinator.enqueue("job-1", sampleRequest);
  coordinator.enqueue("job-2", sampleRequest);
  await flush();

  // Only job-1 forked; job-2 waits for the global permit.
  assert.equal(workers.length, 1);
  assert.equal(coordinator.queuedCount, 1);

  // Advance past one heartbeat interval → the queued permit was heartbeated.
  timers.advance(1_000);
  await flush();
  assert.ok(gate.heartbeatCalls.length >= 1, "queued wait must heartbeat");

  // Job-1 child exits → permit released → FIFO grant for job-2. The next poll
  // observes the grant and forks job-2.
  workers[0].emitExit(0, null);
  timers.advance(1_000);
  await flush();
  assert.equal(gate.releaseCalls.length, 1);
  assert.equal(workers.length, 2);
  assert.equal(coordinator.queuedCount, 0);
});

test("permit gate: worker-start failure returns the permit immediately", async () => {
  const gate = new FakePermitGate(2);
  const { coordinator } = createTestCoordinator(gate, {
    workerFactory: () => {
      throw new Error("fork failed");
    },
  });

  coordinator.enqueue("job-1", sampleRequest);
  await flush();
  assert.equal(gate.acquireCalls.length, 1);
  assert.equal(gate.releaseCalls.length, 1);
});

test("permit gate: bounded wait timeout fails a job that never gets a permit", async () => {
  const gate = new FakePermitGate(1);
  const { coordinator, workers, timers, errors } = createTestCoordinator(gate, {
    permitWaitTimeoutMs: 10_000,
  });

  coordinator.enqueue("job-1", sampleRequest);
  coordinator.enqueue("job-2", sampleRequest);
  await flush();
  assert.equal(workers.length, 1);

  // Never grant job-2; advance past its wait bound.
  timers.advance(11_000);
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].jobId, "job-2");
  assert.match(errors[0].error.message, /permit-wait-timeout/);
  assert.equal(workers.length, 1);
  assert.equal(coordinator.queuedCount, 0);
});

test("permit gate: cancel of a permit-pending job releases its permit", async () => {
  const gate = new FakePermitGate(1);
  const { coordinator, workers } = createTestCoordinator(gate);

  coordinator.enqueue("job-1", sampleRequest);
  coordinator.enqueue("job-2", sampleRequest);
  await flush();
  assert.equal(workers.length, 1);

  const cancelled = coordinator.cancel("job-2");
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.status, "queued-removed");
  assert.equal(coordinator.queuedCount, 0);
});

test("permit gate: dispose releases held permits", async () => {
  const gate = new FakePermitGate(2);
  const { coordinator, workers } = createTestCoordinator(gate);

  coordinator.enqueue("job-1", sampleRequest);
  await flush();
  assert.equal(gate.holds.size, 1);

  coordinator.dispose();
  assert.ok(coordinator.disposed);
  assert.equal(gate.releaseCalls.length, 1);
  workers[0].kill();
});

test("without a permit gate the coordinator keeps its previous immediate dispatch", () => {
  const gate = new FakePermitGate(2);
  const workers: FakeWorker[] = [];
  const timers = createFakeTimers();
  const coordinator = new ResearchWorkerCoordinator({
    concurrency: 2,
    maxQueueSize: 6,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    generateAttemptId: sequentialAttemptId,
    graceMs: 0,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  const result = coordinator.enqueue("job-1", sampleRequest);
  assert.equal(result.status, "dispatched");
  assert.equal(workers.length, 1);
  assert.equal(gate.acquireCalls.length, 0);
});
