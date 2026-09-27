import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("global cache runner and browser default to the same shared database path", () => {
  const previousMarket = process.env.MARKET_DATA_DIR;
  const previousDir = process.env.GLOBAL_CACHE_DIR;
  try {
    delete process.env.GLOBAL_CACHE_DIR;
    for (const marketDataDir of ["/data", "/srv/market"]) {
      process.env.MARKET_DATA_DIR = marketDataDir;
      const config = readGlobalCacheRunnerConfig();
      assert.equal(config.stateDir, path.join(marketDataDir, "global-cache"));
      // Must match server/browser-terminal.ts globalCacheFilePath default:
      // resolve(MARKET_DATA_DIR, "global-cache", "global-research-cache.sqlite").
      assert.equal(
        path.join(config.stateDir, "global-research-cache.sqlite"),
        path.resolve(marketDataDir, "global-cache", "global-research-cache.sqlite"),
      );
    }
    process.env.GLOBAL_CACHE_DIR = "/custom/cache";
    const override = readGlobalCacheRunnerConfig();
    assert.equal(override.stateDir, "/custom/cache");
  } finally {
    if (previousMarket === undefined) delete process.env.MARKET_DATA_DIR;
    else process.env.MARKET_DATA_DIR = previousMarket;
    if (previousDir === undefined) delete process.env.GLOBAL_CACHE_DIR;
    else process.env.GLOBAL_CACHE_DIR = previousDir;
  }
});
import { createGlobalCacheRunner, readGlobalCacheRunnerConfig } from "../server/global-cache-runner.js";
import { createGlobalCacheStore } from "../server/global-cache-store.js";

test("global cache runner stays disabled by default and requires MCP when enabled", () => {
  assert.equal(readGlobalCacheRunnerConfig({} as NodeJS.ProcessEnv).enabled, false);
  assert.throws(() => readGlobalCacheRunnerConfig({ GLOBAL_CACHE_RUNNER_ENABLED: "1" } as NodeJS.ProcessEnv), /UNBROWSER_MCP_URL/);
  const config = readGlobalCacheRunnerConfig({
    GLOBAL_CACHE_RUNNER_ENABLED: "1",
    UNBROWSER_MCP_URL: "https://mcp.test/mcp",
    GLOBAL_CACHE_DIR: "/data/global-cache",
  } as NodeJS.ProcessEnv);
  assert.equal(config.enabled, true);
  assert.equal(config.owner, "global-cache-runner");
});

function fakeResult() {
  return {
    startedAt: 1,
    completedAt: 2,
    polledSources: 1,
    successfulSources: 1,
    failedSources: 0,
    baselineItems: 0,
    newItems: 0,
    admitted: 0,
    watched: 0,
    suppressed: 0,
    decisions: [],
    triggerCandidates: [],
    candidateEvaluated: 0,
    wouldTrigger: 0,
    gated: 0,
    dispatchEnqueued: 0,
    dispatchFailed: 0,
    dispatchPending: 0,
  };
}

test("global cache runner commits the journal only while the lease is held", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "global-cache-commit-"));
  try {
    const stateDir = path.join(root, "state");
    const runner = createGlobalCacheRunner({
      storeFilePath: path.join(root, "cache.sqlite"),
      owner: "runner-a",
      stateDir,
      mcpUrl: "https://mcp.test/mcp",
      fetchImpl: (async () => {
        throw new Error("must not poll upstream in this test");
      }) as typeof fetch,
      createScout: (_client, statePath) => ({
        run: async () => {
          await writeFile(statePath, JSON.stringify({ marker: "polled" }), "utf8");
          return fakeResult();
        },
      }),
    });
    const outcome = await runner.runOnce();
    assert.equal(outcome.ran, true);
    const live = JSON.parse(await readFile(path.join(stateDir, "market-event-scout.json"), "utf8")) as { marker: string };
    assert.equal(live.marker, "polled");
    assert.deepEqual(await readdir(stateDir), ["market-event-scout.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global cache runner discards a fenced-out poll without touching the live journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "global-cache-takeover-"));
  try {
    const stateDir = path.join(root, "state");
    const storeFile = path.join(root, "cache.sqlite");
    const runner = createGlobalCacheRunner({
      storeFilePath: storeFile,
      owner: "runner-a",
      stateDir,
      mcpUrl: "https://mcp.test/mcp",
      fetchImpl: (async () => {
        throw new Error("must not poll upstream in this test");
      }) as typeof fetch,
      createScout: (_client, statePath) => ({
        run: async () => {
          // A replacement leader takes over mid-poll (same owner, new
          // fencing token), then the stale poll writes to its temp copy.
          const replacement = createGlobalCacheStore({ filePath: storeFile });
          const takeover = await replacement.acquireLease("runner-a");
          assert.equal(takeover.acquired, true);
          await writeFile(statePath, JSON.stringify({ marker: "stale" }), "utf8");
          return fakeResult();
        },
      }),
    });
    const outcome = await runner.runOnce();
    assert.deepEqual(outcome, { ran: false, reason: "lease-lost" });
    // The stale temp copy was discarded; no live journal was created.
    await assert.rejects(readFile(path.join(stateDir, "market-event-scout.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global cache runner skips polling while another writer holds the lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "global-cache-runner-"));
  try {
    const storeFile = path.join(root, "cache.sqlite");
    const holder = createGlobalCacheStore({ filePath: storeFile });
    const lease = await holder.acquireLease("other-runner");
    assert.ok(lease.lease);
    const runner = createGlobalCacheRunner({
      storeFilePath: storeFile,
      owner: "global-cache-runner",
      stateDir: path.join(root, "state"),
      mcpUrl: "https://mcp.test/mcp",
      fetchImpl: (async () => {
        throw new Error("must not call MCP while lease is held");
      }) as typeof fetch,
    });
    const result = await runner.runOnce();
    assert.deepEqual(result, { ran: false, reason: "lease-held" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
