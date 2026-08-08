/**
 * One-shot Pi process for a single concurrent market-research attempt.
 *
 * The parent owns scheduling, visible state, and persistence. This process
 * receives one versioned IPC run message, starts a worker-mode extension
 * command, and exits after Pi settles. The extension emits sequenced canvas
 * and progress events directly over the IPC channel.
 *
 * For paired pre-cache runs, the worker is gated by a per-run token limit:
 * before each provider turn, total usage + context estimate + model max
 * output is compared against the limit, and the turn is aborted if it would
 * exceed. Interactive jobs are unaffected.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
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
import { createWebUi } from "./web-ui.js";
import {
  isParentMessage,
  WORKER_PROTOCOL_VERSION,
  type WorkerFatalEvent,
  type WorkerRunMessage,
  type WorkerSettledEvent,
} from "./research-worker-protocol.js";
import { wouldExceedTokenLimit } from "../shared/research-precache-ledger.js";
import { setResearchWorkerUsageCollector, type ResearchWorkerUsage } from "../shared/research-worker-usage.js";

const CWD = path.resolve(process.env.MARKET_ROOT?.trim() || process.cwd());
const RUN_TIMEOUT_MS = 10 * 60_000;
const DISPATCH_TIMEOUT_MS = 60_000;

let session: AgentSession | undefined;
let activeRun: WorkerRunMessage | undefined;
let cancellationRequested = false;
let bootstrapSequence = 0;
let runDispatched = false;

/**
 * Runtime failures can race extension-owned IPC events after dispatch. Use a
 * terminal sentinel sequence so the coordinator accepts exactly one fatal
 * event regardless of how many lower-sequence progress events were emitted.
 */
const RUNTIME_FATAL_SEQUENCE = Number.MAX_SAFE_INTEGER;

/** Redact credentials, opaque identifiers, and URLs before crossing IPC. */
export function safeResearchWorkerFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = raw
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(
      /(authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(?:sk|pk|sess|key|token)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[opaque]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return safe || "Research worker failed after dispatch";
}

/** Build the bounded terminal event used when the worker main loop rejects. */
export function makeRuntimeFatalEvent(run: WorkerRunMessage, error: unknown): WorkerFatalEvent {
  return {
    version: WORKER_PROTOCOL_VERSION,
    type: "fatal",
    jobId: run.jobId,
    attemptId: run.attemptId,
    sequence: RUNTIME_FATAL_SEQUENCE,
    error: safeResearchWorkerFailure(error),
  };
}

/** Best-effort bounded IPC flush before abort/disposal closes the channel. */
async function sendTerminalEvent(event: WorkerFatalEvent | WorkerSettledEvent): Promise<void> {
  if (typeof process.send !== "function") return;
  await new Promise<void>((resolve) => {
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 250);
    try {
      process.send!(event, () => finish());
    } catch {
      finish();
    }
  });
}

function makeSettledCancellationEvent(run: WorkerRunMessage): WorkerSettledEvent {
  return {
    version: WORKER_PROTOCOL_VERSION,
    type: "settled",
    jobId: run.jobId,
    attemptId: run.attemptId,
    sequence: bootstrapSequence++,
    outcome: "cancelled",
  };
}

async function sendBootstrapEvent(
  run: WorkerRunMessage,
  type: "fatal" | "settled",
  payload: { error?: string } = {},
): Promise<void> {
  if (type === "fatal") {
    await sendTerminalEvent({
      version: WORKER_PROTOCOL_VERSION,
      type,
      jobId: run.jobId,
      attemptId: run.attemptId,
      sequence: bootstrapSequence++,
      error: payload.error || "Research worker failed to start",
    });
    return;
  }
  await sendTerminalEvent(makeSettledCancellationEvent(run));
}

function encodedRunMessage(run: WorkerRunMessage): string {
  return Buffer.from(JSON.stringify(run), "utf8").toString("base64url");
}

