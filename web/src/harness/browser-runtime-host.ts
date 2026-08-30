/**
 * Working BrowserExtensionHost runtime (stage 2b).
 *
 * Upgrades the stage-2a compile-only host (extension-loadability.ts) into a
 * REAL Pi API implementation for the isolated research worker:
 *
 *   registerTool    → collects { name, label, description, parameters, execute }
 *   registerCommand → collects command handlers (args-string + ctx)
 *   on              → registers extension event handlers (agent_*, tool_execution_*,
 *                     session_start/tree, message_end, ...)
 *   sendUserMessage → session.runTurn(text, abortSignal) — fire-and-forget like
 *                     Pi's follow-up dispatch; the session's own events drive
 *                     the extension state machine
 *   exec            → throws "not available in browser worker"
 *   appendEntry     → optional host callback (workers never persist)
 *   getFlag         → env lookup (MARKET_* flags read process.env)
 *   setActiveTools  → no-op (alpha sends every registered tool)
 *   ui              → shim: custom throws in the worker; onTerminalInput stores;
 *                     notify/select/etc are safe no-ops
 *   context         → worker ctx shim: isIdle() = !turnActive, abort() aborts
 *                     the active turn, sessionManager is a stub branch reader
 *
 * The host is deliberately typed with LOCAL structural interfaces — no
 * @earendil-works imports in web/src/harness (browser bundles must not pull
 * the SDK runtime). The extension's default export is invoked through a cast,
 * mirroring extension-loadability.ts.
 */

export interface BrowserRuntimeTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute(
		toolCallId: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: unknown) => void) | undefined,
		ctx: unknown,
	): Promise<{ content: Array<{ type: string; text: string }> | string; details?: unknown }>;
}

export interface BrowserRuntimeCommand {
	description?: string;
	handler(args: string, ctx: unknown): Promise<void> | void;
}

type EventHandler = (event: Record<string, unknown>, ctx: unknown) => unknown;

/** The `ctx.ui` surface the extension touches (worker-safe subset). */
export interface BrowserRuntimeUi {
	custom(factory: unknown, options?: Record<string, unknown>): Promise<unknown>;
	onTerminalInput(cb: (data: string) => unknown): () => void;
	notify(message: string, type?: string): void;
	select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
	input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
	setStatus(key: string, text: string | undefined): void;
	setWorkingMessage(message?: string): void;
	setWorkingVisible(visible: boolean): void;
	setWorkingIndicator(options?: unknown): void;
	setHiddenThinkingLabel(label?: string): void;
	setWidget(key: string, content: unknown, options?: unknown): void;
}

/** Worker command/event context (ExtensionCommandContext subset the extension uses). */
export interface BrowserRuntimeContext {
	mode: "tui";
	hasUI: boolean;
	cwd: string;
	ui: BrowserRuntimeUi;
	isIdle(): boolean;
	isProjectTrusted(): boolean;
	hasPendingMessages(): boolean;
	abort(): void;
	signal: AbortSignal | undefined;
	shutdown(): void;
	getContextUsage(): unknown;
	compact(options?: unknown): void;
	getSystemPrompt(): string;
	getSystemPromptOptions(): unknown;
	waitForIdle(): Promise<void>;
	newSession(): Promise<{ cancelled: boolean }>;
	fork(): Promise<{ cancelled: boolean }>;
	navigateTree(): Promise<{ cancelled: boolean }>;
	switchSession(): Promise<{ cancelled: boolean }>;
	reload(): Promise<void>;
	sessionManager: {
		getBranch(): Array<{ type: string; message?: { role?: string; toolName?: string; details?: unknown } }>;
	};
	modelRegistry: Record<string, never>;
	model: undefined;
	scopedModels: readonly unknown[];
}

export interface BrowserRuntimeHost {
	/** Tools registered by the extension (feeds the agent session tool list). */
	readonly tools: Map<string, BrowserRuntimeTool>;
	/** Commands registered by the extension (market-worker-run dispatches here). */
	readonly commands: Map<string, BrowserRuntimeCommand>;
	/** Registered event handlers, keyed by event name. */
	readonly eventHandlers: Map<string, EventHandler[]>;
	/** True while a sendUserMessage turn is running (ctx.isIdle()). */
	turnActive: boolean;
	/** Route an extension event to the registered handlers (try/catch per handler). */
	fireEvent(event: Record<string, unknown>, ctx: BrowserRuntimeContext): void;
	/** Await async extension lifecycle handlers (used during browser bootstrap/teardown). */
	fireEventAsync(event: Record<string, unknown>, ctx: BrowserRuntimeContext): Promise<void>;
	/** Dispatch a user message into the attached agent session (fire-and-forget). */
	sendUserMessage(content: string | unknown[], options?: { deliverAs?: string }): void;
	/** Attach the agent session the core built from the registered tools. */
	attachSession(session: { runTurn(text: string, signal?: AbortSignal): Promise<string> }, abort: AbortController): void;
	/** Build the worker command/event context bound to the abort controller. */
	createContext(abort: AbortController): BrowserRuntimeContext;
	/** Optional error surface for turn rejections the extension cannot see. */
	onTurnError?: (error: unknown) => void;
}

