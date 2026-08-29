/**
 * Isolated research worker core (stage 2b) — runtime kernel shared by the
 * browser worker entry (web/src/harness/research-worker.browser.ts) and the
 * Node differential test (tests/browser-research-worker.test.ts).
 *
 * The core runs ONE worker attempt:
 *
 *   1. Applies the env into the `process` singleton and installs
 *      `process.send` → the injected `emit` callback (the extension's
 *      `emitWorkerEvent` gate is `typeof process.send === "function"`).
 *   2. Dynamically imports the canonical extension (.pi/extensions/
 *      market-terminal.ts) — dynamic so the module-top-level reads
 *      (`isResearchWorkerProcess`, `PUBLIC_MAX_RESEARCH_RUNS`) happen AFTER
 *      the env is set. Under the browser bundle `process` resolves to the
 *      mutable shim; under Node (tsx) it resolves to the real Node process.
 *   3. Builds the working BrowserExtensionHost runtime, attaches a
 *      BrowserAgentSession built from the extension's registered tools, and
 *      bridges session lifecycle events (agent_start/agent_end/agent_settled,
 *      tool_execution_start/end) into the extension's pi.on handlers.
 *   4. Dispatches the `market-worker-run` command with the base64url run
 *      message — the same path the Node worker uses; `pumpResearchQueue`
 *      drives the agent turn(s) via sendUserMessage → session.runTurn.
 *   5. Waits for the extension's terminal IPC event (settled/fatal), then
 *      returns. The worker entry closes itself; the coordinator's grace timer
 *      is the backstop.
 *
 * No `self`/`window`/`Worker` references here — the entry owns the browser
 * surface. The `process` global is typed via a local ambient declaration so
 * this file typechecks under web/tsconfig (no @types/node) while resolving to
 * the real Node process under tsx and to the vite `define` shim in the bundle.
 */

import { BrowserAgentSession, type BrowserSessionEvent } from "./browser-agent-session.js";
import { createBrowserRuntimeHost, type BrowserRuntimeContext } from "./browser-runtime-host.js";
import { createBrowserKernelPorts } from "./browser-ports.js";
import { isMarketResearchToolName, MARKET_RESEARCH_TOOL_NAMES } from "../../../shared/research-tool-policy.js";

/** Local structural `process` subset (vite define points it at the shim in the browser bundle). */
declare const process: {
	env: Record<string, string | undefined>;
	send: ((msg: unknown, cb?: () => void) => void) | undefined;
	pid?: number;
};

/** Local structural WorkerRunMessage (server/research-worker-protocol stays Node-only). */
export interface WorkerRunMessageLike {
	version: 1;
	type: "run";
	jobId: string;
	attemptId: string;
	request: {
		symbol: string;
		question: string;
		chartScope: "day" | "week" | "month" | "year" | "max";
		researchKey: string;
		intent: "brief" | "why";
		contextLabel: string;
		pairedTarget?: unknown;
		origin?: "precache";
		tokenLimit?: number;
	};
}

export const WORKER_PROTOCOL_VERSION = 1;

const DEFAULT_SETTLE_TIMEOUT_MS = 10 * 60_000;

