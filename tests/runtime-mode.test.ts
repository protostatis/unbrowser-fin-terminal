import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeMode, verifyBuildModeManifest, isRuntimeFeatureEnabled } from "../server/runtime-mode.js";

// ── Dev/test defaults ────────────────────────────────────────────────────

test("dev/test defaults to live when PUBLIC_DEMO is unset", () => {
  assert.equal(resolveRuntimeMode({ NODE_ENV: "development" }), "live");
  assert.equal(resolveRuntimeMode({ NODE_ENV: "test" }), "live");
  assert.equal(resolveRuntimeMode({}), "live");
});

test("dev/test defaults to live when PUBLIC_DEMO is empty", () => {
  assert.equal(resolveRuntimeMode({ PUBLIC_DEMO: "" }), "live");
  assert.equal(resolveRuntimeMode({ PUBLIC_DEMO: "  " }), "live");
});

// ── Explicit values ──────────────────────────────────────────────────────

test("PUBLIC_DEMO=1 or true resolves to replay", () => {
  assert.equal(resolveRuntimeMode({ PUBLIC_DEMO: "1" }), "replay");
  assert.equal(resolveRuntimeMode({ PUBLIC_DEMO: "true" }), "replay");
  assert.equal(resolveRuntimeMode({ PUBLIC_DEMO: "TRUE" }), "replay");
  assert.equal(resolveRuntimeMode({ PUBLIC_DEMO: "True" }), "replay");
});

test("PUBLIC_DEMO=0 or false resolves to live", () => {
  assert.equal(resolveRuntimeMode({ PUBLIC_DEMO: "0" }), "live");
  assert.equal(resolveRuntimeMode({ PUBLIC_DEMO: "false" }), "live");
  assert.equal(resolveRuntimeMode({ PUBLIC_DEMO: "FALSE" }), "live");
  assert.equal(resolveRuntimeMode({ PUBLIC_DEMO: "False" }), "live");
});

// ── Production fail-closed ───────────────────────────────────────────────

test("production fails closed when PUBLIC_DEMO is unset", () => {
  assert.throws(
    () => resolveRuntimeMode({ NODE_ENV: "production" }),
    /PUBLIC_DEMO is required in production/,
  );
});

test("production fails closed when PUBLIC_DEMO is empty", () => {
  assert.throws(
    () => resolveRuntimeMode({ NODE_ENV: "production", PUBLIC_DEMO: "" }),
    /PUBLIC_DEMO is required in production/,
  );
});

test("production fails closed with invalid PUBLIC_DEMO", () => {
  for (const value of ["yes", "no", "2", "on", "off", "replay", "live"]) {
    assert.throws(
      () => resolveRuntimeMode({ NODE_ENV: "production", PUBLIC_DEMO: value }),
      /Invalid PUBLIC_DEMO value/,
      `Expected failure for PUBLIC_DEMO="${value}"`,
    );
  }
});

test("non-production also rejects invalid PUBLIC_DEMO", () => {
  assert.throws(
    () => resolveRuntimeMode({ PUBLIC_DEMO: "yes" }),
    /Invalid PUBLIC_DEMO value/,
  );
});

// ── Production valid values ──────────────────────────────────────────────

test("production PUBLIC_DEMO=1 resolves to replay", () => {
  assert.equal(
    resolveRuntimeMode({ NODE_ENV: "production", PUBLIC_DEMO: "1" }),
    "replay",
  );
});

test("production PUBLIC_DEMO=0 resolves to live", () => {
  assert.equal(
    resolveRuntimeMode({ NODE_ENV: "production", PUBLIC_DEMO: "0" }),
    "live",
  );
});

test("production PUBLIC_DEMO=true resolves to replay", () => {
  assert.equal(
    resolveRuntimeMode({ NODE_ENV: "production", PUBLIC_DEMO: "true" }),
    "replay",
  );
});

test("production PUBLIC_DEMO=false resolves to live", () => {
  assert.equal(
    resolveRuntimeMode({ NODE_ENV: "production", PUBLIC_DEMO: "false" }),
    "live",
  );
});

test("production build manifest must match the resolved runtime mode", () => {
  assert.doesNotThrow(() =>
    verifyBuildModeManifest("replay", '<meta name="x-build-mode" content="replay">'),
  );
  assert.doesNotThrow(() =>
    verifyBuildModeManifest("live", '<meta name="x-build-mode" content="live">'),
  );
  assert.doesNotThrow(() =>
    verifyBuildModeManifest("public-gateway", '<meta name="x-build-mode" content="public-live">'),
  );
  assert.throws(
    () => verifyBuildModeManifest("replay", null),
    /Production build artifact missing/,
  );
  assert.throws(
    () => verifyBuildModeManifest("live", "<html></html>"),
    /missing the x-build-mode manifest/,
  );
  assert.throws(
    () => verifyBuildModeManifest("replay", '<meta name="x-build-mode" content="live">'),
    /Build-mode mismatch/,
  );
});

test("public live gateway requires an explicit runtime mode without legacy replay flags", () => {
  assert.equal(
    resolveRuntimeMode({ NODE_ENV: "production", TERMINAL_RUNTIME_MODE: "public-gateway" }),
    "public-gateway",
  );
  assert.throws(
    () => resolveRuntimeMode({ TERMINAL_RUNTIME_MODE: "public-gateway", PUBLIC_DEMO: "0" }),
    /must not set PUBLIC_DEMO/,
  );
  assert.throws(
    () => resolveRuntimeMode({ TERMINAL_RUNTIME_MODE: "unknown" }),
    /Invalid TERMINAL_RUNTIME_MODE/,
  );
});

// ── TERMINAL_RUNTIME_FEATURE_ENABLED boolean spellings ──────────────────────

test("TERMINAL_RUNTIME_FEATURE_ENABLED accepts every Compose boolean spelling", () => {
  for (const value of ["1", "true", "yes", "on", "TRUE", "Yes", "ON"]) {
    assert.equal(
      isRuntimeFeatureEnabled({ TERMINAL_RUNTIME_FEATURE_ENABLED: value }),
      true,
      `"${value}" must enable the runtime feature`,
    );
  }
});

test("TERMINAL_RUNTIME_FEATURE_ENABLED is disabled for empty or non-truthy values", () => {
  for (const value of [undefined, "", " ", "0", "false", "no", "off", "2", "disabled"]) {
    assert.equal(
      isRuntimeFeatureEnabled({ TERMINAL_RUNTIME_FEATURE_ENABLED: value }),
      false,
      `"${String(value)}" must not enable the runtime feature`,
    );
  }
  // Unset entirely (no key) must also be disabled.
  assert.equal(isRuntimeFeatureEnabled({}), false);
});
