/**
 * Browser agent-session tool loop (stage 2a).
 *
 * Framework-free TypeScript port of the OpenRouter agent loop from
 * openrouter-agent-cli (MIT) — `_run_user_turn` / `_call_openrouter` /
 * `_compact_history` / `_execute_tool` in
 * openrouter_agent_cli/cli.py and `run_concurrent` in concurrent.py.
 *
 * No browser APIs beyond fetch/AbortSignal; runs under Node (tsx tests) and in
 * the browser bundle alike. API key is BYOK (memory only, never persisted).
 *
 * Deliberate deviations from cli.py (all cited inline):
 * - Permission policy is NOT ported: browser alpha auto-allows every
 *   registered tool (cli.py prompts via `_effective_policy_decision`).
 * - HTTP errors surface as the turn result text (status + truncated body)
 *   instead of cli.py's silent `return ""` (cli.py:2440-2444).
 * - Network errors propagate instead of being swallowed (cli.py:2445-2448).
 * - No retry/backoff for 429/5xx (cli.py utils.py:257-273) — alpha keeps
 *   request timing deterministic; the caller retries at a higher layer.
 * - `_limit_tool_result` uses generic JSON-object detection instead of
 *   cli.py's hardcoded 7-tool allowlist (cli.py:2300-2343).
 * - `maxDiscoverPerBatch: 0` / `maxDiscoverRounds: 0` disable those caps
 *   (cli.py clamps to 1..10 / 1..5).
 */

// cli.py:410-412
function truncateStr(text: string, limit: number): string {
	return text.length <= limit ? text : text.slice(0, limit) + "...";
}

// cli.py:55-59 (_TERMINAL_ESCAPE_RE + _strip_control_chars)
const TERMINAL_ESCAPE_RE =
	/(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]|\x9d[^\x07\x1b]*(?:\x07|\x1b\\)|\x9b[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f-\x9c\x9e-\x9f]+)/g;
function stripControlChars(text: string): string {
	return text.replace(TERMINAL_ESCAPE_RE, "");
}

// cli.py:425-431 (_message_content_as_text)
function messageContentAsText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (content === null || content === undefined) return "";
	return JSON.stringify(content);
}

// utils.py:18-33 (_decode_tool_arguments)
function decodeToolArguments(rawArgs: unknown): Record<string, unknown> {
	if (rawArgs === null || rawArgs === undefined) return {};
	if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) return rawArgs as Record<string, unknown>;
	if (typeof rawArgs === "string") {
		const value = rawArgs.trim();
		if (!value) return {};
		try {
			const decoded: unknown = JSON.parse(value);
			return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
				? (decoded as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}
	return {};
}

/** Wire-format tool call as OpenRouter emits it inside `message.tool_calls`. */
export interface BrowserToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/** OpenRouter chat-completions message (subset the session produces/reads). */
interface WireMessage {
	role?: string;
	content?: unknown;
	reasoning?: string;
	tool_calls?: BrowserToolCall[] | null;
	tool_call_id?: string;
}

export interface BrowserToolDefinition {
	name: string;
	description: string;
	/** JSON-schema-ish; TypeBox schemas are JSON-schema compatible (shallow passthrough). */
	parameters: unknown;
}

export interface BrowserToolExecutor {
	/**
	 * Execute one tool call. The session passes a signal that fires on
	 * `commandTimeoutMs` or when the user's `runTurn` signal aborts.
	 * `toolCallId` is the wire call id (stage 2b: forwarded to the extension's
	 * registered tool.execute so tool_execution events can correlate).
	 */
	execute(toolName: string, args: Record<string, unknown>, signal: AbortSignal, toolCallId?: string): Promise<{ content: string; isError?: boolean }>;
}

export interface BrowserSessionOptions {
	/** BYOK, memory only — never persisted. */
	apiKey: string;
	/** Any OpenRouter model id, e.g. "deepseek/deepseek-v4-flash-0731". */
	model: string;
	systemPrompt: string;
	tools: BrowserToolDefinition[];
	/** Injected tool executor (the extension's tools run through this). */
	toolExecutor: BrowserToolExecutor;
	/** Max model/tool iterations per user turn. Default 24 (cli.py:79). */
	maxTurns?: number;
	/** Default 1 — alpha serializes state-mutating tools (concurrent only for stateless discover batches). */
	maxConcurrency?: number;
	/** Reserved for the stage-3 persistence layer (cli.py _save_session trim, cli.py:683-711). */
	maxHistoryMessages?: number;
	/** Per-tool-call budget, passed to the executor via AbortSignal.timeout. Default 30_000. */
	commandTimeoutMs?: number;
	/** HTTP call budget. Default 60_000 (cli.py httpx timeout=60.0, cli.py:780). */
	requestTimeoutMs?: number;
	/** Auto-compact when estimated tokens exceed this. Default 12_000 (cli.py:1329). */
	compactThresholdTokens?: number;
	/** Messages kept verbatim after compaction. Default 10 (cli.py:82 CONTEXT_KEEP_TAIL). */
	compactKeepTail?: number;
	/** Tool result content cap. Default 8_000 (cli.py:85 MAX_TOOL_RESULT_CHARS). */
	maxToolResultChars?: number;
	/** Default https://openrouter.ai/api/v1/chat/completions */
	endpoint?: string;
	/** Injectable for tests. */
	fetchImpl?: typeof fetch;
	/** Send parallel_tool_calls:true. Default false (alpha). */
	parallelToolCalls?: boolean;
	/** Cap for discover calls per batch. Default 5; 0 disables the cap (alpha). */
	maxDiscoverPerBatch?: number;
	/** Cap for discover rounds per turn. Default 2; 0 disables the cap (alpha). */
	maxDiscoverRounds?: number;
	/** Optional diagnostic sink (cli.py `_log` lines are surfaced here). */
	onLog?: (line: string) => void;
	/** Optional lifecycle event sink (stage 2b worker wiring). */
	onEvent?: (event: BrowserSessionEvent) => void;
}

/**
 * Session lifecycle events (stage 2b) — the isolated research worker routes
 * these to the extension's `pi.on` handlers so the extension's research state
 * machine (runningResearchId, toolResearchJobs, job settling) runs exactly
 * like the Node worker mode.
 */
export type BrowserSessionEvent =
	| { type: "agent_start" }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean; result: unknown }
	| { type: "agent_end"; messages: Array<Record<string, unknown>> }
	| { type: "agent_settled" };

