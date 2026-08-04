/**
 * Workspace Checkpoint Banner — live session countdown and conversion UI.
 *
 * Displays a persistent session countdown with staged warnings:
 * - Normal: session time remaining + honest research-runs info
 * - 2-minute warning: prominent amber notice
 * - <30s warning: red urgent notice with exact close reason
 * - Ended: close reason propagation + new-session action
 *
 * The conversion CTA (Keep this in my workspace) appears only after meaningful
 * activity AND when the server advertises workspace handoff capability. It
 * requires a durable acknowledgement before navigating away, and an explicit
 * dismiss path keeps that guard non-coercive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  checkpointPhase,
  endReasonMessage,
  FOCUSABLE_SELECTOR,
  formatRunsLabel,
  handoffFailureMessage,
  noSnapshotMessage,
  phaseAnnouncement,
  shouldBlockNavigation,
  type CheckpointBannerPhase,
  type CheckpointRunsInfo,
  type PhaseAnnouncement,
} from "./workspace-checkpoint-banner-logic";

// ──── Types ─────────────────────────────────────────────────────────────────

export type { CheckpointBannerPhase, CheckpointRunsInfo };

export interface WorkspaceCheckpointBannerProps {
  /** Absolute session expiry timestamp (epoch ms). */
  sessionExpiresAt: number;
  /**
   * Authoritative research runs remaining from the gateway. Omitted when the
   * gateway has no authoritative balance — the banner then shows no count
   * rather than a fabricated full-balance figure.
   */
  researchRunsRemaining?: number;
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

