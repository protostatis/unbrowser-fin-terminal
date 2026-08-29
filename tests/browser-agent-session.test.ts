import assert from "node:assert/strict";
import test from "node:test";
import {
	BrowserAgentSession,
	estimateMessagesTokens,
	preserveToolCallGroups,
	type BrowserSessionOptions,
	type BrowserToolExecutor,
} from "../web/src/harness/browser-agent-session.js";

// ── helpers ──────────────────────────────────────────────────────────────────

interface FakeToolCall {
	name: string;
	args?: unknown;
	id?: string;
}

interface ChatResponseSpec {
	content?: string;
	reasoning?: string;
	toolCalls?: FakeToolCall[];
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
	finishReason?: string;
}

/** Deterministic chat-completions response for the fake fetch. */
let nextCallId = 0;
function chatResponse(spec: ChatResponseSpec): Response {
	const toolCalls = spec.toolCalls?.map((tc, i) => ({
		id: tc.id ?? `call_${++nextCallId}_${i}`,
		type: "function",
		function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
	}));
	return new Response(
		JSON.stringify({
			choices: [
				{
					message: {
						role: "assistant",
						content: spec.content ?? null,
						...(spec.reasoning ? { reasoning: spec.reasoning } : {}),
						...(toolCalls ? { tool_calls: toolCalls } : {}),
					},
					finish_reason: toolCalls ? "tool_calls" : (spec.finishReason ?? "stop"),
				},
			],
			usage: spec.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** Fake fetch: serves a script of responses and captures request bodies. */
function scriptedFetch(script: ChatResponseSpec[]): { fetchImpl: typeof fetch; bodies: Record<string, unknown>[] } {
	let call = 0;
	const bodies: Record<string, unknown>[] = [];
	const fetchImpl: typeof fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		bodies.push(body);
		const spec = script[call++];
		if (!spec) throw new Error(`unexpected fetch request #${call}`);
		return chatResponse(spec);
	};
	return { fetchImpl, bodies };
}

/** Capturing tool executor. */
function toolExecutor(impl: (name: string, args: Record<string, unknown>) => string | Promise<string>): BrowserToolExecutor & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	return {
		calls,
		execute: async (name, args) => {
			calls.push({ name, args });
			return { content: await impl(name, args) };
		},
	};
}

const BASE_TOOLS = [
	{ name: "market_quote", description: "Fetch a delayed quote", parameters: { type: "object", properties: { symbol: { type: "string" } } } },
	{ name: "discover", description: "Fetch web content", parameters: { type: "object", properties: { goal: { type: "string" } } } },
];

// ── tests ────────────────────────────────────────────────────────────────────

test("runTurn drives a 3-round tool loop: tool_calls -> tool results -> final text", async () => {
	const executor = toolExecutor((name, args) => {
		if (name === "market_quote") return `{"symbol":${JSON.stringify(String(args.symbol))},"price":123.45}`;
		return "ok";
	});
	const { fetchImpl, bodies } = scriptedFetch([
		{ toolCalls: [{ name: "market_quote", args: { symbol: "AAPL" } }] },
		{ toolCalls: [{ name: "market_quote", args: { symbol: "MSFT" } }] },
		{ content: "Here are the quotes." },
	]);
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: executor,
		fetchImpl,
	});

	const result = await session.runTurn("get quotes for AAPL and MSFT");

	assert.equal(result, "Here are the quotes.");
	assert.deepEqual(executor.calls.map((c) => [c.name, c.args.symbol]), [
		["market_quote", "AAPL"],
		["market_quote", "MSFT"],
	]);

	// Wire-format transcript: user -> assistant(tool_calls) -> tool -> assistant(tool_calls) -> tool -> assistant(text)
	const roles = session.messages.map((m) => m.role);
	assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant", "tool", "assistant"]);
	const assistantMsgs = session.messages.filter((m) => m.role === "assistant" && m.tool_calls);
	assert.equal(assistantMsgs.length, 2);
	for (const msg of assistantMsgs) {
		const calls = msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
		for (const tc of calls) assert.ok(tc.id, "assistant tool_calls entries carry ids");
	}
	// Every tool result correlates with a call id present in the preceding assistant message.
	const toolMsgs = session.messages.filter((m) => m.role === "tool");
	assert.equal(toolMsgs.length, 2);
	for (const tm of toolMsgs) assert.ok(typeof tm.tool_call_id === "string" && typeof tm.content === "string");

	// Request wire format: model, messages, max_tokens, tool_choice auto, tools.
	const body = bodies[0];
	assert.equal(body.model, "m");
	assert.equal(body.tool_choice, "auto");
	assert.equal(body.max_tokens, 4096);
	assert.ok(Array.isArray(body.tools) && body.tools.length === 2);
	assert.equal((body.tools as Array<{ function: { name: string } }>)[0].function.name, "market_quote");
});

