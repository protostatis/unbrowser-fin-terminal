/**
 * Client-side workspace-handoff opt-in.
 *
 * The browser NEVER builds checkpoint content: checkpoints are exported from
 * the assigned worker's authoritative state by the gateway, which then sets
 * the handoff secret as an HttpOnly cookie. This module only records a local
 * "meaningful activity" flag for CTA gating and sends the explicit opt-in
 * request. The handoff secret never reaches browser JS.
 */

import type {
  CheckpointEvent,
} from "../../shared/financial-workspace-checkpoint";

const WORKSPACE_HANDOFF_PATH = "/api/public/workspace-handoff";

// ──── Accumulated Session State (display gating only) ───────────────────────

export interface SessionAccumulator {
  /** Running log of semantic user-visible events (display diagnostics only). */
  events: CheckpointEvent[];
  /** Whether any meaningful user activity has occurred in this session. */
  hasMeaningfulActivity: boolean;
}

export function createSessionAccumulator(): SessionAccumulator {
  return { events: [], hasMeaningfulActivity: false };
}

/**
 * Record a user-visible semantic event locally. This data is never uploaded;
 * it only drives whether the "Keep in workspace" CTA is shown at all.
 */
export function recordEvent(
  acc: SessionAccumulator,
  type: CheckpointEvent["type"],
  data: Record<string, unknown>,
): void {
  const now = Date.now();
  acc.events.push({ at: now, type, data });
  if (
    type === "prompt"
    || type === "command"
    || type === "navigate"
    || type === "research-start"
  ) {
    acc.hasMeaningfulActivity = true;
  }
}

/**
 * Update the local activity gate from a frame. This never produces checkpoint
 * content — it only decides whether the "Keep in workspace" CTA is shown.
 */
export function updateFrameActivity(
  acc: SessionAccumulator,
  state: { research?: { active?: boolean }; symbol?: string; screen?: string } | undefined,
): void {
  if (!state) return;
  if (state.research?.active === true) acc.hasMeaningfulActivity = true;
  if (typeof state.symbol === "string" && state.symbol.length > 0) acc.hasMeaningfulActivity = true;
}

export interface WorkspaceHandoffResult {
  checkpointId: string;
  expiresAt: number;
  handoffId: string;
  authUrl: string;
}

/**
 * Explicit opt-in. Sends the verified visitor + ticket tokens; the gateway
 * verifies the active assignment, exports the authoritative checkpoint from
 * the worker, forwards it to workspace control, and sets the HttpOnly handoff
 * cookie. Only safe fields are returned to JS.
 */
export async function requestWorkspaceHandoff(
  headers: HeadersInit,
): Promise<{ success: true; result: WorkspaceHandoffResult } | { success: false; error: string }> {
  let response: globalThis.Response;
  try {
    response = await fetch(WORKSPACE_HANDOFF_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { success: false, error: "Network error: could not reach checkpoint service" };
  }

  if (!response.ok) {
    let errorText = "Unknown error";
    try {
      const body = await response.json();
      if (body && typeof body.error === "string") errorText = body.error;
    } catch {
      // ignore parse errors
    }
    return { success: false, error: errorText };
  }

  try {
    const result = (await response.json()) as WorkspaceHandoffResult;
    if (
      !result.checkpointId
      || !result.handoffId
      || !result.authUrl
      || !result.expiresAt
    ) {
      return { success: false, error: "Invalid response from checkpoint service" };
    }
    return { success: true, result };
  } catch {
    return { success: false, error: "Failed to parse checkpoint response" };
  }
}
