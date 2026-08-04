/**
 * Public live-session admission gateway.
 *
 * It is the only internet-facing process for anonymous terminal visitors. It
 * verifies Turnstile, owns FIFO admission and budgets, and proxies a session's
 * WebSocket to one isolated internal worker. Admission uses signed opaque
 * browser-held tokens, while workers never receive browser identity material.
 */

import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import express, { type Request } from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { readPublicLiveGatewayConfig, type PublicLiveGatewayConfig } from "./public-live-config.js";
import {
  PublicSessionCoordinator,
  type PublicSessionSnapshot,
  type PublicWorkerAssignment,
} from "./public-session-coordinator.js";
import { PublicSessionPersistence } from "./public-session-persistence.js";
import { createOpaqueId, signOpaqueId, verifyOpaqueId } from "./public-session-tokens.js";
import { matchesProxyToken } from "./proxy-auth.js";
import { isActiveResearchFramePayload } from "./research-activity.js";
import { createWorkspaceHandoffController } from "./workspace-checkpoint-control.js";
import {
  isWorkspaceCheckpointEnabled,
  workspaceServiceUrl,
} from "../shared/financial-workspace-checkpoint.js";
import { CapacityWarmPool } from "./capacity-warm-pool.js";
import {
  ResearchPermitCoordinator,
  RESEARCH_PERMIT_ACQUIRE_TTL_MS,
  type ResearchPermit,
  type ResearchPermitState,
} from "./research-permit-coordinator.js";
import {
  startManagementApi,
  resolveManagementApiConfig,
  type ManagementApi,
} from "./private-management-api.js";
import { isRuntimeFeatureEnabled } from "./runtime-mode.js";

const VISITOR_TOKEN_HEADER = "x-public-visitor-token";
const TICKET_TOKEN_HEADER = "x-public-ticket-token";
const EDGE_PROXY_TOKEN_HEADER = "x-fin-terminal-edge-token";
const SESSION_PROTOCOL_PREFIX = "fin-terminal-session.";
const WORKER_GENERATION_HEADER = "x-fin-terminal-worker-generation";
const MAX_CLIENT_MESSAGE_BYTES = 8 * 1024;
const MAX_WORKER_MESSAGE_BYTES = 512 * 1024;
const MAX_WEBSOCKET_BUFFERED_BYTES = 512 * 1024;
const CLIENT_MESSAGE_RATE_PER_SECOND = 30;
const CLIENT_MESSAGE_BURST = 60;
const CLIENT_ATTACH_RATE_PER_SECOND = 1;
const CLIENT_ATTACH_BURST = 4;
const CLIENT_UPGRADE_ATTEMPTS_PER_MINUTE = 120;
const ACTIVITY_PERSIST_INTERVAL_MS = 2_000;
const TURNSTILE_ACTION = "public_terminal_admission";
const SESSION_ENDED_CLOSE_CODE = 4408;
const WORKER_UNAVAILABLE_CLOSE_CODE = 4410;
const WORKER_HEALTH_INTERVAL_MS = 2_000;
const WORKER_HEALTH_TIMEOUT_MS = 1_500;
const WARM_POOL_SCALE_DOWN_MS = 5 * 60_000; // 5 minutes idle before scale-down
const WARM_POOL_WARM_SPARES = 1; // keep one ready-idle spare
const RESEARCH_PERMIT_MAX_CONCURRENT = 2;
const RESEARCH_PERMIT_MAX_QUEUE = 24;
const RESEARCH_PERMIT_QUEUE_TTL_MS = 30 * 60_000; // 30 minutes in queue
const RESEARCH_PERMIT_HEARTBEAT_MS = 30_000; // 30 seconds

type TurnstileVerification = { success?: unknown; hostname?: unknown; action?: unknown };

export function isAcceptedTurnstileVerification(
  result: TurnstileVerification,
  expectedHostname: string,
): boolean {
  return result.success === true
    && result.action === TURNSTILE_ACTION
    && result.hostname === expectedHostname;
}

export interface PublicLiveGateway {
  server: HttpServer;
  close(): Promise<void>;
}

interface GatewayBridge {
  sessionId: string;
  browser: WebSocket;
  upstream?: WebSocket;
  closed: boolean;
  activityTimer?: ReturnType<typeof setTimeout>;
  activityInFlight: boolean;
  lastActivityPersistedAt: number;
  lastActivityObservedAt: number;
  messageLimiter: TokenBucketRateLimiter;
}

interface SessionTrafficState {
  messageLimiter: TokenBucketRateLimiter;
  attachLimiter: TokenBucketRateLimiter;
  upgradeInFlight: boolean;
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();
  private nextPruneAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {}