test("usage accumulates across all model calls", async () => {
	const { fetchImpl } = scriptedFetch([
		{ toolCalls: [{ name: "market_quote" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
		{ content: "done", usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 } },
	]);
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
	});
	await session.runTurn("hi");
	assert.deepEqual(session.stats, { promptTokens: 250, completionTokens: 50, totalTokens: 300 });
});

test("repetition guard: identical tool signature twice -> nudge + forced tool_choice none", async () => {
	const { fetchImpl, bodies } = scriptedFetch([
		{ toolCalls: [{ name: "market_quote", args: { symbol: "AAPL" } }] },
		{ toolCalls: [{ name: "market_quote", args: { symbol: "AAPL" } }] }, // identical signature
		{ content: "Forced final answer." },
	]);
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
	});
	const result = await session.runTurn("quote AAPL");

	assert.equal(result, "Forced final answer.");
	// The third request is the forced call: no tools, tool_choice none.
	assert.equal(bodies.length, 3);
	const forced = bodies[2];
	assert.equal(forced.tool_choice, "none");
	assert.ok(!("tools" in forced));
	// Nudge tool messages were appended for each pending call id before the forced call.
	const nudge = session.messages.filter((m) => m.role === "tool" && String(m.content).startsWith("STOP. You repeated"));
	assert.equal(nudge.length, 1);
	assert.ok(typeof nudge[0].tool_call_id === "string");
});

test("repetition guard fallback: forced call fails -> 'I got stuck in a tool loop'", async () => {
	const fetchImpl: typeof fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		const isForced = body.tool_choice === "none";
		return chatResponse(
			isForced
				? { content: null, toolCalls: [{ name: "discover" }], finishReason: "tool_calls" } // forced call refuses to stop
				: { toolCalls: [{ name: "market_quote", args: { symbol: "AAPL" } }] },
		);
	};
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
	});
	const result = await session.runTurn("quote AAPL");
	assert.equal(result, "I got stuck in a tool loop and could not make progress.");
});

test("batch caps: discover overflow blocked per batch and per round, ids never dropped", async () => {
	const executor = toolExecutor(() => "discover ok");
	const { fetchImpl } = scriptedFetch([
		{ toolCalls: Array.from({ length: 6 }, (_, i) => ({ name: "discover", args: { goal: `g${i}` } })) },
		{ toolCalls: [{ name: "discover", args: { goal: "round2" } }] },
		{ content: "final" },
	]);
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: executor,
		fetchImpl,
		maxDiscoverPerBatch: 5,
		maxDiscoverRounds: 1,
	});
	await session.runTurn("go discover");

	// Batch cap: only 5 of the 6 first-round calls executed; 6th blocked.
	assert.equal(executor.calls.length, 5);
	const toolMessages = session.messages.filter((m) => m.role === "tool");
	const blockedBatch = toolMessages.filter((m) => String(m.content).includes("max_discover 5 exceeded"));
	assert.equal(blockedBatch.length, 1);
	// Round cap: the second-round discover call was blocked by max_rounds.
	const blockedRound = toolMessages.filter((m) => String(m.content).includes("max_rounds 1 exceeded (round 2)"));
	assert.equal(blockedRound.length, 1);
	// Every tool call still received exactly one correlated result.
	const callIds = toolMessages.map((m) => m.tool_call_id);
	assert.equal(new Set(callIds).size, callIds.length);
	assert.equal(toolMessages.length, 7); // 6 + 1
});

