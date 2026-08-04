/**
 * Pure, DOM-free decision helpers for the Workspace Checkpoint Banner.
 *
 * Kept separate from the React component so the conversion UI's accessible
 * behavior (phase announcements, runs honesty, beforeunload gating, safe
 * failure copy) is unit-testable with the project's node:test conventions —
 * and so the core branch can extend the runs data contract without touching
 * presentation code.
 */

// ──── Phases ────────────────────────────────────────────────────────────────

export type CheckpointBannerPhase =
  | "normal"        // session running, normal display
  | "warning-2m"    // 2-minute warning
  | "critical-30s"  // <30s remaining
  | "ended";        // session ended

export const WARNING_2M_MS = 2 * 60_000;
export const CRITICAL_30S_MS = 30_000;

/** Classify a remaining-time budget into a banner phase. Exact at boundaries. */
export function checkpointPhase(remainingMs: number): CheckpointBannerPhase {
  if (remainingMs <= 0) return "ended";
  if (remainingMs <= CRITICAL_30S_MS) return "critical-30s";
  if (remainingMs <= WARNING_2M_MS) return "warning-2m";
  return "normal";
}

// ──── Runs honesty ──────────────────────────────────────────────────────────

export interface CheckpointRunsInfo {
  /** Actual runs remaining; omit when the server has not reported a live count. */
  remaining?: number;
  /** Maximum runs for this session (the cap, not a remaining count). */
  max?: number;
}

/**
 * Label for research runs. Never invents a remaining count: when the server
 * has not reported a live `remaining`, the label states the honest session cap
 * instead of a misleading fixed "5/5".
 */
export function formatRunsLabel(runs: CheckpointRunsInfo): string | undefined {
  const { remaining, max } = runs;
  if (typeof remaining === "number" && typeof max === "number") {
    return `Research: ${remaining}/${max} runs remaining`;
  }
  if (typeof max === "number") {
    return `Research: up to ${max} runs this session`;
  }
  if (typeof remaining === "number") {
    return `Research: ${remaining} runs remaining`;
  }
  return undefined;
}

// ──── Safe failure copy ─────────────────────────────────────────────────────

/**
 * User-visible copy for a failed workspace handoff. Deliberately generic:
 * it never surfaces server error codes, tokens, ids, or internal details.
 */
export function handoffFailureMessage(): string {
  return "The workspace transfer could not be completed. Your result is still available in this session — nothing was lost. Please try again.";
}

// ──── Announcements ─────────────────────────────────────────────────────────

export type AnnouncementLevel = "polite" | "assertive";

export interface PhaseAnnouncement {
  level: AnnouncementLevel;
  message: string;
}

/**
 * Decide whether a phase transition should be announced. The timer must never
 * announce every second — only warning/critical/ended transitions, with the
 * critical phases using an assertive live region.
 */
export function phaseAnnouncement(
  previous: CheckpointBannerPhase,
  next: CheckpointBannerPhase,
  endedMessage?: string,
): PhaseAnnouncement | undefined {
  if (previous === next) return undefined;
  switch (next) {
    case "warning-2m":
      return {
        level: "polite",
        message: "Session ending soon. About two minutes of terminal time remaining.",
      };
    case "critical-30s":
      return {
        level: "assertive",
        message: "URGENT: This public session closes in under 30 seconds. Save your result to your workspace now if you want to keep it.",
      };
    case "ended":
      return {
        level: "assertive",
        message: endedMessage ?? "Public session ended.",
      };
    default:
      // Entering "normal" (or a non-urgent phase) is not announced.
      return undefined;
  }
}

// ──── BeforeUnload gating ───────────────────────────────────────────────────

export interface BeforeUnloadDecision {
  acknowledged: boolean;
  dismissed: boolean;
  hasMeaningfulActivity: boolean;
  workspaceHandoffAvailable: boolean;
}

/**
 * Only block navigation when the user has explicitly opted into conversion
 * (meaningful activity + handoff capability) AND has neither durably
 * acknowledged nor explicitly dismissed the save reminder. This keeps the
 * beforeunload guard non-coercive.
 */
export function shouldBlockNavigation(decision: BeforeUnloadDecision): boolean {
  return (
    !decision.acknowledged
    && !decision.dismissed
    && decision.hasMeaningfulActivity
    && decision.workspaceHandoffAvailable
  );
}

// ──── Ended-state copy ──────────────────────────────────────────────────────

/** Honest message when the session ended and the result WAS saved. */
export function endReasonMessage(reason?: string): string {
  switch (reason) {
    case "daily-budget-exhausted":
      return "Daily research budget exhausted — please return after reset";
    case "idle-timeout":
      return "Session ended after inactivity";
    case "absolute-timeout":
      return "15-minute public session complete";
    case "worker-unavailable":
      return "Assigned terminal worker restarted";
    case "rate-limited":
      return "Activity limit exceeded";
    case "protocol-violation":
      return "Session closed for safety";
    default:
      return "Session ended";
  }
}

/** Honest message when the session ended without a saved workspace snapshot. */
export function noSnapshotMessage(reason?: string): string {
  if (reason === "absolute-timeout" || reason === "idle-timeout") {
    return "No workspace snapshot was saved before this session ended.";
  }
  return "The session ended before a workspace snapshot could be created.";
}

// ──── Dialog focus traversal ───────────────────────────────────────────────

/** Focusable candidates inside the confirmation dialog (matches modal docs). */
export const FOCUSABLE_SELECTOR =
  "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
