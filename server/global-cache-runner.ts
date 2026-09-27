/**
 * Private global cache runner (shadow polling, dispatch off).
 *
 * Separate process boundary from the browser terminal: this module may run
 * the shared MarketEventScout, but it is never imported by
 * server/browser-terminal.ts, which stays Pi-free. No public ingress, no
 * browser session dependency. Real model dispatch is not wired here; this
 * stage proves feed reachability, journal persistence, and scheduler
 * advancement in the browser-era runtime.
 */

import path from "node:path";
import { MarketEventScout, type MarketEventScoutRunResult } from "../shared/market-event-scout.js";
import { UnbrowserMcpClient } from "../shared/unbrowser-mcp.js";
import { createGlobalCacheStore } from "./global-cache-store.js";

export interface GlobalCacheRunnerConfig {
  enabled: boolean;
  owner: string;
  stateDir: string;
  mcpUrl: string;
}

export function readGlobalCacheRunnerConfig(env: NodeJS.ProcessEnv = process.env): GlobalCacheRunnerConfig {
  const rawEnabled = env.GLOBAL_CACHE_RUNNER_ENABLED?.trim().toLowerCase();
  const enabled = rawEnabled === "1" || rawEnabled === "true" || rawEnabled === "on";
  const owner = env.GLOBAL_CACHE_RUNNER_OWNER?.trim() || "global-cache-runner";
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(owner)) throw new Error("GLOBAL_CACHE_RUNNER_OWNER is invalid");
  const stateDir = env.GLOBAL_CACHE_DIR?.trim() || env.MARKET_DATA_DIR?.trim() || "/data/global-cache";
  if (!path.isAbsolute(stateDir)) throw new Error("GLOBAL_CACHE_DIR must be an absolute path");
  const mcpUrl = env.UNBROWSER_MCP_URL?.trim() ?? "";
  if (enabled && !mcpUrl) throw new Error("UNBROWSER_MCP_URL is required for the global cache runner");
  return { enabled, owner, stateDir, mcpUrl };
}

export interface GlobalCacheRunnerOptions {
  storeFilePath?: string;
  owner?: string;
  stateDir?: string;
  mcpUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createGlobalCacheRunner(options: GlobalCacheRunnerOptions = {}) {
  const now = options.now ?? Date.now;
  const owner = options.owner ?? "global-cache-runner";
  const stateDir = options.stateDir ?? "/data/global-cache";
  const storeFilePath = options.storeFilePath ?? path.join(stateDir, "global-research-cache.sqlite");
  const store = createGlobalCacheStore({ filePath: storeFilePath, now });
  const mcpUrl = options.mcpUrl ?? process.env.UNBROWSER_MCP_URL?.trim() ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;

  async function runOnce(runOptions: { force?: boolean } = {}): Promise<
    | { ran: false; reason: "lease-held" }
    | { ran: true; result: MarketEventScoutRunResult }
  > {
    const lease = await store.acquireLease(owner);
    if (!lease.acquired || !lease.lease) return { ran: false, reason: "lease-held" };
    try {
      if (!mcpUrl) throw new Error("UNBROWSER_MCP_URL is required for the global cache runner");
      const client = new UnbrowserMcpClient(mcpUrl, { fetch: fetchImpl });
      const scout = new MarketEventScout({
        client,
        statePath: path.join(stateDir, "market-event-scout.json"),
        now,
      });
      const result = await scout.run({ force: runOptions.force });
      return { ran: true, result };
    } finally {
      await store.releaseLease(owner, lease.lease.token).catch(() => {});
    }
  }

  return { store, runOnce };
}

export type GlobalCacheRunner = ReturnType<typeof createGlobalCacheRunner>;