test("maxTurns exhaustion returns empty string", async () => {
	const { fetchImpl } = scriptedFetch([
		{ toolCalls: [{ name: "market_quote", args: { symbol: "AAPL" } }] },
		{ toolCalls: [{ name: "market_quote", args: { symbol: "MSFT" } }] },
		{ toolCalls: [{ name: "market_quote", args: { symbol: "GOOG" } }] },
	]);
	const logs: string[] = [];
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
		maxTurns: 3,
		onLog: (line) => logs.push(line),
	});
	const result = await session.runTurn("loop");
	assert.equal(result, "");
	assert.ok(logs.some((line) => line.includes("Reached max turns")));
});

test("HTTP errors surface status + truncated body as the turn result", async () => {
	const fetchImpl: typeof fetch = async () => new Response("x".repeat(500), { status: 401, statusText: "Unauthorized" });
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
	});
	const result = await session.runTurn("hi");
	assert.ok(result.includes("HTTP 401"), `expected status in: ${result.slice(0, 80)}`);
	// Truncated body: 300 chars + "..." from cli.py _truncate.
	assert.ok(result.includes("x".repeat(300)), "body truncated at 300 chars");
	assert.ok(result.endsWith("..."), "truncation marker appended");
});

test("network errors propagate", async () => {
	const fetchImpl: typeof fetch = async () => {
		throw new TypeError("fetch failed: network unreachable");
	};
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
	});
	await assert.rejects(() => session.runTurn("hi"), /network unreachable/);
});

test("pre-aborted user signal propagates AbortError", async () => {
	const { fetchImpl } = scriptedFetch([{ content: "should not be reached" }]);
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
	});
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => session.runTurn("hi", controller.signal), (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("tool results longer than maxToolResultChars are truncated", async () => {
	const executor = toolExecutor(() => "y".repeat(9000));
	const { fetchImpl } = scriptedFetch([{ toolCalls: [{ name: "market_quote" }] }, { content: "ok" }]);
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: executor,
		fetchImpl,
		maxToolResultChars: 8000,
	});
	await session.runTurn("hi");
	const toolMsg = session.messages.find((m) => m.role === "tool") as { content: string };
	assert.ok(toolMsg.content.startsWith("y".repeat(8000)));
	assert.ok(toolMsg.content.includes("[tool result truncated at 8000 characters]"));
});

test("structured JSON tool results keep their shape with truncation markers", async () => {
	const executor = toolExecutor(() => JSON.stringify({ ok: true, content: "z".repeat(9000), extra: "keep" }));
	const { fetchImpl } = scriptedFetch([{ toolCalls: [{ name: "market_quote" }] }, { content: "ok" }]);
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: executor,
		fetchImpl,
	});
	await session.runTurn("hi");
	const toolMsg = session.messages.find((m) => m.role === "tool") as { content: string };
	const parsed = JSON.parse(toolMsg.content) as { truncated?: boolean; content?: string; extra?: string; truncation_notice?: string };
	assert.equal(parsed.truncated, true);
	assert.equal(parsed.extra, "keep");
	assert.equal(parsed.content?.length, 1503); // 1500 + "..."
	assert.ok(parsed.truncation_notice);
});

test("tool_choice none and no tools key when no tools are registered", async () => {
	const { fetchImpl, bodies } = scriptedFetch([{ content: "no tools here" }]);
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: [],
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
	});
	const result = await session.runTurn("hi");
	assert.equal(result, "no tools here");
	assert.equal(bodies[0].tool_choice, "none");
	assert.ok(!("tools" in bodies[0]));
});

