/**
 * Private management API listener for warm-pool capacity operations.
 *
 * Listens on a separate port (default 8789, configurable). Access is gated
 * by a dedicated token (header-based). The API does NOT expose Docker,
 * secrets, or browser identity material.
 *
 * Endpoints:
 *   GET  /api/management/seats         — per-seat status/plan
 *   POST /api/management/seats/:id/drain — drain a seat
 *   POST /api/management/seats/:id/activate — activate a drained seat
 *   POST /api/management/reconcile     — force re-evaluation of the warm pool
 *   GET  /api/management/research      — research permit status
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import type { CapacityWarmPool, SeatStatus } from "./capacity-warm-pool.js";
import type { ResearchPermitCoordinator } from "./research-permit-coordinator.js";

export interface ManagementApiConfig {
  host: string;
  port: number;
  token: string;
  enabled: boolean;
}

const MATH_SCRIPT_ALLOWED = /^[A-Za-z0-9_-]{1,64}$/;

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      if (chunks.reduce((total, c) => total + c.length, 0) + chunk.length > 8_192) {
        request.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function jsonResponse(
  socket: Socket,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  const response = [
    `HTTP/1.1 ${status} ${statusText(status)}`,
    "Content-Type: application/json",
    "Cache-Control: no-store, private",
    `Content-Length: ${Buffer.byteLength(payload, "utf8")}`,
    "Connection: close",
    "",
    payload,
  ].join("\r\n");
  socket.end(response);
}

function textResponse(socket: Socket, status: number, text: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
    "Content-Type: text/plain\r\n" +
    "Cache-Control: no-store, private\r\n" +
    `Content-Length: ${Buffer.byteLength(text, "utf8")}\r\n` +
    "Connection: close\r\n\r\n" +
    text,
  );
}

function statusText(status: number): string {
  switch (status) {
    case 200: return "OK";
    case 201: return "Created";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 409: return "Conflict";
    case 429: return "Too Many Requests";
    case 500: return "Internal Server Error";
    case 503: return "Service Unavailable";
    default: return String(status);
  }
}

export interface ManagementApi {
  server: HttpServer;
  close(): Promise<void>;
}

interface ManagementApiDependencies {
  getSeatStatuses: () => SeatStatus[];
  getWarmPool: () => CapacityWarmPool;
  getResearchCoordinator: () => ResearchPermitCoordinator;
  mutate: <T>(operation: () => T | Promise<T>) => Promise<T>;
  inspect: <T>(operation: () => T) => Promise<T>;
}

export function startManagementApi(
  config: ManagementApiConfig,
  deps: ManagementApiDependencies,
): ManagementApi | undefined {
  if (!config.enabled) {
    console.log("[management] private management API is disabled");
    return undefined;
  }

  const server = createServer(async (request, response) => {
    const socket = request.socket as Socket;

    // Auth: require management token header
    const suppliedToken = singleHeader(request, "x-management-token");
    if (!suppliedToken || suppliedToken !== config.token) {
      textResponse(socket, 401, "Unauthorized");
      return;
    }

    // Parse URL
    let parsed: URL;
    try {
      parsed = new URL(request.url ?? "/", `http://${config.host}:${config.port}`);
    } catch {
      textResponse(socket, 400, "Bad Request");
      return;
    }

    const method = (request.method ?? "GET").toUpperCase();
    const path = parsed.pathname;

    // ── GET /api/management/seats ─────────────────────────────
    if (method === "GET" && path === "/api/management/seats") {
      try {
        const seats = await deps.inspect(() => deps.getSeatStatuses());
        const warmPool = deps.getWarmPool();
        const plan = warmPool.plan(seats);
        jsonResponse(socket, 200, {
          seats: seats.map((s) => ({
            workerId: s.workerId,
            phase: s.phase,
            generation: s.generation ?? null,
            sessionId: s.sessionId ?? null,
            idleSinceMs: s.idleSinceMs ?? null,
            drainRequested: s.drainRequested,
            drainId: s.drainId ?? null,
          })),
          plan: {
            desiredRunning: plan.desiredRunning,
            scaleDownCandidates: plan.scaleDownCandidates,
            activateCandidates: plan.activateCandidates,
          },
        });
      } catch (error) {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // ── POST /api/management/seats/:id/drain ──────────────────
    const drainMatch = path.match(/^\/api\/management\/seats\/([A-Za-z0-9_-]+)\/drain$/);
    if (method === "POST" && drainMatch) {
      const workerId = drainMatch[1];
      if (!MATH_SCRIPT_ALLOWED.test(workerId)) {
        textResponse(socket, 400, "Bad Request: invalid seat id");
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (err) {
        textResponse(socket, 400, `Bad Request: ${err instanceof Error ? err.message : "unknown"}`);
        return;
      }

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        textResponse(socket, 400, "Bad Request: JSON object required");
        return;
      }

      const drainId = (body as Record<string, unknown>).drainId;
      if (typeof drainId !== "string" || drainId.length === 0 || drainId.length > 128) {
        textResponse(socket, 400, "Bad Request: drainId required (string, 1-128 chars)");
        return;
      }

      try {
        const result = await deps.mutate(() => {
          const seats = deps.getSeatStatuses();
          const seat = seats.find((s) => s.workerId === workerId);
          if (!seat) return { accepted: false, reason: "unknown seat" };
          return deps.getWarmPool().requestDrain(seat, drainId);
        });

        if (result.accepted) {
          jsonResponse(socket, 200, { accepted: true, drainId: (result as { drainId: string }).drainId });
        } else {
          jsonResponse(socket, 409, { accepted: false, reason: (result as { reason: string }).reason });
        }
      } catch (error) {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // ── POST /api/management/seats/:id/activate ──────────────
    const activateMatch = path.match(/^\/api\/management\/seats\/([A-Za-z0-9_-]+)\/activate$/);
    if (method === "POST" && activateMatch) {
      const workerId = activateMatch[1];
      if (!MATH_SCRIPT_ALLOWED.test(workerId)) {
        textResponse(socket, 400, "Bad Request: invalid seat id");
        return;
      }

      try {
        const result = await deps.mutate(() => {
          const seats = deps.getSeatStatuses();
          const seat = seats.find((s) => s.workerId === workerId);
          if (!seat) return { released: false, reason: "unknown seat" };
          return deps.getWarmPool().releaseDrain(workerId, seat.generation);
        });

        if (result.released) {
          jsonResponse(socket, 200, { activated: true });
        } else {
          // Try force release if sticky
          deps.getWarmPool().forceReleaseDrain(workerId);
          jsonResponse(socket, 200, { activated: true, note: "force-released" });
        }
      } catch (error) {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // ── POST /api/management/reconcile ──────────────────────
    if (method === "POST" && path === "/api/management/reconcile") {
      try {
        const result = await deps.mutate(() => {
          const seats = deps.getSeatStatuses();
          const plan = deps.getWarmPool().plan(seats);
          return plan;
        });

        jsonResponse(socket, 200, {
          reconciled: true,
          plan: {
            desiredRunning: result.desiredRunning,
            scaleDownCandidates: result.scaleDownCandidates,
            activateCandidates: result.activateCandidates,
          },
        });
      } catch (error) {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // ── GET /api/management/research ─────────────────────────
    if (method === "GET" && path === "/api/management/research") {
      try {
        const metrics = await deps.inspect(() => deps.getResearchCoordinator().metrics());
        jsonResponse(socket, 200, {
          research: {
            acquired: metrics.acquired,
            queued: metrics.queued,
            maxConcurrent: metrics.maxConcurrent,
          },
        });
      } catch (error) {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // ── 404 ──────────────────────────────────────────────────
    textResponse(socket, 404, "Not Found");
  });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  server.listen(config.port, config.host, () => {
    console.log(`[management] private management API listening on http://${config.host}:${config.port}`);
  });

  return { server, close };
}