  take(key: string): boolean {
    const now = this.now();
    if (now >= this.nextPruneAt || this.entries.size >= this.maxEntries) {
      for (const [entryKey, entry] of this.entries) {
        if (now >= entry.expiresAt) this.entries.delete(entryKey);
      }
      this.nextPruneAt = now + Math.min(this.windowMs, 60_000);
    }
    const current = this.entries.get(key);
    if (!current || now >= current.expiresAt) {
      if (!current && this.entries.size >= this.maxEntries) return false;
      this.entries.set(key, { count: 1, expiresAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }
}

/** Per-connection token bucket that bounds accepted browser work in memory. */
export class TokenBucketRateLimiter {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.updatedAt = now();
  }

  take(): boolean {
    const now = this.now();
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1_000;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

export function resolvePublicClientIp(
  remoteAddress: string | undefined,
  forwarded: string | string[] | undefined,
  expectedEdgeToken: string,
  suppliedEdgeToken: string | undefined,
): string {
  const trustedEdge = Boolean(expectedEdgeToken) && matchesProxyToken(
    expectedEdgeToken,
    suppliedEdgeToken,
  );
  if (trustedEdge && typeof forwarded === "string" && isIP(forwarded.trim()) !== 0) {
    return forwarded.trim();
  }
  return remoteAddress ?? "unknown";
}

function publicClientIp(request: IncomingMessage, config: PublicLiveGatewayConfig): string {
  return resolvePublicClientIp(
    request.socket.remoteAddress,
    request.headers["x-real-ip"],
    config.edgeProxyToken,
    singleHeader(request, EDGE_PROXY_TOKEN_HEADER),
  );
}

function isAllowedOrigin(request: IncomingMessage, config: PublicLiveGatewayConfig): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin === config.publicOrigin;
}

function websocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

function workerReadyUrl(httpUrl: string): string {
  return new URL("/api/ready", httpUrl).toString();
}

function rawMessageText(data: RawData): string | undefined {
  const text = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data).toString("utf8");
  return Buffer.byteLength(text, "utf8") <= MAX_CLIENT_MESSAGE_BYTES ? text : undefined;
}

function trustedWorkerMessageText(data: RawData): string | undefined {
  const text = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data).toString("utf8");
  return Buffer.byteLength(text, "utf8") <= MAX_WORKER_MESSAGE_BYTES ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0);
}

const MARKET_SCREENS = new Set(["MARKET", "SIGNALS", "EVENTS", "MOVERS", "WATCH"]);
const CHART_SCOPES = new Set(["day", "week", "month", "year", "max"]);
const TERMINAL_PANES = new Set(["headlines", "story", "lanes", "briefing"]);

function isActionContext(value: unknown): boolean {
  if (!isRecord(value) || !isBoundedString(value.screen, 32)) return false;
  if (value.mode === "ticker") {
    return isBoundedString(value.symbol, 32);
  }
  if (value.mode !== "market") return false;
  return Number.isInteger(value.selectedIndex)
    && (value.selectedIndex as number) >= 0
    && (value.selectedIndex as number) <= 1_000
    && (value.selected === null || isBoundedString(value.selected, 256))
    && (value.pane === null || (typeof value.pane === "string" && TERMINAL_PANES.has(value.pane)));
}

function isAllowedPublicWebAction(value: unknown): boolean {
  if (!isRecord(value) || typeof value.action !== "string") return false;
  switch (value.action) {
    case "navigate-screen":
      return typeof value.screen === "string" && MARKET_SCREENS.has(value.screen);
    case "set-chart-scope":
      return typeof value.scope === "string" && CHART_SCOPES.has(value.scope);
    case "select":
      return isBoundedString(value.screen, 32)
        && Number.isInteger(value.index) && (value.index as number) >= 0 && (value.index as number) <= 1_000
        && isBoundedString(value.item, 256);
    case "focus-pane":
      return typeof value.pane === "string" && TERMINAL_PANES.has(value.pane);
    case "scroll":
      return (value.direction === "up" || value.direction === "down")
        && (value.amount === undefined
          || (Number.isInteger(value.amount) && (value.amount as number) >= 1 && (value.amount as number) <= 8))
        && (value.pane === undefined || (typeof value.pane === "string" && TERMINAL_PANES.has(value.pane)))
        && (value.screen === undefined || isBoundedString(value.screen, 32));
    case "primary":
    case "why":
      return isActionContext(value.context);
    default:
      return false;
  }
}

/** Validate browser messages at the public boundary before reaching a worker. */
export function isAllowedPublicClientMessage(text: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return false;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const data = message as Record<string, unknown>;
  switch (data.type) {
    case "input":
      return typeof data.data === "string" && data.data.length > 0 && data.data.length <= 64;
    case "resize":
      return Number.isInteger(data.cols) && Number.isInteger(data.rows)
        && (data.cols as number) >= 20 && (data.cols as number) <= 320
        && (data.rows as number) >= 10 && (data.rows as number) <= 200;
    case "command":
      return data.name === "market" && typeof data.args === "string"
        && /^[A-Za-z0-9.^=_-]{0,32}$/.test(data.args);
    case "select_response":
      return typeof data.id === "string" && data.id.length > 0 && data.id.length <= 160
        && (data.value === undefined || isBoundedString(data.value, 512, true))
        && (data.cancelled === undefined || typeof data.cancelled === "boolean");
    case "web_action":
      return isAllowedPublicWebAction(data.data);
    default:
      return false;
  }
}

/** Validate the internal worker protocol before relaying it to a browser. */
export function isAllowedPublicWorkerMessage(text: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(message) || typeof message.type !== "string") return false;
  switch (message.type) {
    case "frame":
      return Array.isArray(message.rows)
        && message.rows.length <= 240
        && message.rows.every((row) => isBoundedString(row, 16_384, true))
        && Number.isInteger(message.width) && (message.width as number) >= 20 && (message.width as number) <= 320
        && Number.isInteger(message.rows_count) && message.rows_count === message.rows.length
        && (message.state === undefined || isRecord(message.state));
    case "notify":
      return (message.level === "info" || message.level === "warning" || message.level === "error")
        && isBoundedString(message.message, 2_048);
    case "select_request":
      return isBoundedString(message.id, 160)
        && isBoundedString(message.title, 512)
        && Array.isArray(message.options)
        && message.options.length <= 256
        && message.options.every((option) => isBoundedString(option, 512));
    case "closed":
      return true;
    default:
      return false;
  }
}

function isMeaningfulActivity(text: string): boolean {
  const message = JSON.parse(text) as { type?: unknown };
  return message.type === "input" || message.type === "command"
    || message.type === "select_response" || message.type === "web_action";
}