test("compact() summarizes older messages and preserves tool groups in the tail", async () => {
	const executor = toolExecutor(() => "ok");
	const { fetchImpl } = scriptedFetch([{ content: "Summary bullets: goals; decisions; facts; TODOs; constraints." }]);

	// History: system + 2 tool groups + closing text. keepTail=2 cuts into the
	// second group's tool results, so the walk-back must preserve the group.
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: executor,
		fetchImpl,
		compactKeepTail: 2,
	});
	session.loadHistory([
		{ role: "user", content: "research AAPL" },
		{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "market_quote", arguments: '{"symbol":"AAPL"}' } }] },
		{ role: "tool", tool_call_id: "c1", content: "price 100" },
		{ role: "user", content: "research MSFT" },
		{ role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "market_quote", arguments: '{"symbol":"MSFT"}' } }] },
		{ role: "tool", tool_call_id: "c2", content: "price 200" },
		{ role: "assistant", content: "wrapping up" },
	]);

	const compacted = await session.compact();
	assert.equal(compacted, true);

	// messages = [system, summary assistant, preserved group (assistant tool_calls + tool), closing text]
	const roles = session.messages.map((m) => m.role);
	assert.deepEqual(roles, ["system", "assistant", "assistant", "tool", "assistant"]);
	const summaryMsg = session.messages[1];
	assert.ok(String(summaryMsg.content).startsWith("[Context summary]"));
	assert.ok(String(summaryMsg.content).includes("Summary bullets"));
	// Tool group intact: assistant tool_calls + its tool result kept together.
	const groupAssistant = session.messages[2] as { tool_calls?: Array<{ id: string }> };
	assert.equal(groupAssistant.tool_calls?.[0]?.id, "c2");
	assert.equal((session.messages[3] as { tool_call_id?: string }).tool_call_id, "c2");
	assert.equal(session.messages[4].content, "wrapping up");
});

test("compact() failure keeps prior history unchanged", async () => {
	const fetchImpl: typeof fetch = async () => new Response("boom", { status: 500 });
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
	});
	session.loadHistory([
		{ role: "user", content: "a".repeat(200) },
		{ role: "assistant", content: "b".repeat(200) },
		{ role: "user", content: "c".repeat(200) },
		{ role: "assistant", content: "d".repeat(200) },
		{ role: "user", content: "e".repeat(200) },
		{ role: "assistant", content: "f".repeat(200) },
		{ role: "user", content: "g".repeat(200) },
		{ role: "assistant", content: "h".repeat(200) },
	]);
	const before = JSON.stringify(session.messages);
	const compacted = await session.compact();
	assert.equal(compacted, false);
	assert.equal(JSON.stringify(session.messages), before);
});

test("estimateMessagesTokens: chars // 4 with tool_calls name+arguments", () => {
	assert.equal(estimateMessagesTokens([]), 1);
	assert.equal(estimateMessagesTokens([{ role: "user", content: "abcd" }]), 1);
	assert.equal(estimateMessagesTokens([{ role: "user", content: "a".repeat(100) }]), 25);
	// tool_calls: name (12) + arguments (18) = 30 chars -> 7 tokens
	const msg = {
		role: "assistant",
		content: null,
		tool_calls: [{ id: "c1", type: "function", function: { name: "market_quote", arguments: '{"symbol":"AAPL"}' } }],
	};
	assert.equal(estimateMessagesTokens([msg]), 7);
	// null content contributes 0
	assert.equal(estimateMessagesTokens([{ role: "user", content: null }]), 1);
});

test("preserveToolCallGroups expands a tail that starts with a tool result", () => {
	const full = [
		{ role: "user", content: "u1" },
		{ role: "assistant", content: null, tool_calls: [{ id: "a" }] },
		{ role: "tool", tool_call_id: "a", content: "r1" },
		{ role: "tool", tool_call_id: "a", content: "r2" },
		{ role: "user", content: "u2" },
		{ role: "assistant", content: null, tool_calls: [{ id: "b" }] },
		{ role: "tool", tool_call_id: "b", content: "r3" },
		{ role: "tool", tool_call_id: "b", content: "r4" },
		{ role: "assistant", content: "done" },
	];
	// Tail begins with tool result r3 -> expand back to assistant b (r3, r4 + done).
	const tail = full.slice(5); // [assistant b, tool r3, tool r4, done] — assistant first, unchanged
	assert.deepEqual(preserveToolCallGroups(full, tail), tail);
	// Tail begins mid-group -> include assistant b and the whole group.
	const cutTail = full.slice(6); // [tool r3, tool r4, done]
	const expanded = preserveToolCallGroups(full, cutTail);
	assert.deepEqual(expanded, full.slice(5));
	// Non-tool tails are untouched.
	assert.deepEqual(preserveToolCallGroups(full, full.slice(8)), full.slice(8));
	// Empty tail stays empty.
	assert.deepEqual(preserveToolCallGroups(full, []), []);
});

