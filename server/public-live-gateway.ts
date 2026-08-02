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
import { isActiveResearchFramePayload } from "./research-activity.js";

const VISITOR_TOKEN_HEADER = "x-public-visitor-token";
const TICKET_TOKEN_HEADER = "x-public-ticket-token";
const SESSION_PROTOCOL_PREFIX = "fin-terminal-session.";
const MAX_CLIENT_MESSAGE_BYTES = 8 * 1024;
const MAX_WORKER_MESSAGE_BYTES = 512 * 1024;
const SESSION_ENDED_CLOSE_CODE = 4408;
const WORKER_UNAVAILABLE_CLOSE_CODE = 4410;
const WORKER_HEALTH_INTERVAL_MS = 2_000;
const WORKER_HEALTH_TIMEOUT_MS = 1_500;

type TurnstileVerification = { success?: unknown; hostname?: unknown };

export interface PublicLiveGateway {
  server: HttpServer;
  close(): Promise<void>;
}

interface GatewayBridge {
  sessionId: string;
  browser: WebSocket;
  upstream?: WebSocket;
  closed: boolean;
  messageChain: Promise<void>;
}

class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const now = this.now();
    const current = this.entries.get(key);
    if (!current || now >= current.expiresAt) {
      this.entries.set(key, { count: 1, expiresAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function publicClientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-real-ip"];
  if (typeof forwarded === "string" && /^[A-Fa-f0-9:.]{1,64}$/.test(forwarded.trim())) {
    return forwarded.trim();
  }
  return request.socket.remoteAddress ?? "unknown";
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
      return data.name === "market" && typeof data.args === "string" && data.args.length <= 32;
    case "select_response":
      return typeof data.id === "string" && data.id.length > 0 && data.id.length <= 160
        && (data.value === undefined || typeof data.value === "string")
        && (data.cancelled === undefined || typeof data.cancelled === "boolean");
    case "web_action":
      return data.data !== null && typeof data.data === "object" && !Array.isArray(data.data);
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

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb", type: "application/json" }));
  const admissionLimiter = new FixedWindowRateLimiter(
    config.admissionAttemptsPerWindow,
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
      const metrics = await mutate(() => coordinator.metrics());
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
    const remoteIp = publicClientIp(request);
    const turnstileToken = readJsonToken(request);
    if (!visitorId) {
      response.status(401).json({ error: "visitor_required" });
      return;
    }
    if (!turnstileToken && config.turnstileRequired) {
      response.status(400).json({ error: "turnstile_required" });
      return;
    }
    if (!admissionLimiter.take(remoteIp)) {
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
      const session = await mutate(() => coordinator.status(ticket.ticketId));
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

  browserWss.on("connection", (browser: WebSocket, _request: IncomingMessage, assignment: PublicWorkerAssignment) => {
    const previous = bridges.get(assignment.id);
    closeBridge(previous, 4001, "Replaced by a newer browser connection");
    const bridge: GatewayBridge = {
      sessionId: assignment.id,
      browser,
      closed: false,
      messageChain: Promise.resolve(),
    };
    bridges.set(assignment.id, bridge);
    const endpoint = workerById.get(assignment.workerId);
    if (!endpoint) {
      closeBridge(bridge, WORKER_UNAVAILABLE_CLOSE_CODE, "Assigned worker unavailable");
      return;
    }

    const upstream = new WebSocket(websocketUrl(endpoint.url), {
      origin: config.publicOrigin,
      handshakeTimeout: 5_000,
      headers: {
        "X-Fin-Terminal-Proxy-Token": config.workerProxyToken,
        "X-Fin-Terminal-User": `public:${assignment.id}`,
      },
    });
    bridge.upstream = upstream;
    const pending: string[] = [];

    browser.on("message", (raw: RawData, isBinary: boolean) => {
      bridge.messageChain = bridge.messageChain.then(async () => {
        if (bridge.closed || isBinary) {
          closeBridge(bridge, 1008, "Invalid terminal message");
          return;
        }
        const text = rawMessageText(raw);
        if (!text || !isAllowedPublicClientMessage(text)) {
          closeBridge(bridge, 1008, "Invalid terminal message");
          return;
        }
        if (isMeaningfulActivity(text)) await mutate(() => coordinator.touch(assignment.id));
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(text);
        } else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 16) {
          pending.push(text);
        }
      }).catch((error) => fatal?.(error));
    });
    browser.on("close", () => {
      if (bridges.get(assignment.id) === bridge) bridges.delete(assignment.id);
      void mutate(() => coordinator.detach(assignment.id)).catch((error) => fatal?.(error));
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    });
    browser.on("error", () => closeBridge(bridge, 1011, "Browser connection error"));
    upstream.on("open", () => {
      for (const message of pending.splice(0)) upstream.send(message);
    });
    upstream.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        const text = trustedWorkerMessageText(data);
        if (text && isActiveResearchFramePayload(text)) {
          // This progress signal comes from the assigned worker rather than a
          // browser heartbeat, so an anonymous visitor cannot forge activity.
          bridge.messageChain = bridge.messageChain
            .then(() => mutate(() => coordinator.touch(assignment.id)))
            .catch((error) => fatal?.(error));
        }
      }
      if (!bridge.closed && browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
    });
    upstream.on("close", () => closeBridge(bridge, WORKER_UNAVAILABLE_CLOSE_CODE, "Terminal worker disconnected"));
    upstream.on("error", () => closeBridge(bridge, WORKER_UNAVAILABLE_CLOSE_CODE, "Terminal worker unavailable"));
  });

  let maintenanceRunning = false;
  const refreshWorkers = async () => {
    const results = await Promise.all(config.workerEndpoints.map(async (worker) => ({
      id: worker.id,
      generation: await healthCheck(worker.url),
    })));
    for (const { id, generation } of results) {
      await mutate(() => coordinator.setWorkerReady(id, Boolean(generation), generation));
    }
  };
  const maintenance = async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      await mutate(() => coordinator.sweep());
      await refreshWorkers();
    } finally {
      maintenanceRunning = false;
    }
  };
  const timer = setInterval(() => void maintenance().catch((error) => fatal?.(error)), WORKER_HEALTH_INTERVAL_MS);
  timer.unref();

  let closing = false;
  let signalHandler: (() => void) | undefined;
  const close = async () => {
    if (closing) return;
    closing = true;
    if (signalHandler) {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
    }
    clearInterval(timer);
    for (const bridge of bridges.values()) closeBridge(bridge, 1012, "Public gateway shutting down");
    browserWss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await persistence.close();
  };
  fatal = (error) => {
    if (closing) return;
    console.error("[public-gateway] fatal admission-state error:", error instanceof Error ? error.message : String(error));
    void close().finally(() => process.exitCode = 1);
  };

  server.listen(config.port, config.host, () => {
    console.log(`[public-gateway] listening on http://${config.host}:${config.port}`);
  });
  signalHandler = () => void close();
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  await maintenance();
  return { server, close };
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
  if (bridge.browser.readyState === WebSocket.OPEN || bridge.browser.readyState === WebSocket.CONNECTING) {
    bridge.browser.close(code, reason.slice(0, 123));
  }
  if (bridge.upstream && (bridge.upstream.readyState === WebSocket.OPEN || bridge.upstream.readyState === WebSocket.CONNECTING)) {
    bridge.upstream.close();
  }
}
