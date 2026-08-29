import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MARKET_SCOUT_MODEL_ID } from "../shared/market-event-scout.js";
import { createAgentModelRuntime } from "../server/agent-config.js";

/**
 * One-request, opt-in live provider smoke test for the budget scout model.
 * `npm test` remains deterministic and never reaches OpenRouter.
 */
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const keyFile = process.env.OPENROUTER_API_KEY_FILE?.trim();
if (!apiKey && !keyFile) {
  throw new Error("Set OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE to run the Nemo smoke test");
}

const agentDir = await mkdtemp(path.join(tmpdir(), "fin-terminal-nemo-smoke-"));
try {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MARKET_MODEL_PROVIDER: "openrouter",
    MARKET_MODEL_ID: MARKET_SCOUT_MODEL_ID,
    OPENROUTER_MODEL: MARKET_SCOUT_MODEL_ID,
  };
  const { modelRuntime, model } = await createAgentModelRuntime(agentDir, env);
  if (!model) throw new Error("Nemo smoke test could not resolve a model");

  const response = await modelRuntime.completeSimple(model, {
    messages: [{
      role: "user",
      content: "Reply with exactly NEMO_SMOKE_OK.",
      timestamp: Date.now(),
    }],
  }, {
    maxTokens: 16,
    temperature: 0,
    timeoutMs: 30_000,
    maxRetries: 0,
  });

  if (response.stopReason !== "stop") {
    throw new Error(`Nemo smoke test ended with stop reason: ${response.stopReason}`);
  }
  console.log(`Nemo smoke test passed: ${response.provider}/${response.model}`);
} finally {
  await rm(agentDir, { recursive: true, force: true });
}