test("loadHistory validates and restores persisted messages", () => {
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "current prompt",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl: scriptedFetch([]).fetchImpl,
	});
	session.loadHistory([
		null,
		{ role: "system", content: "stale prompt" }, // dropped, replaced by session prompt
		{ role: "user", content: "hi" },
		{ role: "bogus", content: "skip me" }, // invalid role, skipped
		{ role: "assistant", content: "hello", tool_calls: "not-an-array" }, // malformed, skipped
		{ role: "assistant", content: "thinking" },
		{ role: "tool", tool_call_id: "c9", content: "result" },
		{ role: "tool", content: "missing id" }, // skipped
	]);
	assert.deepEqual(session.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
	assert.equal(session.messages[0].content, "current prompt");
	assert.equal(session.messages[2].content, "thinking");
	assert.equal((session.messages[3] as { tool_call_id?: string }).tool_call_id, "c9");
});

test("auto-compact runs mid-turn when history exceeds the token threshold", async () => {
	const executor = toolExecutor(() => "ok");
	let requests = 0;
	const fetchImpl: typeof fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		requests += 1;
		const isSummary = (body.messages as Array<{ role: string }>)[0]?.role === "system" &&
			String((body.messages as Array<{ content: string }>)[0].content).includes("Summarize prior conversation");
		if (isSummary) return chatResponse({ content: "compacted summary" });
		if (requests <= 2) return chatResponse({ toolCalls: [{ name: "market_quote", args: { symbol: "AAPL" } }] });
		return chatResponse({ content: "final answer" });
	};
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: executor,
		fetchImpl,
		compactThresholdTokens: 10,
		compactKeepTail: 2,
	});
	// History well over the 10-token threshold (12+ messages).
	session.loadHistory([
		{ role: "user", content: "a".repeat(80) },
		{ role: "assistant", content: "b".repeat(80) },
		{ role: "user", content: "c".repeat(80) },
		{ role: "assistant", content: "d".repeat(80) },
		{ role: "user", content: "e".repeat(80) },
		{ role: "assistant", content: "f".repeat(80) },
		{ role: "user", content: "g".repeat(80) },
		{ role: "assistant", content: "h".repeat(80) },
	]);
	await session.runTurn("continue");
	const summaryPresent = session.messages.some((m) => String(m.content).startsWith("[Context summary]"));
	assert.equal(summaryPresent, true, "auto-compaction inserted a context summary");
});

// ── stage 2b: lifecycle event emission ───────────────────────────────────────

