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

test("coordinator reclaims a real worker after dispatch failure without a configured model", async () => {
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
    const failure = await new Promise<Error>((resolve, reject) => {
      const timer = setTimeout(() => {
        coordinator?.dispose();
        reject(new Error("research worker integration test timed out"));
      }, 30_000);
      coordinator = new ResearchWorkerCoordinator({
        workerFactory,
        onEvent: (event) => events.push(event),
        onError: (_jobId, error) => {
          clearTimeout(timer);
          resolve(error);
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

    assert.match(failure.message, /exited unexpectedly/);
    assert.deepEqual(events.map((event) => event.type), ["started", "job"]);
    assert.equal(coordinator.activeCount, 0);
  } finally {
    coordinator?.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
});
