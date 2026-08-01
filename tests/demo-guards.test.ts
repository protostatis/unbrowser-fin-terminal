import assert from "node:assert/strict";
import test from "node:test";
import { createDemoRateLimiter } from "../server/demo-guards.js";

test("demo rate limiter rejects excess connections and inputs per IP", () => {
  const limiter = createDemoRateLimiter({
    connectionLimit: 2,
    connectionWindowMs: 10_000,
    inputLimit: 3,
    inputWindowMs: 10_000,
  });

  assert.equal(limiter.allowConnection("1.2.3.4"), true);
  assert.equal(limiter.allowConnection("1.2.3.4"), true);
  assert.equal(limiter.allowConnection("1.2.3.4"), false);
  // A different IP is unaffected.
  assert.equal(limiter.allowConnection("5.6.7.8"), true);

  assert.equal(limiter.allowInput("1.2.3.4"), true);
  assert.equal(limiter.allowInput("1.2.3.4"), true);
  assert.equal(limiter.allowInput("1.2.3.4"), true);
  assert.equal(limiter.allowInput("1.2.3.4"), false);
  // Connection and input budgets are independent.
  assert.equal(limiter.allowConnection("5.6.7.8"), true);
  assert.equal(limiter.allowInput("5.6.7.8"), true);
});

test("demo rate limiter windows reset after the window elapses", async () => {
  const limiter = createDemoRateLimiter({
    connectionLimit: 1,
    connectionWindowMs: 50,
    inputLimit: 1,
    inputWindowMs: 50,
  });

  assert.equal(limiter.allowConnection("1.2.3.4"), true);
  assert.equal(limiter.allowConnection("1.2.3.4"), false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(limiter.allowConnection("1.2.3.4"), true);

  assert.equal(limiter.allowInput("1.2.3.4"), true);
  assert.equal(limiter.allowInput("1.2.3.4"), false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(limiter.allowInput("1.2.3.4"), true);
});
