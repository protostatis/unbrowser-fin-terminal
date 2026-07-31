/**
 * SPIKE — prove the in-process Pi SDK can host the canonical market-terminal
 * extension, bind our UI, open /market, render, and drive a real J-triggered
 * research job (agent_start → market_technicals/discover → market_canvas
 * stage=partial → live canvas update).
 *
 * Not part of the shipping server. Run: npx tsx server/spike-sdk.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ExtensionUIContext,
  type ExtensionCommandContextActions,
} from "@earendil-works/pi-coding-agent";
import webTheme from "./theme.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CWD = path.resolve(__dirname, "..");

// ── Minimal HarnessUI: captures the component, forwards input, logs calls ────
type Panel = { render(w: number): string[]; handleInput(d: string): void; debugState?(): unknown; setCanvas?(c: unknown): void; setResearchJob?(j: unknown): void };
let activePanel: Panel | null = null;
let inputHandler: ((data: string) => unknown) | null = null;
let onRenderRequest: (() => void) | null = null;
let canvasUpdates = 0;
let agentStartSeen = false;
const toolEventsSeen = new Set<string>();

const webTui = {
  requestRender() { onRenderRequest?.(); },
  terminal: { rows: 35 },
};

const uiBase: Record<string, unknown> = {
  theme: webTheme,
  custom<T>(_factory: (...args: unknown[]) => Panel, _opts?: unknown): Promise<T> {
    return new Promise<T>((resolve) => {
      const done = (result: T) => resolve(result);
      // factory signature: (tui, theme, keybindings, done) => Component
      const panel = _factory(webTui as never, webTheme as never, undefined as never, done as never);
      activePanel = panel;
      console.log("[ui] custom() panel captured:", panel?.constructor?.name ?? typeof panel);
      onRenderRequest?.();
    });
  },
  onTerminalInput(handler: (data: string) => unknown): () => void {
    inputHandler = handler;
    return () => { inputHandler = null; };
  },
  notify(message: string, type?: string) { console.log(`[ui:notify:${type ?? "info"}] ${message}`); },
  async select(title: string, options: string[]) {
    console.log(`[ui:select] ${title} -> defaulting to first: ${options[0]}`);
    return options[0];
  },
};
// Proxy: no-op for any other ExtensionUIContext method the session might call.
const ui = new Proxy(uiBase, {
  get(target, prop) {
    if (prop in target) return target[prop as string];
    if (prop === "theme") return webTheme;
    return () => {};
  },
}) as unknown as ExtensionUIContext;

const commandContextActions: ExtensionCommandContextActions = {
  waitForIdle: async () => {},
  newSession: async () => ({ cancelled: false }),
  fork: async () => ({ cancelled: false }),
  navigateTree: async () => ({ cancelled: false }),
  switchSession: async () => ({ cancelled: false }),
  reload: async () => {},
} as unknown as ExtensionCommandContextActions;

// ── Boot the session ─────────────────────────────────────────────────────────
async function main() {
  console.log("[spike] cwd:", CWD);
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: getAgentDir() });
  await loader.reload();

  console.log("[spike] creating agent session...");
  const { session, extensionsResult } = await createAgentSession({
    cwd: CWD,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(CWD),
  });
  const discovered = extensionsResult.extensions.map((e) => {
    const si = e.sourceInfo as { path?: string; label?: string } | undefined;
    return si?.path ?? si?.label ?? "(unknown)";
  });
  console.log("[spike] discovered extensions:", discovered);
  console.log("[spike] session created. model:", session.model ? `${session.model.provider}/${session.model.id}` : "(none)");
  if (extensionsResult.errors.length) console.warn("[spike] extension load errors:", extensionsResult.errors);

  // Observe every event.
  const seenEvents = new Set<string>();
  session.subscribe((event) => {
    seenEvents.add(event.type);
    if (event.type === "agent_start") { agentStartSeen = true; console.log("[event] agent_start"); }
    if (event.type === "agent_settled") console.log("[event] agent_settled");
    if (event.type === "tool_execution_start") {
      const name = (event as { toolName: string }).toolName;
      toolEventsSeen.add(name);
      console.log("[event] tool_start:", name);
    }
    if (event.type === "tool_execution_end") console.log("[event] tool_end:", (event as { toolName: string }).toolName);
  });

  // Whenever the extension requests a render, log the panel state + canvas count.
  onRenderRequest = () => {
    if (!activePanel) return;
    const rows = activePanel.render(120);
    const state = typeof activePanel.debugState === "function" ? activePanel.debugState() as Record<string, unknown> : undefined;
    const research = state?.research as { outcome?: string; activity?: string; publishedBlocks?: number } | undefined;
    console.log(`[render] ${rows.length} rows | screen=${state?.screen ?? state?.mode} | research=${research ? `${research.outcome}/${research.activity} blocks=${research.publishedBlocks}` : "none"}`);
  };

  await session.bindExtensions({ uiContext: ui, mode: "tui", commandContextActions });
  console.log("[spike] extensions bound.");

  // Track canvas updates via the panel's setCanvas hook.
  const wrapPanel = () => {
    if (!activePanel) return;
    const orig = activePanel.setCanvas?.bind(activePanel);
    if (orig) {
      activePanel.setCanvas = (c: unknown) => {
        canvasUpdates++;
        const canvas = c as { stage?: string; blocks?: unknown[] };
        console.log(`[canvas #${canvasUpdates}] stage=${canvas.stage} blocks=${canvas.blocks?.length ?? "?"}`);
        orig(c);
      };
    }
  };

  // Run /market in the background (it blocks until the panel closes).
  console.log("[spike] running /market ...");
  const marketPromise = session.prompt("/market");

  // Wait for the panel to appear.
  await waitFor(() => activePanel !== null, 5000);
  wrapPanel();
  await sleep(500);
  onRenderRequest?.(); // initial render

  // 1. Verify input -> render: press 'd' to switch screens.
  console.log("\n[spike] pressing 'd' (switch screen) ...");
  inputHandler?.("d");
  await sleep(300);
  onRenderRequest?.();

  // 2. Verify research linkage: press 'j' to start a real research job.
  console.log("\n[spike] pressing 'j' (start research) — observing agent activity for 25s ...");
  inputHandler?.("j");
  await sleep(25_000);

  console.log("\n=== SPIKE RESULT ===");
  console.log("agent_start fired:", agentStartSeen);
  console.log("tool events seen:", [...toolEventsSeen]);
  console.log("canvas updates:", canvasUpdates);
  console.log("all event types seen:", [...seenEvents].sort());
  const ok = agentStartSeen && canvasUpdates > 0;
  console.log(ok ? "\n✅ LINKAGE PROVEN: J triggers a real agent run that publishes canvas updates." : "\n⚠️  Linkage NOT fully proven — see logs above.");

  // Clean up: close the panel by sending 'q', then dispose.
  try { inputHandler?.("q"); } catch {}
  try { await marketPromise; } catch {}
  session.dispose();
  process.exit(ok ? 0 : 2);
}

// ── helpers ──────────────────────────────────────────────────────────────────
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function waitFor(cond: () => boolean, ms: number) {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = () => { if (cond()) resolve(); else if (Date.now() - start > ms) reject(new Error("timeout")); else setTimeout(tick, 50); };
    tick();
  });
}
function observe(ms: number) {
  const tools = new Set<string>();
  let agentStart = false;
  return new Promise<{ tools: Set<string>; agentStart: boolean }>((resolve) => {
    const done = () => resolve({ tools, agentStart });
    // Re-check seenEvents each tick by reading console-captured state is hard;
    // instead instrument via a polling check of a shared marker.
    const start = Date.now();
    const interval = setInterval(() => {
      // No direct access to session.subscribe here; the subscriber above logs.
      // We approximate completion by canvas updates / timeout.
      if (canvasUpdates > 0 && Date.now() - start > 8000) { clearInterval(interval); done(); }
      else if (Date.now() - start > ms) { clearInterval(interval); done(); }
    }, 500);
  });
}

main().catch((err) => {
  console.error("[spike] FAILED:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
