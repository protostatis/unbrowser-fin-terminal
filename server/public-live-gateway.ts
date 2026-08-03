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
const ACTIVITY_PERSIST_INTERVAL_MS = 2_000;
const TURNSTILE_ACTION = "public_terminal_admission";
const SESSION_ENDED_CLOSE_CODE = 4408;
const WORKER_UNAVAILABLE_CLOSE_CODE = 4410;
const WORKER_HEALTH_INTERVAL_MS = 2_000;
const WORKER_HEALTH_TIMEOUT_MS = 1_500;

type TurnstileVerification = { success?: unknown; hostname?: unknown; action?: unknown };

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
  if (result.success !== true) return false;
  if (result.action !== TURNSTILE_ACTION) return false;
  return !config.turnstileExpectedHostname || result.hostname === config.turnstileExpectedHostname;
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
        const bridge = bridges.get(session.id);
        closeBridge(bridge, SESSION_ENDED_CLOSE_CODE, reason);
      },
    });
    const restored = await persistence.load();
    if (restored) coordinator.restore(restored);

    let mutations = Promise.resolve();
    let fatal: ((error: unknown) => void) | undefined;
    const mutate = <T>(operation: () => T | Promise<T>): Promise<T> => {
      const result = mutations.then(async () => {
        const value = await operation();
        await persistence.save(coordinator.exportState());
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
        const metrics = await inspect(() => coordinator.metrics());
        response.json({ status: "ready", publicLive: true, ...metrics });
      } catch {
        response.status(503).json({ status: "unavailable" });
      }
    });
    app.get("/api/public/config", (request, response) => {
      const visitorId = identityFor(request, true);
      response.json({
        visitorToken: signOpaqueId(visitorId!, config.signingKey),
        turnstileSiteKey: config.turnstileSiteKey,
        turnstileRequired: config.turnstileRequired,
        ticketTtlMs: config.ticketTtlMs,
        maxSessionMs: config.absoluteTimeoutMs,
        maxResearchRuns: config.maxResearchRuns,
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

    server.on("upgrade", (request, socket, head) => {
      const parsed = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (parsed.pathname !== "/ws" || !isAllowedOrigin(request, config)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const ticketId = websocketTicketFor(request);
      if (!ticketId) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      void mutate(() => coordinator.attach(ticketId)).then((assignment) => {
        if (!assignment) {
          socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        browserWss.handleUpgrade(request, socket, head, (browser) => {
          browserWss.emit("connection", browser, request, assignment);
        });
      }).catch(() => {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
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
      const bridge: GatewayBridge = {
        sessionId: assignment.id,
        browser,
        closed: false,
        activityInFlight: false,
        lastActivityPersistedAt: attachedAt,
        lastActivityObservedAt: attachedAt,
        messageLimiter: new TokenBucketRateLimiter(
          CLIENT_MESSAGE_RATE_PER_SECOND,
          CLIENT_MESSAGE_BURST,
        ),
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
        const results = await Promise.all(config.workerEndpoints.map(async (worker) => ({
          id: worker.id,
          generation: await healthCheck(worker.url),
        })));
        await mutate(() => {
          coordinator.sweep();
          for (const { id, generation } of results) {
            coordinator.setWorkerReady(id, Boolean(generation), generation);
          }
        });
      } finally {
        maintenanceRunning = false;
      }
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    let closing = false;
    let signalHandler: (() => void) | undefined;
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