/** Base64url-encode a run message the way server/research-worker.ts does. */
export function encodeRunMessage(run: WorkerRunMessageLike): string {
	const bytes = new TextEncoder().encode(JSON.stringify(run));
	let binary = "";
	// Chunked: String.fromCharCode(...spread) hits argument-count limits above
	// ~64k elements; run messages may approach the 64KB IPC cap.
	const CHUNK = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface RunResearchAttemptOptions {
	/** Environment applied to `process.env` BEFORE the extension module executes. */
	env: Record<string, string>;
	/** Terminal IPC sink — the extension's emitWorkerEvent lands here. */
	emit: (msg: unknown) => void;
	/** External cancellation (coordinator cancel message). */
	signal?: AbortSignal;
	/** Injectable fetch for the OpenRouter endpoint (tests). */
	fetchImpl?: typeof fetch;
	/** Overrides env.BROWSER_MODEL. */
	model?: string;
	/** Overrides env.BROWSER_API_KEY. */
	apiKey?: string;
	/** System prompt for the agent session (defaults to the worker constant). */
	systemPrompt?: string;
	/** How long to wait for the extension's terminal event before emitting a core fatal. */
	settleTimeoutMs?: number;
}

export const DEFAULT_WORKER_SYSTEM_PROMPT =
	"You are a market research worker for the open terminal. Use only the supplied tools: " +
	"publish deterministic technicals with market_technicals, discover candidate public sources with " +
	"market_discover, extract evidence with market_extract, and publish structured canvases with " +
	"market_canvas. Follow the workflow described in the user instructions.";

/** Serialize an extension tool result into the STRING the model sees (Pi's ToolResultMessage content). */
export function serializeToolResult(result: { content: Array<{ type: string; text: string }> | string; details?: unknown }): string {
	const parts = Array.isArray(result.content) ? result.content.map((part) => part.text ?? "").filter((text) => text.length > 0) : [result.content];
	if (parts.length > 0) return parts.join("\n");
	try {
		return JSON.stringify(result.details ?? {});
	} catch {
		return "{}";
	}
}

/** Bounded, redaction-lite fatal error text (mirrors research-worker.ts's safeResearchWorkerFailure shape). */
export function safeWorkerFailure(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const safe = raw
		.replace(/https?:\/\/\S+/gi, "[url]")
		.replace(/(authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 400);
	return safe || "Research worker failed after dispatch";
}

/**
 * Run one isolated research attempt end to end. Resolves once the extension
 * has emitted a terminal event (settled/fatal) or the attempt was aborted.
 */
export async function runResearchAttempt(run: WorkerRunMessageLike, options: RunResearchAttemptOptions): Promise<void> {
	const { env, emit } = options;
	const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;

	// ── 1. Environment + IPC bridge BEFORE the extension module executes. ──
	let terminalEmitted = false;
	const emitWrapped = (msg: unknown): void => {
		const rec = msg as { type?: string } | null | undefined;
		if (rec && (rec.type === "settled" || rec.type === "fatal")) terminalEmitted = true;
		emit(msg);
	};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) process.env[key] = value;
	}
	process.env.MARKET_RESEARCH_WORKER = "1";
	process.send = (msg, cb) => {
		emitWrapped(msg);
		cb?.();
	};

	// ── 2. Boot the extension (dynamic import: env must be applied first). ──
	const host = createBrowserRuntimeHost();
	host.onTurnError = (error: unknown) => {
		// Turn rejections are expected on abort; anything else is logged (the
		// extension still settles the job via the agent_settled event).
		if (!(error instanceof Error && error.name === "AbortError")) console.error("[research-worker] agent turn error:", error);
	};
  const extensionModule = await import("../../../.pi/extensions/market-terminal.js");
  const extension = (extensionModule as { default: (pi: unknown) => void }).default;
  const configure = (extensionModule as {
    configureMarketTerminalRuntime?: (
      ports: ReturnType<typeof createBrowserKernelPorts>,
      options?: { workerProcess?: boolean; browserSession?: boolean },
    ) => void;
  }).configureMarketTerminalRuntime;
  if (process.pid === 0) {
    configure?.(createBrowserKernelPorts({
      apiKey: options.apiKey ?? process.env.BROWSER_API_KEY,
      model: options.model ?? process.env.BROWSER_MODEL,
      unbrowserEndpoint: process.env.UNBROWSER_MCP_URL,
      workerProcess: true,
      fetchImpl: options.fetchImpl,
    }), { workerProcess: true });
  }
  extension(host as unknown as Parameters<typeof extension>[0]);

	// ── 3. Session wiring. ──
	const controller = new AbortController();
	const externalSignal = options.signal;
	const abortFromExternal = () => controller.abort();
	if (externalSignal?.aborted) controller.abort();
	else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

	const ctx = host.createContext(controller);
	// Fresh attempt: reset module-scope worker state exactly like Pi's session
	// bootstrap (restoreSessionState resets jobs and clears workerBridge).
	host.fireEvent({ type: "session_start", reason: "startup", systemPrompt: options.systemPrompt ?? DEFAULT_WORKER_SYSTEM_PROMPT, systemPromptOptions: {} }, ctx);
	host.fireEvent({ type: "session_tree", cwd: "/browser" }, ctx);

	const model = options.model ?? process.env.BROWSER_MODEL;
	if (!model) throw new Error("BROWSER_MODEL is required to boot the research worker");
	const apiKey = options.apiKey ?? process.env.BROWSER_API_KEY;
	if (!apiKey) throw new Error("BROWSER_API_KEY is required to boot the research worker");

	const registeredResearchTools = [...host.tools.values()].filter((tool) => isMarketResearchToolName(tool.name));
	const registeredNames = new Set(registeredResearchTools.map((tool) => tool.name));
	if (registeredNames.size !== MARKET_RESEARCH_TOOL_NAMES.length || MARKET_RESEARCH_TOOL_NAMES.some((name) => !registeredNames.has(name))) {
		throw new Error("Browser research tool contract is incomplete");
	}
	const tools = registeredResearchTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));

	const session = new BrowserAgentSession({
		apiKey,
		model,
		systemPrompt: options.systemPrompt ?? DEFAULT_WORKER_SYSTEM_PROMPT,
		tools,
		toolExecutor: {
			async execute(toolName, args, signal, toolCallId) {
				const tool = host.tools.get(toolName);
				if (!tool) {
					return { content: `Tool error (${toolName}): not registered in the browser worker`, isError: true };
				}
				try {
					const result = await tool.execute(toolCallId ?? "", args, signal, undefined, ctx);
					return { content: serializeToolResult(result), isError: false };
				} catch (error) {
					return { content: error instanceof Error ? error.message : String(error), isError: true };
				}
			},
		},
		fetchImpl: options.fetchImpl,
		onEvent: (event: BrowserSessionEvent) => {
			// isIdle() must be false during a turn (pumpResearchQueue re-entry
			// guard) and true again BEFORE the extension's agent_settled handler
			// runs (it schedules the next pump).
			if (event.type === "agent_start") host.turnActive = true;
			if (event.type === "agent_settled") host.turnActive = false;
			host.fireEvent(event as unknown as Record<string, unknown>, ctx);
		},
	});
	host.attachSession(session, controller);

	// ── 4. Dispatch the run message through the extension command. ──
	const emitFatal = (error: unknown): void => {
		emitWrapped({
			version: WORKER_PROTOCOL_VERSION,
			type: "fatal",
			jobId: run.jobId,
			attemptId: run.attemptId,
			// Terminal sentinel: always strictly greater than any extension-emitted
			// sequence (mirrors server/research-worker.ts RUNTIME_FATAL_SEQUENCE).
			sequence: Number.MAX_SAFE_INTEGER,
			error: safeWorkerFailure(error),
		});
	};
	const handler = host.commands.get("market-worker-run");
	if (!handler) {
		emitFatal(new Error("market-worker-run command was not registered by the extension"));
		return;
	}
	try {
		await handler.handler(encodeRunMessage(run), ctx);
	} catch (error) {
		// Invalid payload / double-run / dispatch failure: the extension could
		// not create a job, so no settled event will follow. Emit fatal now.
		emitFatal(error);
		return;
	}

	// ── 5. Wait for the terminal event (or abort / core timeout). ──
	await waitForTerminal(
		settleTimeoutMs,
		() => terminalEmitted,
		controller.signal,
		emitFatal,
		() => {
			if (terminalEmitted) return;
			emitWrapped({
				version: WORKER_PROTOCOL_VERSION,
				type: "settled",
				jobId: run.jobId,
				attemptId: run.attemptId,
				sequence: Number.MAX_SAFE_INTEGER,
				outcome: "cancelled",
			});
		},
	);
}

