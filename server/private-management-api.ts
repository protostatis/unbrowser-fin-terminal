/**
 * Private management API listener for warm-pool capacity operations and the
 * global research-permit surface.
 *
 * Listens on a separate port (default 8789, configurable via
 * `TERMINAL_RUNTIME_MANAGEMENT_PORT`) and is reached only over private
 * connectivity: the host reconciler calls it via `docker exec` on loopback,
 * and worker permit clients reach it over internal Compose networks. Caddy
 * never proxies this port. Access is gated by a dedicated token
 * (`X-Management-Token`). The API does NOT expose Docker, secrets, or browser
 * identity material.
 *
 * Infra reconciler contract v1 (exact paths, POST only, JSON):
 *   POST /api/management/reconcile-snapshot — versioned seat map + totals + plan
 *   POST /api/management/reconcile-plan     — desired warm-pool plan only
 *   POST /api/management/drain              — { workerId, drainId, expectedGeneration }
 *   POST /api/management/activate           — { workerId }
 *
 * v1 response shapes:
 *   reconcile-snapshot → {
 *     version: 1,
 *     seats: { "<workerId>": {
 *       workerId, status: absent|starting|healthy|draining|stopped,
 *       phase, generation|null, assigned, idleSeconds,
 *       drainRequested, drainId|null, containerId: ""
 *     } },
 *     totalAssigned, totalQueued,
 *     plan: { desiredRunning, scaleDownCandidates[], activateCandidates[] }
 *   }
 *   drain → 200 { accepted: true, drainId } | 409 { accepted: false, reason }
 *   activate → 200 { accepted: true } | 409 { accepted: false, reason }
 *
 * Worker permit surface (worker→gateway private client):
 *   POST /api/management/research-permits/acquire   — { sessionId, workerGeneration }
 *   POST /api/management/research-permits/status    — { requestId }
 *   POST /api/management/research-permits/heartbeat — { requestId, sessionId? }
 *   POST /api/management/research-permits/release   — { requestId }
 *
 * Compatibility aliases (kept for existing tooling):
 *   GET  /api/management/seats                    → reconcile-snapshot
 *   POST /api/management/seats/:id/drain          → drain
 *   POST /api/management/seats/:id/activate       → activate
 *   POST /api/management/reconcile                → reconcile-plan
 *   GET  /api/management/research                 → permit metrics
 *
 * Feature-gated by `TERMINAL_RUNTIME_FEATURE_ENABLED=1` plus
 * `TERMINAL_RUNTIME_MANAGEMENT_TOKEN` (>= 32 chars). The public listener
 * never mounts these paths.
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import type { CapacityWarmPool, SeatStatus, SeatPhase } from "./capacity-warm-pool.js";
import type { ResearchPermitCoordinator } from "./research-permit-coordinator.js";

export interface ManagementApiConfig {
  host: string;
  port: number;
  token: string;
  enabled: boolean;
}

const SEAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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
  /** Number of currently queued public visitors (gateway admission queue). */
  getQueueCount: () => number;
  /** Extend the owning public session's idle lease (used by permit heartbeat). */
  touchSession?: (sessionId: string) => void;
  mutate: <T>(operation: () => T | Promise<T>) => Promise<T>;
  inspect: <T>(operation: () => T) => Promise<T>;
}

// ── Reconciler contract v1: seat status normalization ───────────────────────

export type ReconcilerSeatStatus = "absent" | "starting" | "healthy" | "draining" | "stopped";

/**
 * Map a gateway seat phase to the host reconciler's lifecycle status.
 * The reconciler only stops seats reported as `healthy` (and never stops
 * assigned ones); `recycling` means the process was terminated and a
 * replacement is pending, which the reconciler treats as stopped.
 */
const RECONCILER_STATUS: Record<SeatPhase, ReconcilerSeatStatus> = {
  absent: "absent",
  starting: "starting",
  "ready-idle": "healthy",
  assigned: "healthy",
  admitted: "healthy",
  active: "healthy",
  disconnected: "healthy",
  draining: "draining",
  recycling: "stopped",
};

/** Phases that count as an assigned seat (never a scale-down candidate). */
const ASSIGNED_PHASES = new Set<SeatPhase>(["assigned", "admitted", "active", "disconnected"]);

export function seatContractStatus(phase: SeatPhase): ReconcilerSeatStatus {
  return RECONCILER_STATUS[phase];
}

export function seatContractAssigned(phase: SeatPhase): boolean {
  return ASSIGNED_PHASES.has(phase);
}

