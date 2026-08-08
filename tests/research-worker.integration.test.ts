import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDefaultWorkerFactory,
  ResearchWorkerCoordinator,
  type WorkerFactory,
} from "../server/research-worker-coordinator.js";
import type { WorkerEvent } from "../server/research-worker-protocol.js";

test("real worker reports a terminal fatal event after dispatched model failure", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "fin-terminal-worker-test-"));
  const childFactory = createDefaultWorkerFactory();
  const workerFactory: WorkerFactory = (env) => childFactory({
    ...env,
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
  let coordinator: ResearchWorkerCoordinator | undefined;

  try {
    const fatal = await new Promise<Extract<WorkerEvent, { type: "fatal" }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        coordinator?.dispose();
        reject(new Error("research worker integration test timed out"));
      }, 30_000);
      coordinator = new ResearchWorkerCoordinator({
        workerFactory,
        onEvent: (event) => {
          events.push(event);
          if (event.type === "fatal") {
            clearTimeout(timer);
            resolve(event);
          }
        },
        onError: (_jobId, error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const result = coordinator.enqueue("integration-job", {
        symbol: "AAPL",
        question: "Verify worker lifecycle without model credentials",
        chartScope: "day",
        researchKey: "v1/ticker/brief",
        intent: "brief",
        contextLabel: "AAPL BRIEF",
      });
      if (!result.accepted) reject(new Error(`worker was not dispatched: ${result.reason}`));
    });

    assert.equal(fatal.sequence, Number.MAX_SAFE_INTEGER);
    assert.ok(fatal.error.length > 0 && fatal.error.length <= 400);
    assert.deepEqual(events.map((event) => event.type), ["started", "job", "fatal"]);
    for (let attempt = 0; attempt < 100 && coordinator.activeCount !== 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(coordinator.activeCount, 0);
  } finally {
    coordinator?.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
});
