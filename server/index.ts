/**
 * Market Terminal web backend — Express + WebSocket.
 *
 * Architecture: a REAL in-process Pi agent session (createAgentSession) hosts
 * the UNCHANGED `.pi/extensions/market-terminal.ts`. The session IS the
 * ExtensionAPI (agent, tools, events, pi.exec, pi.sendUserMessage, model/auth).
 * We only supply the UI surface (server/web-ui.ts) so the extension's
 * `ctx.ui.custom()` hands us the live panel, whose `render()` we convert
 * (ANSI→HTML) and stream to the browser. Research (J/K) runs the real agent in
 * the same process, so canvases flow live to the same panel.
 *
 * The extension file (.pi/extensions/market-terminal.ts) is never edited.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { ansiToHtml } from "./theme.js";
import { createWebUi, type Panel } from "./web-ui.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CWD = path.resolve(__dirname, "..");

// ==========================================================================
// 1. Connection state (single active web client; the session is a singleton)
// ==========================================================================

let activePanel: Panel | null = null;
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

// ==========================================================================
// 2. Create the REAL Pi agent session and bind our UI
// ==========================================================================

async function bootSession(): Promise<AgentSession> {
  console.log("[server] cwd:", CWD);
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: getAgentDir() });
  await loader.reload();

  console.log("[server] creating agent session...");
  const { session, extensionsResult } = await createAgentSession({
    cwd: CWD,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(CWD),
  });
  console.log(
    "[server] session ready. model:",
    session.model ? `${session.model.provider}/${session.model.id}` : "(none — research will fail until a model is configured)",
  );
  if (extensionsResult.errors.length) {
    console.warn("[server] extension load errors:", extensionsResult.errors);
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

const PORT = Number(process.env.PORT ?? 8787);
const server = app.listen(PORT, async () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});

// ==========================================================================
// 4. WebSocket — drive the panel
// ==========================================================================

let session: AgentSession | undefined;
let panelOpening = false;

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  console.log("[ws] client connected");
  sendToClient = (msg) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* client gone */
    }
  };

  // Open the Market Map for this client (no-op if one is already opening/open).
  openMarket();

  ws.on("message", (raw) => {
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
    // Reject any pending selects so they don't leak.
    for (const [, p] of pendingSelects) p.resolve(undefined);
    pendingSelects.clear();
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
  })
  .catch((err) => {
    console.error("[server] FAILED to boot agent session:", err instanceof Error ? err.stack ?? err.message : err);
    console.error("[server] Research will not work. Browsing still works only after a successful boot.");
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
