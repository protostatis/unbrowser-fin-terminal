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

import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  MarketEventScout,
  type MarketEventDocumentClient,
  type MarketEventScoutRunResult,
} from "../shared/market-event-scout.js";
import { UnbrowserMcpClient } from "../shared/unbrowser-mcp.js";
import { createGlobalCacheStore } from "./global-cache-store.js";

export interface RunnerScout {
  run: (options?: { force?: boolean; signal?: AbortSignal }) => Promise<MarketEventScoutRunResult>;
}

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
  const explicitDir = env.GLOBAL_CACHE_DIR?.trim();
  const marketDataDir = env.MARKET_DATA_DIR?.trim();
  // Matches the browser default (<MARKET_DATA_DIR>/global-cache) so both
  // processes share one database unless GLOBAL_CACHE_DIR overrides it.
  const stateDir = explicitDir || (marketDataDir ? path.join(marketDataDir, "global-cache") : "/data/global-cache");
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
  /** Lease TTL ms for the poll cycle; renewed by heartbeat while polling. */
  leaseTtlMs?: number;
  /** Injectable scout factory (tests drive lease-takeover scenarios). */
  createScout?: (client: MarketEventDocumentClient, statePath: string) => RunnerScout;
}

export function createGlobalCacheRunner(options: GlobalCacheRunnerOptions = {}) {
  const now = options.now ?? Date.now;
  const owner = options.owner ?? "global-cache-runner";
  const stateDir = options.stateDir ?? "/data/global-cache";
  const storeFilePath = options.storeFilePath ?? path.join(stateDir, "global-research-cache.sqlite");
  const leaseTtlMs = options.leaseTtlMs ?? 60_000;
  const store = createGlobalCacheStore({ filePath: storeFilePath, now, leaseTtlMs });
  const mcpUrl = options.mcpUrl ?? process.env.UNBROWSER_MCP_URL?.trim() ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;

  async function runOnce(runOptions: { force?: boolean } = {}): Promise<
    | { ran: false; reason: "lease-held" | "lease-lost" }
    | { ran: true; result: MarketEventScoutRunResult }
  > {
    const lease = await store.acquireLease(owner);
    if (!lease.acquired || !lease.lease) return { ran: false, reason: "lease-held" };
    const token = lease.lease.token;
    // Heartbeat renewal keeps the 60s lease alive across slow feed polls so
    // a replacement runner cannot start mid-poll. The journal itself is a
    // deterministic JSON merge (stable candidate IDs dedupe), while cache
    // publication stays transactionally fenced on the lease token.
    const heartbeatEveryMs = Math.max(5_000, Math.floor(leaseTtlMs / 3));
    const heartbeat = setInterval(() => {
      void store.renewLease(owner, token).catch(() => {});
    }, heartbeatEveryMs);
    // Fence the journal itself: poll against an isolated temp copy and only
    // atomically commit it over the live journal when the lease is still
    // held. A fenced-out leader discards its temp copy, so it can neither
    // publish nor replace a newer journal with a stale snapshot.
    const liveJournal = path.join(stateDir, "market-event-scout.json");
    const tempJournal = `${liveJournal}.tmp-${process.pid}-${randomUUID().replace(/-/g, "")}`;
    try {
      if (!mcpUrl) throw new Error("UNBROWSER_MCP_URL is required for the global cache runner");
      await mkdir(stateDir, { recursive: true });
      try {
        await copyFile(liveJournal, tempJournal);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
      const client = new UnbrowserMcpClient(mcpUrl, { fetch: fetchImpl });
      const createScout = options.createScout
        ?? ((documentClient: MarketEventDocumentClient, statePath: string) =>
          new MarketEventScout({ client: documentClient, statePath, now }));
      const scout = createScout(client, tempJournal);
      const result = await scout.run({ force: runOptions.force });
      // Post-run fencing: if we lost the lease mid-poll, discard the temp
      // journal and the result rather than committing either.
      if (!(await store.checkLease(token))) {
        await rm(tempJournal, { force: true }).catch(() => {});
        return { ran: false, reason: "lease-lost" };
      }
      try {
        await rename(tempJournal, liveJournal);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
        // The poll wrote nothing (no due sources); the live journal stands.
      }
      return { ran: true, result };
    } finally {
      clearInterval(heartbeat);
      await rm(tempJournal, { force: true }).catch(() => {});
      await store.releaseLease(owner, token).catch(() => {});
    }
  }

  return { store, runOnce };
}

export type GlobalCacheRunner = ReturnType<typeof createGlobalCacheRunner>;
