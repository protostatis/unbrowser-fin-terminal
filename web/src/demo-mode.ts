/**
 * Replay-only demo build detection.
 *
 * The public kiosk is a static replay build compiled with
 * PUBLIC_BASE_PATH=/unbrowser/fin-terminal-demo/, so Vite's BASE_URL contains
 * the exact path segment `fin-terminal-demo`. The match is segment-exact: a
 * path segment must equal the demo segment, so lookalikes such as
 * `not-fin-terminal-demo` or `fin-terminal-demo-2` never match.
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

/** True when `baseUrl` contains `fin-terminal-demo` as an exact path segment. */
export function isReplayDemoBuild(baseUrl: string): boolean {
  return baseUrl.split("/").includes(REPLAY_DEMO_SEGMENT);
}

/** Static replay-only demo flag consumed by the app shell. */
export const REPLAY_DEMO = isReplayDemoBuild(viteBaseUrl());

/**
 * Backwards-compatible alias kept for the unchanged live terminal: the kiosk
 * deployment is now the replay-only build, so both flags always agree.
 */
export const PUBLIC_DEMO = REPLAY_DEMO;
