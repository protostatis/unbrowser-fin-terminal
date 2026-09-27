import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createBrowserTerminalApp } from "../server/browser-terminal.js";
import { createGlobalCacheStore } from "../server/global-cache-store.js";
import { globalCacheKey } from "../shared/global-research-cache.js";

const PROXY_TOKEN = "test-proxy-token";
const NOW = 1_700_000_000_000 + 1_000;

function headers(principal: string): HeadersInit {
  return {
    "x-fin-terminal-proxy-token": PROXY_TOKEN,
    "x-fin-terminal-user": principal,
  };
}

function fixtureEntry() {
  const identity = { symbol: "AAPL", chartScope: "day" as const, researchKey: "v1/ticker/brief", intent: "brief" as const };
  const generatedAt = 1_700_000_000_000;
  return {
    schema: 1 as const,
    producer: "global-scout-runner/v1",
    cacheKey: globalCacheKey(identity),
    identity,
    kind: "ticker-brief" as const,
    canvas: {
      symbol: "AAPL",
      title: "AAPL Brief",
      content: "",
      stage: "complete" as const,
      updatedAt: generatedAt,
      blocks: [
        {
          kind: "bullets" as const,
          title: "Read",
          dossierHint: "read" as const,
          items: [{ text: "verified fact", sourceIds: ["S1"] }],
        },
      ],
      evidencePackets: [
        {
          sourceId: "S1",
          sourceTitle: "Example",
          sourceDomain: "example.com",
          sourceUrl: "https://example.com/report",
          excerpt: "verified fact",
          retrievalStatus: "fetched" as const,
          extractedAt: generatedAt,
          extractionMode: "mcp",
          truncated: false,
        },
      ],
    },
    quality: { usable: true, codes: [] as string[], fetchedCount: 1, qualityVersion: 1 },
    provenance: {
      candidateId: `trg-${"a".repeat(32)}`,
      decisionId: `evt-${"b".repeat(32)}`,
      sourceId: "nasdaq-trade-halts",
      sourceUrl: "https://example.com/report",
      title: "Trading halt",
      observedAt: generatedAt,
      publishedAt: generatedAt,
    },
    asOf: generatedAt,
    generatedAt,
    expiresAt: generatedAt + 2 * 60 * 60_000,
    promptContract: "scout-canonical-brief/v1",
    policyVersion: "quality-public/v1",
  };
}

async function withPopulatedServer<T>(fn: (base: string, calls: string[]) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "global-cache-endpoint-"));
  const calls: string[] = [];
  try {
    const cacheFile = path.join(root, "global-research-cache.sqlite");
    const seeder = createGlobalCacheStore({ filePath: cacheFile, now: () => NOW });
    const lease = await seeder.acquireLease("global-cache-runner");
    assert.ok(lease.lease);
    const put = await seeder.putEntry(lease.lease.token, fixtureEntry());
    assert.equal(put.ok, true);
    await seeder.releaseLease("global-cache-runner", lease.lease.token);

    const app = createBrowserTerminalApp({
      fetchImpl: (async (input) => {
        calls.push(String(input));
        return new Response("unexpected upstream", { status: 500 });
      }) as typeof fetch,
      openRouterApiKey: "server-secret",
      mcpEndpoint: "https://mcp.test/mcp",
      storageRoot: path.join(root, "browser-sessions"),
      globalCacheFilePath: cacheFile,
      webDist: "",
      proxyToken: PROXY_TOKEN,
      now: () => NOW,
    });
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address() as AddressInfo;
      return await fn(`http://127.0.0.1:${address.port}`, calls);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("global cache endpoint serves the same sanitized entry to two principals without upstream calls", async () => {
  await withPopulatedServer(async (base, calls) => {
    const query = "/api/browser/v1/global-cache?symbol=AAPL&scope=day&researchKey=v1%2Fticker%2Fbrief&intent=brief";
    const first = await fetch(`${base}${query}`, { headers: headers("account:alice") });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    assert.equal(firstBody.provenance, "global");
    assert.equal(firstBody.cacheKey, fixtureEntry().cacheKey);
    // Internal trigger/job identifiers never cross the account boundary.
    const text = JSON.stringify(firstBody);
    assert.ok(!text.includes("trg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    assert.ok(!text.includes("evt-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));

    const second = await fetch(`${base}${query}`, { headers: headers("account:bob") });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), firstBody);
    assert.deepEqual(calls, []);
  });
});

test("global cache endpoint misses, rejects bad identities, and requires auth", async () => {
  await withPopulatedServer(async (base) => {
    const missing = await fetch(
      `${base}/api/browser/v1/global-cache?symbol=MSFT&scope=day&researchKey=v1%2Fticker%2Fbrief&intent=brief`,
      { headers: headers("account:alice") },
    );
    assert.equal(missing.status, 404);

    const invalid = await fetch(
      `${base}/api/browser/v1/global-cache?symbol=AAPL&scope=day&researchKey=v1%2Fticker%2Fwhy&intent=why`,
      { headers: headers("account:alice") },
    );
    assert.equal(invalid.status, 400);

    const unauthenticated = await fetch(
      `${base}/api/browser/v1/global-cache?symbol=AAPL&scope=day&researchKey=v1%2Fticker%2Fbrief&intent=brief`,
    );
    assert.equal(unauthenticated.status, 403);
  });
});

test("browser terminal stays Pi-free and the runner stays out of the browser bundle", async () => {
  const terminalSource = await readFile(new URL("../server/browser-terminal.ts", import.meta.url), "utf8");
  assert.ok(!terminalSource.includes("@earendil-works/pi-coding-agent"));
  assert.ok(!terminalSource.includes("@earendil-works/pi-ai"));
  assert.ok(!terminalSource.includes("global-cache-runner"));
  assert.ok(!terminalSource.includes("createAgentSession"));
  const tsconfig = JSON.parse(
    await readFile(new URL("../tsconfig.browser-server.json", import.meta.url), "utf8"),
  ) as { include: string[] };
  assert.ok(!tsconfig.include.some((entry) => entry.includes("global-cache-runner")));
});