test("onEvent fires agent_start/tool_execution/agent_end/agent_settled in order with correct shapes", async () => {
	const executor = toolExecutor((name, args) => (name === "market_quote" ? `{"symbol":${JSON.stringify(String(args.symbol))},"price":1}` : "ok"));
	const { fetchImpl } = scriptedFetch([
		{ toolCalls: [{ name: "market_quote", args: { symbol: "AAPL" } }, { name: "discover", args: { goal: "x" } }] },
		{ content: "final text" },
	]);
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: executor,
		fetchImpl,
		onEvent: (event) => events.push(event as { type: string; [key: string]: unknown }),
	});
	await session.runTurn("go");

	assert.deepEqual(events.map((e) => e.type), [
		"agent_start",
		"tool_execution_start",
		"tool_execution_end",
		"tool_execution_start",
		"tool_execution_end",
		"agent_end",
		"agent_settled",
	]);

	// tool_execution_start/end pair shapes, correlated by toolCallId.
	const starts = events.filter((e) => e.type === "tool_execution_start");
	assert.equal(starts.length, 2);
	for (const start of starts) {
		assert.ok(typeof start.toolCallId === "string" && start.toolCallId.length > 0);
		assert.ok(typeof start.toolName === "string");
		assert.ok(typeof start.args === "object");
	}
	const ends = events.filter((e) => e.type === "tool_execution_end");
	assert.equal(ends.length, 2);
	for (const end of ends) {
		assert.equal(end.isError, false);
		assert.ok(typeof end.result === "object" && typeof (end.result as { content: string }).content === "string");
	}
	assert.deepEqual(ends.map((e) => e.toolName), ["market_quote", "discover"]);
	assert.deepEqual(
		starts.map((s) => s.toolCallId),
		ends.map((e) => e.toolCallId),
	);

	// agent_end carries the full transcript INCLUDING the final assistant message.
	const agentEnd = events.find((e) => e.type === "agent_end") as { messages?: Array<Record<string, unknown>> };
	const roles = agentEnd.messages?.map((m) => m.role);
	assert.deepEqual(roles, ["system", "user", "assistant", "tool", "tool", "assistant"]);
	const lastAssistant = [...(agentEnd.messages ?? [])].reverse().find((m) => m.role === "assistant");
	assert.equal(lastAssistant?.content, "final text");
	assert.equal(lastAssistant?.stopReason, "stop");
});

test("stored assistant messages carry mapped stopReason: toolUse on tool-call turns, stop on final", async () => {
	const { fetchImpl } = scriptedFetch([
		{ toolCalls: [{ name: "market_quote", args: { symbol: "AAPL" } }], finishReason: "tool_calls" },
		{ content: "done", finishReason: "stop" },
	]);
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
	});
	await session.runTurn("hi");
	const assistants = session.messages.filter((m) => m.role === "assistant");
	assert.equal(assistants.length, 2);
	assert.equal((assistants[0] as { stopReason?: string }).stopReason, "toolUse");
	assert.equal((assistants[1] as { stopReason?: string }).stopReason, "stop");
});

test("finish_reason length maps to stopReason 'length'", async () => {
	const { fetchImpl } = scriptedFetch([{ content: "partial output", finishReason: "length" }]);
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
	});
	await session.runTurn("hi");
	const assistant = session.messages.filter((m) => m.role === "assistant").at(-1) as { stopReason?: string };
	assert.equal(assistant.stopReason, "length");
});

test("HTTP error turn stores stopReason 'error' and still fires agent_end + agent_settled", async () => {
	const events: string[] = [];
	const fetchImpl: typeof fetch = async () => new Response("boom", { status: 500, statusText: "Internal Server Error" });
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: toolExecutor(() => "ok"),
		fetchImpl,
		onEvent: (event) => events.push(event.type),
	});
	const result = await session.runTurn("hi");
	assert.ok(result.includes("HTTP 500"));
	assert.deepEqual(events, ["agent_start", "agent_end", "agent_settled"]);
	const assistant = session.messages.filter((m) => m.role === "assistant").at(-1) as { stopReason?: string; content?: string };
	assert.equal(assistant.stopReason, "error");
	assert.ok(String(assistant.content).includes("HTTP 500"));
});

test("abort during tool execution fires agent_end + agent_settled and propagates AbortError", async () => {
	const events: string[] = [];
	const controller = new AbortController();
	const fetchImpl = scriptedFetch([{ toolCalls: [{ name: "market_quote" }] }]).fetchImpl;
	const session = new BrowserAgentSession({
		apiKey: "k",
		model: "m",
		systemPrompt: "sys",
		tools: BASE_TOOLS,
		toolExecutor: {
			execute: async () => {
				controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 10));
				throw new Error("aborted operation");
			},
		},
		fetchImpl,
		onEvent: (event) => events.push(event.type),
	});
	await assert.rejects(() => session.runTurn("hi", controller.signal), (error: unknown) => error instanceof Error && error.name === "AbortError");
	// The extension's settle detection must never deadlock on aborted turns.
	assert.deepEqual(events, ["agent_start", "tool_execution_start", "tool_execution_end", "agent_end", "agent_settled"]);
});
