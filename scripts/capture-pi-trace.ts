/**
 * Conformance trace capture — Stage 0 of the browser-session migration.
 *
 * Boots a REAL AgentSession (the same path as server/index.ts) with:
 *   - MARKET_MODEL_PROVIDER=conformance  → deterministic mock model
 *     (server/conformance-mock-model.ts, registered via agent-config.ts)
 *   - UNBROWSER_MCP_URL=<mock endpoint>  → deterministic MCP fixture
 *     (scripts/conformance/mock-mcp-server.ts)
 *   - MARKET_MOCK_MONDAY=1               → deterministic quote fixtures
 *
 * Runs the canonical research scenario and records a versioned JSONL trace
 * (shared/conformance-trace.ts) that later becomes the conformance contract
 * for the browser adapter:
 *
 *   /market AAPL → J (BRIEF, settles complete) → K (WHY, settles complete)
 *   → J again, cancel with C (settles cancelled) → q (close)
 *
 * No model key and no network are required. The trace is deterministic in
 * behavior: same scenario → same tool sequence, job transitions, canvas
 * mutations, and usage accounting.
 *
 * Usage:  npx tsx scripts/capture-pi-trace.ts [--out tests/fixtures/pi-trace-v1.jsonl]
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { assertMarketAgentTools, createAgentModelRuntime, MARKET_AGENT_TOOLS } from "../server/agent-config.js";
import { createWebUi, type Panel } from "../server/web-ui.js";
import {
  boundedTracePayload,
  CONFORMANCE_TRACE_VERSION,
  type ConformanceTraceEvent,
} from "../shared/conformance-trace.js";
import { startMockMcpServer } from "./conformance/mock-mcp-server.js";

const CWD = path.resolve(process.env.MARKET_ROOT?.trim() || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const CAPTURE_VERSION = "1";

type State = Record<string, unknown> | undefined;

class TraceRecorder {
  private events: ConformanceTraceEvent[] = [];
  private seq = 0;
  private lastStateJson: string | undefined;

  constructor(private readonly scenario: string) {}

  private next(kind: ConformanceTraceEvent["kind"], payload: Record<string, unknown>): void {
    this.seq += 1;
    this.events.push({
      version: CONFORMANCE_TRACE_VERSION,
      seq: this.seq,
      ts: Date.now(),
      kind,
      payload: boundedTracePayload(kind, payload),
    });
  }

  meta(extra: Record<string, unknown>): void {
    this.next("meta", {
      captureVersion: CAPTURE_VERSION,
      scenario: this.scenario,
      model: "conformance/conformance-model-v1",
      env: {
        MARKET_MOCK_MONDAY: process.env.MARKET_MOCK_MONDAY ?? "",
        MARKET_RESEARCH_CONCURRENCY: process.env.MARKET_RESEARCH_CONCURRENCY ?? "",
        MARKET_PRECACHE_ENABLED: process.env.MARKET_PRECACHE_ENABLED ?? "",
        UNBROWSER_MCP_URL: "(mock endpoint)",
      },
      cwd: CWD,
      capturedAt: Date.now(),
      ...extra,
    });
  }

  command(name: string, args: string): void {
    this.next("command", { name, args });
  }

  input(data: string): void {
    this.next("input", { data });
  }

  sessionEvent(type: string, payload: Record<string, unknown>): void {
    this.next("session_event", { type, ...payload });
  }

  panel(opened: boolean): void {
    this.next("panel", { opened });
  }

  /** Record a state snapshot only when it changed (bounded size). */
  state(snapshot: State): void {
    if (!snapshot) return;
    const json = JSON.stringify(snapshot);
    if (json === this.lastStateJson) return;
    this.lastStateJson = json;
    this.next("state", snapshot);
  }

  usage(stats: unknown): void {
    this.next("usage", { stats });
  }

  archive(entries: unknown): void {
    this.next("archive", { entries });
  }

  settle(outcome: string, contextLabel: string | undefined): void {
    this.next("settle", { outcome, contextLabel });
  }

  text(): string {
    return this.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  }
}

function researchDebugState(snapshot: State): { research?: Record<string, unknown>; researchQueue?: unknown[]; recentResearch?: unknown[] } {
  return {
    research: snapshot && typeof snapshot.research === "object" ? snapshot.research as Record<string, unknown> : undefined,
    researchQueue: Array.isArray(snapshot?.researchQueue) ? snapshot.researchQueue as unknown[] : undefined,
    recentResearch: Array.isArray(snapshot?.recentResearch) ? snapshot.recentResearch as unknown[] : undefined,
  };
}

/**
 * Every research job visible in a panel state snapshot, deduplicated by id.
 * The extension keeps the settled job in `research` (currentResearchJob) and
 * mirrors recently settled jobs into `recentResearch` (30s window) — so an
 * outcome is observable through either field (plus the active queue).
 */
