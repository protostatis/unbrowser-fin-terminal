/**
 * Final-image smoke for the native research-worker entry point.
 *
 * This runs from /app/server in the production image, forks the same worker
 * path used by live research, and forces a deterministic pre-session failure.
 * A terminal fatal IPC event proves that native ESM loading, fork wiring, and
 * the bootstrap IPC flush all work without credentials or network access.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDefaultWorkerFactory,
  ResearchWorkerCoordinator,
  type WorkerFactory,
} from "./research-worker-coordinator.js";
import type { WorkerEvent } from "./research-worker-protocol.js";

const JOB_ID = "artifact-smoke-job";
const ATTEMPT_ID = "artifact-smoke-attempt";
const EXPECTED_ERROR = "UNBROWSER_MCP_URL is required for isolated production research";
const EVENT_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 5_000;

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("research worker did not exit promptly");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function smokeResearchWorkerArtifact(): Promise<void> {
  const agentDir = await mkdtemp(path.join(tmpdir(), "fin-terminal-artifact-smoke-"));
  const childFactory = createDefaultWorkerFactory();
  const workerFactory: WorkerFactory = (env) => childFactory({
    ...env,
    MARKET_ROOT: path.resolve(import.meta.dirname, ".."),
    PI_CODING_AGENT_DIR: agentDir,
    HOME: agentDir,
    XDG_CONFIG_HOME: agentDir,
    XDG_CACHE_HOME: agentDir,
    NODE_ENV: "production",
    UNBROWSER_MCP_URL: "",
    UNBROWSER_MCP_REQUIRED: "1",
    MARKET_MODEL_PROVIDER: "",
    MARKET_MODEL_ID: "",
    OPENROUTER_MODEL: "",
    OPENROUTER_API_KEY: "",
    OPENROUTER_API_KEY_FILE: "",
  });
  let coordinator: ResearchWorkerCoordinator | undefined;

  try {
    const fatal = await new Promise<Extract<WorkerEvent, { type: "fatal" }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("research worker artifact smoke timed out"));
      }, EVENT_TIMEOUT_MS);
      coordinator = new ResearchWorkerCoordinator({
        concurrency: 1,
        workerFactory,
        generateAttemptId: () => ATTEMPT_ID,
        terminalGraceMs: 2_000,
        onEvent: (event) => {
          if (event.type !== "fatal") return;
          clearTimeout(timer);
          resolve(event);
        },
        onError: (_jobId, error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const result = coordinator.enqueue(JOB_ID, {
        symbol: "AAPL",
        question: "Verify the final research worker artifact",
        chartScope: "day",
        researchKey: "v1/ticker/brief",
        intent: "brief",
        contextLabel: "AAPL BRIEF",
      });
      if (!result.accepted) {
        clearTimeout(timer);
        reject(new Error(`research worker was not dispatched: ${result.reason}`));
      }
    });

    assert.equal(fatal.jobId, JOB_ID);
    assert.equal(fatal.attemptId, ATTEMPT_ID);
    assert.equal(fatal.sequence, 0);
    assert.equal(fatal.error, EXPECTED_ERROR);
    await waitUntil(() => coordinator?.activeCount === 0, EXIT_TIMEOUT_MS);
  } finally {
    coordinator?.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
}

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMainModule) {
  smokeResearchWorkerArtifact()
    .then(() => console.log("research worker artifact smoke passed"))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
