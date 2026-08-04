/**
 * Focused accessibility/DOM-decision tests for the Workspace Checkpoint
 * Banner's pure logic module (runs honesty, phase announcements, beforeunload
 * gating, safe failure copy, dialog focus traversal).
 *
 * The conversion UI review required:
 *  - no misleading fixed "5/5" runs display when live data is unavailable,
 *  - timer announcements only on warning/critical phase transitions
 *    (assertive for critical), never every second,
 *  - an explicit dismiss/acknowledge path so beforeunload is not coercive,
 *  - user-visible failure copy with no secret/internal details,
 *  - honest no-snapshot copy when the session ended without a save.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  checkpointPhase,
  CRITICAL_30S_MS,
  endReasonMessage,
  FOCUSABLE_SELECTOR,
  formatRunsLabel,
  handoffFailureMessage,
  noSnapshotMessage,
  phaseAnnouncement,
  shouldBlockNavigation,
  WARNING_2M_MS,
  type BeforeUnloadDecision,
} from "../web/src/workspace-checkpoint-banner-logic.js";

test("phase classification is exact at the warning/critical boundaries", () => {
  assert.equal(checkpointPhase(0), "ended");
  assert.equal(checkpointPhase(1), "critical-30s");
  assert.equal(checkpointPhase(CRITICAL_30S_MS), "critical-30s");
  assert.equal(checkpointPhase(CRITICAL_30S_MS + 1), "warning-2m");
  assert.equal(checkpointPhase(WARNING_2M_MS), "warning-2m");
  assert.equal(checkpointPhase(WARNING_2M_MS + 1), "normal");
  assert.equal(checkpointPhase(Number.POSITIVE_INFINITY), "normal");
});

test("runs label avoids a misleading fixed remaining count when live data is missing", () => {
  // Real data from the (future) core: a real remaining count is shown verbatim.
  assert.equal(formatRunsLabel({ remaining: 3, max: 5 }), "Research: 3/5 runs remaining");
  assert.equal(formatRunsLabel({ remaining: 0, max: 5 }), "Research: 0/5 runs remaining");

  // Only the cap is known: honest "up to N", never "N/N".
  assert.equal(formatRunsLabel({ max: 5 }), "Research: up to 5 runs this session");

  // Only remaining is known (no cap to pair it with).
  assert.equal(formatRunsLabel({ remaining: 3 }), "Research: 3 runs remaining");

  // Nothing known: no runs readout at all.
  assert.equal(formatRunsLabel({}), undefined);
});

test("announcements fire only on phase transitions and mark critical as assertive", () => {
  // No announcement when the phase does not change (the timer ticks every
  // second without interrupting screen readers).
  assert.equal(phaseAnnouncement("normal", "normal"), undefined);
  assert.equal(phaseAnnouncement("warning-2m", "warning-2m"), undefined);
  assert.equal(phaseAnnouncement("critical-30s", "critical-30s"), undefined);
  assert.equal(phaseAnnouncement("ended", "ended"), undefined);

  // 2-minute warning is polite.
  const warning = phaseAnnouncement("normal", "warning-2m");
  assert.equal(warning?.level, "polite");
  assert.match(warning!.message, /ending soon/i);
  assert.match(warning!.message, /two minutes/i);

  // Critical is assertive and urgent.
  const critical = phaseAnnouncement("warning-2m", "critical-30s");
  assert.equal(critical?.level, "assertive");
  assert.match(critical!.message, /urgent/i);
  assert.match(critical!.message, /30 seconds/i);

  // Ended is assertive and carries the honest snapshot message.
  const ended = phaseAnnouncement(
    "critical-30s",
    "ended",
    "No workspace snapshot was saved before this session ended.",
  );
  assert.equal(ended?.level, "assertive");
  assert.match(ended!.message, /No workspace snapshot was saved/);

  // Entering "normal" from a warning is not announced.
  assert.equal(phaseAnnouncement("warning-2m", "normal"), undefined);
});

test("safe handoff failure copy exposes no secrets or internal details and offers retry", () => {
  const message = handoffFailureMessage();
  assert.ok(message.length > 0);
  // No error codes, ids, tokens, urls, or internal identifiers.
  assert.ok(!/[A-Z][A-Z0-9_]+\s*\/\s*[0-9]+/.test(message), "no internal error codes");
  assert.ok(!/[0-9a-f]{12,}/i.test(message), "no opaque ids");
  assert.ok(!/https?:\/\/|token|secret|cookie/i.test(message), "no secret/internal details");
  // The user always has a recovery path.
  assert.match(message, /try again/i);
  assert.match(message, /still available/i);
});

test("beforeunload is blocked only until the user acknowledges or explicitly dismisses", () => {
  const gate: BeforeUnloadDecision = {
    acknowledged: false,
    dismissed: false,
    hasMeaningfulActivity: true,
    workspaceHandoffAvailable: true,
  };
  assert.equal(shouldBlockNavigation(gate), true, "opt-in + unacknowledged blocks");

  // Durable acknowledgement (successful conversion or new session) unlocks.
  assert.equal(shouldBlockNavigation({ ...gate, acknowledged: true }), false);
  // Explicit dismiss/acknowledge path unlocks too (non-coercive).
  assert.equal(shouldBlockNavigation({ ...gate, dismissed: true }), false);
  // Before any meaningful activity there is nothing to save: never blocked.
  assert.equal(shouldBlockNavigation({ ...gate, hasMeaningfulActivity: false }), false);
  // No handoff capability means there is no opt-in to protect.
  assert.equal(shouldBlockNavigation({ ...gate, workspaceHandoffAvailable: false }), false);
  assert.equal(
    shouldBlockNavigation({
      acknowledged: false,
      dismissed: false,
      hasMeaningfulActivity: false,
      workspaceHandoffAvailable: true,
    }),
    false,
  );
});

test("ended state keeps the honest no-snapshot copy when nothing was saved", () => {
  assert.match(noSnapshotMessage("absolute-timeout"), /No workspace snapshot was saved/);
  assert.match(noSnapshotMessage("idle-timeout"), /No workspace snapshot was saved/);
  assert.match(noSnapshotMessage("rate-limited"), /before a workspace snapshot could be created/);
  assert.match(noSnapshotMessage(undefined), /before a workspace snapshot could be created/);
  assert.match(endReasonMessage("absolute-timeout"), /15-minute public session complete/);
});

test("dialog focus selector covers every confirmation action for keyboard traversal", () => {
  assert.match(FOCUSABLE_SELECTOR, /button:not\(\[disabled\]\)/);
  assert.match(FOCUSABLE_SELECTOR, /a\[href\]/);
  assert.match(FOCUSABLE_SELECTOR, /input:not\(\[disabled\]\)/);
  assert.match(FOCUSABLE_SELECTOR, /textarea:not\(\[disabled\]\)/);
  assert.match(FOCUSABLE_SELECTOR, /\[tabindex\]:not\(\[tabindex='-1'\]\)/);
});
