/**
 * Resolve the server runtime mode from PUBLIC_DEMO, with an explicit public
 * admission-gateway override for the isolated live-session pool.
 *
 *   PUBLIC_DEMO=1 or true  → "replay"  (static-file-only kiosk, no agent)
 *   PUBLIC_DEMO=0 or false → "live"    (full agent session + websocket)
 *   TERMINAL_RUNTIME_MODE=public-gateway → public admission gateway only
 *
 * Production (NODE_ENV=production) requires PUBLIC_DEMO to be explicitly set
 * and fails closed on any unrecognised value. Dev / test environments default
 * to "live" when PUBLIC_DEMO is unset.
 *
 * This module MUST NOT import any agent or UI dependencies so it can be
 * evaluated before large side-effectful modules are loaded.
 */

export type RuntimeMode = "replay" | "live" | "public-gateway";
export type BuildMode = "replay" | "live" | "public-live";

const VALID_REPLAY = new Set(["1", "true"]);
const VALID_LIVE = new Set(["0", "false"]);
const VALID_VALUES = new Set([...VALID_REPLAY, ...VALID_LIVE]);

/**
 * Resolve the `TERMINAL_RUNTIME_FEATURE_ENABLED` master flag. Compose
 * interpolation can render a boolean as `1`, `true`, `yes`, or `on` (in any
 * case), so the gateway and the worker permit client must agree on all four
 * spellings. Anything else — including an empty/unset value — is disabled.
 */
export function isRuntimeFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test((env.TERMINAL_RUNTIME_FEATURE_ENABLED ?? "").trim());
}

export function resolveRuntimeMode(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeMode {
  const explicit = env.TERMINAL_RUNTIME_MODE?.trim();
  if (explicit) {
    if (!["replay", "live", "public-gateway"].includes(explicit)) {
      throw new Error(
        `Invalid TERMINAL_RUNTIME_MODE value: "${explicit}". Must be live, replay, or public-gateway.`,
      );
    }
    const legacy = env.PUBLIC_DEMO?.trim();
    if (legacy && explicit !== "public-gateway") {
      const legacyMode = legacy.toLowerCase();
      const expectedLegacy = explicit === "replay" ? VALID_REPLAY : VALID_LIVE;
      if (!expectedLegacy.has(legacyMode)) {
        throw new Error("TERMINAL_RUNTIME_MODE conflicts with PUBLIC_DEMO");
      }
    }
    if (legacy && explicit === "public-gateway") {
      throw new Error("public-gateway must not set PUBLIC_DEMO");
    }
    return explicit as RuntimeMode;
  }
  const raw = env.PUBLIC_DEMO?.trim();

  const isProduction = env.NODE_ENV === "production";

  if (raw === undefined || raw === "") {
    if (isProduction) {
      throw new Error(
        "PUBLIC_DEMO is required in production. Set PUBLIC_DEMO=0 (live) or PUBLIC_DEMO=1 (replay).",
      );
    }
    // dev / test default to live
    return "live";
  }

  const lower = raw.toLowerCase();
  if (VALID_REPLAY.has(lower)) return "replay";
  if (VALID_LIVE.has(lower)) return "live";

  throw new Error(
    `Invalid PUBLIC_DEMO value: "${raw}". Must be 0, 1, true, or false.`,
  );
}

const BUILD_MODE_RE = /<meta\s+name="x-build-mode"\s+content="(replay|live|public-live)"/i;

function expectedBuildMode(runtimeMode: RuntimeMode): BuildMode {
  return runtimeMode === "public-gateway" ? "public-live" : runtimeMode;
}

/**
 * Verify that a production server will serve a client built for its exact
 * runtime mode. The build pipeline is trusted; this catches deployment mixups.
 */
export function verifyBuildModeManifest(
  expectedMode: RuntimeMode,
  html: string | null,
): void {
  if (html === null) {
    throw new Error(
      'Production build artifact missing: dist-web/index.html not found. Run "npm run build" first.',
    );
  }
  const actualMode = BUILD_MODE_RE.exec(html)?.[1]?.toLowerCase() as BuildMode | undefined;
  if (!actualMode) {
    throw new Error(
      "Built frontend is missing the x-build-mode manifest. Rebuild with the correct PUBLIC_BASE_PATH.",
    );
  }
  const expected = expectedBuildMode(expectedMode);
  if (actualMode !== expected) {
    throw new Error(
      `Build-mode mismatch: server expects "${expected}" but frontend was built for "${actualMode}". ` +
        "Rebuild with matching TERMINAL_RUNTIME_MODE and PUBLIC_BASE_PATH.",
    );
  }
}
