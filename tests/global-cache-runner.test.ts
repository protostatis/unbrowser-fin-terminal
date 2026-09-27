import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
