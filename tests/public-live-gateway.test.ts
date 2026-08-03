import assert from "node:assert/strict";
import test from "node:test";
import {
  FixedWindowRateLimiter,
  isAllowedPublicClientMessage,
  isAllowedPublicWorkerMessage,
  resolvePublicClientIp,
  TokenBucketRateLimiter,
} from "../server/public-live-gateway.js";

function message(value: unknown): string {
  return JSON.stringify(value);
}

test("public gateway forwards only bounded terminal protocol messages", () => {
  for (const value of [
    { type: "input", data: "j" },
    { type: "resize", cols: 120, rows: 40 },
    { type: "command", name: "market", args: "AAPL" },
    { type: "select_response", id: "select-1", value: "yes" },
    { type: "select_response", id: "select-1", cancelled: true },
    { type: "web_action", data: { action: "scroll", direction: "down", amount: 1 } },
  ]) {
    assert.equal(isAllowedPublicClientMessage(message(value)), true, JSON.stringify(value));
  }
});

test("public gateway rejects malformed, oversized, and unsupported browser protocol messages", () => {
  for (const value of [
    "not json",
    message(null),
    message({ type: "input", data: "" }),
    message({ type: "input", data: "x".repeat(65) }),
    message({ type: "resize", cols: 1, rows: 40 }),
    message({ type: "command", name: "shell", args: "whoami" }),
    message({ type: "select_response", id: "" }),
    message({ type: "web_action", data: [] }),
    message({ type: "web_action", data: {} }),
    message({ type: "web_action", data: { action: "shell" } }),
    message({ type: "web_action", data: { action: "scroll", direction: "sideways" } }),
    message({ type: "command", name: "market", args: "AAPL\n/quit" }),
    message({ type: "select_response", id: "select-1", value: "x".repeat(513) }),
    message({ type: "unknown" }),
  ]) {
    assert.equal(isAllowedPublicClientMessage(value), false, value);
  }
});

test("public gateway validates bounded worker-to-browser messages", () => {
  for (const value of [
    { type: "frame", rows: ["row"], width: 120, rows_count: 1, state: { mode: "market" } },
    { type: "notify", level: "info", message: "Ready" },
    { type: "select_request", id: "select-1", title: "Choose", options: ["yes", "no"] },
    { type: "closed" },
  ]) {
    assert.equal(isAllowedPublicWorkerMessage(message(value)), true, JSON.stringify(value));
  }

  for (const value of [
    "not json",
    message({ type: "frame", rows: ["row"], width: 120, rows_count: 2 }),
    message({ type: "frame", rows: ["x".repeat(16_385)], width: 120, rows_count: 1 }),
    message({ type: "notify", level: "debug", message: "no" }),
    message({ type: "select_request", id: "select-1", title: "Choose", options: "yes" }),
    message({ type: "unknown" }),
  ]) {
    assert.equal(isAllowedPublicWorkerMessage(value), false, value);
  }
});

test("public admission limiter bounds identity storage and expires windows", () => {
  let now = 0;
  const limiter = new FixedWindowRateLimiter(2, 1_000, () => now, 2);
  assert.equal(limiter.take("first"), true);
  assert.equal(limiter.take("first"), true);
  assert.equal(limiter.take("first"), false);
  assert.equal(limiter.take("second"), true);
  assert.equal(limiter.take("third"), false);
  now = 1_000;
  assert.equal(limiter.take("third"), true);
});

test("public socket token bucket rejects sustained floods and refills", () => {
  let now = 0;
  const limiter = new TokenBucketRateLimiter(2, 3, () => now);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);
  now = 500;
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);
});

test("forwarded client IP is trusted only from the authenticated edge", () => {
  const edgeToken = "edge-token-0123456789012345678901";
  assert.equal(resolvePublicClientIp(
    "198.51.100.10",
    "203.0.113.20",
    edgeToken,
    "wrong-token",
  ), "198.51.100.10");
  assert.equal(resolvePublicClientIp(
    "198.51.100.10",
    "203.0.113.20",
    edgeToken,
    edgeToken,
  ), "203.0.113.20");
  assert.equal(resolvePublicClientIp(
    "198.51.100.10",
    "not-an-ip",
    edgeToken,
    edgeToken,
  ), "198.51.100.10");
  assert.equal(resolvePublicClientIp(
    "198.51.100.10",
    "203.0.113.20",
    "",
    undefined,
  ), "198.51.100.10");
});
