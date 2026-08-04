/**
 * Fresh private-workspace boot from a validated checkpoint.
 *
 * A checkpoint is imported into a brand-new in-memory session — never a raw
 * transcript or process state. The canonical checkpoint is stored as an
 * extension custom entry (excluded from LLM context), and a bounded
 * continuation summary is injected as a custom message entry so the fresh
 * agent session starts from the saved research state.
 *
 * Feature-flagged with FINANCIAL_WORKSPACE_CHECKPOINTS=1.
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  validateCheckpoint,
  isWorkspaceCheckpointEnabled,
  type FinancialTerminalCheckpoint,
} from "../shared/financial-workspace-checkpoint.js";

/** Custom-entry type that carries the validated checkpoint (not sent to the LLM). */
export const WORKSPACE_CHECKPOINT_CUSTOM_TYPE = "financial-workspace-checkpoint";

/** Custom-message-entry type that carries the bounded continuation seed. */
export const WORKSPACE_CHECKPOINT_SEED_TYPE = "financial-workspace-continuation-seed";

/** Cap on the continuation seed injected into the fresh session context. */
export const WORKSPACE_CHECKPOINT_SEED_MAX_CHARS = 4_096;

export interface PrivateWorkspaceImportResult {
  sessionManager: SessionManager;
  /** Bounded continuation seed injected into the fresh session context. */
  continuationSeed: string;
  checkpoint: FinancialTerminalCheckpoint;
}

function freshSessionId(): string {
  return `private-workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Resolve the checkpoint file a private-workspace runtime should import, or
 * undefined when the feature is disabled or no file was provisioned.
 *
 * Primary env: `FIN_WORKSPACE_CHECKPOINT_FILE` — the exact variable the
 * host-side runtime provider writes when it provisions the per-account
 * volume (`/data/checkpoint.json`). Legacy alias: `TERMINAL_WORKSPACE_IMPORT_FILE`.
 * Both spellings require `FINANCIAL_WORKSPACE_CHECKPOINTS` to be enabled.
 */
export function resolveCheckpointImportFile(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!isWorkspaceCheckpointEnabled(env)) return undefined;
  return (
    env.FIN_WORKSPACE_CHECKPOINT_FILE?.trim()
    || env.TERMINAL_WORKSPACE_IMPORT_FILE?.trim()
    || undefined
  );
}

/**
 * Boot a fresh in-memory session seeded from a validated checkpoint.
 * Never restores raw transcript/process state: only the canonical checkpoint
 * (custom entry) and a bounded continuation summary (custom message) are
 * written, and only after the payload passes the shared codec validation.
 */
export function importCheckpointIntoFreshSession(options: {
  checkpoint: unknown;
  cwd: string;
}): PrivateWorkspaceImportResult {
  const validation = validateCheckpoint(options.checkpoint);
  if (!validation.valid) {
    throw new Error(`cannot import invalid checkpoint: ${validation.reason}`);
  }
  const checkpoint = validation.checkpoint;

  const sessionManager = SessionManager.inMemory(options.cwd, {
    id: freshSessionId(),
  });

  // Custom state entry: canonical checkpoint data for the extension to
  // reconstruct research state on boot. Not part of LLM context.
  sessionManager.appendCustomEntry(WORKSPACE_CHECKPOINT_CUSTOM_TYPE, checkpoint);

  // Bounded continuation seed: participates in LLM context so the fresh agent
  // session knows it is continuing saved research.
  const continuationSeed = checkpoint.continuationSummary.slice(
    0,
    WORKSPACE_CHECKPOINT_SEED_MAX_CHARS,
  );
  sessionManager.appendCustomMessageEntry(
    WORKSPACE_CHECKPOINT_SEED_TYPE,
    continuationSeed,
    true,
    {
      checkpointId: checkpoint.id,
      source: checkpoint.source,
      createdAt: checkpoint.createdAt,
      expiresAt: checkpoint.expiresAt,
    },
  );

  return { sessionManager, continuationSeed, checkpoint };
}