function waitForTerminal(
	timeoutMs: number,
	isTerminal: () => boolean,
	signal: AbortSignal,
	emitFatal: (error: unknown) => void,
	emitCancelled: () => void,
): Promise<void> {
	if (isTerminal()) return Promise.resolve();
	if (signal.aborted) {
		emitCancelled();
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		let finished = false;
		const finish = (): void => {
			if (finished) return;
			finished = true;
			clearInterval(poll);
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const onAbort = (): void => {
			emitCancelled();
			finish();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		const poll = setInterval(() => {
			if (isTerminal()) finish();
		}, 50);
		const timeout = setTimeout(() => {
			emitFatal(new Error(`Research worker exceeded its ${Math.round(timeoutMs / 1000)}s settle deadline`));
			finish();
		}, timeoutMs);
	});
}

/**
 * Worker-message state machine for the browser entry: waits for the run
 * message, dispatches it, and handles cancel. Testable with a direct
 * getRunMessage/emit pair (no Worker API).
 */
export interface BrowserResearchWorkerRuntime {
	/** Wait for the run message and execute the attempt to its terminal event. */
	run(): Promise<void>;
	/** Forward a coordinator cancel (aborts the active turn; fence is parent-side). */
	handleCancel(): void;
}

export interface BrowserResearchWorkerRuntimeOptions {
	env: Record<string, string>;
	emit: (msg: unknown) => void;
	getRunMessage: () => Promise<WorkerRunMessageLike>;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	model?: string;
	apiKey?: string;
	settleTimeoutMs?: number;
}

export function createBrowserResearchWorkerRuntime(options: BrowserResearchWorkerRuntimeOptions): BrowserResearchWorkerRuntime {
	const controller = new AbortController();
	let cancelledBeforeRun = false;
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	return {
		async run(): Promise<void> {
			const run = await options.getRunMessage();
			if (cancelledBeforeRun || controller.signal.aborted) {
				// Cancelled before dispatch: settle cancelled with sequence 0
				// (mirrors research-worker.ts sendBootstrapEvent).
				options.emit({
					version: WORKER_PROTOCOL_VERSION,
					type: "settled",
					jobId: run.jobId,
					attemptId: run.attemptId,
					sequence: 0,
					outcome: "cancelled",
				});
				return;
			}
			await runResearchAttempt(run, {
				env: options.env,
				emit: options.emit,
				signal,
				fetchImpl: options.fetchImpl,
				model: options.model,
				apiKey: options.apiKey,
				settleTimeoutMs: options.settleTimeoutMs,
			});
		},
		handleCancel(): void {
			cancelledBeforeRun = true;
			controller.abort();
		},
	};
}
