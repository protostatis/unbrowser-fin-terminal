/**
 * Private global cache runner entrypoint.
 *
 * No ingress, no browser session, no account data. Polls the shared scout
 * journal on a fixed cadence with model dispatch off. Exits 0 when disabled
 * so the same image can ship while rollout stays off.
 */

import { createGlobalCacheRunner, readGlobalCacheRunnerConfig } from "./global-cache-runner.js";

function intervalMs(): number {
  const raw = process.env.GLOBAL_CACHE_RUNNER_INTERVAL_MS?.trim();
  if (!raw) return 60_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 30_000 || value > 10 * 60_000) {
    throw new Error("GLOBAL_CACHE_RUNNER_INTERVAL_MS must be an integer from 30000 to 600000");
  }
  return value;
}

async function main(): Promise<void> {
  const config = readGlobalCacheRunnerConfig();
  if (!config.enabled) {
    console.log("[global-cache-runner] disabled (GLOBAL_CACHE_RUNNER_ENABLED is not 1)");
    return;
  }
  const cadence = intervalMs();
  const runner = createGlobalCacheRunner({
    owner: config.owner,
    stateDir: config.stateDir,
    mcpUrl: config.mcpUrl,
  });
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[global-cache-runner] shutting down (${signal})...`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(`[global-cache-runner] polling every ${cadence}ms from ${config.stateDir}`);
  for (;;) {
    if (shuttingDown) return;
    try {
      const outcome = await runner.runOnce();
      if (!outcome.ran) {
        console.log("[global-cache-runner] skipped: lease held by another writer");
      } else {
        const result = outcome.result;
        console.log(
          `[global-cache-runner] polled=${result.polledSources} ok=${result.successfulSources} failed=${result.failedSources} new=${result.newItems} admitted=${result.admitted}`,
        );
      }
    } catch (error) {
      console.warn("[global-cache-runner] poll failed:", error instanceof Error ? error.message : String(error));
    }
    // The cadence timer stays referenced: it is the only event-loop handle
    // between polls, and an unref'd timer would let the runner exit after
    // its first poll instead of shadowing continuously.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, cadence);
    });
  }
}

void main().catch((error: unknown) => {
  console.error("[global-cache-runner] failed to start:", error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