function visibleResearchJobs(snapshot: State): Array<Record<string, unknown>> {
  const { research, researchQueue, recentResearch } = researchDebugState(snapshot);
  const jobs = new Map<string, Record<string, unknown>>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const job = value as Record<string, unknown>;
    const id = String(job.id ?? "");
    if (id && !jobs.has(id)) jobs.set(id, job);
  };
  collect(research);
  for (const job of researchQueue ?? []) collect(job);
  for (const job of recentResearch ?? []) collect(job);
  return [...jobs.values()];
}

/** True when any visible job settled with `outcome` (optionally scoped by contextLabel). */
function hasSettledJob(snapshot: State, outcome: string, contextLabel?: string): boolean {
  return visibleResearchJobs(snapshot).some((job) =>
    job.outcome === outcome && (contextLabel === undefined || job.contextLabel === contextLabel),
  );
}

function waitFor(
  label: string,
  poll: () => boolean,
  timeoutMs = 120_000,
  intervalMs = 200,
  onTimeout?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let done = false;
      try {
        done = poll();
      } catch {
        done = false;
      }
      if (done) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        onTimeout?.();
        reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`));
      }
    }, intervalMs);
  });
}

async function main(): Promise<void> {
  const outArg = process.argv.findIndex((arg) => arg === "--out");
  const outPath = path.resolve(outArg >= 0 ? process.argv[outArg + 1] ?? "" : "tests/fixtures/pi-trace-v1.jsonl");
  if (!outPath) throw new Error("--out requires a path");

  const scenario = "ticker-brief-why-cancel-close";
  const recorder = new TraceRecorder(scenario);

  // ── Deterministic environment ─────────────────────────────────────────────
  const mockMcp = await startMockMcpServer();
  const dataDir = await mkdtemp(os.tmpdir(), "fin-terminal-trace-");
  process.env.MARKET_MODEL_PROVIDER = "conformance";
  process.env.MARKET_MODEL_ID = "conformance-model-v1";
  process.env.UNBROWSER_MCP_URL = mockMcp.endpoint;
  process.env.MARKET_MOCK_MONDAY = "1";
  process.env.MARKET_PRECACHE_ENABLED = "0";
  process.env.MARKET_RESEARCH_CONCURRENCY = "1";
  process.env.MARKET_DATA_DIR = dataDir;
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";

  recorder.meta({ dataDir: "(tmp)", outPath });

  let panel: Panel | null = null;
  const web = createWebUi({
    onPanel: (p) => {
      panel = p;
      recorder.panel(Boolean(p));
      recorder.state(panel?.debugState?.());
    },
    onRenderRequest: () => recorder.state(panel?.debugState?.()),
    onNotify: (message, level) => recorder.sessionEvent("notify", { level, message }),
    onSelect: async () => undefined,
  });

  // ── Boot the real session ─────────────────────────────────────────────────
  const agentDir = getAgentDir();
  const { modelRuntime, model } = await createAgentModelRuntime(agentDir);
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir });
  await loader.reload();

  let session: AgentSession | undefined;
  const unsubscribe = (() => {
    let handler: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    return {
      attach(s: AgentSession): void {
        handler = (event) => {
          const type = String(event.type);
          if (type === "agent_end") {
            const messages = Array.isArray(event.messages) ? event.messages : [];
            recorder.sessionEvent(type, { messageCount: messages.length });
          } else {
            recorder.sessionEvent(type, {});
          }
        };
        s.subscribe(handler);
      },
      detach(): void {
        handler = undefined;
      },
    };
  })();

  try {
    const created = await createAgentSession({
      cwd: CWD,
      agentDir,
      modelRuntime,
      ...(model ? { model } : {}),
      noTools: "builtin",
      tools: [...MARKET_AGENT_TOOLS],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(CWD),
    });
    if (created.extensionsResult.errors.length) {
      throw new Error(`Extension load errors: ${created.extensionsResult.errors.join(" | ")}`);
    }
    assertMarketAgentTools(created.session);
    await created.session.bindExtensions({
      uiContext: web.ui,
      mode: "tui",
      commandContextActions: web.commandContextActions,
    });
    session = created.session;
    unsubscribe.attach(session);
    console.log("[capture] session ready");
  } catch (error) {
    await mockMcp.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  try {
    // ── Scenario ────────────────────────────────────────────────────────────
    recorder.command("market", "AAPL");
    // The prompt promise resolves only when the panel closes (q); drive the
    // panel via inputs and await closure at the end.
    const panelClosed = session!.prompt("/market AAPL")
      .catch((error) => {
        console.error("[capture] /market command error:", error instanceof Error ? error.message : String(error));
      })
      .then(() => undefined);

    // Phase 0: panel opens with a deterministic (mock-Monday) quote.
    await waitFor("panel open", () => panel !== null, 60_000);
    await waitFor("quote sync", () => {
      const state = panel?.debugState?.();
      return Boolean(state && (state as { hasQuote?: boolean }).hasQuote);
    }, 60_000);
    recorder.state(panel?.debugState?.());

    // Probe: "?" toggles help; if status does not change, input never reaches
    // the panel and the research phases below cannot be diagnosed.
    web.sendInput("?");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const probeState = panel?.debugState?.() as { status?: string } | undefined;
    console.error("[capture] probe status:", probeState?.status);
    web.sendInput("?");

    // Phase 1: J → BRIEF → complete
    recorder.input("j");
    web.sendInput("j");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const jState = panel?.debugState?.() as { status?: string; research?: Record<string, unknown>; researchQueue?: unknown[] } | undefined;
    console.error("[capture] post-J status:", jState?.status, "| research:", JSON.stringify(jState?.research), "| queue:", JSON.stringify(jState?.researchQueue));
    await waitFor("BRIEF completion", () => {
      const snapshot = panel?.debugState?.();
      return hasSettledJob(snapshot, "complete", "AAPL BRIEF");
    }, 45_000, 200, () => {
      const state = panel?.debugState?.();
      console.error("[capture] BRIEF timeout state:", JSON.stringify(researchDebugState(state), null, 2).slice(0, 4000));
      console.error("[capture] BRIEF timeout full state:", JSON.stringify(state, null, 2).slice(0, 8000));
    });
    recorder.state(panel?.debugState?.());
    recorder.usage(session?.getSessionStats());
    recorder.settle("complete", "AAPL BRIEF");
    console.log("[capture] BRIEF complete");

    // Phase 2: K → WHY → complete
    recorder.input("k");
    web.sendInput("k");
    await waitFor("WHY completion", () => {
      const snapshot = panel?.debugState?.();
      return hasSettledJob(snapshot, "complete", "AAPL WHY");
    }, 120_000);
    recorder.state(panel?.debugState?.());
    recorder.usage(session?.getSessionStats());
    recorder.settle("complete", "AAPL WHY");
    console.log("[capture] WHY complete");

    // Phase 3: J again, cancel while running → cancelled
    recorder.input("j");
    web.sendInput("j");
    // A completed BRIEF was archived in phase 1, so J first shows the cache
    // decision prompt (extension defaults promptForCache=true). F = refresh
    // forces a fresh dispatch so C has a running job to cancel.
    await waitFor("cache decision or dispatch", () => {
      const snapshot = panel?.debugState?.() as { cacheDecision?: unknown; research?: Record<string, unknown> } | undefined;
      return Boolean(snapshot?.cacheDecision) || Boolean(snapshot?.research && (snapshot.research.phase === "dispatched" || snapshot.research.phase === "running"));
    }, 30_000);
    const afterJ = panel?.debugState?.() as { cacheDecision?: unknown; research?: Record<string, unknown> } | undefined;
    if (afterJ?.cacheDecision) {
      console.error("[capture] cache decision shown; pressing F to refresh");
      recorder.input("f");
      web.sendInput("f");
    }
    await waitFor("research dispatch", () => {
      const { research } = researchDebugState(panel?.debugState?.());
      return Boolean(research && (research.phase === "dispatched" || research.phase === "running"));
    }, 60_000);
    recorder.input("c");
    web.sendInput("c");
    await waitFor("cancel settle", () => {
      const snapshot = panel?.debugState?.();
      return hasSettledJob(snapshot, "cancelled");
    }, 60_000);
    recorder.state(panel?.debugState?.());
    recorder.settle("cancelled", "AAPL BRIEF (cancelled)");
    console.log("[capture] cancel settled");

    // Phase 4: close
    recorder.input("q");
    web.sendInput("q");
    await panelClosed;
    await waitFor("panel close", () => panel === null, 10_000);
    recorder.state(panel?.debugState?.());

    // Archive summary (bounded: entry count + ids + outcomes).
    try {
      const archivePath = path.join(dataDir, "market-research-archive.json");
      const { readFile } = await import("node:fs/promises");
      const archive = JSON.parse(await readFile(archivePath, "utf8"));
      recorder.archive({
        entryCount: Array.isArray(archive.entries) ? archive.entries.length : 0,
        ids: Array.isArray(archive.entries) ? archive.entries.map((e: { archiveId?: string }) => e.archiveId) : [],
      });
    } catch {
      recorder.archive({ entryCount: 0, note: "archive not readable in tmp data dir" });
    }
  } finally {
    try {
      await session?.abort();
    } catch {
      /* best-effort */
    }
    try {
      await session?.dispose();
    } catch {
      /* best-effort */
    }
    try {
      await mockMcp.close();
    } catch {
      /* best-effort */
    }
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, recorder.text(), "utf8");
  console.log(`[capture] trace written to ${outPath} (${recorder.events.length} events)`);
  // The SDK and mock server may leave handles behind; force a clean exit.
  process.exit(0);
}

async function mkdtemp(base: string, prefix: string): Promise<string> {
  const { mkdtemp: impl } = await import("node:fs/promises");
  return impl(path.join(base, prefix));
}

main().catch((error) => {
  console.error("[capture] FAILED:", error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
