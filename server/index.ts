/**
 * Market Terminal web backend — signed-in live, static replay, or public live gateway.
 *
 * The runtime mode is determined by PUBLIC_DEMO or TERMINAL_RUNTIME_MODE:
 *   PUBLIC_DEMO=1|true  → replay-only server (static files, no agent)
 *   PUBLIC_DEMO=0|false → live server (full agent session + WebSocket)
 *   TERMINAL_RUNTIME_MODE=public-gateway → Turnstile admission + isolated workers
 *
 * In production PUBLIC_DEMO must be explicitly set; dev defaults to live.
 *
 * Architecture (live): a REAL in-process Pi agent session (createAgentSession)
 * hosts the canonical `.pi/extensions/market-terminal.ts`. The session IS the
 * ExtensionAPI (agent, tools, events, pi.exec, pi.sendUserMessage, model/auth).
 * We only supply the UI surface (server/web-ui.ts) so the extension's
 * `ctx.ui.custom()` hands us the live panel, whose `render()` we convert
 * (ANSI→HTML) and stream to the browser. Research (J/K) runs the real agent in
 * the same process, so canvases flow live to the same panel.
 *
 * The same extension file powers both Pi's TUI and this browser projection.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import express from "express";
import { resolveRuntimeMode, verifyBuildModeManifest } from "./runtime-mode.js";
import {
  matchesProxyToken,
  singleHeader,
} from "./proxy-auth.js";

// ── Live-mode only imports (no side effects — safe to statically load) ──────
import { WebSocket, WebSocketServer } from "ws";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  assertMarketAgentTools,
  createAgentModelRuntime,
  MARKET_AGENT_TOOLS,
  validateUnbrowserRuntime,
} from "./agent-config.js";
import { ansiToHtml } from "./theme.js";
import { createWebUi, type Panel } from "./web-ui.js";
import {
  normalizePrincipal,
  PrincipalLease,
} from "./proxy-auth.js";
import { readResearchWorkerConcurrency } from "./research-worker-coordinator.js";
import { resolveWebAction } from "./web-actions.js";
import { startPublicLiveGateway } from "./public-live-gateway.js";
import { readPublicSessionWorkerConfig } from "./public-live-config.js";
import { PublicSessionWorkerLifecycle } from "./public-session-worker.js";
import { createOpaqueId } from "./public-session-tokens.js";
import { hasActiveResearchState } from "./research-activity.js";
import {
  isWorkspaceCheckpointEnabled,
  CHECKPOINT_EXPORT_PATH,
} from "../shared/financial-workspace-checkpoint.js";
import {
  createWorkspaceCheckpointExportHandler,
} from "./workspace-checkpoint-handler.js";
import {
  createServerCheckpointEventLog,
  recordServerCheckpointEvent,
  workerGenerationEpoch,
  type ServerCheckpointEventLog,
  type CheckpointWorkerState,
} from "./workspace-checkpoint-export.js";
import { importCheckpointIntoFreshSession } from "./workspace-checkpoint-import.js";

// ==========================================================================
// Runtime mode — must be resolved before any live-only side effects
// ==========================================================================

const RUNTIME_MODE = resolveRuntimeMode();
const isReplay = RUNTIME_MODE === "replay";
const isPublicGateway = RUNTIME_MODE === "public-gateway";

// ==========================================================================
// Common configuration
// ==========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CWD = path.resolve(process.env.MARKET_ROOT?.trim() || path.resolve(__dirname, ".."));
const WEB_DIST = path.join(CWD, "dist-web");

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const PROXY_TOKEN = process.env.MARKET_PROXY_TOKEN?.trim() || "";
const PROXY_TOKEN_HEADER = "x-fin-terminal-proxy-token";

// Production guard: PROXY_TOKEN required in live mode only.
// Replay mode may serve without a token if the deployer chooses.
if (process.env.NODE_ENV === "production" && RUNTIME_MODE === "live" && !PROXY_TOKEN) {
  throw new Error("MARKET_PROXY_TOKEN is required in production");
}

// Build and runtime mode must be paired before either server listens. This
// protects both directions: replay routes cannot boot a live client, and the
// authenticated terminal cannot serve a replay-only client.
if (process.env.NODE_ENV === "production") {
  const indexPath = path.join(WEB_DIST, "index.html");
  const html = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
  verifyBuildModeManifest(RUNTIME_MODE, html);
}

// ==========================================================================
// Express app — shared across both modes
// ==========================================================================

if (isPublicGateway) {
  void startPublicLiveGateway().catch((error) => {
    console.error(
      "[public-gateway] failed to start:",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    process.exitCode = 1;
  });
} else {
const app = express();

app.get("/api/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

app.use((req, res, next) => {
  // Container readiness probes originate inside the Compose network and do not
  // carry Caddy's proxy token. Keep this narrow endpoint public so a healthy
  // candidate is not rolled back before Caddy can serve it.
  if (req.path === "/api/ready") {
    next();
    return;
  }
  if (!matchesProxyToken(PROXY_TOKEN, singleHeader(req, PROXY_TOKEN_HEADER))) {
    res.status(403).type("text").send("Forbidden");
    return;
  }
  next();
});

// ==========================================================================
// REPLAY-ONLY MODE
// ==========================================================================

if (isReplay) {
  console.log("[server] runtime mode: replay (static-only, no agent)");

  // ── /api/ready ──────────────────────────────────────────────────────────
  app.get("/api/ready", (_req, res) => {
    res.json({ status: "ready", replay: true });
  });

  // ── Reject WebSocket upgrades ───────────────────────────────────────────
  // Explicitly block any request to /ws: both genuine WebSocket upgrade
  // handshakes and accidental HTTP requests from stale browser tabs.
  app.all("/ws", (_req, res) => {
    res.status(403).type("text").send("WebSocket not available in replay mode");
  });

  // ── Static file serving ─────────────────────────────────────────────────
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res.type("html").send(
        `<!doctype html><meta charset="utf-8"><title>Market Terminal</title>` +
          `<body style="font-family:system-ui;background:#0b0e14;color:#c9d1d9;padding:2rem">` +
          `<h2>Frontend not built yet</h2><p>Run <code>npm run build</code> then reload.</p></body>`,
      ),
    );
  }

  // ── Listen ──────────────────────────────────────────────────────────────
  const server = app.listen(PORT, HOST, () => {
    console.log(`[server] replay mode listening on http://${HOST}:${PORT}`);
  });

  // HTTP Upgrade bypasses Express routing. Reject it at the Node server so a
  // stale client cannot receive a successful WebSocket handshake in replay.
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  // ── Graceful shutdown ───────────────────────────────────────────────────
  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] shutting down (${signal})...`);
    server.close(() => process.exit(0));
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ==========================================================================
// LIVE MODE
// ==========================================================================

else {
  console.log("[server] runtime mode: live (full agent session + websocket)");

  // ── Live-only constants ─────────────────────────────────────────────────
  const PRINCIPAL_HEADER = "x-fin-terminal-user";
  const PUBLIC_WORKER_GENERATION_HEADER = "X-Fin-Terminal-Worker-Generation";
  const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const CLIENT_REPLACED_CLOSE_CODE = 4001;
  const publicSessionWorker = readPublicSessionWorkerConfig();
  const publicWorkerInstanceId = publicSessionWorker.enabled ? createOpaqueId() : undefined;
  const RESEARCH_WORKER_CONCURRENCY = readResearchWorkerConcurrency();
  if (publicSessionWorker.enabled && RESEARCH_WORKER_CONCURRENCY !== 1) {
    throw new Error("PUBLIC_SESSION_WORKER requires MARKET_RESEARCH_CONCURRENCY=1");
  }

  // ── Authoritative checkpoint event log (server-observed, not browser) ───
  const checkpointEventLog: ServerCheckpointEventLog = createServerCheckpointEventLog();
  let lastCheckpointEventState: {
    screen?: string;
    symbol?: string;
    chartScope?: string;
    researchActive?: boolean;
    researchPhase?: string;
    researchOutcome?: string;
  } | undefined;

  // A public worker exposes its process generation to the research-permit
  // client and the checkpoint exporter via process env.
  if (publicWorkerInstanceId) {
    process.env.TERMINAL_RUNTIME_WORKER_GENERATION = publicWorkerInstanceId;
  }

  function parseAllowedOrigins(raw: string | undefined): Set<string> | null {
    if (raw === undefined) return null;
    const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (entries.length === 0) throw new Error("ALLOWED_ORIGINS must not be empty when set");

    const origins = new Set<string>();
    for (const entry of entries) {
      let parsed: URL;
      try {
        parsed = new URL(entry);
      } catch {
        throw new Error(`Invalid ALLOWED_ORIGINS entry: ${entry}`);
      }
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.origin !== entry
      ) {
        throw new Error(`ALLOWED_ORIGINS entries must be canonical HTTP(S) origins: ${entry}`);
      }
      origins.add(parsed.origin);
    }
    return origins;
  }

  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  if (!LOOPBACK_HOSTS.has(HOST) && !allowedOrigins) {
    throw new Error(
      "Refusing a non-loopback HOST without ALLOWED_ORIGINS. Remote deployment also requires authentication.",
    );
  }

  function isAllowedWebSocketRequest(req: IncomingMessage): boolean {
    const originValues: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]?.toLowerCase() === "origin") {
        originValues.push(req.rawHeaders[i + 1] ?? "");
      }
    }
    if (originValues.length !== 1 || originValues[0] === "null") return false;

    let parsed: URL;
    try {
      parsed = new URL(originValues[0]);
    } catch {
      return false;
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== originValues[0]
    ) {
      return false;
    }

    if (allowedOrigins) return allowedOrigins.has(parsed.origin);
    return LOOPBACK_HOSTS.has(parsed.hostname);
  }

  function requestPrincipal(req: IncomingMessage): string | undefined {
    return normalizePrincipal(singleHeader(req, PRINCIPAL_HEADER), Boolean(PROXY_TOKEN));
  }

  // ── Connection state (single active web client; the session is a singleton)
  let activePanel: Panel | null = null;
  let activeClient: WebSocket | null = null;
  let cols = 120;
  let sendToClient: (msg: object) => void = () => {};
  let renderScheduled = false;

  function pushFrame(): void {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      if (!activePanel) return;
      try {
        const raw = activePanel.render(cols);
        const rows = raw.map((r) => ansiToHtml(r));
        const rawState =
          typeof activePanel.debugState === "function" ? activePanel.debugState() : undefined;
        if (publicWorkerLifecycle && hasActiveResearchState(rawState)) {
          // Trusted model/tool progress extends the idle lease, while the
          // absolute public-session deadline remains unchanged.
          publicWorkerLifecycle.touch();
        }
        recordCheckpointFrameEvents(rawState);
        sendToClient({ type: "frame", rows, width: cols, rows_count: rows.length, state: rawState });
      } catch (err) {
        console.warn("[render] error:", err instanceof Error ? err.message : String(err));
      }
    });
  }

  /** Project the authoritative frame state into checkpoint-legal fields. */
  function projectCheckpointWorkerState(rawState: unknown): CheckpointWorkerState {
    const state = rawState && typeof rawState === "object" && !Array.isArray(rawState)
      ? rawState as Record<string, unknown>
      : {};
    const research = state.research && typeof state.research === "object"
      ? state.research as Record<string, unknown>
      : undefined;
    const researchQueue = Array.isArray(state.researchQueue)
      ? state.researchQueue.filter((job): job is Record<string, unknown> =>
        Boolean(job) && typeof job === "object")
      : undefined;
    const dossier = state.dossier && typeof state.dossier === "object"
      ? state.dossier as Record<string, unknown>
      : undefined;
    const packets = dossier?.packets && Array.isArray(dossier.packets)
      ? dossier.packets.filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
      : undefined;
    return {
      ...(typeof state.screen === "string" ? { screen: state.screen } : {}),
      ...(typeof state.symbol === "string" ? { symbol: state.symbol } : {}),
      ...(typeof state.chartScope === "string" ? { chartScope: state.chartScope } : {}),
      ...(typeof state.searchQuery === "string" ? { searchQuery: state.searchQuery } : {}),
      ...(Array.isArray(state.available)
        ? { available: state.available.filter((s): s is string => typeof s === "string") }
        : {}),
      ...(research
        ? { research: projectResearchState(research) }
        : {}),
      ...(researchQueue
        ? {
            researchQueue: researchQueue
              .map(projectResearchState)
              .filter((job): job is NonNullable<typeof job> => job !== undefined),
          }
        : {}),
      ...(dossier
        ? {
            dossier: {
              ...(typeof dossier.title === "string" ? { title: dossier.title } : {}),
              ...(typeof dossier.intent === "string" ? { intent: dossier.intent } : {}),
              ...(typeof dossier.stage === "string" ? { stage: dossier.stage } : {}),
              ...(typeof dossier.summary === "string" ? { summary: dossier.summary } : {}),
              ...(Array.isArray(dossier.summarySourceIds)
                ? { summarySourceIds: dossier.summarySourceIds.filter((s): s is string => typeof s === "string") }
                : {}),
              ...(typeof dossier.evidenceStatus === "string" ? { evidenceStatus: dossier.evidenceStatus } : {}),
              ...(packets
                ? {
                    packets: packets.map((p) => ({
                      ...(typeof p.sourceId === "string" ? { sourceId: p.sourceId } : {}),
                      ...(typeof p.sourceTitle === "string" ? { sourceTitle: p.sourceTitle } : {}),
                      ...(typeof p.sourceDomain === "string" ? { sourceDomain: p.sourceDomain } : {}),
                      ...(typeof p.sourceUrl === "string" ? { sourceUrl: p.sourceUrl } : {}),
                      ...(typeof p.retrievalStatus === "string" ? { retrievalStatus: p.retrievalStatus } : {}),
                      ...(typeof p.extractedAt === "number" ? { extractedAt: p.extractedAt } : {}),
                      ...(typeof p.excerpt === "string" ? { excerpt: p.excerpt } : {}),
                      ...(typeof p.failureNote === "string" ? { failureNote: p.failureNote } : {}),
                    })),
                  }
                : {}),
            },
          }
        : {}),
    };
  }

  function projectResearchState(job: Record<string, unknown>): CheckpointWorkerState["research"] {
    return {
      ...(typeof job.id === "string" ? { id: job.id } : {}),
      ...(typeof job.contextLabel === "string" ? { contextLabel: job.contextLabel } : {}),
      ...(typeof job.symbol === "string" ? { symbol: job.symbol } : {}),
      ...(typeof job.outcome === "string" ? { outcome: job.outcome } : {}),
      ...(typeof job.phase === "string" ? { phase: job.phase } : {}),
      ...(typeof job.activity === "string" ? { activity: job.activity } : {}),
      ...(typeof job.active === "boolean" ? { active: job.active } : {}),
      ...(typeof job.updatedAt === "number" ? { updatedAt: job.updatedAt } : {}),
    };
  }

  /** Record authoritative navigate/research events from frame transitions. */
  function recordCheckpointFrameEvents(rawState: unknown): void {
    const state = rawState && typeof rawState === "object" && !Array.isArray(rawState)
      ? rawState as Record<string, unknown>
      : {};
    const screen = typeof state.screen === "string" ? state.screen : undefined;
    const symbol = typeof state.symbol === "string" ? state.symbol : undefined;
    const chartScope = typeof state.chartScope === "string" ? state.chartScope : undefined;
    const research = state.research && typeof state.research === "object"
      ? state.research as Record<string, unknown>
      : undefined;
    const researchActive = research?.active === true;
    const researchPhase = typeof research?.phase === "string" ? research.phase : undefined;
    const researchOutcome = typeof research?.outcome === "string" ? research.outcome : undefined;

    if (
      !lastCheckpointEventState
      || screen !== lastCheckpointEventState.screen
      || symbol !== lastCheckpointEventState.symbol
      || chartScope !== lastCheckpointEventState.chartScope
    ) {
      recordServerCheckpointEvent(checkpointEventLog, "navigate", {
        ...(screen ? { screen } : {}),
        ...(symbol ? { symbol } : {}),
        ...(chartScope ? { chartScope } : {}),
      });
    }

    const wasActive = lastCheckpointEventState?.researchActive ?? false;
    if (researchActive && !wasActive && (researchPhase === "dispatched" || researchPhase === "running")) {
      recordServerCheckpointEvent(checkpointEventLog, "research-start", {
        ...(typeof research?.symbol === "string" ? { symbol: research.symbol } : {}),
        ...(typeof research?.contextLabel === "string" ? { contextLabel: research.contextLabel } : {}),
      });
    }
    if (!researchActive && wasActive && researchPhase === "settled") {
      if (researchOutcome === "complete") {
        recordServerCheckpointEvent(checkpointEventLog, "research-complete", {
          ...(typeof research?.symbol === "string" ? { symbol: research.symbol } : {}),
          ...(typeof research?.contextLabel === "string" ? { contextLabel: research.contextLabel } : {}),
          ...(typeof research?.id === "string" ? { id: research.id } : {}),
        });
      } else if (researchOutcome === "failed" || researchOutcome === "cancelled") {
        recordServerCheckpointEvent(checkpointEventLog, "research-failed", {
          ...(typeof research?.symbol === "string" ? { symbol: research.symbol } : {}),
          ...(typeof research?.contextLabel === "string" ? { contextLabel: research.contextLabel } : {}),
        });
      }
    }

    lastCheckpointEventState = {
      screen,
      symbol,
      chartScope,
      researchActive,
      researchPhase,
      researchOutcome,
    };
  }

  const web = createWebUi({
    onPanel: (p) => {
      activePanel = p;
      console.log("[panel]", p ? `opened (${typeof p.debugState === "function" ? (p.debugState() as { mode?: string }).mode : "?"})` : "closed");
    },
    onRenderRequest: () => pushFrame(),
    onNotify: (message, level) => sendToClient({ type: "notify", level, message }),
    onSelect: (id, title, options) => {
      sendToClient({ type: "select_request", id, title, options });
      return waitForSelect(id);
    },
  });

  const pendingSelects = new Map<string, { resolve: (v: string | undefined) => void }>();
  function waitForSelect(id: string): Promise<string | undefined> {
    return new Promise((resolve) => pendingSelects.set(id, { resolve }));
  }

  function cancelPendingSelects(): void {
    for (const [, pending] of pendingSelects) pending.resolve(undefined);
    pendingSelects.clear();
  }

  // ── Create the REAL Pi agent session and bind our UI ────────────────────
  let session: AgentSession | undefined;
  let panelOpening = false;
  let sessionBootState: "starting" | "ready" | "failed" = "starting";
  const principalLease = new PrincipalLease();

  // Fresh private-workspace import: when TERMINAL_WORKSPACE_IMPORT_FILE points
  // at a validated checkpoint, boot an in-memory session seeded from it
  // (custom state entry + bounded continuation seed) instead of an empty one.
  let workspaceImportSessionManager: ReturnType<typeof SessionManager.inMemory> | undefined;
  if (isWorkspaceCheckpointEnabled() && process.env.TERMINAL_WORKSPACE_IMPORT_FILE?.trim()) {
    try {
      const importFile = process.env.TERMINAL_WORKSPACE_IMPORT_FILE.trim();
      const raw = JSON.parse(readFileSync(importFile, "utf8"));
      workspaceImportSessionManager = importCheckpointIntoFreshSession({
        checkpoint: raw,
        cwd: CWD,
      }).sessionManager;
      console.log(`[workspace-import] booting fresh workspace from ${importFile}`);
    } catch (error) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          `Cannot import workspace checkpoint: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      console.error(
        "[workspace-import] checkpoint import failed; booting an empty session:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function bootSession(): Promise<AgentSession> {
    console.log("[server] cwd:", CWD);
    console.log(`[server] research worker concurrency: ${RESEARCH_WORKER_CONCURRENCY}`);
    validateUnbrowserRuntime();
    const agentDir = getAgentDir();
    const { modelRuntime, model, config } = await createAgentModelRuntime(agentDir);
    if (publicSessionWorker.enabled && (!config.provider || !config.modelId)) {
      throw new Error(
        "PUBLIC_SESSION_WORKER requires an explicit MARKET_MODEL_PROVIDER/MARKET_MODEL_ID or OpenRouter model configuration",
      );
    }
    const loader = new DefaultResourceLoader({ cwd: CWD, agentDir });
    await loader.reload();

    console.log("[server] creating agent session...");
    const { session, extensionsResult } = await createAgentSession({
      cwd: CWD,
      agentDir,
      modelRuntime,
      ...(model ? { model } : {}),
      noTools: "builtin",
      tools: [...MARKET_AGENT_TOOLS],
      resourceLoader: loader,
      sessionManager: workspaceImportSessionManager ?? SessionManager.inMemory(CWD),
    });
    if (extensionsResult.errors.length) {
      session.dispose();
      throw new Error(`Market extension failed to load: ${extensionsResult.errors.map((error) => String(error)).join(" | ")}`);
    }
    try {
      assertMarketAgentTools(session);
    } catch (error) {
      session.dispose();
      throw error;
    }
    console.log(
      "[server] session ready. model:",
      session.model ? `${session.model.provider}/${session.model.id}` : "(none — research will fail until a model is configured)",
    );
    if (config.provider && config.modelId) {
      console.log(`[server] model policy: ${config.provider}/${config.modelId}, max output ${config.maxOutputTokens} tokens`);
    }

    await session.bindExtensions({
      uiContext: web.ui,
      mode: "tui",
      commandContextActions: web.commandContextActions,
    });
    console.log("[server] extensions bound (mode: tui).");
    return session;
  }

  // ── /api/ready (live) ───────────────────────────────────────────────────
  app.get("/api/ready", (_req, res) => {
    const ready = sessionBootState === "ready" && Boolean(session);
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : sessionBootState,
      ...(publicWorkerInstanceId ? { publicWorker: true, instanceId: publicWorkerInstanceId } : {}),
    });
  });

  // ── Private workspace checkpoint export (worker-side, never public) ─────
  // The gateway calls this only for the active assigned session/generation.
  // The worker's proxy-token middleware already guards every route below;
  // the handler additionally requires the shared control token.
  if (isWorkspaceCheckpointEnabled()) {
    const workspaceCheckpointExport = createWorkspaceCheckpointExportHandler({
      getExportContext: () => {
        if (!publicWorkerInstanceId) return undefined;
        const sessionId = process.env.TERMINAL_RUNTIME_SESSION_ID;
        const generation = process.env.TERMINAL_RUNTIME_WORKER_GENERATION;
        if (!sessionId || !generation) return undefined;
        const rawState =
          typeof activePanel?.debugState === "function" ? activePanel.debugState() : undefined;
        return {
          sessionId,
          generation: workerGenerationEpoch(generation),
          sourceRevision: generation,
          state: projectCheckpointWorkerState(rawState),
          eventLog: checkpointEventLog,
        };
      },
    });
    app.post(CHECKPOINT_EXPORT_PATH, workspaceCheckpointExport);
    console.log("[workspace-checkpoint] worker export endpoint enabled");
  }

  // ── Static files ────────────────────────────────────────────────────────
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res.type("html").send(
        `<!doctype html><meta charset="utf-8"><title>Market Terminal</title>` +
          `<body style="font-family:system-ui;background:#0b0e14;color:#c9d1d9;padding:2rem">` +
          `<h2>Frontend not built yet</h2><p>Run <code>npm run build</code> then reload.</p></body>`,
      ),
    );
  }

  // ── Listen ──────────────────────────────────────────────────────────────
  const server = app.listen(PORT, HOST, async () => {
    console.log(`[server] Listening on http://${HOST}:${PORT}`);
  });

  // ── WebSocket — drive the panel ─────────────────────────────────────────
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 64 * 1024,
    verifyClient: ({ req }, done) => {
      if (!matchesProxyToken(PROXY_TOKEN, singleHeader(req, PROXY_TOKEN_HEADER))) {
        done(false, 403, "Forbidden");
        return;
      }
      const principal = requestPrincipal(req);
      if (!principal) {
        done(false, 403, "Forbidden");
        return;
      }
      if (!isAllowedWebSocketRequest(req)) {
        console.warn("[ws] rejected connection with invalid or disallowed Origin");
        done(false, 403, "Forbidden");
        return;
      }
      if (!principalLease.claim(principal)) {
        done(false, 409, "Terminal session is assigned to another principal");
        return;
      }
      done(true);
    },
  });
  if (publicWorkerInstanceId) {
    wss.on("headers", (headers) => {
      // The gateway compares this authenticated internal handshake with the
      // generation it probed before assigning the seat. Browser-controlled
      // traffic never reaches this worker listener directly.
      headers.push(`${PUBLIC_WORKER_GENERATION_HEADER}: ${publicWorkerInstanceId}`);
    });
  }

  const publicWorkerLifecycle = publicSessionWorker.enabled
    ? new PublicSessionWorkerLifecycle({
      idleTimeoutMs: publicSessionWorker.idleTimeoutMs,
      absoluteTimeoutMs: publicSessionWorker.absoluteTimeoutMs,
      reconnectGraceMs: publicSessionWorker.reconnectGraceMs,
      onEnd: (reason) => {
        console.log(`[public-worker] ending disposable session: ${reason}`);
        for (const client of wss.clients) client.close(4408, `Public session ${reason}`);
        void shutdown(`public session ${reason}`);
      },
    })
    : undefined;

  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    const socketIp = request.socket.remoteAddress ?? "unknown";
    let lastWebScrollAt = 0;
    // The edge proxy overwrites this with the visitor's real IP; never trust a
    // client-supplied header (Caddy strips it from the request first).
    const clientIp = (request.headers["x-real-ip"] as string | undefined)?.trim() || socketIp;

    // Bind the current public session identity for permit gating + checkpoint
    // export authorization. A worker serves one tenant at a time.
    const connectedPrincipal = requestPrincipal(request);
    if (connectedPrincipal && connectedPrincipal.startsWith("public:")) {
      process.env.TERMINAL_RUNTIME_SESSION_ID = connectedPrincipal.slice("public:".length);
    } else {
      delete process.env.TERMINAL_RUNTIME_SESSION_ID;
    }

    console.log("[ws] client connected");
    publicWorkerLifecycle?.connectedClient();
    const previousClient = activeClient;
    activeClient = ws;
    if (previousClient && previousClient.readyState === WebSocket.OPEN) {
      // A dedicated application close code tells the old browser tab not to
      // reconnect automatically and steal the singleton session back.
      cancelPendingSelects();
      previousClient.close(
        CLIENT_REPLACED_CLOSE_CODE,
        "Replaced by a newer market-terminal client",
      );
    }
    sendToClient = (msg) => {
      if (activeClient !== ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* client gone */
      }
    };

    // Open the Market Map for this client (no-op if one is already opening/open).
    openMarket();
    // Reconnecting to an existing singleton panel must immediately replay its
    // current frame; otherwise the new client stays blank until another input or
    // render event happens to arrive.
    if (activePanel) pushFrame();

    ws.on("message", (raw) => {
      if (activeClient !== ws) return;
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "input": {
          publicWorkerLifecycle?.touch();
          web.sendInput(String(msg.data ?? ""));
          pushFrame(); // ensure a frame after state mutation
          break;
        }
        case "resize": {
          const c = Number(msg.cols);
          const r = Number(msg.rows);
          if (Number.isFinite(c) && c > 0) cols = c;
          if (Number.isFinite(r) && r > 0) web.webTui.terminal.rows = r;
          pushFrame();
          break;
        }
        case "command":
          publicWorkerLifecycle?.touch();
          // Open a panel by name. "market" with args opens a ticker, e.g. {args:"NKE"}.
          if (msg.name === "market") openMarket(typeof msg.args === "string" ? msg.args : "");
          recordServerCheckpointEvent(checkpointEventLog, "command", {
            name: String(msg.name ?? "").slice(0, 32),
            ...(typeof msg.args === "string" ? { args: msg.args.slice(0, 64) } : {}),
          });
          break;
        case "select_response": {
          publicWorkerLifecycle?.touch();
          const id = String(msg.id ?? "");
          const pending = pendingSelects.get(id);
          if (pending) {
            pendingSelects.delete(id);
            pending.resolve(msg.cancelled ? undefined : msg.value);
          }
          break;
        }
        case "web_action": {
          publicWorkerLifecycle?.touch();
          const isScrollAction =
            typeof msg.data === "object" &&
            msg.data !== null &&
            (msg.data as { action?: unknown }).action === "scroll";
          const now = Date.now();
          // High-resolution trackpads can emit dozens of wheel events per
          // second. Silently throttle them here as a server-side backstop so a
          // legitimate scroll gesture cannot exhaust the public-demo budget.
          if (isScrollAction && now - lastWebScrollAt < 500) break;

          let inputs: string[] | undefined;
          try {
            const rawState =
              typeof activePanel?.debugState === "function"
                ? activePanel.debugState()
                : undefined;
            const result = resolveWebAction(msg.data, rawState);
            if (Array.isArray(result)) inputs = result;
          } catch {
            // Defensive: any unexpected exception is swallowed.
          }
          if (!inputs) break;
          for (const input of inputs) web.sendInput(input);
          if (isScrollAction) lastWebScrollAt = now;
          pushFrame();
          break;
        }
        default:
          break;
      }
    });

    ws.on("close", () => {
      console.log("[ws] client disconnected");
      delete process.env.TERMINAL_RUNTIME_SESSION_ID;
      if (activeClient !== ws) return;
      activeClient = null;
      sendToClient = () => {};
      publicWorkerLifecycle?.disconnectedClient();
      // Reject any pending selects so they don't leak.
      cancelPendingSelects();
    });

    ws.on("error", (err) => console.warn("[ws] error:", err.message));
  });

  /** Open (or reopen) a panel via the real session command. `args` may be a ticker. */
  function openMarket(args = ""): void {
    console.log("[market] openMarket:", args || "(map)", "panelOpening=", panelOpening, "activePanel=", !!activePanel, "session=", !!session);
    if (panelOpening || activePanel) return; // one panel at a time
    if (!session) return;
    panelOpening = true;
    // session.prompt("/market [args]") runs the extension command, which calls
    // ctx.ui.custom(...) -> our shim captures the panel. The promise resolves
    // when the user closes the panel (Q/Esc).
    const cmd = args ? `/market ${args}` : "/market";
    session
      .prompt(cmd)
      .catch((err) => console.error("[market] command error:", err instanceof Error ? err.message : String(err)))
      .finally(() => {
        panelOpening = false;
        sendToClient({ type: "closed" });
      });
  }

  // ── Boot + shutdown ─────────────────────────────────────────────────────
  bootSession()
    .then((s) => {
      session = s;
      sessionBootState = "ready";
      // A browser can connect before the agent session finishes booting. Its
      // first openMarket() call is then a no-op, so retry once the session exists.
      if (wss.clients.size > 0) openMarket();
    })
    .catch((err) => {
      sessionBootState = "failed";
      console.error("[server] FAILED to boot agent session:", err instanceof Error ? err.stack ?? err.message : err);
      if (process.env.NODE_ENV === "production") {
        console.error("[server] Fatal production startup failure; exiting.");
        wss.close();
        server.close(() => process.exit(1));
        return;
      }
      console.error("[server] Research is unavailable; fix the configuration and restart.");
    });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] shutting down (${signal})...`);
    publicWorkerLifecycle?.dispose();
    const forceExit = setTimeout(() => process.exit(1), 30_000);
    forceExit.unref();
    for (const client of wss.clients) client.close(1012, "Server shutting down");
    wss.close();
    try {
      await session?.abort();
    } catch {
      /* ignore abort failures during shutdown */
    }
    try {
      session?.dispose();
    } catch {
      /* ignore disposal failures during shutdown */
    }
    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
}