/**
 * Map an OpenRouter `finish_reason` to the Pi-style `stopReason` the extension
 * reads on stored assistant messages (agent_end handler checks
 * "error"|"aborted"|"length"|"stop"). Unknown/absent reasons default to
 * "stop": the model ended its response without a tool call.
 */
export function mapStopReason(finishReason: string | null | undefined, hasToolCalls: boolean): "stop" | "length" | "toolUse" | "error" | "aborted" {
	if (finishReason === "tool_calls" || (hasToolCalls && finishReason === null)) return "toolUse";
	if (finishReason === "length") return "length";
	if (finishReason === "error") return "error";
	if (finishReason === "aborted") return "aborted";
	return "stop";
}

export interface BrowserSessionStats {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export interface OpenRouterUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
}

interface OpenRouterChoice {
	message: WireMessage;
	finish_reason?: string | null;
}

interface OpenRouterResponse {
	choices?: OpenRouterChoice[] | null;
	usage?: OpenRouterUsage | null;
}

/** HTTP-level failure from the OpenRouter endpoint. */
export class OpenRouterHttpError extends Error {
	readonly status: number;
	constructor(status: number, detail: string) {
		super(`[openrouter] HTTP ${status}: ${detail}`);
		this.name = "OpenRouterHttpError";
		this.status = status;
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
	const error = new Error("The operation was aborted.");
	error.name = "AbortError";
	return error;
}

/**
 * cli.py:434-442 (_estimate_tokens): chars // 4 over message content plus
 * tool_calls name + arguments, floor at 1.
 */
export function estimateMessagesTokens(messages: Array<Record<string, unknown>>): number {
	let chars = 0;
	for (const message of messages) {
		chars += messageContentAsText(message).length;
		for (const tc of (message.tool_calls as BrowserToolCall[] | undefined) ?? []) {
			const fn = tc.function ?? ({} as BrowserToolCall["function"]);
			chars += String(fn.name ?? "").length;
			chars += String(fn.arguments ?? "").length;
		}
	}
	return Math.max(1, Math.floor(chars / 4));
}

/**
 * cli.py:689-711 (the tool-group preservation in `_save_session` trimming).
 * `tail` must be a suffix of `messages`. If the tail starts with a tool
 * result, expand backward to include the assistant `tool_calls` message (and
 * any of that group's tool results that were cut off), so a tool-call group is
 * never split. Non-tool tails are returned unchanged.
 */
export function preserveToolCallGroups(messages: Array<Record<string, unknown>>, tail: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	if (tail.length === 0) return [];
	const first = tail[0] as WireMessage;
	if (first.role !== "tool") return tail;
	const start = messages.length - tail.length;
	let idx = start - 1;
	while (idx >= 0 && (messages[idx] as WireMessage).role === "tool") idx -= 1;
	if (idx >= 0 && (messages[idx] as WireMessage).role === "assistant" && (messages[idx] as WireMessage).tool_calls) {
		return messages.slice(idx);
	}
	return tail;
}

/**
 * concurrent.py run_concurrent port: run tool handlers behind a concurrency
 * cap, results in input order; abort errors propagate, other errors become
 * `Tool error (name): ...` strings.
 */
async function runConcurrent(
	calls: Array<[string, Record<string, unknown>, string]>,
	handler: (toolName: string, args: Record<string, unknown>, toolCallId: string) => Promise<string>,
	maxConcurrency: number,
): Promise<string[]> {
	if (calls.length === 0) return [];
	const cap = Math.max(1, maxConcurrency);
	const results: string[] = new Array(calls.length);
	let nextIndex = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const i = nextIndex++;
			if (i >= calls.length) return;
			const [name, args, toolCallId] = calls[i];
			try {
				results[i] = await handler(name, args, toolCallId);
			} catch (error) {
				if (isAbortError(error)) throw error;
				results[i] = `Tool error (${name}): ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(cap, calls.length) }, () => worker()));
	return results;
}

export class BrowserAgentSession {
	/** System + history, OpenRouter wire format. */
	readonly messages: Array<Record<string, unknown>>;
	stats: BrowserSessionStats;

	private readonly options: Required<Pick<
		BrowserSessionOptions,
		| "apiKey" | "model" | "systemPrompt" | "tools" | "toolExecutor" | "maxTurns" | "maxConcurrency"
		| "maxHistoryMessages" | "commandTimeoutMs" | "requestTimeoutMs" | "compactThresholdTokens"
		| "compactKeepTail" | "maxToolResultChars" | "endpoint" | "parallelToolCalls"
		| "maxDiscoverPerBatch" | "maxDiscoverRounds"
	>> & Pick<BrowserSessionOptions, "fetchImpl" | "onLog" | "onEvent">;

	constructor(options: BrowserSessionOptions) {
		this.options = {
			apiKey: options.apiKey,
			model: options.model,
			systemPrompt: options.systemPrompt,
			tools: options.tools,
			toolExecutor: options.toolExecutor,
			maxTurns: options.maxTurns ?? 24,
			maxConcurrency: options.maxConcurrency ?? 1,
			maxHistoryMessages: options.maxHistoryMessages ?? 60,
			commandTimeoutMs: options.commandTimeoutMs ?? 30_000,
			requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
			compactThresholdTokens: options.compactThresholdTokens ?? 12_000,
			compactKeepTail: options.compactKeepTail ?? 10,
			maxToolResultChars: options.maxToolResultChars ?? 8_000,
			endpoint: options.endpoint ?? "https://openrouter.ai/api/v1/chat/completions",
			fetchImpl: options.fetchImpl,
			parallelToolCalls: options.parallelToolCalls ?? false,
			maxDiscoverPerBatch: options.maxDiscoverPerBatch ?? 5,
			maxDiscoverRounds: options.maxDiscoverRounds ?? 2,
			onLog: options.onLog,
			onEvent: options.onEvent,
		};
		this.messages = [{ role: "system", content: options.systemPrompt }];
		this.stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	}

	/**
	 * Run one user turn to completion (final assistant text). Returns "" when
	 * maxTurns is exhausted (cli.py:2668-2670). HTTP errors are surfaced as
	 * the returned text; network errors / aborts propagate.
	 *
	 * Lifecycle events (stage 2b): agent_start fires before the first provider
	 * call; tool_execution_start/end wrap each executor call; agent_end fires
	 * once the turn's transcript is final (messages include the final assistant
	 * message with its mapped stopReason); agent_settled ALWAYS fires — also on
	 * abort/error — so the worker's settle detection never deadlocks.
	 */
	async runTurn(userText: string, signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) throw abortError();
		this.messages.push({ role: "user", content: userText });
		let lastToolSignature: string | null = null;
		let repeatedCount = 0;
		let discoverRounds = 0;
		let startFired = false;
		let endFired = false;
		const fireEnd = (): void => {
			if (endFired) return;
			endFired = true;
			this.fireEvent({ type: "agent_end", messages: this.messages });
		};

		try {
			for (let turn = 0; turn < this.options.maxTurns; turn++) {
				if (signal?.aborted) throw abortError();
				if (!startFired) {
					startFired = true;
					this.fireEvent({ type: "agent_start" });
				}
				// cli.py:2433-2435 auto-compact before each model request.
				if (await this.compactHistory(false, signal)) {
					this.log("[context] Auto-compacted old history.");
				}

				let response: OpenRouterResponse;
				try {
					response = await this.callOpenRouter(this.messages, "auto", signal);
				} catch (error) {
					if (error instanceof OpenRouterHttpError) {
						// cli.py:2440-2444 logs and returns ""; deviation: the
						// surfaced message carries status + truncated body. The
						// stored assistant message carries stopReason "error" so
						// the extension's agent_end handler surfaces it.
						this.log(error.message);
						const failed: Record<string, unknown> = {
							role: "assistant",
							content: error.message,
							stopReason: "error",
						};
						this.messages.push(failed);
						fireEnd();
						return error.message;
					}
					throw error; // network errors / aborts propagate
				}
				// Injectable/test fetch implementations are allowed to resolve after
				// their signal fires. Do not execute a tool or issue another request
				// after cancellation in that case.
				if (signal?.aborted) throw abortError();

				const choice = response.choices?.[0];
				if (!choice) throw new Error("OpenRouter response missing choices[0]");
				const message = choice.message as Record<string, unknown>;
				const finishReason = choice.finish_reason ?? "";
				const toolCalls = (message.tool_calls as BrowserToolCall[] | null | undefined) ?? [];
				(message as Record<string, unknown>).stopReason = mapStopReason(finishReason, toolCalls.length > 0);
				this.messages.push(message);

				// cli.py:2456-2462 — final assistant text ends the turn.
				if (toolCalls.length === 0) {
					fireEnd();
					const text = String(message.content ?? message.reasoning ?? "");
					return text || `[empty response, finish_reason=${finishReason}]`;
				}

				// cli.py:2464-2478 — repetition guard (compare name + raw args).
				const signature = JSON.stringify(
					toolCalls.map((tc) => ({ name: tc.function?.name, args: tc.function?.arguments })),
				);
				if (signature === lastToolSignature) {
					repeatedCount += 1;
				} else {
					repeatedCount = 0;
					lastToolSignature = signature;
				}

				// cli.py:2480-2512 — after ONE repeat: nudge per pending call id,
				// force tool_choice:"none" once, fall back on failure.
				if (repeatedCount >= 1) {
					const nudge =
						"STOP. You repeated the same tool call without progress. " +
						"Do not call additional tools. Reply with a concise final answer.";
					toolCalls.forEach((tc, idx) => {
						const toolCallId = String(tc.id ?? `loop-${turn + 1}-${idx + 1}`);
						tc.id = toolCallId;
						this.messages.push({ role: "tool", tool_call_id: toolCallId, content: nudge });
					});
					let text = "";
					try {
						const forced = await this.callOpenRouter(this.messages, "none", signal);
						const forcedMessage = forced.choices?.[0]?.message;
						if (forcedMessage) {
							const forcedCalls = (forcedMessage.tool_calls as BrowserToolCall[] | null | undefined) ?? [];
							(forcedMessage as Record<string, unknown>).stopReason = mapStopReason(
								forced.choices?.[0]?.finish_reason ?? "",
								forcedCalls.length > 0,
							);
							text = String(forcedMessage.content ?? forcedMessage.reasoning ?? "");
							this.messages.push(forcedMessage as Record<string, unknown>);
						}
					} catch (error) {
						if (isAbortError(error)) throw error;
						text = "";
					}
					fireEnd();
					return text || "I got stuck in a tool loop and could not make progress.";
				}

				// cli.py:2514-2523 — decode args, canonicalize, ensure ids.
				const parsedCalls: Array<{ toolName: string; toolArgs: Record<string, unknown>; toolCallId: string; tc: BrowserToolCall }> = [];
				for (const [idx, tc] of toolCalls.entries()) {
					const fn = tc.function ?? ({} as BrowserToolCall["function"]);
					const toolName = String(fn.name ?? "").trim();
					const toolArgs = decodeToolArguments(fn.arguments);
					fn.arguments = JSON.stringify(toolArgs); // canonical compact form (cli.py:2520 separators=(",", ":"))
					const toolCallId = String(tc.id ?? `tc-${turn + 1}-${idx + 1}`);
					tc.id = toolCallId;
					parsedCalls.push({ toolName, toolArgs, toolCallId, tc });
				}

				// cli.py:2525-2554 — discover batch caps, never dropping call ids.
				const blockedCalls = new Map<string, string>();
				let discoverCount = 0;
				const maxDiscover = this.options.maxDiscoverPerBatch;
				for (const call of parsedCalls) {
					if (call.toolName !== "discover") continue;
					discoverCount += 1;
					if (maxDiscover > 0 && discoverCount > maxDiscover) {
						blockedCalls.set(call.toolCallId, `discover blocked: max_discover ${maxDiscover} exceeded`);
					}
				}
				if (maxDiscover > 0 && discoverCount > maxDiscover) {
					this.log(
						`[policy] discover calls ${discoverCount} > max_discover=${maxDiscover}; ` +
							"overflow calls were returned as blocked results",
					);
				}
				if (discoverCount > 0) {
					discoverRounds += 1;
					const maxRounds = this.options.maxDiscoverRounds;
					if (maxRounds > 0 && discoverRounds > maxRounds) {
						this.log(
							`[policy] discover rounds ${discoverRounds} > max_rounds=${maxRounds}; ` +
								"discover calls were returned as blocked results",
						);
						for (const call of parsedCalls) {
							if (call.toolName === "discover") {
								blockedCalls.set(
									call.toolCallId,
									`discover blocked: max_rounds ${maxRounds} exceeded (round ${discoverRounds})`,
								);
							}
						}
					}
				}

				const executableCalls = parsedCalls.filter((call) => !blockedCalls.has(call.toolCallId));

				// cli.py:2560-2580 — only all-discover batches may run concurrently;
				// stateful tools serialize (alpha default maxConcurrency=1).
				const canConcurrent =
					executableCalls.length > 1 && executableCalls.every((call) => call.toolName === "discover");

				const resultByCallId = new Map<string, string>();
				if (canConcurrent && this.options.maxConcurrency > 1) {
					this.log(
						`[executor] dispatching ${executableCalls.length} stateless discover call(s) ` +
							`concurrently (cap=${this.options.maxConcurrency})`,
					);
					const results = await runConcurrent(
						executableCalls.map((call) => [call.toolName, call.toolArgs, call.toolCallId] as [string, Record<string, unknown>, string]),
						(toolName, toolArgs, toolCallId) => this.runToolCall(toolName, toolArgs, toolCallId, signal),
						this.options.maxConcurrency,
					);
					for (const [call, result] of zip(executableCalls, results)) {
						resultByCallId.set(call.toolCallId, result);
					}
				} else {
					for (const call of executableCalls) {
						if (signal?.aborted) throw abortError();
						resultByCallId.set(call.toolCallId, await this.runToolCall(call.toolName, call.toolArgs, call.toolCallId, signal));
					}
				}

				// cli.py:2640-2666 — every original tool-call id receives one result.
				for (const call of parsedCalls) {
					const content = blockedCalls.get(call.toolCallId) ?? resultByCallId.get(call.toolCallId);
					this.messages.push({
						role: "tool",
						tool_call_id: call.toolCallId,
						content: this.limitToolResult(call.toolName, content ?? `Tool error (${call.toolName}): executor returned no result`),
					});
				}
			}

			this.log("[agent] Reached max turns for this user message.");
			fireEnd();
			return ""; // cli.py:2668-2670
		} finally {
			// The turn transcript is final (or the turn was aborted mid-flight):
			// agent_end always fires so the extension sees the last assistant
			// stopReason, and agent_settled ALWAYS fires so the worker's settle
			// detection cannot deadlock on aborted turns.
			fireEnd();
			this.fireEvent({ type: "agent_settled" });
		}
	}

	/**
	 * Force compaction (the /compact analog, cli.py:1325-1401 with force=true).
	 * Summarizes older messages via a tool_choice:"none" call and keeps the
	 * tail with tool-call groups intact. Returns false (history unchanged) on
	 * failure, mirroring cli.py fallback strings.
	 */
	async compact(signal?: AbortSignal): Promise<boolean> {
		return this.compactHistory(true, signal);
	}

	/**
	 * Restore persisted history (e.g. from IndexedDB in stage 3). Mirrors
	 * cli.py `_load_session` (cli.py:644-663): stored system messages are
	 * dropped and the session's own system prompt is prepended; malformed
	 * entries are skipped.
	 */
	loadHistory(messages: unknown[]): void {
		if (!Array.isArray(messages)) throw new TypeError("loadHistory: expected an array of messages");
		const restored: Array<Record<string, unknown>> = [];
		for (const raw of messages) {
			if (raw === null || typeof raw !== "object") continue;
			const msg = raw as Record<string, unknown>;
			const role = msg.role;
			if (typeof role !== "string" || !["system", "user", "assistant", "tool"].includes(role)) continue;
			if (role === "system") continue;
			if (role === "assistant" && msg.tool_calls !== undefined && !Array.isArray(msg.tool_calls)) continue;
			if (role === "tool" && (typeof msg.tool_call_id !== "string" || typeof msg.content !== "string")) continue;
			restored.push(msg);
		}
		this.messages.length = 0;
		this.messages.push({ role: "system", content: this.options.systemPrompt }, ...restored);
	}

	// ── internals ─────────────────────────────────────────────────────────────

	/** utils.py:218-284 `call_openrouter` port; usage accumulates per call. */
	private async callOpenRouter(
		messages: Array<Record<string, unknown>>,
		toolChoice: "auto" | "none",
		signal?: AbortSignal,
	): Promise<OpenRouterResponse> {
		const hasTools = toolChoice !== "none" && this.options.tools.length > 0;
		const body: Record<string, unknown> = {
			model: this.options.model,
			messages,
			temperature: 0,
			max_tokens: 4096,
			tool_choice: hasTools ? "auto" : "none",
		};
		if (hasTools) {
			body.tools = this.options.tools.map((tool) => ({
				type: "function",
				function: { name: tool.name, description: tool.description, parameters: tool.parameters },
			}));
			if (this.options.parallelToolCalls) body.parallel_tool_calls = true;
		}

		const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const fetchImpl = this.options.fetchImpl ?? fetch;
		const response = await fetchImpl(this.options.endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.options.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal,
		});

		// cli.py:275-276 raise_for_status, but surfaced instead of swallowed.
		if (!response.ok) {
			const detail = truncateStr((await response.text()) || response.statusText, 300);
			throw new OpenRouterHttpError(response.status, detail);
		}

		const data = (await response.json()) as OpenRouterResponse;
		// cli.py:1271-1277 usage accumulation.
		const usage = data.usage;
		if (usage) {
			this.stats.promptTokens += Number(usage.prompt_tokens ?? 0);
			this.stats.completionTokens += Number(usage.completion_tokens ?? 0);
			this.stats.totalTokens += Number(usage.total_tokens ?? 0);
		}
		return data;
	}

	/** cli.py:1287-1306 `_split_for_compaction`. */
	private splitForCompaction(): { older: Array<Record<string, unknown>>; tail: Array<Record<string, unknown>> } | null {
		const nonSystem = this.messages.filter((message) => (message as WireMessage).role !== "system");
		const keepTail = this.options.compactKeepTail;
		if (nonSystem.length <= keepTail + 2) return null;

		const tail = nonSystem.slice(-keepTail);
		if (tail.length > 0 && (tail[0] as WireMessage).role === "tool") {
			// Walk back over the group's tool results; if the preceding message
			// is an assistant tool_calls message, keep the whole group.
			let idx = nonSystem.length - tail.length - 1;
			while (idx >= 0 && (nonSystem[idx] as WireMessage).role === "tool") idx -= 1;
			if (idx >= 0 && (nonSystem[idx] as WireMessage).role === "assistant" && (nonSystem[idx] as WireMessage).tool_calls) {
				return { older: nonSystem.slice(0, idx), tail: nonSystem.slice(idx) };
			}
			return { older: nonSystem.slice(0, nonSystem.length - keepTail), tail };
		}
		return { older: nonSystem.slice(0, nonSystem.length - keepTail), tail };
	}

	/** cli.py:1325-1401 `_compact_history` (force skips the token threshold). */
	private async compactHistory(force: boolean, signal?: AbortSignal): Promise<boolean> {
		// KV-cache friendly: compact by tokens, not early message count.
		if (!force && estimateMessagesTokens(this.messages) < this.options.compactThresholdTokens) return false;
		const split = this.splitForCompaction();
		if (!split) return false;
		const { older, tail } = split;

		this.log(`[context] summarising ${older.length} older messages`);
		const transcriptLines: string[] = [];
		for (const msg of older.slice(-80)) {
			const role = String((msg as WireMessage).role ?? "unknown");
			const text = truncateStr(stripControlChars(messageContentAsText(msg)).replace(/\n/g, " "), 500);
			transcriptLines.push(`${role}: ${text}`);
		}
		const transcript = transcriptLines.join("\n") || "No prior messages.";

		const summaryPrompt: Array<Record<string, unknown>> = [
			{
				role: "system",
				content:
					"Summarize prior conversation for continuation. " +
					"Return short bullets: goals, decisions, facts, TODOs, constraints. " +
					"Keep below 180 words.",
			},
			{ role: "user", content: transcript },
		];

		let summary = "";
		try {
			const summaryResponse = await this.callOpenRouter(summaryPrompt, "none", signal);
			const summaryMessage = summaryResponse.choices?.[0]?.message;
			summary = String(summaryMessage?.content ?? summaryMessage?.reasoning ?? "").trim();
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) throw abortError();
			this.log(`[context] Compaction failed (${error instanceof Error ? error.message : String(error)}); history unchanged.`);
			return false;
		}
		if (!summary) {
			this.log("[context] Compaction returned no summary; history unchanged.");
			return false;
		}

		this.messages.length = 0;
		this.messages.push(
			{ role: "system", content: this.options.systemPrompt },
			{ role: "assistant", content: `[Context summary]\n${summary}` },
			...tail,
		);
		return true;
	}

	/** cli.py:2345-2406 `_run_tool_call`: execute, wrap errors, honor abort. */
	private async runToolCall(
		toolName: string,
		args: Record<string, unknown>,
		toolCallId: string,
		signal?: AbortSignal,
	): Promise<string> {
		this.log(`[tool ${toolCallId}] ${toolName}(${truncateStr(JSON.stringify(args), 180)})`);
		const callSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.options.commandTimeoutMs)]) : AbortSignal.timeout(this.options.commandTimeoutMs);
		this.fireEvent({ type: "tool_execution_start", toolCallId, toolName, args });
		try {
			const result = await this.options.toolExecutor.execute(toolName, args, callSignal, toolCallId);
			this.fireEvent({ type: "tool_execution_end", toolCallId, toolName, isError: result.isError === true, result });
			return result.isError ? `Tool error (${toolName}): ${result.content}` : result.content;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.fireEvent({ type: "tool_execution_end", toolCallId, toolName, isError: true, result: message });
			if (signal?.aborted) throw abortError(); // user abort propagates (cli.py:2374-2378)
			return `Tool error (${toolName}): ${message}`;
		}
	}

	/** cli.py:2300-2343 `_limit_tool_result`; generic JSON detection (deviation). */
	private limitToolResult(toolName: string, result: string): string {
		const max = this.options.maxToolResultChars;
		if (result.length <= max) return result;
		try {
			const payload: unknown = JSON.parse(result);
			if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
				const obj = payload as Record<string, unknown>;
				obj.truncated = true;
				obj.truncation_notice =
					`Tool result exceeded ${max} characters. ` + "Inspect the local transcript for the full result.";
				if (typeof obj.content === "string") obj.content = truncateStr(obj.content, 1500);
				if (typeof obj.stdout === "string") obj.stdout = truncateStr(obj.stdout, 1500);
				if (typeof obj.stderr === "string") obj.stderr = truncateStr(obj.stderr, 1500);
				const compact = JSON.stringify(obj);
				if (compact.length <= max) return compact;
			}
		} catch {
			// fall through to plain truncation
		}
		return result.slice(0, max) + `\n[tool result truncated at ${max} characters]`;
	}

	private log(line: string): void {
		this.options.onLog?.(line);
	}

	private fireEvent(event: BrowserSessionEvent): void {
		try {
			this.options.onEvent?.(event);
		} catch (error) {
			// A consumer callback must never break the tool loop.
			this.log(`[events] handler error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function* zip<T, U>(left: T[], right: U[]): Generator<[T, U]> {
	for (let i = 0; i < Math.min(left.length, right.length); i++) yield [left[i], right[i]];
}
