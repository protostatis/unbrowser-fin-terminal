/**
 * Workspace Checkpoint Banner — live session countdown and conversion UI.
 *
 * Displays a persistent session countdown with staged warnings:
 * - Normal: session runs left + time remaining
 * - 2-minute warning: prominent amber notice
 * - <30s warning: red urgent notice with exact close reason
 * - Ended: close reason propagation + new-session action
 *
 * The conversion CTA (Keep this in my workspace) appears only after meaningful
 * activity AND when the server advertises workspace handoff capability. It
 * requires a durable acknowledgement before navigating away.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ──── Types ─────────────────────────────────────────────────────────────────

export type CheckpointBannerPhase =
  | "normal"        // session running, normal display
  | "warning-2m"    // 2-minute warning
  | "critical-30s"  // <30s remaining
  | "ended";        // session ended

export interface WorkspaceCheckpointBannerProps {
  /** Absolute session expiry timestamp (epoch ms). */
  sessionExpiresAt: number;
  /** Research runs remaining. */
  researchRunsRemaining: number;
  /** Maximum research runs for this session. */
  maxResearchRuns: number;
  /** Whether the user has performed meaningful activity. */
  hasMeaningfulActivity: boolean;
  /** Whether the server advertises workspace handoff capability. */
  workspaceHandoffAvailable: boolean;
  /** Session end reason (shown when ended). */
  endReason?: string;
  /** Callback when user opts in to workspace conversion. Resolves true only after the handoff was durably created. */
  onConvertToWorkspace: () => Promise<boolean>;
  /** Callback when user wants to start a new public session. */
  onNewSession: () => void;
  /** Current render timestamp for animation. */
  now?: () => number;
}

// ──── Constants ─────────────────────────────────────────────────────────────

const WARNING_2M_MS = 2 * 60_000;
const CRITICAL_30S_MS = 30_000;

// ──── Helpers ───────────────────────────────────────────────────────────────

