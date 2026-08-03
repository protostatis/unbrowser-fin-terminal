import assert from "node:assert/strict";
import test from "node:test";
import { readPublicLiveGatewayConfig, readPublicSessionWorkerConfig } from "../server/public-live-config.js";
import { createOpaqueId, signOpaqueId, verifyOpaqueId } from "../server/public-session-tokens.js";

function configEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "8788",
    PUBLIC_BASE_PATH: "/fin-terminal-demo/",
    PUBLIC_ALLOWED_ORIGIN: "https://unbrowser.unchainedsky.com",
    PUBLIC_REDIS_URL: "redis://redis:6379/0",
    PUBLIC_SESSION_SIGNING_KEY: "01234567890123456789012345678901",
    PUBLIC_EDGE_PROXY_TOKEN: "edge-proxy-token-0123456789012345",
    PUBLIC_WORKER_PROXY_TOKEN: "worker-proxy-token",
    PUBLIC_TURNSTILE_SITE_KEY: "turnstile-site-key",
    PUBLIC_TURNSTILE_SECRET: "turnstile-secret",
    PUBLIC_MAX_SESSIONS: "2",
    PUBLIC_WORKER_ENDPOINTS: "seat-01=http://worker-01:8787,seat-02=http://worker-02:8787",
    ...overrides,
  };
}

test("public live gateway requires an explicit, bounded isolated-worker contract", () => {
  const config = readPublicLiveGatewayConfig(configEnv());
  assert.equal(config.workerEndpoints.length, 2);
  assert.equal(config.maxQueue, 50);
  assert.equal(config.ticketTtlMs, 600_000);
  assert.equal(config.idleTimeoutMs, 300_000);
  assert.equal(config.absoluteTimeoutMs, 900_000);
  assert.equal(config.maxResearchRuns, 5);
  assert.equal(config.dailyBudgetMicroUsd, 10_000_000);
  assert.equal(config.edgeProxyToken, "edge-proxy-token-0123456789012345");
});

test("public gateway rejects unsafe origins, worker endpoints, and impossible budget reservations", () => {
  assert.throws(
    () => readPublicLiveGatewayConfig(configEnv({ PUBLIC_ALLOWED_ORIGIN: "https://example.com/path" })),
    /PUBLIC_ALLOWED_ORIGIN must be a canonical HTTP\(S\) origin/,
  );
  assert.throws(
    () => readPublicLiveGatewayConfig(configEnv({ PUBLIC_REDIS_URL: "https://redis.example" })),
    /PUBLIC_REDIS_URL must be an absolute redis/,
  );
  assert.throws(
    () => readPublicLiveGatewayConfig(configEnv({ PUBLIC_WORKER_ENDPOINTS: "seat-01=http://worker-01:8787" })),
    /exactly PUBLIC_MAX_SESSIONS workers/,
  );
  assert.throws(
    () => readPublicLiveGatewayConfig(configEnv({ PUBLIC_EDGE_PROXY_TOKEN: "" })),
    /PUBLIC_EDGE_PROXY_TOKEN is required in production/,
  );
  assert.throws(
    () => readPublicLiveGatewayConfig(configEnv({
      PUBLIC_DAILY_RESEARCH_BUDGET_MICRO_USD: "100000",
      PUBLIC_RESEARCH_RUN_RESERVATION_MICRO_USD: "100000",
    })),
    /reservation cannot exceed/,
  );
});

test("public workers opt into fixed-lived-session limits only when explicitly enabled", () => {
  assert.equal(readPublicSessionWorkerConfig({}).enabled, false);
  const worker = readPublicSessionWorkerConfig({
    PUBLIC_SESSION_WORKER: "1",
    PUBLIC_IDLE_TIMEOUT_SECONDS: "300",
    PUBLIC_SESSION_MAX_SECONDS: "900",
    PUBLIC_MAX_RESEARCH_RUNS: "5",
  });
  assert.deepEqual(worker, {
    enabled: true,
    idleTimeoutMs: 300_000,
    absoluteTimeoutMs: 900_000,
    reconnectGraceMs: 30_000,
    maxResearchRuns: 5,
  });
});

test("Turnstile and Redis development shortcuts fail closed in production", () => {
  const development = readPublicLiveGatewayConfig(configEnv({
    NODE_ENV: "development",
    PUBLIC_REDIS_URL: "memory://public-live-dev",
    PUBLIC_TURNSTILE_BYPASS: "1",
    PUBLIC_TURNSTILE_SITE_KEY: "",
    PUBLIC_TURNSTILE_SECRET: "",
  }));
  assert.equal(development.turnstileRequired, false);
  assert.equal(development.redisUrl, "memory://public-live-dev");
  assert.throws(
    () => readPublicLiveGatewayConfig(configEnv({ PUBLIC_TURNSTILE_BYPASS: "1" })),
    /forbidden in production/,
  );
  assert.throws(
    () => readPublicLiveGatewayConfig(configEnv({ PUBLIC_REDIS_URL: "memory://public-live" })),
    /cannot use memory/,
  );
});

test("public session tokens carry signed opaque identifiers only", () => {
  const key = "01234567890123456789012345678901";
  const id = createOpaqueId();
  const token = signOpaqueId(id, key);
  assert.equal(verifyOpaqueId(token, key), id);
  assert.equal(verifyOpaqueId(`${token}x`, key), undefined);
  assert.equal(verifyOpaqueId(token, `${key}x`), undefined);
});
