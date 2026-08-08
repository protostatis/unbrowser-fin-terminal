import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  dispatchAndWaitForSettlement,
  makeRuntimeFatalEvent,
  safeResearchWorkerFailure,
} from "../server/research-worker.js";
import { isWorkerFatalEvent, type WorkerRunMessage } from "../server/research-worker-protocol.js";

type SessionEvent = { type: "agent_start" | "agent_settled" };

function immediateResearchSession(events: SessionEvent[]): AgentSession {
  let listener: ((event: SessionEvent) => void) | undefined;
  return {
    subscribe(next: (event: SessionEvent) => void) {
      listener = next;
      return () => { listener = undefined; };
    },
    extensionRunner: {
      onError() {
        return () => {};
      },
    },
    async prompt() {
      for (const event of events) listener?.(event);
    },
  } as unknown as AgentSession;
}

test("research worker subscribes before an immediate follow-up turn settles", async () => {
  const session = immediateResearchSession([
    { type: "agent_start" },
    { type: "agent_settled" },
  ]);
  await dispatchAndWaitForSettlement(session, "/market-worker-run test", {
    dispatchTimeoutMs: 50,
    runTimeoutMs: 100,
  });
});

test("research worker ignores settlement until the model turn starts", async () => {
  const session = immediateResearchSession([
    { type: "agent_settled" },
    { type: "agent_start" },
    { type: "agent_settled" },
  ]);
  await assert.doesNotReject(() => dispatchAndWaitForSettlement(
    session,
    "/market-worker-run test",
    { dispatchTimeoutMs: 50, runTimeoutMs: 100 },
  ));
});

test("runtime fatal events supersede progress sequences without leaking sensitive error text", () => {
  const run: WorkerRunMessage = {
    version: 1,
    type: "run",
    jobId: "job-1",
    attemptId: "attempt-1",
    request: {
      symbol: "AAPL",
      question: "Why did Apple move?",
      chartScope: "day",
      researchKey: "v1/ticker/why",
      intent: "why",
      contextLabel: "AAPL WHY",
    },
  };
  const secret = "sk-test_abcdefghijklmnopqrstuvwxyz123456";
  const event = makeRuntimeFatalEvent(
    run,
    new Error(`provider failed at https://example.com/request?api_key=${secret} token=${secret}`),
  );

  assert.equal(isWorkerFatalEvent(event), true);
  assert.equal(event.sequence, Number.MAX_SAFE_INTEGER);
  assert.equal(event.error.includes(secret), false);
  assert.equal(event.error.includes("https://"), false);
  assert.ok(event.error.length <= 400);
});

test("worker failure redaction has a stable empty-message fallback", () => {
  assert.equal(safeResearchWorkerFailure("   "), "Research worker failed after dispatch");
});
