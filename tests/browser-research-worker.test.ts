/**
 * Stage 2b DIFFERENTIAL test: browser research-worker core vs the Node Pi
 * conformance fixture.
 *
 * Runs the real extension (the same .pi/extensions/market-terminal.ts the
 * Node worker forks) inside `runResearchAttempt` — the browser worker core —
 * with:
 *   - the SAME conformance script the Pi-side capture uses, implemented at the
 *     HTTP level against BrowserAgentSession's OpenRouter wire format
 *     (server/conformance-mock-model.ts conformancePlan translated 1:1);
 *   - the SAME deterministic mock MCP endpoint
 *     (scripts/conformance/mock-mcp-server.ts);
 *   - MARKET_MOCK_MONDAY=1 so market_technicals is deterministic (same as the
 *     capture);
 *   - the extension's real sourceIdForUrl for canvas citation ids.
 *
 * The emitted worker-event stream must mirror the Node worker outcome: a
 * settled event with outcome "complete" plus the job transition sequence
 * queued → running → partial → complete observed through job/canvas events.
 * A negative control (HTTP 500 model endpoint) must settle "failed".
 *
 * This test file runs under tsx in its own Node process (node --test), so the
 * in-process `process.env` / `process.send` mutations made by the core are
 * isolated from other test files.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { startMockMcpServer, type MockMcpServerHandle } from "../scripts/conformance/mock-mcp-server.js";
import {
	CONFORMANCE_FIXTURE_SENTENCE,
	CONFORMANCE_FIXTURE_URLS,
} from "../server/conformance-mock-model.js";
import { sourceIdForUrl } from "../shared/kernel/hash.js";
import { parseConformanceTrace } from "../shared/conformance-trace.js";
import { CONFORMANCE_RESEARCH_TOOLS, projectBrowserWorkerTrace, projectPiTrace } from "../shared/conformance-diff.js";
import { runResearchAttempt, type WorkerRunMessageLike } from "../web/src/harness/research-worker-core.js";

// ── Conformance script (OpenRouter HTTP level) ───────────────────────────────

type WireToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type WireMessage = {
	role?: string;
	content?: unknown;
	tool_calls?: WireToolCall[] | null;
	tool_call_id?: string;
};

type TurnPlan =
	| { kind: "technicals"; symbol: string; researchId: string }
	| { kind: "discover"; symbol: string; researchId: string }
	| { kind: "extract"; researchId: string; candidateIds: string[] }
	| { kind: "canvas"; symbol: string; researchId: string; sourceIds: string[] }
	| { kind: "final" };

/** Mirrors conformance-mock-model.ts planForContext, over the session's wire messages. */
function planFromMessages(messages: WireMessage[]): TurnPlan {
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const prompt = String(
		typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? ""),
	);
	const researchId = /research_id=([A-Za-z0-9_-]{1,160})/.exec(prompt)?.[1] ?? "job-unknown";
	const symbol = /(?:target|symbol)=([A-Za-z0-9.^$-]{1,20})/i.exec(prompt)?.[1]
		?? /\bResearch ([A-Za-z0-9.^$-]{1,20})\s+/i.exec(prompt)?.[1]
		?? "AAPL";

	const executed = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const tc of message.tool_calls ?? []) executed.add(tc.function.name);
	}
	if (executed.has("market_canvas")) return { kind: "final" };

	const lastTool = [...messages].reverse().find((m) => m.role === "tool");
	const lastToolContent = String(lastTool?.content ?? "");

	if (executed.has("market_extract")) {
		// Extract succeeded → complete canvas with the REAL source ids of the
		// fixture URLs (two extracted candidates), like the Node conformancePlan.
		const sourceIds = CONFORMANCE_FIXTURE_URLS.slice(0, 2).map(sourceIdForUrl);
		return { kind: "canvas", symbol, researchId, sourceIds };
	}
	if (executed.has("market_discover")) {
		const ids: string[] = [];
		const seen = new Set<string>();
		for (const match of lastToolContent.matchAll(/candidate_id=([A-Za-z0-9_-]{8,160})/g)) {
			const id = match[1]!;
			if (!seen.has(id)) {
				seen.add(id);
				ids.push(id);
			}
			if (ids.length >= 2) break;
		}
		return ids.length > 0 ? { kind: "extract", researchId, candidateIds: ids } : { kind: "final" };
	}
	if (executed.has("market_technicals")) return { kind: "discover", symbol, researchId };
	return { kind: "technicals", symbol, researchId };
}