function waitForRunMessage(): Promise<WorkerRunMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Research worker did not receive a run message")), 30_000);
    timeout.unref();
    const onMessage = (raw: unknown) => {
      if (!isParentMessage(raw)) return;
      if (raw.type === "cancel") return;
      clearTimeout(timeout);
      process.off("message", onMessage);
      resolve(raw);
    };
    process.on("message", onMessage);
    process.once("disconnect", () => {
      clearTimeout(timeout);
      reject(new Error("Research worker parent disconnected before dispatch"));
    });
  });
}

function installCancellationListener(): void {
  process.on("message", (raw: unknown) => {
    if (!isParentMessage(raw) || raw.type !== "cancel" || !activeRun) return;
    if (raw.jobId !== activeRun.jobId || raw.attemptId !== activeRun.attemptId) return;
    cancellationRequested = true;
    void session?.abort();
  });
}

async function createWorkerSession(): Promise<AgentSession> {
  validateUnbrowserRuntime();
  const agentDir = getAgentDir();
  const { modelRuntime, model } = await createAgentModelRuntime(agentDir);
  const loader = new DefaultResourceLoader({ cwd: CWD, agentDir });
  await loader.reload();

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
  if (created.extensionsResult.errors.length > 0) {
    created.session.dispose();
    throw new Error(`Market extension failed to load: ${created.extensionsResult.errors.map((error) => String(error)).join(" | ")}`);
  }
  try {
    assertMarketAgentTools(created.session);
  } catch (error) {
    created.session.dispose();
    throw error;
  }

  const ui = createWebUi({
    onPanel: () => {},
    onRenderRequest: () => {},
    onNotify: () => {},
    onSelect: async () => undefined,
  });
  await created.session.bindExtensions({
    uiContext: ui.ui,
    mode: "tui",
    commandContextActions: ui.commandContextActions,
  });
  return created.session;
}

export interface ResearchSettlementOptions {
  runTimeoutMs?: number;
  dispatchTimeoutMs?: number;
}

export async function waitForSettlement(
  activeSession: AgentSession,
  options: ResearchSettlementOptions = {},
): Promise<void> {
  const runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
  const dispatchTimeoutMs = options.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    let completed = false;
    let researchTurnStarted = false;
    let unsubscribe = () => {};
    let unsubscribeError = () => {};
    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      clearTimeout(dispatchTimeout);
      unsubscribe();
      unsubscribeError();
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("Research worker exceeded its 10-minute runtime limit")));
    }, runTimeoutMs);
    const dispatchTimeout = setTimeout(() => {
      finish(() => reject(new Error("Research worker did not start an agent turn within 60 seconds")));
    }, dispatchTimeoutMs);
    unsubscribe = activeSession.subscribe((event) => {
      if (event.type === "agent_start") {
        researchTurnStarted = true;
        clearTimeout(dispatchTimeout);
        return;
      }
      if (event.type !== "agent_settled" || !researchTurnStarted) return;
      // Pi runs extension event handlers before subscriber callbacks; yield one
      // turn so the last IPC canvas/settled event is flushed before disposal.
      finish(() => setTimeout(resolve, 0));
    });
    unsubscribeError = activeSession.extensionRunner.onError((error) => {
      if (error.event !== "send_user_message") return;
      finish(() => reject(new Error(error.error)));
    });
  });
}

/**
 * Install a per-turn token guard for paired pre-cache jobs. Subscribes
 * to turn_start events; before each provider turn, checks whether the
 * projected total tokens would exceed the token limit and aborts if so.
 * Does nothing for interactive (non-pre-cache) jobs or when no limit is set.
 */
export function installTokenGuard(
  activeSession: AgentSession,
  tokenLimit: number,
): () => void {
  let guardTriggered = false;
  const unsubscribe = activeSession.subscribe((event) => {
    if (event.type !== "turn_start") return;
    if (cancellationRequested) return;
    if (guardTriggered) {
      void activeSession.abort();
      return;
    }
    try {
      const stats = activeSession.getSessionStats();
      const usedTotal = stats.tokens.total;
      const contextEstimate = activeSession.getContextUsage()?.tokens;
      const modelMaxTokens = activeSession.model?.maxTokens;
      if (
        contextEstimate === null
        || contextEstimate === undefined
        || modelMaxTokens === undefined
        || wouldExceedTokenLimit({ usedTotal, contextEstimate, modelMaxTokens, tokenLimit })
      ) {
        guardTriggered = true;
        void activeSession.abort();
      }
    } catch {
      // Unknown accounting cannot safely authorize another paid provider turn.
      guardTriggered = true;
      void activeSession.abort();
    }
  });
  return unsubscribe;
}

