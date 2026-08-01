/**
 * One-shot Pi process for a single concurrent market-research attempt.
 *
 * The parent owns scheduling, visible state, and persistence. This process
 * receives one versioned IPC run message, starts a worker-mode extension
 * command, and exits after Pi settles. The extension emits sequenced canvas
 * and progress events directly over the IPC channel.
 */

import path from "node:path";
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
  type WorkerRunMessage,
} from "./research-worker-protocol.js";

const CWD = path.resolve(process.env.MARKET_ROOT?.trim() || process.cwd());
const RUN_TIMEOUT_MS = 10 * 60_000;
const DISPATCH_TIMEOUT_MS = 60_000;

let session: AgentSession | undefined;
let activeRun: WorkerRunMessage | undefined;
let cancellationRequested = false;
let bootstrapSequence = 0;
let runDispatched = false;

function sendBootstrapEvent(
  run: WorkerRunMessage,
  type: "fatal" | "settled",
  payload: { error?: string; outcome?: "cancelled" },
): void {
  if (typeof process.send !== "function") return;
  if (type === "fatal") {
    process.send({
      version: WORKER_PROTOCOL_VERSION,
      type,
      jobId: run.jobId,
      attemptId: run.attemptId,
      sequence: bootstrapSequence++,
      error: payload.error || "Research worker failed to start",
    });
    return;
  }
  process.send({
    version: WORKER_PROTOCOL_VERSION,
    type,
    jobId: run.jobId,
    attemptId: run.attemptId,
    sequence: bootstrapSequence++,
    outcome: payload.outcome || "cancelled",
  });
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

async function waitForSettlement(activeSession: AgentSession): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let completed = false;
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
    }, RUN_TIMEOUT_MS);
    timeout.unref();
    const dispatchTimeout = setTimeout(() => {
      finish(() => reject(new Error("Research worker did not start an agent turn within 60 seconds")));
    }, DISPATCH_TIMEOUT_MS);
    dispatchTimeout.unref();
    unsubscribe = activeSession.subscribe((event) => {
      if (event.type === "agent_start") {
        clearTimeout(dispatchTimeout);
        return;
      }
      if (event.type !== "agent_settled") return;
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

async function shutdown(): Promise<void> {
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
    sendBootstrapEvent(run, "settled", { outcome: "cancelled" });
    return;
  }

  session = await createWorkerSession();
  if (cancellationRequested) {
    sendBootstrapEvent(run, "settled", { outcome: "cancelled" });
    return;
  }

  await session.prompt(`/market-worker-run ${encodedRunMessage(run)}`);
  runDispatched = true;
  await waitForSettlement(session);
}

main()
  .catch(async (error) => {
    process.exitCode = 1;
    if (activeRun && !runDispatched) {
      sendBootstrapEvent(activeRun, "fatal", {
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    } else {
      await abortDispatchedFailure();
    }
  })
  .finally(() => {
    void shutdown();
  });
