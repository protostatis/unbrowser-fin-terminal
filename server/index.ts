/**
 * Market Terminal web backend — Express + WebSocket.
 *
 * Architecture: a REAL in-process Pi agent session (createAgentSession) hosts
 * the canonical `.pi/extensions/market-terminal.ts`. The session IS the
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
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import express from "express";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CWD = path.resolve(__dirname, "..");

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const CLIENT_REPLACED_CLOSE_CODE = 4001;

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

// ==========================================================================
// 1. Connection state (single active web client; the session is a singleton)
// ==========================================================================

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
      const state = typeof activePanel.debugState === "function" ? activePanel.debugState() : undefined;
      sendToClient({ type: "frame", rows, width: cols, rows_count: rows.length, state });
    } catch (err) {
      console.warn("[render] error:", err instanceof Error ? err.message : String(err));
    }
  });
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

// ==========================================================================
// 2. Create the REAL Pi agent session and bind our UI
// ==========================================================================

async function bootSession(): Promise<AgentSession> {
  console.log("[server] cwd:", CWD);
  validateUnbrowserRuntime();
  const agentDir = getAgentDir();
  const { modelRuntime, model, config } = await createAgentModelRuntime(agentDir);
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
    sessionManager: SessionManager.inMemory(CWD),
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

// ==========================================================================
// 3. Express app — health + static frontend
// ==========================================================================

const app = express();
app.get("/api/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

const webDist = path.resolve(__dirname, "..", "dist-web");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
} else {
  app.get("/", (_req, res) =>
    res.type("html").send(
      `<!doctype html><meta charset="utf-8"><title>Market Terminal</title>` +
        `<body style="font-family:system-ui;background:#0b0e14;color:#c9d1d9;padding:2rem">` +
        `<h2>Frontend not built yet</h2><p>Run <code>npm run build</code> then reload.</p></body>`,
    ),
  );
}

const server = app.listen(PORT, HOST, async () => {
  console.log(`[server] Listening on http://${HOST}:${PORT}`);
});

// ==========================================================================
// 4. WebSocket — drive the panel
// ==========================================================================

let session: AgentSession | undefined;
let panelOpening = false;

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 64 * 1024,
  verifyClient: ({ req }, done) => {
    if (isAllowedWebSocketRequest(req)) {
      done(true);
      return;
    }
    console.warn("[ws] rejected connection with invalid or disallowed Origin");
    done(false, 403, "Forbidden");
  },
});

wss.on("connection", (ws: WebSocket) => {
  console.log("[ws] client connected");
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
    switch (msg.type) {
      case "input":
        web.sendInput(String(msg.data ?? ""));
        pushFrame(); // ensure a frame after state mutation
        break;
      case "resize": {
        const c = Number(msg.cols);
        const r = Number(msg.rows);
        if (Number.isFinite(c) && c > 0) cols = c;
        if (Number.isFinite(r) && r > 0) web.webTui.terminal.rows = r;
        pushFrame();
        break;
      }
      case "command":
        // Open a panel by name. "market" with args opens a ticker, e.g. {args:"NKE"}.
        if (msg.name === "market") openMarket(typeof msg.args === "string" ? msg.args : "");
        break;
      case "select_response": {
        const id = String(msg.id ?? "");
        const pending = pendingSelects.get(id);
        if (pending) {
          pendingSelects.delete(id);
          pending.resolve(msg.cancelled ? undefined : msg.value);
        }
        break;
      }
      default:
        break;
    }
  });

  ws.on("close", () => {
    console.log("[ws] client disconnected");
    if (activeClient !== ws) return;
    activeClient = null;
    sendToClient = () => {};
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

// ==========================================================================
// 5. Boot + shutdown
// ==========================================================================

bootSession()
  .then((s) => {
    session = s;
    // A browser can connect before the agent session finishes booting. Its
    // first openMarket() call is then a no-op, so retry once the session exists.
    if (wss.clients.size > 0) openMarket();
  })
  .catch((err) => {
    console.error("[server] FAILED to boot agent session:", err instanceof Error ? err.stack ?? err.message : err);
    if (process.env.NODE_ENV === "production") {
      console.error("[server] Fatal production startup failure; exiting.");
      wss.close();
      server.close(() => process.exit(1));
      return;
    }
    console.error("[server] Research is unavailable; fix the configuration and restart.");
  });

process.on("SIGINT", () => {
  console.log("[server] shutting down...");
  try {
    session?.dispose();
  } catch {
    /* ignore */
  }
  wss.close();
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => process.emit("SIGINT"));