/**
 * Collect Pi-reported session usage stats.
 * Stats shape: { tokens: { input, output, cacheRead, cacheWrite, total }, cost: number }
 */
export function collectSessionUsage(
  activeSession: AgentSession,
): ResearchWorkerUsage | undefined {
  try {
    const stats = activeSession.getSessionStats();
    const t = stats.tokens as Record<string, unknown>;
    const tokenCount = (value: unknown): number | undefined => typeof value === "number"
      && Number.isFinite(value) && value >= 0 && Number.isInteger(value) ? value : undefined;
    const inputTokens = tokenCount(t.input);
    const outputTokens = tokenCount(t.output);
    const cacheReadTokens = tokenCount(t.cacheRead);
    const cacheWriteTokens = tokenCount(t.cacheWrite);
    const reportedTotal = tokenCount(t.total);
    if (inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined
      || cacheWriteTokens === undefined || reportedTotal === undefined) return undefined;
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    if (reportedTotal !== totalTokens) return undefined;
    const cost = typeof stats.cost === "number" && Number.isFinite(stats.cost) && stats.cost >= 0 ? stats.cost : undefined;
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, ...(cost !== undefined ? { cost } : {}) };
  } catch {
    return undefined;
  }
}

export async function dispatchAndWaitForSettlement(
  activeSession: AgentSession,
  command: string,
  options: ResearchSettlementOptions = {},
  onCommandDispatched: () => void = () => {},
): Promise<void> {
  const settlement = waitForSettlement(activeSession, options);
  // Subscribe before dispatch: a queued follow-up may start and settle before
  // the command prompt's promise continuation runs.
  onCommandDispatched();
  await activeSession.prompt(command);
  await settlement;
}

async function shutdown(): Promise<void> {
  setResearchWorkerUsageCollector(undefined);
  try {
    session?.dispose();
  } catch {
    // Best-effort cleanup; parent has already received a terminal event.
  }
  if (process.connected) process.disconnect();
}

async function abortDispatchedFailure(): Promise<void> {
  if (!session || !runDispatched) return;
  try {
    await session.abort();
  } catch {
    // The coordinator has a hard deadline and will fence a child that cannot
    // acknowledge its own abort.
  }
}

async function main(): Promise<void> {
  const run = await waitForRunMessage();
  activeRun = run;
  installCancellationListener();
  if (cancellationRequested) {
    await sendBootstrapEvent(run, "settled");
    return;
  }

  session = await createWorkerSession();
  if (cancellationRequested) {
    await sendBootstrapEvent(run, "settled");
    return;
  }

  // Install token guard for paired pre-cache jobs with a token limit.
  if (run.request.origin === "precache" && typeof run.request.tokenLimit === "number") {
    installTokenGuard(session, run.request.tokenLimit);
  }

  // Register across native ESM / jiti extension caches before the turn starts.
  setResearchWorkerUsageCollector(() => session ? collectSessionUsage(session) : undefined);

  await dispatchAndWaitForSettlement(
    session,
    `/market-worker-run ${encodedRunMessage(run)}`,
    {},
    () => { runDispatched = true; },
  );
}

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMainModule) {
  main()
    .catch(async (error) => {
      process.exitCode = 1;
      if (activeRun && !runDispatched) {
        await sendBootstrapEvent(activeRun, "fatal", {
          error: safeResearchWorkerFailure(error),
        });
      } else {
        if (activeRun) await sendTerminalEvent(makeRuntimeFatalEvent(activeRun, error));
        await abortDispatchedFailure();
      }
    })
    .finally(() => {
      void shutdown();
    });
}