async function verifyTurnstile(
  token: string,
  remoteIp: string,
  config: PublicLiveGatewayConfig,
): Promise<boolean> {
  if (token.length < 20 || token.length > 4_096) return false;
  const body = new URLSearchParams({
    secret: config.turnstileSecret,
    response: token,
    remoteip: remoteIp,
  });
  let response: globalThis.Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  let result: TurnstileVerification;
  try {
    result = await response.json() as TurnstileVerification;
  } catch {
    return false;
  }
  return isAcceptedTurnstileVerification(result, config.turnstileExpectedHostname);
}

function workerGeneration(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { instanceId?: unknown }).instanceId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{16,160}$/.test(id) ? id : undefined;
}

async function healthCheck(workerUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(workerReadyUrl(workerUrl), {
      signal: AbortSignal.timeout(WORKER_HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return workerGeneration(await response.json());
  } catch {
    return undefined;
  }
}

function readJsonToken(request: Request): string | undefined {
  const token = request.body && typeof request.body === "object"
    ? (request.body as { turnstileToken?: unknown }).turnstileToken
    : undefined;
  return typeof token === "string" ? token.trim() : undefined;
}

/** Start the gateway after configuration and Redis admission lease validation. */
export async function startPublicLiveGateway(): Promise<PublicLiveGateway> {
  const config = readPublicLiveGatewayConfig();
  const instanceId = createOpaqueId();
  const persistence = new PublicSessionPersistence(config.redisUrl, instanceId);
  let cleanup: (() => Promise<void>) | undefined;
  try {
    await persistence.connect();

    const bridges = new Map<string, GatewayBridge>();
    const trafficBySession = new Map<string, SessionTrafficState>();
    const coordinator = new PublicSessionCoordinator({
      workerIds: config.workerEndpoints.map(({ id }) => id),
      maxQueue: config.maxQueue,
      ticketTtlMs: config.ticketTtlMs,
      reconnectGraceMs: config.reconnectGraceMs,
      idleTimeoutMs: config.idleTimeoutMs,
      absoluteTimeoutMs: config.absoluteTimeoutMs,
      maxResearchRuns: config.maxResearchRuns,
      dailyBudgetMicroUsd: config.dailyBudgetMicroUsd,
      researchRunReservationMicroUsd: config.researchRunReservationMicroUsd,
      onSessionEnded: (session, reason) => {
        trafficBySession.delete(session.id);
        const bridge = bridges.get(session.id);
        closeBridge(bridge, SESSION_ENDED_CLOSE_CODE, reason);
      },
    });
    const restored = await persistence.load();
    if (restored) coordinator.restore(restored);

    // ── Warm-pool capacity planner ──────────────────────────────────────
    const warmPool = new CapacityWarmPool({
      totalSeats: config.workerEndpoints.length,
      idleScaleDownMs: WARM_POOL_SCALE_DOWN_MS,
      warmSpares: WARM_POOL_WARM_SPARES,
    });
    const capacityRestored = await persistence.loadCapacityState();
    if (capacityRestored) warmPool.restore(capacityRestored);

    // A drain accepted by a previous gateway process must stay enforced after
    // a restart even if only one half of the persisted state survived (or the
    // state predates the coordinator ineligibility fence). Every warm-pool
    // drain re-fences its seat in the coordinator before the first health
    // probe could re-enable it. The gateway persists capacity before the
    // coordinator state so a partial write always leaves the warm-pool drain
    // present for this reconciliation to rediscover.
    for (const seat of coordinator.getSeatStatuses()) {
      if (warmPool.isDraining(seat.workerId)) {
        coordinator.setWorkerDrainIneligible(seat.workerId, true);
      }
    }

    // ── Research permit coordinator ─────────────────────────────────────
    const researchPermits = new ResearchPermitCoordinator({
      maxConcurrent: RESEARCH_PERMIT_MAX_CONCURRENT,
      maxQueue: RESEARCH_PERMIT_MAX_QUEUE,
      defaultQueueTtlMs: RESEARCH_PERMIT_QUEUE_TTL_MS,
      heartbeatIntervalMs: RESEARCH_PERMIT_HEARTBEAT_MS,
      acquireTtlMs: RESEARCH_PERMIT_ACQUIRE_TTL_MS,
    });
    const permitRestored = await persistence.loadResearchPermitState();
    if (permitRestored) researchPermits.restore(permitRestored);

    // Companion Redis keys (warm-pool drains, research permits) are only
    // written when the runtime feature is actually enabled. When it is off,
    // the coordinator still runs them in memory but there is no operator or
    // worker surface that could produce durable state, so the extra writes
    // (and their lease renewals) are skipped.
    const runtimeFeaturesEnabled = isRuntimeFeatureEnabled(process.env);

    let mutations = Promise.resolve();
    let fatal: ((error: unknown) => void) | undefined;
    const mutate = <T>(operation: () => T | Promise<T>): Promise<T> => {
      const result = mutations.then(async () => {
        const value = await operation();
        if (runtimeFeaturesEnabled) {
          // Persist capacity FIRST: if the coordinator write fails after this
          // point the gateway exits and the restarted gateway re-fences every
          // warm-pool drain against the coordinator, so a drain can never be
          // lost between the two Redis keys.
          await persistence.saveCapacityState(warmPool.exportState());
        }
        await persistence.save(coordinator.exportState());
        if (runtimeFeaturesEnabled) {
          await persistence.saveResearchPermitState(researchPermits.exportState());
        }
        return value;
      });
      mutations = result.then(() => undefined, (error) => {
        fatal?.(error);
      });
      return result;
    };
    const inspect = <T>(operation: () => T): Promise<T> => mutations.then(operation);

    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "8kb", type: "application/json" }));
    app.use("/api/public", (_request, response, next) => {
      response.set({
        "Cache-Control": "no-store, private",
        Pragma: "no-cache",
      });
      next();
    });
    const admissionLimiter = new FixedWindowRateLimiter(
      config.admissionAttemptsPerWindow,
      config.admissionWindowMs,
    );
    // Caddy strips and overwrites X-Real-IP. This second, coarser peer limit
    // keeps a directly exposed or misconfigured proxy from bypassing the
    // visitor-IP limiter by rotating that header.
    const peerAdmissionLimiter = new FixedWindowRateLimiter(
      config.admissionAttemptsPerWindow * Math.max(config.maxQueue, 10),
      config.admissionWindowMs,
    );
    const websocketUpgradeLimiter = new FixedWindowRateLimiter(
      CLIENT_UPGRADE_ATTEMPTS_PER_MINUTE,
      60_000,
    );
    const websocketPeerUpgradeLimiter = new FixedWindowRateLimiter(
      CLIENT_UPGRADE_ATTEMPTS_PER_MINUTE * Math.max(config.maxQueue, 10),
      60_000,
    );

    const identityFor = (request: IncomingMessage, create = false): string | undefined => {
      const known = verifyOpaqueId(singleHeader(request, VISITOR_TOKEN_HEADER), config.signingKey);
      if (known) return known;
      return create ? createOpaqueId() : undefined;
    };

    const ticketFor = (request: IncomingMessage): { visitorId: string; ticketId: string } | undefined => {
      const visitorId = verifyOpaqueId(singleHeader(request, VISITOR_TOKEN_HEADER), config.signingKey);
      const ticketId = verifyOpaqueId(singleHeader(request, TICKET_TOKEN_HEADER), config.signingKey);
      return visitorId && ticketId ? { visitorId, ticketId } : undefined;
    };

    const websocketTicketFor = (request: IncomingMessage): string | undefined => {
      const offered = singleHeader(request, "sec-websocket-protocol");
      if (!offered) return undefined;
      const protocol = offered.split(",").map((entry) => entry.trim())
        .find((entry) => entry.startsWith(SESSION_PROTOCOL_PREFIX));
      return verifyOpaqueId(protocol?.slice(SESSION_PROTOCOL_PREFIX.length), config.signingKey);
    };

    app.get("/api/health", (_request, response) => {
      response.json({ status: "ok" });
    });
    app.get("/api/ready", async (_request, response) => {
      try {
        const metrics = await inspect(() => {
          const coordinatorMetrics = coordinator.metrics();
          const seatStatuses = coordinator.getSeatStatuses();
          const drainMap = new Map<string, boolean>();
          for (const seat of seatStatuses) {
            drainMap.set(seat.workerId, warmPool.isDraining(seat.workerId));
          }
          const seatsWithDrain = seatStatuses.map((s) => ({
            ...s,
            drainRequested: drainMap.get(s.workerId) ?? false,
          }));
          const plan = warmPool.plan(seatsWithDrain);
          const permitMetrics = researchPermits.metrics();
          return {
            ...coordinatorMetrics,
            desiredRunning: plan.desiredRunning,
            totalSeats: config.workerEndpoints.length,
            scaleDownCandidates: plan.scaleDownCandidates,
            researchPermitsAcquired: permitMetrics.acquired,
            researchPermitsQueued: permitMetrics.queued,
          };
        });
        response.json({ status: "ready", publicLive: true, ...metrics });
      } catch {
        response.status(503).json({ status: "unavailable" });
      }
    });
    app.get("/api/public/config", (request, response) => {
      const visitorId = identityFor(request, true);
      const checkpointEnabled = isWorkspaceCheckpointEnabled()
        && Boolean(workspaceServiceUrl());
      response.json({
        visitorToken: signOpaqueId(visitorId!, config.signingKey),
        turnstileSiteKey: config.turnstileSiteKey,
        turnstileRequired: config.turnstileRequired,
        ticketTtlMs: config.ticketTtlMs,
        maxSessionMs: config.absoluteTimeoutMs,
        maxResearchRuns: config.maxResearchRuns,
        workspaceHandoffAvailable: checkpointEnabled,
      });
    });
    app.post("/api/public/admission", async (request, response) => {
      if (!isAllowedOrigin(request, config)) {
        response.status(403).json({ error: "origin_not_allowed" });
        return;
      }
      const visitorId = identityFor(request);
      const remoteIp = publicClientIp(request, config);
      const peerIp = request.socket.remoteAddress ?? "unknown";
      const turnstileToken = readJsonToken(request);
      if (!visitorId) {
        response.status(401).json({ error: "visitor_required" });
        return;
      }
      if (!turnstileToken && config.turnstileRequired) {
        response.status(400).json({ error: "turnstile_required" });
        return;
      }
      if (!peerAdmissionLimiter.take(peerIp) || !admissionLimiter.take(remoteIp)) {
        response.status(429).json({ error: "admission_limited" });
        return;
      }
      if (config.turnstileRequired && !(await verifyTurnstile(turnstileToken!, remoteIp, config))) {
        response.status(403).json({ error: "turnstile_invalid" });
        return;
      }
      try {
        const result = await mutate(() => coordinator.admit(visitorId));
        if (!result.accepted) {
          response.status(503).json({ error: result.reason });
          return;
        }
        response.json({
          ...publicStatus(result.session),
          ticketToken: signOpaqueId(result.session.id, config.signingKey),
        });
      } catch {
        response.status(503).json({ error: "admission_unavailable" });
      }
    });
    app.get("/api/public/admission/status", async (request, response) => {
      const ticket = ticketFor(request);
      if (!ticket) {
        response.status(401).json({ error: "ticket_required" });
        return;
      }
      try {
        const session = await inspect(() => coordinator.status(ticket.ticketId));
        if (!session || session.visitorId !== ticket.visitorId) {
          response.status(404).json({ error: "ticket_unknown" });
          return;
        }
        response.json(publicStatus(session));
      } catch {
        response.status(503).json({ error: "admission_unavailable" });
      }
    });

    // ── Workspace handoff (browser opt-in → worker export → control) ─────
    // The browser only initiates opt-in; checkpoint content is always built
    // from the assigned worker's authoritative state, never from the browser.
    const workspaceHandoff = createWorkspaceHandoffController({
      ticketFromRequest: (request) => {
        const visitorId = verifyOpaqueId(singleHeader(request as IncomingMessage, VISITOR_TOKEN_HEADER), config.signingKey);
        const ticketId = verifyOpaqueId(singleHeader(request as IncomingMessage, TICKET_TOKEN_HEADER), config.signingKey);
        return visitorId && ticketId ? { visitorId, ticketId } : undefined;
      },
      activeAssignmentFor: (ticketId, visitorId) => {
        const session = coordinator.status(ticketId);
        if (!session || session.visitorId !== visitorId || session.state !== "active") return undefined;
        const assigned = coordinator.getAssignedWorker(ticketId);
        if (!assigned) return undefined;
        const endpoint = workerById.get(assigned.workerId);
        if (!endpoint) return undefined;
        return {
          workerId: assigned.workerId,
          workerUrl: endpoint.url,
          workerGeneration: assigned.workerGeneration,
        };
      },
    });
    app.post("/api/public/workspace-handoff", workspaceHandoff);

    const __filename = fileURLToPath(import.meta.url);
    const cwd = path.resolve(process.env.MARKET_ROOT?.trim() || path.resolve(path.dirname(__filename), ".."));
    const webDist = path.join(cwd, "dist-web");
    if (existsSync(webDist)) {
      app.use(express.static(webDist));
      app.get(/^(?!\/api|\/ws).*/, (_request, response) => response.sendFile(path.join(webDist, "index.html")));
    } else {
      app.get("/", (_request, response) => response.type("html").send("<h2>Frontend not built yet</h2>"));
    }

    const server = createServer(app);
    const browserWss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
    const workerById = new Map(config.workerEndpoints.map((worker) => [worker.id, worker]));

    const trafficFor = (sessionId: string): SessionTrafficState => {
      const existing = trafficBySession.get(sessionId);
      if (existing) return existing;
      const created: SessionTrafficState = {
        messageLimiter: new TokenBucketRateLimiter(
          CLIENT_MESSAGE_RATE_PER_SECOND,
          CLIENT_MESSAGE_BURST,
        ),
        attachLimiter: new TokenBucketRateLimiter(
          CLIENT_ATTACH_RATE_PER_SECOND,
          CLIENT_ATTACH_BURST,
        ),
        upgradeInFlight: false,
      };
      trafficBySession.set(sessionId, created);
      return created;
    };
    const rejectUpgrade = (socket: Duplex, status: string) => {
      if (socket.destroyed) return;
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };

    server.on("upgrade", (request, socket, head) => {
      let parsed: URL;
      try {
        // Origin-form request targets do not need the untrusted Host header as
        // a parsing base. A fixed base also makes malformed Host values inert.
        parsed = new URL(request.url ?? "/", "http://localhost");
      } catch {
        rejectUpgrade(socket, "400 Bad Request");
        return;
      }
      if (parsed.pathname !== "/ws" || !isAllowedOrigin(request, config)) {
        rejectUpgrade(socket, "403 Forbidden");
        return;
      }
      if (
        !websocketPeerUpgradeLimiter.take(request.socket.remoteAddress ?? "unknown")
        || !websocketUpgradeLimiter.take(publicClientIp(request, config))
      ) {
        rejectUpgrade(socket, "429 Too Many Requests");
        return;
      }
      const ticketId = websocketTicketFor(request);
      if (!ticketId) {
        rejectUpgrade(socket, "401 Unauthorized");
        return;
      }
      const traffic = trafficFor(ticketId);
      if (traffic.upgradeInFlight || !traffic.attachLimiter.take()) {
        rejectUpgrade(socket, "429 Too Many Requests");
        return;
      }
      traffic.upgradeInFlight = true;
      let socketClosed = socket.destroyed;
      let reservationVersion: number | undefined;
      const releaseUpgrade = () => {
        traffic.upgradeInFlight = false;
      };
      const cancelReservedUpgrade = () => {
        if (reservationVersion === undefined) return;
        const version = reservationVersion;
        reservationVersion = undefined;
        releaseUpgrade();
        void mutate(() => coordinator.cancelAttachment(ticketId, version))
          .catch((error) => fatal?.(error));
      };
      const onSocketClose = () => {
        socketClosed = true;
        cancelReservedUpgrade();
      };
      socket.once("close", onSocketClose);
      socket.once("error", onSocketClose);

      void mutate(() => coordinator.reserveAttachment(ticketId)).then((reservation) => {
        if (!reservation) {
          socket.off("close", onSocketClose);
          socket.off("error", onSocketClose);
          releaseUpgrade();
          if (!bridges.has(ticketId) && trafficBySession.get(ticketId) === traffic) {
            trafficBySession.delete(ticketId);
          }
          rejectUpgrade(socket, "409 Conflict");
          return;
        }
        reservationVersion = reservation.connectionVersion;
        if (socketClosed || socket.destroyed) {
          socket.off("close", onSocketClose);
          socket.off("error", onSocketClose);
          cancelReservedUpgrade();
          return;
        }
        try {
          browserWss.handleUpgrade(request, socket, head, (browser) => {
            socket.off("close", onSocketClose);
            socket.off("error", onSocketClose);
            reservationVersion = undefined;
            browser.pause();
            let browserClosed = browser.readyState !== WebSocket.OPEN;
            const markBrowserClosed = () => {
              browserClosed = true;
            };
            browser.once("close", markBrowserClosed);
            browser.once("error", markBrowserClosed);
            const previousBridge = bridges.get(ticketId);
            void mutate(() => {
              if (browserClosed || browser.readyState !== WebSocket.OPEN) {
                coordinator.cancelAttachment(ticketId, reservation.connectionVersion);
                return undefined;
              }
              const assignment = coordinator.activateAttachment(
                ticketId,
                reservation.connectionVersion,
              );
              return assignment && coordinator.markWorkerConnectionStarted(
                ticketId,
                assignment.connectionVersion,
              )
                ? assignment
                : undefined;
            }).then((assignment) => {
              releaseUpgrade();
              browser.off("close", markBrowserClosed);
              browser.off("error", markBrowserClosed);
              if (!assignment) {
                browser.resume();
                if (browser.readyState === WebSocket.OPEN) {
                  browser.close(SESSION_ENDED_CLOSE_CODE, "Public session unavailable");
                }
                return;
              }
              if (browserClosed || browser.readyState !== WebSocket.OPEN) {
                if (
                  previousBridge
                  && bridges.get(ticketId) === previousBridge
                  && reservation.previousConnectionVersion
                ) {
                  void mutate(() => coordinator.rollbackAttachment(
                    ticketId,
                    assignment.connectionVersion,
                    reservation.previousConnectionVersion!,
                  )).catch((error) => fatal?.(error));
                } else {
                  void mutate(() => coordinator.detach(ticketId, assignment.connectionVersion))
                    .catch((error) => fatal?.(error));
                }
                if (browser.readyState !== WebSocket.CLOSED) browser.terminate();
                return;
              }
              browserWss.emit("connection", browser, request, assignment);
              browser.resume();
            }).catch((error) => {
              releaseUpgrade();
              browser.off("close", markBrowserClosed);
              browser.off("error", markBrowserClosed);
              browser.terminate();
              fatal?.(error);
            });
          });
        } catch {
          socket.off("close", onSocketClose);
          socket.off("error", onSocketClose);
          cancelReservedUpgrade();
          if (!socket.destroyed) socket.destroy();
        }
      }).catch(() => {
        socket.off("close", onSocketClose);
        socket.off("error", onSocketClose);
        releaseUpgrade();
        cancelReservedUpgrade();
        rejectUpgrade(socket, "503 Service Unavailable");
      });
    });

    const scheduleActivityPersist = (bridge: GatewayBridge) => {
      bridge.lastActivityObservedAt = Date.now();
      if (bridge.closed || bridge.activityInFlight || bridge.activityTimer) return;
      const persist = () => {
        bridge.activityTimer = undefined;
        if (bridge.closed || bridge.activityInFlight) return;
        bridge.activityInFlight = true;
        const observedThrough = bridge.lastActivityObservedAt;
        void mutate(() => coordinator.touch(bridge.sessionId)).then(() => {
          bridge.lastActivityPersistedAt = Date.now();
        }).catch((error) => fatal?.(error)).finally(() => {
          bridge.activityInFlight = false;
          if (!bridge.closed && bridge.lastActivityObservedAt > observedThrough) {
            scheduleActivityPersist(bridge);
          }
        });
      };
      const delay = Math.max(
        0,
        bridge.lastActivityPersistedAt + ACTIVITY_PERSIST_INTERVAL_MS - Date.now(),
      );
      if (delay === 0) {
        persist();
      } else {
        bridge.activityTimer = setTimeout(persist, delay);
        bridge.activityTimer.unref();
      }
    };

    browserWss.on("connection", (
      browser: WebSocket,
      _request: IncomingMessage,
      assignment: PublicWorkerAssignment,
    ) => {
      const previous = bridges.get(assignment.id);
      closeBridge(previous, 4001, "Replaced by a newer browser connection");
      const attachedAt = Date.now();
      const traffic = trafficFor(assignment.id);
      const bridge: GatewayBridge = {
        sessionId: assignment.id,
        browser,
        closed: false,
        activityInFlight: false,
        lastActivityPersistedAt: attachedAt,
        lastActivityObservedAt: attachedAt,
        messageLimiter: traffic.messageLimiter,
      };
      bridges.set(assignment.id, bridge);
      const endpoint = workerById.get(assignment.workerId);
      if (!endpoint) {
        bridges.delete(assignment.id);
        closeBridge(bridge, WORKER_UNAVAILABLE_CLOSE_CODE, "Assigned worker unavailable");
        void mutate(() => coordinator.setWorkerReady(assignment.workerId, false))
          .catch((error) => fatal?.(error));
        return;
      }

      const upstream = new WebSocket(websocketUrl(endpoint.url), {
        origin: config.publicOrigin,
        handshakeTimeout: 5_000,
        maxPayload: MAX_WORKER_MESSAGE_BYTES,
        headers: {
          "X-Fin-Terminal-Proxy-Token": config.workerProxyToken,
          "X-Fin-Terminal-User": `public:${assignment.id}`,
        },
      });
      bridge.upstream = upstream;
      const pending: string[] = [];
      let pendingWorkerMessage: string | undefined;
      let upstreamOpen = false;
      let generationConfirmed = false;

      const endForBrowserPolicy = (reason: "rate-limited" | "protocol-violation") => {
        closeBridge(bridge, SESSION_ENDED_CLOSE_CODE, reason);
        void mutate(() => coordinator.terminate(assignment.id, reason))
          .catch((error) => fatal?.(error));
      };
      const failAssignedWorker = (reason: string) => {
        if (bridge.closed) return;
        closeBridge(bridge, WORKER_UNAVAILABLE_CLOSE_CODE, reason);
        void mutate(() => coordinator.setWorkerReady(assignment.workerId, false))
          .catch((error) => fatal?.(error));
      };
      const sendUpstream = (text: string): boolean => {
        if (upstream.bufferedAmount > MAX_WEBSOCKET_BUFFERED_BYTES) {
          failAssignedWorker("Terminal worker is not accepting input");
          return false;
        }
        upstream.send(text);
        return true;
      };
      const forwardWorkerMessage = (text: string) => {
        if (bridge.closed || browser.readyState !== WebSocket.OPEN) return;
        if (browser.bufferedAmount > MAX_WEBSOCKET_BUFFERED_BYTES) {
          closeBridge(bridge, 1008, "Browser is not accepting terminal output");
          return;
        }
        if (isActiveResearchFramePayload(text)) {
          // This progress signal comes from the assigned worker rather than a
          // browser heartbeat, so an anonymous visitor cannot forge activity.
          scheduleActivityPersist(bridge);
        }
        browser.send(text);
      };
      const flushConfirmedConnection = () => {
        if (!upstreamOpen || !generationConfirmed || bridge.closed) return;
        for (const message of pending.splice(0)) {
          if (!sendUpstream(message)) return;
        }
        if (pendingWorkerMessage) {
          const message = pendingWorkerMessage;
          pendingWorkerMessage = undefined;
          forwardWorkerMessage(message);
        }
      };

      browser.on("message", (raw: RawData, isBinary: boolean) => {
        if (bridge.closed) return;
        const text = isBinary ? undefined : rawMessageText(raw);
        if (!text || !isAllowedPublicClientMessage(text)) {
          endForBrowserPolicy("protocol-violation");
          return;
        }
        if (!bridge.messageLimiter.take()) {
          endForBrowserPolicy("rate-limited");
          return;
        }
        if (isMeaningfulActivity(text)) scheduleActivityPersist(bridge);
        if (upstreamOpen && generationConfirmed) {
          sendUpstream(text);
        } else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 16) {
          pending.push(text);
        } else {
          endForBrowserPolicy("rate-limited");
        }
      });
      browser.on("close", () => {
        // Mark this bridge closed before retiring its upstream. Otherwise the
        // resulting upstream close event would be mistaken for a worker fault
        // and would destroy an otherwise reconnectable public session.
        closeBridge(bridge, 1000, "Browser disconnected");
        const current = bridges.get(assignment.id) === bridge;
        if (current) {
          bridges.delete(assignment.id);
          void mutate(() => coordinator.detach(assignment.id, assignment.connectionVersion))
            .catch((error) => fatal?.(error));
        }
      });
      browser.on("error", () => closeBridge(bridge, 1011, "Browser connection error"));
      upstream.on("upgrade", (response) => {
        const observedGeneration = workerGeneration({
          instanceId: singleHeader(response, WORKER_GENERATION_HEADER),
        });
        void mutate(() => coordinator.confirmWorkerGeneration(
          assignment.id,
          assignment.connectionVersion,
          observedGeneration,
        )).then((confirmed) => {
          if (!confirmed) {
            closeBridge(bridge, WORKER_UNAVAILABLE_CLOSE_CODE, "Terminal worker generation changed");
            return;
          }
          generationConfirmed = true;
          flushConfirmedConnection();
        }).catch((error) => fatal?.(error));
      });
      upstream.on("open", () => {
        upstreamOpen = true;
        flushConfirmedConnection();
      });
      upstream.on("message", (data: RawData, isBinary: boolean) => {
        if (bridge.closed) return;
        const text = isBinary ? undefined : trustedWorkerMessageText(data);
        if (!text || !isAllowedPublicWorkerMessage(text)) {
          failAssignedWorker("Terminal worker sent an invalid message");
          return;
        }
        if (!generationConfirmed) {
          // Keep only the latest pre-confirmation frame; generation validation
          // completes before any worker content can cross the public boundary.
          pendingWorkerMessage = text;
          return;
        }
        forwardWorkerMessage(text);
      });
      upstream.on("close", () => {
        if (!bridge.closed) failAssignedWorker("Terminal worker disconnected");
      });
      upstream.on("error", () => {
        if (!bridge.closed) failAssignedWorker("Terminal worker unavailable");
      });
    });

    let maintenanceRunning = false;
    const maintenance = async () => {
      if (maintenanceRunning) return;
      maintenanceRunning = true;
      try {
        const probes = await inspect(() => config.workerEndpoints.map((worker) => ({
          ...worker,
          probeEpoch: coordinator.workerProbeEpoch(worker.id),
        })));
        const results = await Promise.all(probes.map(async (worker) => ({
          id: worker.id,
          probeEpoch: worker.probeEpoch,
          generation: await healthCheck(worker.url),
        })));
        await mutate(() => {
          coordinator.sweep();
          for (const { id, generation, probeEpoch } of results) {
            coordinator.setWorkerReady(id, Boolean(generation), generation, probeEpoch);
          }
          // Run warm-pool planning: compute desired state and log scale-down/activate.
          researchPermits.sweep();
          const seatStatuses = coordinator.getSeatStatuses();
          const drainMap = new Map<string, boolean>();
          for (const seat of seatStatuses) {
            drainMap.set(seat.workerId, warmPool.isDraining(seat.workerId));
          }
          const seatsWithDrain = seatStatuses.map((s) => ({
            ...s,
            drainRequested: drainMap.get(s.workerId) ?? false,
            drainId: warmPool.getDrain(s.workerId)?.drainId,
            drainGeneration: warmPool.getDrain(s.workerId)?.generation,
            drainSinceMs: warmPool.getDrain(s.workerId)
              ? Date.now() - (warmPool.getDrain(s.workerId)?.requestedAt ?? Date.now())
              : undefined,
          }));
          const plan = warmPool.plan(seatsWithDrain);
          if (plan.scaleDownCandidates.length > 0) {
            console.log("[warm-pool] scale-down candidates:", plan.scaleDownCandidates.join(", "));
          }
          if (plan.activateCandidates.length > 0) {
            console.log("[warm-pool] activate candidates:", plan.activateCandidates.join(", "));
          }
          console.log(
            `[warm-pool] desired running=${plan.desiredRunning}, ` +
            `current=${seatsWithDrain.filter((s) =>
              s.phase !== "absent" && !s.drainRequested).length}`,
          );
        });
      } finally {
        maintenanceRunning = false;
      }
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    let closing = false;
    let signalHandler: (() => void) | undefined;
    let managementApi: ManagementApi | undefined;
    const close = async () => {
      if (closing) return;
      closing = true;
      if (signalHandler) {
        process.off("SIGINT", signalHandler);
        process.off("SIGTERM", signalHandler);
      }
      if (timer) clearInterval(timer);
      for (const bridge of bridges.values()) closeBridge(bridge, 1012, "Public gateway shutting down");
      browserWss.close();
      if (managementApi) await managementApi.close();
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await persistence.close();
    };
    cleanup = close;

    await maintenance();
    fatal = (error) => {
      if (closing) return;
      console.error("[public-gateway] fatal admission-state error:", error instanceof Error ? error.message : String(error));
      void close().finally(() => process.exitCode = 1);
    };
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(config.port, config.host, () => {
        server.off("error", onError);
        console.log(`[public-gateway] listening on http://${config.host}:${config.port}`);
        resolve();
      });
    });
    server.on("error", fatal);
    timer = setInterval(() => void maintenance().catch((error) => fatal?.(error)), WORKER_HEALTH_INTERVAL_MS);
    timer.unref();

    // ── Private management API ───────────────────────────────────────────
    // Feature-gated via TERMINAL_RUNTIME_FEATURE_ENABLED (boolean spellings
    // 1|true|yes|on); the token must be explicit and strong. This listener is
    // private-only (separate port, dedicated TERMINAL_RUNTIME_MANAGEMENT_HOST,
    // default 0.0.0.0 which is safe only because no host port is published
    // and Caddy never routes to it). A bind failure rejects gateway startup:
    // the feature is required, so we fail closed rather than run without it.
    const managementConfig = resolveManagementApiConfig(process.env);
    if (managementConfig) {
      managementApi = await startManagementApi(
        managementConfig,
        {
          getSeatStatuses: () => {
            const seatStatuses = coordinator.getSeatStatuses();
            const drainMap = new Map<string, boolean>();
            for (const seat of seatStatuses) {
              drainMap.set(seat.workerId, warmPool.isDraining(seat.workerId));
            }
            return seatStatuses.map((s) => ({
              ...s,
              drainRequested: drainMap.get(s.workerId) ?? false,
              drainId: warmPool.getDrain(s.workerId)?.drainId,
              drainGeneration: warmPool.getDrain(s.workerId)?.generation,
              drainSinceMs: warmPool.getDrain(s.workerId)
                ? Date.now() - (warmPool.getDrain(s.workerId)?.requestedAt ?? Date.now())
                : undefined,
            }));
          },
          getWarmPool: () => warmPool,
          getResearchCoordinator: () => researchPermits,
          getQueueCount: () => coordinator.metrics().queuedVisitors,
          touchSession: (sessionId) => coordinator.touch(sessionId),
          setWorkerDrainIneligible: (workerId, ineligible) =>
            coordinator.setWorkerDrainIneligible(workerId, ineligible),
          mutate,
          inspect,
        },
      );
    }
    signalHandler = () => void close();
    process.once("SIGINT", signalHandler);
    process.once("SIGTERM", signalHandler);
    return { server, close };
  } catch (error) {
    try {
      if (cleanup) await cleanup();
      else await persistence.close();
    } catch {
      // Preserve the startup error; orchestrators should restart the process.
    }
    throw error;
  }
}