/**
 * One seat record in the reconciler v1 snapshot. Always includes the exact
 * six named worker ids (absent seats included), normalized from the app's
 * phase model.
 */
export function seatContractRecord(seat: SeatStatus): Record<string, unknown> {
  return {
    workerId: seat.workerId,
    status: RECONCILER_STATUS[seat.phase],
    phase: seat.phase,
    generation: seat.generation ?? null,
    assigned: ASSIGNED_PHASES.has(seat.phase),
    idleSeconds: seat.idleSinceMs !== undefined ? Math.round(seat.idleSinceMs / 1000) : 0,
    drainRequested: seat.drainRequested,
    drainId: seat.drainId ?? null,
    // Docker authority stays host-side; the gateway never reports a container id.
    containerId: "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireBodyObject(
  socket: Socket,
  request: IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  return readJsonBody(request).then(
    (body) => {
      if (!isRecord(body)) {
        textResponse(socket, 400, "Bad Request: JSON object required");
        return undefined;
      }
      return body;
    },
    (err: unknown) => {
      textResponse(
        socket,
        400,
        `Bad Request: ${err instanceof Error ? err.message : "unknown"}`,
      );
      return undefined;
    },
  );
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

    // ── Shared plan computation ──────────────────────────────────────────
    const snapshotFor = (): {
      seats: Record<string, Record<string, unknown>>;
      totalAssigned: number;
      totalQueued: number;
      plan: ReturnType<CapacityWarmPool["plan"]>;
    } => {
      const seats = deps.getSeatStatuses();
      const plan = deps.getWarmPool().plan(seats);
      const seatMap: Record<string, Record<string, unknown>> = {};
      for (const seat of seats) {
        seatMap[seat.workerId] = seatContractRecord(seat);
      }
      return {
        seats: seatMap,
        totalAssigned: seats.filter((s) => ASSIGNED_PHASES.has(s.phase)).length,
        totalQueued: deps.getQueueCount(),
        plan,
      };
    };
    const planJson = (plan: ReturnType<CapacityWarmPool["plan"]>) => ({
      desiredRunning: plan.desiredRunning,
      scaleDownCandidates: plan.scaleDownCandidates,
      activateCandidates: plan.activateCandidates,
    });
    const snapshotJson = (snapshot: ReturnType<typeof snapshotFor>) => ({
      version: 1,
      seats: snapshot.seats,
      totalAssigned: snapshot.totalAssigned,
      totalQueued: snapshot.totalQueued,
      plan: planJson(snapshot.plan),
    });

    // ── POST /api/management/reconcile-snapshot ──────────────────────────
    if (method === "POST" && path === "/api/management/reconcile-snapshot") {
      try {
        const snapshot = await deps.inspect(snapshotFor);
        jsonResponse(socket, 200, snapshotJson(snapshot));
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // ── POST /api/management/reconcile-plan ──────────────────────────────
    if (method === "POST" && path === "/api/management/reconcile-plan") {
      try {
        const plan = await deps.inspect(() => snapshotFor().plan);
        jsonResponse(socket, 200, {
          version: 1,
          reconciled: true,
          plan: planJson(plan),
        });
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // ── POST /api/management/drain ───────────────────────────────────────
    if (method === "POST" && path === "/api/management/drain") {
      const body = await requireBodyObject(socket, request);
      if (!body) return;
      const workerId = body.workerId;
      const drainId = body.drainId;
      const expectedGeneration = body.expectedGeneration;
      if (typeof workerId !== "string" || !SEAT_ID_PATTERN.test(workerId)) {
        textResponse(socket, 400, "Bad Request: workerId required (URL-safe, 1-64 chars)");
        return;
      }
      if (typeof drainId !== "string" || drainId.length === 0 || drainId.length > 128) {
        textResponse(socket, 400, "Bad Request: drainId required (string, 1-128 chars)");
        return;
      }
      if (
        expectedGeneration !== undefined
        && expectedGeneration !== null
        && (typeof expectedGeneration !== "string" || expectedGeneration.length === 0 || expectedGeneration.length > 160)
      ) {
        textResponse(socket, 400, "Bad Request: expectedGeneration must be a string (1-160 chars)");
        return;
      }
      try {
        const result = await deps.mutate(() => {
          const seat = deps.getSeatStatuses().find((s) => s.workerId === workerId);
          if (!seat) return { accepted: false as const, reason: "unknown seat" };
          // Generation CAS: the reconciler may only drain the exact process
          // generation it observed. A replaced worker invalidates the drain.
          if (expectedGeneration && seat.generation !== expectedGeneration) {
            return { accepted: false as const, reason: "generation mismatch" };
          }
          return deps.getWarmPool().requestDrain(seat, drainId);
        });
        if (result.accepted) {
          jsonResponse(socket, 200, { accepted: true, drainId: (result as { drainId: string }).drainId });
        } else {
          jsonResponse(socket, 409, { accepted: false, reason: (result as { reason: string }).reason });
        }
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // ── POST /api/management/activate ────────────────────────────────────
    if (method === "POST" && path === "/api/management/activate") {
      const body = await requireBodyObject(socket, request);
      if (!body) return;
      const workerId = body.workerId;
      if (typeof workerId !== "string" || !SEAT_ID_PATTERN.test(workerId)) {
        textResponse(socket, 400, "Bad Request: workerId required (URL-safe, 1-64 chars)");
        return;
      }
      try {
        const result = await deps.mutate(() => {
          const seat = deps.getSeatStatuses().find((s) => s.workerId === workerId);
          if (!seat) return { accepted: false as const, reason: "unknown seat" };
          const drain = deps.getWarmPool().getDrain(workerId);
          if (!drain) {
            // Nothing to release — an explicit activate is a safe no-op.
            return { accepted: true as const };
          }
          // Drain is sticky: only an explicit activation with a changed
          // process generation (the reconciler restarted the container)
          // releases it. A same-generation activate is rejected.
          if (seat.generation && seat.generation === drain.generation) {
            return { accepted: false as const, reason: "drain sticky; generation unchanged" };
          }
          const released = deps.getWarmPool().releaseDrain(workerId, seat.generation);
          if (!released.released) {
            deps.getWarmPool().forceReleaseDrain(workerId);
          }
          return { accepted: true as const };
        });
        if (result.accepted) {
          jsonResponse(socket, 200, { accepted: true });
        } else {
          jsonResponse(socket, 409, { accepted: false, reason: (result as { reason: string }).reason });
        }
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // ── Research-permit surface ──────────────────────────────────────────

    // POST /api/management/research-permits/acquire
    if (method === "POST" && path === "/api/management/research-permits/acquire") {
      const body = await requireBodyObject(socket, request);
      if (!body) return;
      const sessionId = body.sessionId;
      const workerGeneration = body.workerGeneration;
      const requestId = body.requestId;
      if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) {
        textResponse(socket, 400, "Bad Request: sessionId required (1-128 chars)");
        return;
      }
      if (typeof workerGeneration !== "string" || workerGeneration.length === 0 || workerGeneration.length > 160) {
        textResponse(socket, 400, "Bad Request: workerGeneration required (1-160 chars)");
        return;
      }
      if (requestId !== undefined && (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128)) {
        textResponse(socket, 400, "Bad Request: requestId must be a string (1-128 chars)");
        return;
      }
      try {
        const result = await deps.mutate(() =>
          deps.getResearchCoordinator().acquire(
            sessionId,
            workerGeneration,
            typeof requestId === "string" ? requestId : undefined,
          ),
        );
        jsonResponse(socket, 200, {
          accepted: result.accepted,
          status: result.status,
          ...(result.permit ? { requestId: result.permit.requestId } : {}),
          ...(result.queuePosition !== undefined ? { queuePosition: result.queuePosition } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        });
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // POST /api/management/research-permits/status
    if (method === "POST" && path === "/api/management/research-permits/status") {
      const body = await requireBodyObject(socket, request);
      if (!body) return;
      const requestId = body.requestId;
      if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
        textResponse(socket, 400, "Bad Request: requestId required (1-128 chars)");
        return;
      }
      try {
        const permit = await deps.inspect(() => deps.getResearchCoordinator().status(requestId));
        jsonResponse(socket, 200, {
          requestId,
          status: permit?.status ?? "not-found",
        });
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // POST /api/management/research-permits/heartbeat
    if (method === "POST" && path === "/api/management/research-permits/heartbeat") {
      const body = await requireBodyObject(socket, request);
      if (!body) return;
      const requestId = body.requestId;
      const sessionId = body.sessionId;
      if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
        textResponse(socket, 400, "Bad Request: requestId required (1-128 chars)");
        return;
      }
      try {
        const result = await deps.mutate(() => {
          const hb = deps.getResearchCoordinator().heartbeat(requestId);
          // A queued research wait must keep an otherwise active session from
          // idle-expiring; the 15-minute absolute limit remains unchanged.
          if (hb.alive && typeof sessionId === "string" && sessionId.length > 0) {
            deps.touchSession?.(sessionId);
          }
          return hb;
        });
        jsonResponse(socket, 200, { alive: result.alive, ...(result.reason ? { reason: result.reason } : {}) });
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // POST /api/management/research-permits/release
    if (method === "POST" && path === "/api/management/research-permits/release") {
      const body = await requireBodyObject(socket, request);
      if (!body) return;
      const requestId = body.requestId;
      if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
        textResponse(socket, 400, "Bad Request: requestId required (1-128 chars)");
        return;
      }
      try {
        const result = await deps.mutate(() => deps.getResearchCoordinator().release(requestId));
        jsonResponse(socket, 200, { released: result.released, ...(result.reason ? { reason: result.reason } : {}) });
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // ── Compatibility aliases ────────────────────────────────────────────

    // GET /api/management/seats (alias for reconcile-snapshot)
    if (method === "GET" && path === "/api/management/seats") {
      try {
        const snapshot = await deps.inspect(snapshotFor);
        jsonResponse(socket, 200, snapshotJson(snapshot));
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // POST /api/management/seats/:id/drain (alias for drain)
    const drainMatch = path.match(/^\/api\/management\/seats\/([A-Za-z0-9_-]+)\/drain$/);
    if (method === "POST" && drainMatch) {
      const workerId = drainMatch[1];
      if (!SEAT_ID_PATTERN.test(workerId)) {
        textResponse(socket, 400, "Bad Request: invalid seat id");
        return;
      }
      const body = await requireBodyObject(socket, request);
      if (!body) return;
      const drainId = body.drainId;
      const expectedGeneration = body.expectedGeneration;
      if (typeof drainId !== "string" || drainId.length === 0 || drainId.length > 128) {
        textResponse(socket, 400, "Bad Request: drainId required (string, 1-128 chars)");
        return;
      }
      if (
        expectedGeneration !== undefined
        && expectedGeneration !== null
        && (typeof expectedGeneration !== "string" || expectedGeneration.length === 0 || expectedGeneration.length > 160)
      ) {
        textResponse(socket, 400, "Bad Request: expectedGeneration must be a string (1-160 chars)");
        return;
      }
      try {
        const result = await deps.mutate(() => {
          const seat = deps.getSeatStatuses().find((s) => s.workerId === workerId);
          if (!seat) return { accepted: false as const, reason: "unknown seat" };
          if (expectedGeneration && seat.generation !== expectedGeneration) {
            return { accepted: false as const, reason: "generation mismatch" };
          }
          return deps.getWarmPool().requestDrain(seat, drainId);
        });
        if (result.accepted) {
          jsonResponse(socket, 200, { accepted: true, drainId: (result as { drainId: string }).drainId });
        } else {
          jsonResponse(socket, 409, { accepted: false, reason: (result as { reason: string }).reason });
        }
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // POST /api/management/seats/:id/activate (alias for activate)
    const activateMatch = path.match(/^\/api\/management\/seats\/([A-Za-z0-9_-]+)\/activate$/);
    if (method === "POST" && activateMatch) {
      const workerId = activateMatch[1];
      if (!SEAT_ID_PATTERN.test(workerId)) {
        textResponse(socket, 400, "Bad Request: invalid seat id");
        return;
      }
      try {
        const result = await deps.mutate(() => {
          const seat = deps.getSeatStatuses().find((s) => s.workerId === workerId);
          if (!seat) return { accepted: false as const, reason: "unknown seat" };
          const drain = deps.getWarmPool().getDrain(workerId);
          if (!drain) return { accepted: true as const };
          if (seat.generation && seat.generation === drain.generation) {
            return { accepted: false as const, reason: "drain sticky; generation unchanged" };
          }
          const released = deps.getWarmPool().releaseDrain(workerId, seat.generation);
          if (!released.released) deps.getWarmPool().forceReleaseDrain(workerId);
          return { accepted: true as const };
        });
        if (result.accepted) {
          jsonResponse(socket, 200, { accepted: true });
        } else {
          jsonResponse(socket, 409, { accepted: false, reason: (result as { reason: string }).reason });
        }
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // POST /api/management/reconcile (alias for reconcile-plan)
    if (method === "POST" && path === "/api/management/reconcile") {
      try {
        const plan = await deps.inspect(() => snapshotFor().plan);
        jsonResponse(socket, 200, {
          version: 1,
          reconciled: true,
          plan: planJson(plan),
        });
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // GET /api/management/research (alias for permit metrics)
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
      } catch {
        jsonResponse(socket, 500, { error: "internal error" });
      }
      return;
    }

    // ── 404 ──────────────────────────────────────────────────────────────
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