export interface BrowserRuntimeHostOptions {
	ui?: BrowserRuntimeUi;
	cwd?: string;
	hasUI?: boolean;
	/** Durable session entries restored before the extension receives session_start. */
	sessionBranch?: Array<{ type: string; customType?: string; data?: unknown }>;
	/** Optional persistence hook for session-local custom entries. */
	appendEntry?: (type: string, data: Record<string, unknown>) => void;
}

function noOpUi(): BrowserRuntimeUi {
	return {
		custom: () => Promise.reject(new Error("ui.custom is not available in the isolated research worker")),
		onTerminalInput: () => () => {},
		notify: () => {},
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
	};
}

export function createBrowserRuntimeHost(options: BrowserRuntimeHostOptions = {}): BrowserRuntimeHost {
	const tools = new Map<string, BrowserRuntimeTool>();
	const commands = new Map<string, BrowserRuntimeCommand>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const ui = options.ui ?? noOpUi();
	const host: BrowserRuntimeHost = {
		tools,
		commands,
		eventHandlers,
		turnActive: false,
		fireEvent(event, ctx) {
			for (const handler of eventHandlers.get(event.type as string) ?? []) {
				try {
					handler(event, ctx);
				} catch (error) {
					// Pi's extensionRunner also isolates handler errors; the worker
					// must keep running (the settle path never depends on a throw).
					console.error(`[worker host] ${String(event.type)} handler error:`, error);
				}
			}
		},
		async fireEventAsync(event, ctx) {
			for (const handler of eventHandlers.get(event.type as string) ?? []) {
				try {
					await handler(event, ctx);
				} catch (error) {
					console.error(`[browser host] ${String(event.type)} handler error:`, error);
				}
			}
		},
		sendUserMessage(content, _options) {
			const session = attached.session;
			const abort = attached.abort;
			if (!session) {
				host.onTurnError?.(new Error("sendUserMessage called before the agent session was attached"));
				return;
			}
			const text = typeof content === "string" ? content : JSON.stringify(content);
			host.turnActive = true;
			void session.runTurn(text, abort.signal).catch((error: unknown) => {
				// Aborts are expected (cancel); everything else is surfaced to
				// the core so it can emit a fatal if the extension did not settle.
				host.onTurnError?.(error);
			});
		},
		attachSession(session, abort) {
			attached.session = session;
			attached.abort = abort;
		},
		createContext(abort) {
			return {
				mode: "tui",
				hasUI: options.hasUI ?? true,
				cwd: options.cwd ?? "/browser",
				ui,
				isIdle: () => !host.turnActive,
				isProjectTrusted: () => true,
				hasPendingMessages: () => false,
				abort: () => abort.abort(),
				signal: abort.signal,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: () => {},
				getSystemPrompt: () => "",
				getSystemPromptOptions: () => ({}),
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: true }),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: async () => {},
				sessionManager: { getBranch: () => options.sessionBranch ?? [] },
				modelRegistry: {},
				model: undefined,
				scopedModels: [],
			};
		},
		onTurnError: undefined,
	};
	const attached: { session?: { runTurn(text: string, signal?: AbortSignal): Promise<string> }; abort: AbortController } = {
		abort: new AbortController(),
	};

	// ── Pi API surface (cast at the call site, same as extension-loadability) ──
	(host as unknown as Record<string, unknown>).registerTool = (tool: {
		name?: string;
		label?: string;
		description?: string;
		parameters?: unknown;
		execute?: BrowserRuntimeTool["execute"];
	}) => {
		if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") {
			throw new Error(`registerTool: invalid tool registration (name=${String(tool?.name)})`);
		}
		tools.set(tool.name, {
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters ?? {},
			execute: tool.execute,
		});
	};
	(host as unknown as Record<string, unknown>).registerCommand = (name: string, spec: BrowserRuntimeCommand) => {
		if (!name || !spec || typeof spec.handler !== "function") {
			throw new Error(`registerCommand: invalid command registration (name=${String(name)})`);
		}
		commands.set(name, spec);
	};
	(host as unknown as Record<string, unknown>).on = (event: string, handler: EventHandler) => {
		if (!event || typeof handler !== "function") throw new Error(`on: invalid event registration (${String(event)})`);
		const list = eventHandlers.get(event) ?? [];
		list.push(handler);
		eventHandlers.set(event, list);
	};
	(host as unknown as Record<string, unknown>).exec = async () => {
		throw new Error("exec: the unbrowser CLI is not available in the browser research worker");
	};
	(host as unknown as Record<string, unknown>).appendEntry = (type: string, data: Record<string, unknown>) => {
		options.appendEntry?.(type, data);
	};
	(host as unknown as Record<string, unknown>).getFlag = (name: string) => {
		try {
			const raw = (process.env as Record<string, string | undefined>)[name];
			return raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";
		} catch {
			return false;
		}
	};
	(host as unknown as Record<string, unknown>).setActiveTools = () => {};
	(host as unknown as Record<string, unknown>).ui = ui;
	(host as unknown as Record<string, unknown>).registerShortcut = () => {};
	(host as unknown as Record<string, unknown>).registerFlag = () => {};

	return host;
}