function endReasonMessage(reason?: string): string {
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
function noSnapshotMessage(reason?: string): string {
  if (reason === "absolute-timeout" || reason === "idle-timeout") {
    return "No workspace snapshot was saved before this session ended.";
  }
  return "The session ended before a workspace snapshot could be created.";
}

/** Human-readable time remaining. */
function formatTime(ms: number): string {
  if (ms <= 0) return "0:00";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// ──── Component ─────────────────────────────────────────────────────────────

export function WorkspaceCheckpointBanner({
  sessionExpiresAt,
  researchRunsRemaining,
  maxResearchRuns,
  hasMeaningfulActivity,
  workspaceHandoffAvailable,
  endReason,
  onConvertToWorkspace,
  onNewSession,
  now: nowImpl,
}: WorkspaceCheckpointBannerProps) {
  const nowFn = nowImpl ?? Date.now;
  const [now, setNow] = useState(() => nowFn());
  const [converting, setConverting] = useState(false);
  const [acknowledgedBeforeNavigate, setAcknowledgedBeforeNavigate] = useState(false);
  const [handoffCreated, setHandoffCreated] = useState(false);
  const [showConversionConfirm, setShowConversionConfirm] = useState(false);
  // Synchronous guard so a navigation that happens before React re-renders
  // still respects the durable acknowledgement.
  const acknowledgedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  // ── Timer tick ─────────────────────────────────────────────────────────
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setNow(nowFn());
    }, 1_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [nowFn]);

  // ── Phase calculation ──────────────────────────────────────────────────
  const remaining = Math.max(0, sessionExpiresAt - now);
  const isEnded = remaining <= 0;

  const phase: CheckpointBannerPhase = useMemo(() => {
    if (isEnded) return "ended";
    if (remaining <= CRITICAL_30S_MS) return "critical-30s";
    if (remaining <= WARNING_2M_MS) return "warning-2m";
    return "normal";
  }, [isEnded, remaining]);

  // ── BeforeUnload guard for durable ack ─────────────────────────────────
  useEffect(() => {
    if (!hasMeaningfulActivity || !workspaceHandoffAvailable) return;
    if (acknowledgedRef.current) return;

    const handler = (event: BeforeUnloadEvent) => {
      if (acknowledgedRef.current) return;
      // Standard beforeunload prevention
      event.preventDefault();
      // For older browsers
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasMeaningfulActivity, workspaceHandoffAvailable, acknowledgedBeforeNavigate]);

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleConvert = useCallback(async () => {
    setConverting(true);
    try {
      const success = await onConvertToWorkspace();
      if (success) {
        acknowledgedRef.current = true;
        setAcknowledgedBeforeNavigate(true);
        setHandoffCreated(true);
      } else {
        setConverting(false);
      }
    } catch {
      setConverting(false);
    }
  }, [onConvertToWorkspace]);

  const handleNewSession = useCallback(() => {
    acknowledgedRef.current = true;
    setAcknowledgedBeforeNavigate(true);
    onNewSession();
  }, [onNewSession]);

  // ── Hide CTA when no handoff capability ────────────────────────────────
  const showConversionCta =
    hasMeaningfulActivity
    && workspaceHandoffAvailable
    && !converting
    && !isEnded
    && phase !== "ended";

  const showConversionConfirmDialog = showConversionConfirm && !converting;

  return (
    <div
      className={`workspace-checkpoint-banner workspace-checkpoint-${phase}`}
      role="status"
      aria-live="polite"
    >
      {/* Session countdown and runs */}
      <div className="workspace-checkpoint-info">
        {!isEnded ? (
          <>
            <span className="workspace-checkpoint-timer">
              <span className="workspace-checkpoint-timer-icon" aria-hidden="true">
                {phase === "critical-30s" ? "●" : "◉"}
              </span>
              <span className="workspace-checkpoint-timer-value">
                {formatTime(remaining)}
              </span>
              {phase === "warning-2m" && (
                <span className="workspace-checkpoint-timer-warning">
                  Session ending soon
                </span>
              )}
              {phase === "critical-30s" && (
                <span className="workspace-checkpoint-timer-critical">
                  Closing in {Math.ceil(remaining / 1000)}s
                </span>
              )}
            </span>
            <span className="workspace-checkpoint-runs">
              Research: {researchRunsRemaining}/{maxResearchRuns} runs remaining
            </span>
          </>
        ) : (
          <span className="workspace-checkpoint-ended">
            {handoffCreated ? endReasonMessage(endReason) : noSnapshotMessage(endReason)}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="workspace-checkpoint-actions">
        {/* Conversion CTA — hidden unless server says handoff is available */}
        {showConversionCta && !showConversionConfirmDialog && (
          <button
            type="button"
            className="workspace-checkpoint-convert-cta"
            onClick={() => setShowConversionConfirm(true)}
            disabled={converting}
          >
            KEEP IN WORKSPACE <span aria-hidden="true">→</span>
          </button>
        )}

        {/* Conversion confirmation dialog */}
        {showConversionConfirmDialog && (
          <div className="workspace-checkpoint-confirm" role="dialog" aria-modal="true">
            <p>Save your terminal state to a private workspace?</p>
            <p className="workspace-checkpoint-confirm-detail">
              Research results, evidence, context, and watchlist will transfer.
              A private workspace session starts fresh from this checkpoint.
            </p>
            <div className="workspace-checkpoint-confirm-actions">
              <button
                type="button"
                className="workspace-checkpoint-confirm-primary"
                onClick={handleConvert}
                disabled={converting}
              >
                {converting ? "CREATING CHECKPOINT…" : "YES, SAVE TO WORKSPACE"}
              </button>
              <button
                type="button"
                className="workspace-checkpoint-confirm-secondary"
                onClick={() => setShowConversionConfirm(false)}
              >
                NOT NOW
              </button>
            </div>
          </div>
        )}

        {/* Converting state */}
        {converting && (
          <span className="workspace-checkpoint-converting">
            Securing checkpoint…
          </span>
        )}

        {/* New session action — always available after end */}
        {isEnded && (
          <button
            type="button"
            className="workspace-checkpoint-new-session"
            onClick={handleNewSession}
          >
            NEW PUBLIC SESSION
          </button>
        )}
      </div>

      {/* Phase-based visual indicators */}
      {!isEnded && phase !== "normal" && (
        <div
          className={`workspace-checkpoint-warning-flash workspace-checkpoint-flash-${phase}`}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
