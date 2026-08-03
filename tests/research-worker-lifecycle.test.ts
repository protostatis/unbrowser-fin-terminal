import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { dispatchAndWaitForSettlement } from "../server/research-worker.js";

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