function publicStatus(session: PublicSessionSnapshot): Record<string, unknown> {
  return {
    status: session.state,
    ...(session.queuePosition ? { queuePosition: session.queuePosition } : {}),
    ...(session.sessionExpiresAt ? { sessionExpiresAt: session.sessionExpiresAt } : {}),
    ...(session.idleExpiresAt ? { idleExpiresAt: session.idleExpiresAt } : {}),
    // Authoritative per-session research balance from the coordinator; the UI
    // renders it when present and never fabricates a full-balance count.
    researchRunsRemaining: session.researchRunsRemaining,
    ...(session.endReason ? { reason: session.endReason } : {}),
  };
}

function closeBridge(bridge: GatewayBridge | undefined, code: number, reason: string): void {
  if (!bridge || bridge.closed) return;
  bridge.closed = true;
  if (bridge.activityTimer) {
    clearTimeout(bridge.activityTimer);
    bridge.activityTimer = undefined;
  }
  if (bridge.browser.readyState === WebSocket.OPEN || bridge.browser.readyState === WebSocket.CONNECTING) {
    bridge.browser.close(code, reason.slice(0, 123));
  }
  if (bridge.upstream && (bridge.upstream.readyState === WebSocket.OPEN || bridge.upstream.readyState === WebSocket.CONNECTING)) {
    bridge.upstream.close();
  }
}
