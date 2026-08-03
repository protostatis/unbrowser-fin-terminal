/**
 * Client-side checkpoint builder and submitter for the public live terminal.
 *
 * Accumulates a semantic event projection from user actions and frame state,
 * builds a validated checkpoint when the user explicitly opts in before timeout,
 * and submits it to the gateway's checkpoint endpoint.
 *
 * This module never has access to server-side secrets, cookies, or
 * credentials — those are handled entirely server-side via HttpOnly cookies.
 */

import type {
  FinancialTerminalCheckpoint,
  CheckpointEvent,
  CheckpointCanvas,
  CheckpointPacket,
  CheckpointContext,
  CheckpointInterruptedWork,
} from "../../shared/financial-workspace-checkpoint";
import type { TerminalFrameState, ChartScope } from "./mobile-controls";
import type { TerminalDossier, DossierPacket } from "./dossier";

const CHECKPOINT_SUBMIT_PATH = "/internal/financial-workspace/checkpoints";

// ──── Accumulated Session State ─────────────────────────────────────────────

export interface SessionAccumulator {
  /** Running log of semantic user-visible events. */
  events: CheckpointEvent[];
  /** Last known terminal frame state (for context extraction). */
  lastFrameState?: TerminalFrameState;
  /** Last known dossier (for canvas extraction). */
  lastDossier?: TerminalDossier;
  /** Whether any meaningful user activity has occurred in this session. */
  hasMeaningfulActivity: boolean;
  /** Latest research state if interrupted. */
  latestResearchState?: TerminalFrameState["research"];
  /** Count of completed research runs. */
  researchRunCount: number;
  /** Latest watchlist. */
  watchlist: string[];
}

export function createSessionAccumulator(): SessionAccumulator {
  return {
    events: [],
    hasMeaningfulActivity: false,
    researchRunCount: 0,
    watchlist: [],
  };
}

// ──── Event Recording ───────────────────────────────────────────────────────

/**
 * Record a user-visible semantic event.
 * Called by the UI layer when the user types, navigates, starts research, etc.
 */
export function recordEvent(
  acc: SessionAccumulator,
  type: CheckpointEvent["type"],
  data: Record<string, unknown>,
): void {
  const now = Date.now();
  acc.events.push({ at: now, type, data });

  // Track meaningful activity
  if (
    type === "prompt"
    || type === "command"
    || type === "navigate"
    || type === "research-start"
  ) {
    acc.hasMeaningfulActivity = true;
  }

  // Track research completions
  if (type === "research-complete") {
    acc.researchRunCount += 1;
  }
}

/**
 * Update the accumulator with the latest frame state.
 * Call on every frame message received from the server.
 */
export function updateFrameState(
  acc: SessionAccumulator,
  state: TerminalFrameState | undefined,
  dossier?: TerminalDossier,
): void {
  acc.lastFrameState = state;
  if (dossier) acc.lastDossier = dossier;

  if (state) {
    // Track screen/symbol changes
    if (state.screen) {
      const lastScreen = acc.events
        .filter((e) => e.type === "navigate")
        .slice(-1)[0];
      if (!lastScreen || lastScreen.data.screen !== state.screen) {
        const data: Record<string, unknown> = { screen: state.screen };
        if (state.mode === "ticker" && state.symbol) data.symbol = state.symbol;
        if (state.chartScope) data.chartScope = state.chartScope;
        recordEvent(acc, "navigate", data);
      }
    }

    // Track research state changes
    if (state.research) {
      const currentResearch = acc.latestResearchState;
      if (
        !currentResearch?.active
        && state.research.active
        && state.research.phase === "dispatched"
      ) {
        recordEvent(acc, "research-start", {
          symbol: state.research.symbol ?? state.symbol,
          contextLabel: state.research.contextLabel,
        });
      }
      if (
        currentResearch?.active
        && !state.research.active
        && state.research.phase === "settled"
        && state.research.outcome === "complete"
      ) {
        recordEvent(acc, "research-complete", {
          symbol: state.research.symbol ?? state.symbol,
          contextLabel: state.research.contextLabel,
          id: state.research.id,
        });
      }
      if (
        currentResearch?.active
        && !state.research.active
        && state.research.phase === "settled"
        && state.research.outcome === "failed"
      ) {
        recordEvent(acc, "research-failed", {
          symbol: state.research.symbol ?? state.symbol,
          contextLabel: state.research.contextLabel,
        });
      }
      acc.latestResearchState = state.research;
    }

    // Track watchlist
    if (state.available && Array.isArray(state.available) && state.screen === "WATCH") {
      acc.watchlist = state.available.filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
    }
  }
}

// ──── Checkpoint Builder ────────────────────────────────────────────────────

/**
 * Build a checkpoint from accumulated session state.
 * This is called when the user explicitly opts in before a public timeout.
 */
