/**
 * Workspace checkpoint HTTP handler — server-side checkpoint creation endpoint.
 *
 * Receives a checkpoint from the browser (built from accumulated session data),
 * validates it, forwards to the internal financial-workspace service, and
 * returns a handoff reference. Secrets are NEVER returned to JS; the gateway
 * sets an HttpOnly cookie for the handoff secret.
 *
 * Feature-flagged with FINANCIAL_WORKSPACE_CHECKPOINTS=1.
 *
 * Endpoint: POST /internal/financial-workspace/checkpoints
 * Auth: Bearer control token (x-fin-terminal-control-token header)
 */

import type { Request, Response } from "express";
import {
  validateCheckpoint,
  isWorkspaceCheckpointEnabled,
  workspaceServiceUrl,
  workspaceControlToken,
  type CheckpointCreateResponse,
  type FinancialTerminalCheckpoint,
} from "../shared/financial-workspace-checkpoint.js";

const CHECKPOINT_INTERNAL_PATH = "/internal/financial-workspace/checkpoints";
const CONTROL_TOKEN_HEADER = "x-fin-terminal-control-token";
const HANDOFF_COOKIE_NAME = "fin-terminal-handoff-secret";
const INTERNAL_SERVICE_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Create the checkpoint handler middleware.
 * Returns a handler that can be mounted on the express app.
 */
export function createWorkspaceCheckpointHandler(options: {
  env?: NodeJS.ProcessEnv;
} = {}) {
  const env = options.env ?? process.env;

  return async function workspaceCheckpointHandler(
    request: Request,
    response: Response,
  ): Promise<void> {
    // Feature flag gate
    if (!isWorkspaceCheckpointEnabled(env)) {
      response.status(404).json({ error: "not_found" });
      return;
    }

    // Auth: require bearer control token
    const expectedToken = workspaceControlToken(env);
    if (!expectedToken) {
      response.status(503).json({ error: "workspace_checkpoints_not_configured" });
      return;
    }

    const suppliedToken = request.headers[CONTROL_TOKEN_HEADER];
    if (
      typeof suppliedToken !== "string"
      || suppliedToken.length !== expectedToken.length
    ) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }

    // Constant-time comparison
    const suppliedBuf = Buffer.from(suppliedToken);
    const expectedBuf = Buffer.from(expectedToken);
    if (
      suppliedBuf.length !== expectedBuf.length
      || !suppliedBuf.equals(expectedBuf)
    ) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }

    // Parse body
    if (!isRecord(request.body)) {
      response.status(400).json({ error: "invalid_request_body" });
      return;
    }

    const { requestId, source, checkpoint } = request.body as {
      requestId?: unknown;
      source?: unknown;
      checkpoint?: unknown;
    };

    // Validate request shape
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
      response.status(400).json({ error: "requestId is required" });
      return;
    }

    if (!isRecord(source)) {
      response.status(400).json({ error: "source is required" });
      return;
    }

    // Validate the checkpoint payload
    const validation = validateCheckpoint(checkpoint);
    if (!validation.valid) {
      response.status(422).json({ error: `checkpoint_validation_failed: ${validation.reason}` });
      return;
    }

    const validCheckpoint: FinancialTerminalCheckpoint = validation.checkpoint;

    // Verify session ID and generation match the source
    if (
      typeof source.sessionId !== "string"
      || source.sessionId !== validCheckpoint.source.sessionId
    ) {
      response.status(422).json({ error: "checkpoint session ID does not match source" });
      return;
    }

    if (
      typeof source.generation !== "number"
      || source.generation !== validCheckpoint.source.generation
    ) {
      response.status(422).json({ error: "checkpoint generation does not match source" });
      return;
    }

    // Forward to internal workspace service
    const serviceUrl = workspaceServiceUrl(env);
    if (!serviceUrl) {
      response.status(503).json({ error: "workspace_service_unavailable" });
      return;
    }

    const controlToken = workspaceControlToken(env)!;
    let serviceResponse: CheckpointCreateResponse | undefined;

    try {
      const fetchResponse = await fetch(
        `${serviceUrl}${CHECKPOINT_INTERNAL_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${controlToken}`,
          },
          body: JSON.stringify({
            requestId,
            source: {
              sessionId: source.sessionId,
              workerId: source.workerId ?? validCheckpoint.source.sessionId,
              generation: source.generation,
              sourceRevision: source.sourceRevision,
            },
            checkpoint: validCheckpoint,
          }),
          signal: AbortSignal.timeout(INTERNAL_SERVICE_TIMEOUT_MS),
        },
      );

      if (!fetchResponse.ok) {
        const errorText = await fetchResponse.text().catch(() => "");
        console.error(
          `[workspace-checkpoint] internal service returned ${fetchResponse.status}: ${errorText.slice(0, 200)}`,
        );
        response.status(502).json({ error: "workspace_service_error" });
        return;
      }

      serviceResponse = (await fetchResponse.json()) as CheckpointCreateResponse;
    } catch (error) {
      console.error(
        "[workspace-checkpoint] internal service unavailable:",
        error instanceof Error ? error.message : String(error),
      );
      response.status(502).json({ error: "workspace_service_unavailable" });
      return;
    }

    // Validate service response
    if (
      !serviceResponse
      || typeof serviceResponse.checkpointId !== "string"
      || typeof serviceResponse.expiresAt !== "number"
      || typeof serviceResponse.handoffId !== "string"
      || typeof serviceResponse.handoffSecret !== "string"
      || typeof serviceResponse.authUrl !== "string"
    ) {
      response.status(502).json({ error: "workspace_service_invalid_response" });
      return;
    }

    // Set HttpOnly Secure SameSite=Lax cookie with the handoff secret
    // The handoff secret NEVER reaches browser JS — it is only in the cookie
    response.cookie(HANDOFF_COOKIE_NAME, serviceResponse.handoffSecret, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.max(0, Math.floor((serviceResponse.expiresAt - Date.now()) / 1000)),
    });

    // Return only safe fields to JS (explicitly exclude handoffSecret)
    response.status(201).json({
      checkpointId: serviceResponse.checkpointId,
      expiresAt: serviceResponse.expiresAt,
      handoffId: serviceResponse.handoffId,
      authUrl: serviceResponse.authUrl,
    });
  };
}