function chatCompletion(turn: number, plan: Exclude<TurnPlan, { kind: "final" }>): Response {
	const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
	switch (plan.kind) {
		case "technicals":
			toolCalls.push({ name: "market_technicals", args: { scope: "ticker", symbol: plan.symbol, research_id: plan.researchId } });
			break;
		case "discover":
			toolCalls.push({ name: "market_discover", args: { scope: "ticker", symbol: plan.symbol, research_id: plan.researchId } });
			break;
		case "extract":
			toolCalls.push(...plan.candidateIds.map((candidateId) => ({
				name: "market_extract",
				args: { research_id: plan.researchId, candidate_id: candidateId, mode: "text_main" },
			})));
			break;
		case "canvas":
			toolCalls.push({
				name: "market_canvas",
				args: {
					symbol: plan.symbol,
					title: `${plan.symbol} conformance brief`,
					research_id: plan.researchId,
					stage: "complete",
					content: "",
					blocks: [
						{
							id: "read",
							kind: "text",
							title: "Summary",
							text: `${plan.symbol} traded on verified public reporting reviewed from fetched sources.`,
							sourceIds: plan.sourceIds,
							dossierHint: "read",
						},
						{
							id: "unknowns",
							kind: "bullets",
							title: "Unknowns",
							items: [{ text: "No additional confirmed catalysts beyond the fetched reporting." }],
							dossierHint: "unknowns",
						},
					],
					citations: plan.sourceIds.length > 0
						? [{ source_id: plan.sourceIds[0]!, quote: CONFORMANCE_FIXTURE_SENTENCE.slice(0, 80) }]
						: [],
				},
			});
			break;
	}
	const input = 2_000 + turn * 500;
	const output = 600 + turn * 100;
	return new Response(
		JSON.stringify({
			choices: [{
				message: {
					role: "assistant",
					content: null,
					tool_calls: toolCalls.map((tc, index) => ({
						id: `call_${turn}_${index}`,
						type: "function",
						function: { name: tc.name, arguments: JSON.stringify(tc.args) },
					})),
				},
				finish_reason: "tool_calls",
			}],
			usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** Scripted OpenRouter endpoint: the conformance 5-turn plan. */
function conformanceFetch() {
	let calls = 0;
	const fetchImpl: typeof fetch = async (url, init) => {
		const body = JSON.parse(String(init?.body)) as { messages?: WireMessage[] };
		if (!String(url).includes("/chat/completions")) {
			throw new Error(`unexpected fetch URL: ${String(url)}`);
		}
		calls += 1;
		const plan = planFromMessages(body.messages ?? []);
		if (plan.kind === "final") {
			return new Response(
				JSON.stringify({
					choices: [{ message: { role: "assistant", content: "Conformance research complete." }, finish_reason: "stop" }],
					usage: { prompt_tokens: 2_000 + calls * 500, completion_tokens: 600 + calls * 100, total_tokens: 2_000 + calls * 500 + 600 + calls * 100 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return chatCompletion(calls, plan);
	};
	return { fetchImpl, callCount: () => calls };
}

/** HTTP-500 model endpoint for the negative control. */
function failingFetch(): typeof fetch {
	return async () => new Response("model endpoint exploded", { status: 500, statusText: "Internal Server Error" });
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const RUN: WorkerRunMessageLike = {
	version: 1,
	type: "run",
	jobId: "differential-job-1",
	attemptId: "attempt-1",
	request: {
		symbol: "AAPL",
		question: "Latest earnings and catalysts",
		chartScope: "day",
		researchKey: "v1/ticker/brief",
		intent: "brief",
		contextLabel: "AAPL BRIEF",
	},
};

const PI_TRACE = projectPiTrace(parseConformanceTrace(readFileSync(new URL("./fixtures/pi-trace-v1.jsonl", import.meta.url), "utf8")).events);

function workerEnv(mcpEndpoint: string): Record<string, string> {
	return {
		MARKET_RESEARCH_WORKER: "1",
		BROWSER_MODEL: "conformance",
		BROWSER_API_KEY: "test",
		UNBROWSER_MCP_URL: mcpEndpoint,
		MARKET_MOCK_MONDAY: "1",
		MARKET_PRECACHE_ENABLED: "0",
		// Exercise the structured prompt fields used by the browser build. The
		// conformance model must not fall back to AAPL when the prompt carries
		// `target=` / `symbol=` instead of the legacy prose form.
		MARKET_RESEARCH_PROMPT: "compact",
	};
}

interface CollectedEvent {
	version: number;
	type: string;
	jobId: string;
	attemptId: string;
	sequence: number;
	[key: string]: unknown;
}

function collectEvents(events: CollectedEvent[]): (msg: unknown) => void {
	return (msg) => {
		const rec = msg as Record<string, unknown>;
		if (!rec || typeof rec !== "object") return;
		if (typeof rec.version !== "number" || typeof rec.type !== "string") return;
		events.push({
			version: Number(rec.version),
			type: String(rec.type),
			jobId: String(rec.jobId ?? ""),
			attemptId: String(rec.attemptId ?? ""),
			sequence: Number(rec.sequence ?? -1),
			...rec,
		});
	};
}

// ── Differential: complete flow ──────────────────────────────────────────────

test("differential: browser worker core settles complete with the conformance script (vs Node fixture)", async () => {
	const mockMcp: MockMcpServerHandle = await startMockMcpServer();
	try {
		const { fetchImpl, callCount } = conformanceFetch();
		const events: CollectedEvent[] = [];
		await runResearchAttempt(RUN, {
			env: workerEnv(mockMcp.endpoint),
			emit: collectEvents(events),
			fetchImpl,
			settleTimeoutMs: 30_000,
		});

		// ── Terminal outcome ─────────────────────────────────────────────────
		const settled = events.filter((e) => e.type === "settled");
		assert.equal(settled.length, 1, `expected exactly one settled event, got ${settled.length}`);
		assert.equal(settled[0].outcome, "complete", `settled outcome: ${JSON.stringify(settled[0])}`);
		assert.equal(settled[0].jobId, "differential-job-1");
		assert.equal(settled[0].attemptId, "attempt-1");
		assert.equal(settled[0].version, 1);

		// ── Canvas evidence (at least one; the final one is stage=complete) ──
		const canvases = events.filter((e) => e.type === "canvas");
		assert.ok(canvases.length >= 1, "expected at least one canvas event");
		const finalCanvas = canvases.at(-1)!.canvas as {
			stage?: string;
			blocks?: Array<{ id: string; sourceIds?: string[]; dossierHint?: string }>;
			evidenceCitations?: Array<{ sourceId: string; quote: string }>;
		};
		assert.equal(finalCanvas.stage, "complete");
		assert.equal(finalCanvas.symbol, "AAPL");
		const readBlock = finalCanvas.blocks?.find((block) => block.dossierHint === "read");
		assert.ok(readBlock, "complete canvas carries a read block");
		const sourceIds = readBlock?.sourceIds ?? [];
		assert.deepEqual(sourceIds, CONFORMANCE_FIXTURE_URLS.slice(0, 2).map(sourceIdForUrl),
			"source ids use the extension's real S-<sha256-12> scheme");
		// The extension normalizes submitted `citations` to `evidenceCitations`
		// on the stored/emitted canvas.
		const citation = finalCanvas.evidenceCitations?.[0];
		assert.ok(citation && citation.quote === CONFORMANCE_FIXTURE_SENTENCE.slice(0, 80),
			"citation quotes the exact fixture sentence served by the mock MCP");
		assert.ok(sourceIds.includes(citation?.sourceId ?? ""), "citation source id is listed on the read block");

		// ── Job-flow mirror of the Node capture (queued → running → partial → complete) ──
		const jobOutcomes = events
			.filter((e) => e.type === "job")
			.map((e) => String(e.outcome));
		for (const expected of ["queued", "running", "partial", "complete"]) {
			assert.ok(jobOutcomes.includes(expected), `job transition ${expected} observed (got ${jobOutcomes.join(",")})`);
		}
		const toolNames = events
			.filter((e) => e.type === "job")
			.map((e) => String(e.toolName ?? ""))
			.filter(Boolean);
		assert.ok(toolNames.includes("market_technicals"));
		assert.ok(toolNames.includes("market_discover"));
		assert.ok(toolNames.includes("market_extract"));
		assert.ok(toolNames.includes("market_canvas"));

		// ── Protocol integrity: headers + strictly increasing sequence ───────
		assert.ok(events.length >= 4, "expected started/job/canvas/settled stream");
		assert.equal(events[0].type, "started");
		assert.equal(events[0].sequence, 0);
		for (let i = 1; i < events.length; i++) {
			assert.ok(events[i].sequence > events[i - 1].sequence, `sequence strictly increasing at ${i}`);
			assert.equal(events[i].jobId, "differential-job-1");
			assert.equal(events[i].attemptId, "attempt-1");
		}

		// The conformance plan ran the full 5-turn script (no premature stop).
		assert.ok(callCount() >= 5, `expected ≥5 model calls, got ${callCount()}`);

		// Fixture-backed semantic differential: ignore timestamps, generated ids,
		// duplicate renders, and terminal layout while comparing the stable worker
		// contract against the captured Pi scenario.
		const browser = projectBrowserWorkerTrace(events);
		assert.equal(PI_TRACE.panelOpened, true);
		assert.equal(PI_TRACE.panelClosed, true);
		assert.deepEqual(browser.researchTools, [...CONFORMANCE_RESEARCH_TOOLS]);
		assert.equal(browser.finalCanvas?.stage, PI_TRACE.finalCanvas?.stage);
		assert.deepEqual(browser.finalCanvas?.sourceIds, PI_TRACE.finalCanvas?.sourceIds);
		assert.equal(browser.settles[0]?.outcome, PI_TRACE.settles[0]?.outcome);
	} finally {
		await mockMcp.close();
	}
});

// ── Negative control: model HTTP error → settled failed ─────────────────────

test("differential negative control: model HTTP error settles the attempt failed", async () => {
	const mockMcp: MockMcpServerHandle = await startMockMcpServer();
	try {
		const events: CollectedEvent[] = [];
		await runResearchAttempt(RUN, {
			env: workerEnv(mockMcp.endpoint),
			emit: collectEvents(events),
			fetchImpl: failingFetch(),
			settleTimeoutMs: 30_000,
		});

		const settled = events.filter((e) => e.type === "settled");
		assert.equal(settled.length, 1, `expected exactly one settled event, got ${settled.length}`);
		assert.equal(settled[0].outcome, "failed", `settled outcome: ${JSON.stringify(settled[0])}`);
		// The extension surfaces the stopReason "error" mapping from the
		// session's agent_end event (same message the Pi worker produces).
		assert.ok(String(settled[0].error ?? "").includes("model request failed"),
			`settled error: ${JSON.stringify(settled[0].error)}`);
		assert.equal(events.filter((e) => e.type === "canvas").length, 0, "no canvas published on failure");
	} finally {
		await mockMcp.close();
	}
});

// ── Runtime wrapper: coordinator cancel handling ────────────────────────────

test("runtime wrapper: cancel before the run message settles cancelled; cancel mid-run aborts the turn", async () => {
	const mockMcp: MockMcpServerHandle = await startMockMcpServer();
	try {
		const { createBrowserResearchWorkerRuntime } = await import("../web/src/harness/research-worker-core.js");

		// 1. Cancel arrives before the run message → run() emits settled(cancelled).
		{
			let resolveRun: ((run: WorkerRunMessageLike) => void) | undefined;
			const emitted: unknown[] = [];
			const runtime = createBrowserResearchWorkerRuntime({
				env: workerEnv(mockMcp.endpoint),
				emit: (msg) => emitted.push(msg),
				getRunMessage: () => new Promise((resolve) => { resolveRun = resolve; }),
				settleTimeoutMs: 10_000,
			});
			const runningBefore = runtime.run();
			runtime.handleCancel();
			resolveRun?.(RUN);
			await runningBefore;
			const settled = emitted.filter((e) => (e as { type?: string }).type === "settled");
			assert.equal(settled.length, 1, "cancel-before-run emits exactly one settled event");
			assert.equal((settled[0] as { outcome?: string }).outcome, "cancelled");
			assert.equal((settled[0] as { jobId?: string }).jobId, "differential-job-1");
		}

		// 2. Cancel mid-run: the active turn aborts; run() resolves (the worker
		//    side settles the running job — the coordinator has already fenced
		//    the attempt, so no hang and no double-terminal).
		{
			const events: CollectedEvent[] = [];
			const delayedFetch: typeof fetch = async (url, init) => {
				const body = JSON.parse(String(init?.body)) as { messages?: WireMessage[] };
				const plan = planFromMessages(body.messages ?? []);
				// First provider call: tool-call turn (the cancel lands during it).
				const response = chatCompletion(1, plan as Exclude<TurnPlan, { kind: "final" }>);
				await new Promise((resolve) => setTimeout(resolve, 50));
				return response;
			};
			const runtime = createBrowserResearchWorkerRuntime({
				env: workerEnv(mockMcp.endpoint),
				emit: collectEvents(events),
				getRunMessage: () => Promise.resolve(RUN),
				fetchImpl: delayedFetch,
				settleTimeoutMs: 10_000,
			});
			const running = runtime.run();
			// Give the attempt time to boot and reach the first provider call.
			await new Promise((resolve) => setTimeout(resolve, 100));
			runtime.handleCancel();
			await running;
			const settled = events.filter((e) => e.type === "settled");
			assert.equal(settled.length, 1, "mid-run cancel still emits one worker-side settled event");
			assert.ok(["failed", "cancelled"].includes(String(settled[0].outcome)),
				`worker-side settle after abort: ${JSON.stringify(settled[0])}`);
		}
	} finally {
		await mockMcp.close();
	}
});