export function buildCheckpoint(
  acc: SessionAccumulator,
  sessionId: string,
  generation: number,
  sourceRevision?: string,
): FinancialTerminalCheckpoint {
  const now = Date.now();

  // Extract context from last frame state
  const context: CheckpointContext = {};
  if (acc.lastFrameState) {
    const state = acc.lastFrameState;
    if (state.screen) context.screen = state.screen;
    if (state.symbol) context.symbol = state.symbol;
    if (state.chartScope) context.chartScope = state.chartScope as ChartScope;
    if (state.searchQuery) context.searchQuery = state.searchQuery;
  }
  if (acc.watchlist.length > 0) {
    context.watchlist = acc.watchlist;
  }

  // Extract canvases from dossier
  const canvases: CheckpointCanvas[] = [];
  if (acc.lastDossier) {
    canvases.push(buildCanvasFromDossier(acc.lastDossier));
  }

  // Extract interrupted work
  let interruptedWork: CheckpointInterruptedWork | undefined;
  if (acc.latestResearchState?.active) {
    interruptedWork = {
      activeResearch: {
        symbol: acc.latestResearchState.symbol,
        contextLabel: acc.latestResearchState.contextLabel,
        activity: acc.latestResearchState.activity,
        phase: acc.latestResearchState.phase,
        startedAt: acc.latestResearchState.updatedAt,
      },
    };
  }

  // Build the checkpoint
  const checkpoint: FinancialTerminalCheckpoint = {
    version: 1,
    id: `${sessionId}-checkpoint-${now.toString(36)}`,
    source: {
      sessionId,
      generation,
      ...(sourceRevision ? { sourceRevision } : {}),
    },
    createdAt: now,
    expiresAt: now + 60 * 60 * 1000, // 1 hour unclaimed retention
    eventLog: acc.events,
    context,
    canvases,
    ...(interruptedWork ? { interruptedWork } : {}),
    continuationSummary: "",
  };

  // Build continuation summary
  checkpoint.continuationSummary = buildContinuationSummary(checkpoint);

  return checkpoint;
}

function buildCanvasFromDossier(dossier: TerminalDossier): CheckpointCanvas {
  const packets: CheckpointPacket[] = (dossier.packets ?? []).map(
    (packet: DossierPacket): CheckpointPacket => ({
      sourceId: packet.sourceId,
      sourceTitle: packet.sourceTitle,
      sourceDomain: packet.sourceDomain,
      excerpt: packet.excerpt,
      retrievalStatus: packet.retrievalStatus,
      extractedAt: packet.extractedAt,
    }),
  );

  return {
    id: `canvas-${Date.now().toString(36)}`,
    title: dossier.title,
    intent: dossier.intent ?? "brief",
    stage: dossier.stage ?? "partial",
    summary: dossier.summary,
    summarySourceIds: dossier.summarySourceIds,
    evidenceStatus: dossier.evidenceStatus ?? "pending",
    packets,
  };
}

function buildContinuationSummary(checkpoint: FinancialTerminalCheckpoint): string {
  const lines: string[] = [];

  if (checkpoint.context.symbol) {
    lines.push(`Continue from a saved checkpoint: ${checkpoint.context.symbol}`);
  } else {
    lines.push("Continue from a saved checkpoint");
  }

  if (checkpoint.canvases.length > 0) {
    const completed = checkpoint.canvases.filter((c) => c.stage === "complete").length;
    const partial = checkpoint.canvases.filter((c) => c.stage === "partial").length;
    const parts: string[] = [];
    if (completed > 0) parts.push(`${completed} completed canvas${completed !== 1 ? "es" : ""}`);
    if (partial > 0) parts.push(`${partial} partial`);
    lines.push(`Research: ${parts.join(", ")}`);
  }

  const researchComplete = checkpoint.eventLog.filter(
    (e) => e.type === "research-complete",
  ).length;
  if (researchComplete > 0) {
    lines.push(`${researchComplete} research run${researchComplete !== 1 ? "s" : ""} completed`);
  }

  if (checkpoint.interruptedWork?.activeResearch) {
    const label =
      checkpoint.interruptedWork.activeResearch.contextLabel
      ?? checkpoint.interruptedWork.activeResearch.symbol
      ?? "unknown";
    lines.push(`Interrupted research on ${label} — available for continuation`);
  }

  return lines.join(". ") + ".";
}

// ──── Checkpoint Submission ─────────────────────────────────────────────────

export interface CheckpointSubmitResult {
  checkpointId: string;
  expiresAt: number;
  handoffId: string;
  authUrl: string;
}

/**
 * Submit a checkpoint to the gateway's internal endpoint.
 * The handoff secret is handled server-side via HttpOnly cookie.
 */
export async function submitCheckpoint(
  sessionId: string,
  workerId: string,
  generation: number,
  sourceRevision: string | undefined,
  checkpoint: FinancialTerminalCheckpoint,
): Promise<{ success: true; result: CheckpointSubmitResult } | { success: false; error: string }> {
  const requestId = `${sessionId}-${Date.now().toString(36)}`;

  let response: globalThis.Response;
  try {
    response = await fetch(CHECKPOINT_SUBMIT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        source: {
          sessionId,
          workerId,
          generation,
          sourceRevision,
        },
        checkpoint,
      }),
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
    const result = (await response.json()) as CheckpointSubmitResult;
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