// ──── Helpers ───────────────────────────────────────────────────────────────

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
  const [handoffError, setHandoffError] = useState(false);
  const [acknowledgedBeforeNavigate, setAcknowledgedBeforeNavigate] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [handoffCreated, setHandoffCreated] = useState(false);
  const [showConversionConfirm, setShowConversionConfirm] = useState(false);
  const [liveAnnouncement, setLiveAnnouncement] = useState<PhaseAnnouncement>();
  // Synchronous guard so a navigation that happens before React re-renders
  // still respects the durable acknowledgement.
  const acknowledgedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const confirmTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmDialogRef = useRef<HTMLDivElement>(null);
  const confirmPrimaryRef = useRef<HTMLButtonElement>(null);

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
  const phase = useMemo<CheckpointBannerPhase>(() => checkpointPhase(remaining), [remaining]);

  // ── Phase-transition announcements (never per-second) ──────────────────
  const endedMessage = handoffCreated ? endReasonMessage(endReason) : noSnapshotMessage(endReason);
  const prevPhaseRef = useRef<CheckpointBannerPhase>(phase);
  useEffect(() => {
    const previous = prevPhaseRef.current;
    if (previous === phase) return;
    prevPhaseRef.current = phase;
    const announcement = phaseAnnouncement(previous, phase, endedMessage);
    if (announcement) setLiveAnnouncement(announcement);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── BeforeUnload guard for durable ack (non-coercive) ──────────────────
  const blockNavigation = shouldBlockNavigation({
    acknowledged: acknowledgedBeforeNavigate,
    dismissed,
    hasMeaningfulActivity,
    workspaceHandoffAvailable,
  });
  useEffect(() => {
    if (!blockNavigation) return;

    const handler = (event: BeforeUnloadEvent) => {
      if (acknowledgedRef.current) return;
      // Standard beforeunload prevention
      event.preventDefault();
      // For older browsers
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [blockNavigation]);

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleConvert = useCallback(async () => {
    setConverting(true);
    setHandoffError(false);
    try {
      const success = await onConvertToWorkspace();
      if (success) {
        acknowledgedRef.current = true;
        setAcknowledgedBeforeNavigate(true);
        setHandoffCreated(true);
        setShowConversionConfirm(false);
        requestAnimationFrame(() => confirmTriggerRef.current?.focus({ preventScroll: true }));
      } else {
        setConverting(false);
        setHandoffError(true);
      }
    } catch {
      setConverting(false);
      setHandoffError(true);
    }
  }, [onConvertToWorkspace]);

  const handleNewSession = useCallback(() => {
    acknowledgedRef.current = true;
    setAcknowledgedBeforeNavigate(true);
    onNewSession();
  }, [onNewSession]);

  /** Explicit dismiss/acknowledge: the user may leave without saving. */
  const handleDismiss = useCallback(() => {
    acknowledgedRef.current = true;
    setAcknowledgedBeforeNavigate(true);
    setDismissed(true);
    setShowConversionConfirm(false);
    requestAnimationFrame(() => confirmTriggerRef.current?.focus({ preventScroll: true }));
  }, []);

  const closeConfirm = useCallback(() => {
    setShowConversionConfirm(false);
    requestAnimationFrame(() => confirmTriggerRef.current?.focus({ preventScroll: true }));
  }, []);

  // ── Confirmation dialog focus management ───────────────────────────────
  useEffect(() => {
    if (!showConversionConfirm) return;
    requestAnimationFrame(() => confirmPrimaryRef.current?.focus({ preventScroll: true }));
  }, [showConversionConfirm]);

  useEffect(() => {
    if (!showConversionConfirm) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeConfirm();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = confirmDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        confirmPrimaryRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !(active instanceof Node) || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !(active instanceof Node) || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeConfirm, showConversionConfirm]);

  // ── Derived display state ──────────────────────────────────────────────
  const isEnded = phase === "ended";
  // Feed the gateway's authoritative balance (when present) through the pure
  // runs-label logic: real remaining is shown verbatim, otherwise only the
  // honest session cap is stated — never a fabricated full-balance figure.
  const runsLabel = formatRunsLabel({
    remaining: researchRunsRemaining,
    max: maxResearchRuns,
  });
  const showConversionConfirmDialog = showConversionConfirm && !converting && !dismissed;

  const showConversionCta =
    hasMeaningfulActivity
    && workspaceHandoffAvailable
    && !converting
    && !dismissed
    && !isEnded
    && !showConversionConfirmDialog;

  return (
    <div className={`workspace-checkpoint-banner workspace-checkpoint-${phase}`}>
      {/* Visually-hidden live regions: announce ONLY phase transitions. */}
      <span className="workspace-checkpoint-live workspace-checkpoint-live-polite" role="status" aria-live="polite">
        {liveAnnouncement?.level === "polite" && (
          <span key={liveAnnouncement.message}>{liveAnnouncement.message}</span>
        )}
      </span>
      <span className="workspace-checkpoint-live workspace-checkpoint-live-assertive" role="alert">
        {liveAnnouncement?.level === "assertive" && (
          <span key={liveAnnouncement.message}>{liveAnnouncement.message}</span>
        )}
      </span>

      {/* Session countdown and runs */}
      <div className="workspace-checkpoint-info">
        {!isEnded ? (
          <>
            <span className="workspace-checkpoint-timer">
              <span className="workspace-checkpoint-timer-icon" aria-hidden="true">
                {phase === "critical-30s" ? "●" : "◉"}
              </span>
              <span className="workspace-checkpoint-timer-value" aria-hidden="true">
                {formatTime(remaining)}
              </span>
              {phase === "warning-2m" && (
                <span className="workspace-checkpoint-timer-warning" aria-hidden="true">
                  Session ending soon
                </span>
              )}
              {phase === "critical-30s" && (
                <span className="workspace-checkpoint-timer-critical" aria-hidden="true">
                  Closing in {Math.ceil(remaining / 1000)}s
                </span>
              )}
            </span>
            {runsLabel && <span className="workspace-checkpoint-runs">{runsLabel}</span>}
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
        {showConversionCta && (
          <button
            ref={confirmTriggerRef}
            type="button"
            className="workspace-checkpoint-convert-cta"
            onClick={() => setShowConversionConfirm(true)}
          >
            KEEP IN WORKSPACE <span aria-hidden="true">→</span>
          </button>
        )}

        {/* Explicit dismiss/acknowledge — removes beforeunload coercion */}
        {hasMeaningfulActivity && workspaceHandoffAvailable && !dismissed && !isEnded && !converting && !showConversionConfirmDialog && (
          <button
            type="button"
            className="workspace-checkpoint-dismiss"
            onClick={handleDismiss}
            aria-label="Dismiss save reminder and allow leaving this session without saving"
          >
            DISMISS
          </button>
        )}
        {dismissed && !isEnded && (
          <span className="workspace-checkpoint-dismissed-note">
            No snapshot will be saved — you can leave freely.
          </span>
        )}

        {/* Conversion confirmation dialog */}
        {showConversionConfirmDialog && (
          <div
            ref={confirmDialogRef}
            className="workspace-checkpoint-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-checkpoint-confirm-title"
            aria-describedby="workspace-checkpoint-confirm-detail"
          >
            {handoffError && (
              <div className="workspace-checkpoint-confirm-error" role="alert">
                <strong>Workspace transfer could not be completed</strong>
                {handoffFailureMessage()}
              </div>
            )}
            <p id="workspace-checkpoint-confirm-title">Save your terminal state to a private workspace?</p>
            <p id="workspace-checkpoint-confirm-detail" className="workspace-checkpoint-confirm-detail">
              Research results, evidence, context, and watchlist will transfer.
              A private workspace session starts fresh from this checkpoint.
            </p>
            <div className="workspace-checkpoint-confirm-actions">
              <button
                ref={confirmPrimaryRef}
                type="button"
                className="workspace-checkpoint-confirm-primary"
                onClick={() => void handleConvert()}
                disabled={converting}
              >
                {converting ? "CREATING CHECKPOINT…" : handoffError ? "TRY AGAIN" : "YES, SAVE TO WORKSPACE"}
              </button>
              <button
                type="button"
                className="workspace-checkpoint-confirm-secondary"
                onClick={closeConfirm}
                disabled={converting}
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
