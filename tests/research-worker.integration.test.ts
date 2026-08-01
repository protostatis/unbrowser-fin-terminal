import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultWorkerFactory } from "../server/research-worker-coordinator.js";
import {
  isWorkerEvent,
  type WorkerEvent,
} from "../server/research-worker-protocol.js";

test("one-shot worker emits a terminal failure without a configured model", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "fin-terminal-worker-test-"));
  const factory = createDefaultWorkerFactory();
  const worker = factory({
    MARKET_RESEARCH_WORKER: "1",
    MARKET_ROOT: path.resolve(import.meta.dirname, ".."),
    PI_CODING_AGENT_DIR: agentDir,
    HOME: agentDir,
    XDG_CONFIG_HOME: agentDir,
    XDG_CACHE_HOME: agentDir,
    NODE_ENV: "test",
    MARKET_MODEL_PROVIDER: "",
    MARKET_MODEL_ID: "",
    OPENROUTER_MODEL: "",
    OPENROUTER_API_KEY: "",
    OPENROUTER_API_KEY_FILE: "",
  });
  const events: WorkerEvent[] = [];

  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.kill("SIGKILL");
        reject(new Error("research worker integration test timed out"));
      }, 30_000);
      worker.onMessage((message) => {
        if (isWorkerEvent(message)) events.push(message);
      });
      worker.onError((error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.onExit((code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      worker.send({
        version: 1,
        type: "run",
        jobId: "integration-job",
        attemptId: "integration-attempt",
        request: {
          symbol: "AAPL",
          question: "Verify worker lifecycle without model credentials",
          chartScope: "day",
          researchKey: "v1/ticker/brief",
          intent: "brief",
          contextLabel: "AAPL BRIEF",
        },
      });
    });

    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
    assert.deepEqual(events.map((event) => event.type), ["started", "job", "job", "settled"]);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "settled");
    if (terminal?.type === "settled") assert.equal(terminal.outcome, "failed");
  } finally {
    worker.kill("SIGKILL");
    await rm(agentDir, { recursive: true, force: true });
  }
});
