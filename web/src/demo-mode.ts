/**
 * Client build-mode detection.
 *
 * Legacy replay builds are selected from the exact `fin-terminal-demo` path
 * segment. The public live gateway deliberately uses the same stable URL but
 * sets VITE_TERMINAL_BUILD_MODE=public-live at build time, so it cannot be
 * mistaken for a static replay.
 *
 * When this flag is true the app shell renders the static ReplayApp instead of
 * the live terminal. The replay build therefore performs no WebSocket, fetch,
 * auth, identity, persistence, redirect, model, or third-party-source request.
 */

/** The exact base-path segment that marks a replay-only demo build. */
export const REPLAY_DEMO_SEGMENT = "fin-terminal-demo";

type ViteImportMeta = { env?: { BASE_URL?: string } };

/** Resolve Vite's BASE_URL without failing in non-Vite (Node/test) contexts. */
function viteBaseUrl(): string {
  const baseUrl = (import.meta as ViteImportMeta).env?.BASE_URL;
  return typeof baseUrl === "string" && baseUrl.length > 0 ? baseUrl : "/";
}

function viteBuildMode(): string | undefined {
  const mode = (import.meta as ViteImportMeta & { env?: { VITE_TERMINAL_BUILD_MODE?: string } })
    .env?.VITE_TERMINAL_BUILD_MODE;
  return typeof mode === "string" && mode.length > 0 ? mode : undefined;
}

/** True when `baseUrl` contains `fin-terminal-demo` as an exact path segment. */
export function isReplayDemoBuild(baseUrl: string): boolean {
  return baseUrl.split("/").includes(REPLAY_DEMO_SEGMENT);
}

export type TerminalBuildMode = "live" | "replay" | "public-live";

export function resolveTerminalBuildMode(
  baseUrl: string,
  explicitMode?: string,
): TerminalBuildMode {
  if (explicitMode === "live" || explicitMode === "replay" || explicitMode === "public-live") {
    return explicitMode;
  }
  return isReplayDemoBuild(baseUrl) ? "replay" : "live";
}

/** Static replay-only demo flag consumed by the app shell. */
export const TERMINAL_BUILD_MODE = resolveTerminalBuildMode(viteBaseUrl(), viteBuildMode());
export const REPLAY_DEMO = TERMINAL_BUILD_MODE === "replay";

/** The public live build waits for a Turnstile-backed session admission. */
export const PUBLIC_LIVE_DEMO = TERMINAL_BUILD_MODE === "public-live";

/**
 * Backwards-compatible alias kept for the unchanged live terminal: the kiosk
 * deployment is now the replay-only build, so both flags always agree.
 */
export const PUBLIC_DEMO = REPLAY_DEMO;
