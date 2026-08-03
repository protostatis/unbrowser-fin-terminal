/**
 * Worker-side private workspace-checkpoint export endpoint.
 *
 * Mounted on the LIVE worker server (never on the public listener). The
 * gateway calls it only for the active assigned session/generation and sends
 * the shared control token. The checkpoint is built exclusively from the
 * worker's authoritative state — never from browser frame content.
 *
 * Endpoint: POST /internal/financial-workspace/checkpoint-export
 * Auth:     X-Fin-Terminal-Control-Token (constant-time compare)
 * Body:     { sessionId, generation, sourceRevision? }
 *
 * Feature-flagged with FINANCIAL_WORKSPACE_CHECKPOINTS=1.
 */

import type { Request, Response } from "express";
import {
  isWorkspaceCheckpointEnabled,
  workspaceControlToken,
  CHECKPOINT_EXPORT_PATH,
} from "../shared/financial-workspace-checkpoint.js";
import {
  buildAuthoritativeCheckpoint,
  serializeAuthoritativeCheckpoint,
  type CheckpointWorkerState,
  type ServerCheckpointEventLog,
} from "./workspace-checkpoint-export.js";

export const CONTROL_TOKEN_HEADER = "x-fin-terminal-control-token";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface WorkerCheckpointExportContext {
  sessionId: string;
  generation: number;
  sourceRevision?: string;
  /** Authoritative extension frame state (debugState projection). */
  state: CheckpointWorkerState;
  /** Server-observed event log (never browser-sourced). */
  eventLog: ServerCheckpointEventLog;
}

export interface WorkspaceCheckpointExportHandlerOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Returns the worker's current export context, or undefined when no public
   * session is attached. The handler verifies the requested session/generation
   * against this authoritative context.
   */
  getExportContext: () => WorkerCheckpointExportContext | undefined;
}

export function createWorkspaceCheckpointExportHandler(
  options: WorkspaceCheckpointExportHandlerOptions,
) {
  const env = options.env ?? process.env;

  return async function workspaceCheckpointExportHandler(
    request: Request,
    response: Response,
  ): Promise<void> {
    if (!isWorkspaceCheckpointEnabled(env)) {
      response.status(404).json({ error: "not_found" });
      return;
    }

    const expectedToken = workspaceControlToken(env);
    if (!expectedToken) {
      response.status(503).json({ error: "workspace_checkpoints_not_configured" });
      return;
    }

    const suppliedToken = request.headers[CONTROL_TOKEN_HEADER];
    const suppliedBuf = Buffer.from(typeof suppliedToken === "string" ? suppliedToken : "");
    const expectedBuf = Buffer.from(expectedToken);
    if (
      suppliedBuf.length !== expectedBuf.length
      || !suppliedBuf.equals(expectedBuf)
    ) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }

    if (!isRecord(request.body)) {
      response.status(400).json({ error: "invalid_request_body" });
      return;
    }
    const sessionId = request.body.sessionId;
    const generation = request.body.generation;
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) {
      response.status(400).json({ error: "sessionId is required" });
      return;
    }
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) {
      response.status(400).json({ error: "generation is required" });
      return;
    }

    const context = options.getExportContext();
    if (!context) {
      response.status(409).json({ error: "no_active_public_session" });
      return;
    }
    if (context.sessionId !== sessionId || context.generation !== generation) {
      response.status(409).json({ error: "session_generation_mismatch" });
      return;
    }

    try {
      const checkpoint = buildAuthoritativeCheckpoint({
        state: context.state,
        sessionId: context.sessionId,
        generation: context.generation,
        sourceRevision: context.sourceRevision,
        eventLog: context.eventLog,
      });
      const serialized = serializeAuthoritativeCheckpoint(checkpoint);
      response.status(200).json({ checkpoint: JSON.parse(serialized) });
    } catch (error) {
      console.error(
        "[workspace-checkpoint] export failed:",
        error instanceof Error ? error.message : String(error),
      );
      response.status(422).json({
        error: error instanceof Error ? error.message : "checkpoint_export_failed",
      });
    }
  };
}

export { CHECKPOINT_EXPORT_PATH };
