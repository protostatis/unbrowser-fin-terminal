/**
 * Gateway-side workspace-handoff controller.
 *
 * The browser only initiates opt-in: it posts its ticket token and receives a
 * safe redirect reference. This controller then:
 *   1. Verifies the ticket belongs to an active assigned session.
 *   2. Calls the assigned worker's PRIVATE checkpoint-export endpoint
 *      (authenticated with the proxy + control tokens) for exactly that
 *      session/generation.
 *   3. Forwards the authoritative checkpoint to the workspace control service.
 *   4. Sets the handoff secret as an HttpOnly cookie and returns only safe
 *      fields to JS — the handoff secret never reaches browser JS.
 *
 * Mounted on the public listener at POST /api/public/workspace-handoff.
 */

import type { Request, Response } from "express";
import {
  isWorkspaceCheckpointEnabled,
  workspaceServiceUrl,
  workspaceControlToken,
  CHECKPOINT_CREATE_PATH,
  CHECKPOINT_EXPORT_PATH,
  type CheckpointCreateResponse,
} from "../shared/financial-workspace-checkpoint.js";
import { CONTROL_TOKEN_HEADER } from "./workspace-checkpoint-handler.js";
import { workerGenerationEpoch } from "./workspace-checkpoint-export.js";

export const HANDOFF_COOKIE_NAME = "fin-terminal-handoff-secret";
const WORKER_PROXY_TOKEN_HEADER = "x-fin-terminal-proxy-token";
const INTERNAL_SERVICE_TIMEOUT_MS = 10_000;

export interface WorkspaceHandoffAssignment {
  workerId: string;
  workerUrl: string;
  workerGeneration: string;
}

export interface WorkspaceHandoffControllerOptions {
  env?: NodeJS.ProcessEnv;
  /** Resolve the authenticated visitor+ticket pair from the request. */
  ticketFromRequest: (request: Request) => { visitorId: string; ticketId: string } | undefined;
  /** Return the active assignment for the ticket, or undefined when stale/foreign. */
  activeAssignmentFor: (
    ticketId: string,
    visitorId: string,
  ) => WorkspaceHandoffAssignment | undefined;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

export function createWorkspaceHandoffController(
  options: WorkspaceHandoffControllerOptions,
) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return async function workspaceHandoffController(
    request: Request,
    response: Response,
  ): Promise<void> {
    if (!isWorkspaceCheckpointEnabled(env)) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    const serviceUrl = workspaceServiceUrl(env);
    const controlToken = workspaceControlToken(env);
    if (!serviceUrl || !controlToken) {
      response.status(503).json({ error: "workspace_checkpoints_not_configured" });
      return;
    }

    const ticket = options.ticketFromRequest(request);
    if (!ticket) {
      response.status(401).json({ error: "ticket_required" });
      return;
    }
    const assignment = options.activeAssignmentFor(ticket.ticketId, ticket.visitorId);
    if (!assignment) {
      response.status(409).json({ error: "session_not_active" });
      return;
    }

    // 1. Request the authoritative checkpoint from the assigned worker.
    let exported: { checkpoint?: unknown };
    try {
      const exportResponse = await fetchImpl(
        `${assignment.workerUrl}${CHECKPOINT_EXPORT_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [WORKER_PROXY_TOKEN_HEADER]: env.PUBLIC_WORKER_PROXY_TOKEN?.trim() ?? "",
            [CONTROL_TOKEN_HEADER]: controlToken,
          },
          body: JSON.stringify({
            sessionId: ticket.ticketId,
            generation: workerGenerationEpoch(assignment.workerGeneration),
          }),
          signal: AbortSignal.timeout(INTERNAL_SERVICE_TIMEOUT_MS),
        },
      );
      if (!exportResponse.ok) {
        const errorText = await exportResponse.text().catch(() => "");
        console.error(
          `[workspace-checkpoint] worker export returned ${exportResponse.status}: ${errorText.slice(0, 200)}`,
        );
        response.status(502).json({ error: "worker_export_failed" });
        return;
      }
      exported = (await exportResponse.json()) as { checkpoint?: unknown };
    } catch (error) {
      console.error(
        "[workspace-checkpoint] worker export unavailable:",
        error instanceof Error ? error.message : String(error),
      );
      response.status(502).json({ error: "worker_export_unavailable" });
      return;
    }
    if (!isRecord(exported) || !isRecord(exported.checkpoint)) {
      response.status(502).json({ error: "worker_export_invalid_response" });
      return;
    }
    const checkpoint = exported.checkpoint;

    // 2. Forward to the internal workspace service.
    const requestId = `${ticket.ticketId}-${Date.now().toString(36)}`;
    let serviceResponse: CheckpointCreateResponse | undefined;
    try {
      const createResponse = await fetchImpl(
        `${serviceUrl}${CHECKPOINT_CREATE_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${controlToken}`,
          },
          body: JSON.stringify({
            requestId,
            source: {
              sessionId: ticket.ticketId,
              workerId: boundedString(assignment.workerId, 128) ?? assignment.workerId,
              generation: workerGenerationEpoch(assignment.workerGeneration),
              sourceRevision: boundedString(assignment.workerGeneration, 160),
            },
            checkpoint,
          }),
          signal: AbortSignal.timeout(INTERNAL_SERVICE_TIMEOUT_MS),
        },
      );
      if (!createResponse.ok) {
        const errorText = await createResponse.text().catch(() => "");
        console.error(
          `[workspace-checkpoint] workspace service returned ${createResponse.status}: ${errorText.slice(0, 200)}`,
        );
        response.status(502).json({ error: "workspace_service_error" });
        return;
      }
      serviceResponse = (await createResponse.json()) as CheckpointCreateResponse;
    } catch (error) {
      console.error(
        "[workspace-checkpoint] workspace service unavailable:",
        error instanceof Error ? error.message : String(error),
      );
      response.status(502).json({ error: "workspace_service_unavailable" });
      return;
    }

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

    // 3. Handoff secret goes ONLY into the HttpOnly cookie.
    response.cookie(HANDOFF_COOKIE_NAME, serviceResponse.handoffSecret, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.max(0, Math.floor((serviceResponse.expiresAt - Date.now()) / 1000)),
    });

    response.status(201).json({
      checkpointId: serviceResponse.checkpointId,
      expiresAt: serviceResponse.expiresAt,
      handoffId: serviceResponse.handoffId,
      authUrl: serviceResponse.authUrl,
    });
  };
}
