import { test, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import {
	CONFORMANCE_FIXTURE_SENTENCE,
	CONFORMANCE_FIXTURE_URLS,
} from "../../server/conformance-mock-model.js";
import { sourceIdForUrl } from "../../shared/kernel/hash.js";
import { mockMondayChartPayload } from "../../shared/kernel/quotes.js";

const MCP_ENDPOINT = "http://browser-e2e.invalid/mcp";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ALLOWED_EXTERNAL_PREFIXES = [
	"https://openrouter.ai/",
	"https://query1.finance.yahoo.com/",
	MCP_ENDPOINT,
];

type WireMessage = {
	role?: string;
	content?: unknown;
	tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
};

function corsHeaders(origin = "http://127.0.0.1:45173"): Record<string, string> {
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-headers": "content-type, authorization",
		"access-control-allow-methods": "POST, OPTIONS",
		"content-type": "application/json",
	};
}

const ARTICLE_CONTENT = [
	"# Connected browser fixture",
	"",
	CONFORMANCE_FIXTURE_SENTENCE,
	"The company reported quarterly results and reaffirmed its capital allocation program.",
].join("\n");

function mcpToolText(name: string, args: Record<string, unknown>): string {
	if (name === "navigate") {
		const url = String(args.url ?? "");
		const isSearch = url.startsWith("https://lite.duckduckgo.com/lite/");
		return JSON.stringify({
			url,
			status: isSearch ? 200 : CONFORMANCE_FIXTURE_URLS.includes(url as (typeof CONFORMANCE_FIXTURE_URLS)[number]) ? 200 : 404,
			headers: { "content-type": "text/html; charset=utf-8" },
			blockmap: {
				density: { likely_js_filled: false, thin_shell: false },
				interactives: {
					link_samples: isSearch
						? CONFORMANCE_FIXTURE_URLS.map((fixtureUrl) => ({ text: `Fixture result for ${fixtureUrl}`, href: fixtureUrl }))
						: [],
				},
			},
		});
	}
	if (name === "text_main" || name === "body") return JSON.stringify(ARTICLE_CONTENT);
	if (name === "table_to_json") return JSON.stringify({ rows: [{ period: "Q2 2026", revenue: "$95B" }] });
	if (name === "extract_cards") return JSON.stringify([{ headline: "Connected fixture", url: CONFORMANCE_FIXTURE_URLS[0] }]);
	return JSON.stringify({ error: `unknown tool ${name}` });
}

async function routeMcp(route: Route, requests: Array<{ method: string; body?: unknown }>): Promise<void> {
	const request = route.request();
	const headers = {
		...corsHeaders(),
		"access-control-allow-headers": "content-type, mcp-session-id",
		"access-control-allow-methods": "POST, DELETE, OPTIONS",
		"access-control-expose-headers": "mcp-session-id",
		"mcp-session-id": "browser-e2e-session",
	};
	if (request.method() === "OPTIONS") {
		await route.fulfill({ status: 204, headers });
		return;
	}
	if (request.method() === "DELETE") {
		await route.fulfill({ status: 204, headers });
		return;
	}
	requests.push({ method: request.method(), body: request.postDataJSON() });
	const body = request.postDataJSON() as {
		id?: string | number;
		method?: string;
		params?: { name?: string; arguments?: Record<string, unknown> };
	};
	if (body.method === "notifications/initialized") {
		await route.fulfill({ status: 202, headers, body: "" });
		return;
	}
	const result = body.method === "initialize"
		? {
			protocolVersion: "2025-03-26",
			capabilities: {},
			serverInfo: { name: "browser-e2e-mcp", version: "1" },
		}
		: body.method === "tools/call"
			? { content: [{ type: "text", text: mcpToolText(body.params?.name ?? "", body.params?.arguments ?? {}) }] }
			: undefined;
	await route.fulfill({
		status: result ? 200 : 400,
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, ...(result ? { result } : { error: { message: `unhandled method ${body.method}` } }) }),
	});
}

function responseForToolCalls(messages: WireMessage[]): Array<{
	name: string;
	args: Record<string, unknown>;
}> {
	const prompt = String(
		[...messages].reverse().find((message) => message.role === "user")?.content ?? "",
	);
	const researchId = /research_id=([A-Za-z0-9_-]{1,160})/.exec(prompt)?.[1] ?? "job-unknown";
	const target = /target=([A-Za-z0-9.^$-]{1,20})/.exec(prompt)?.[1]
		?? /(?:^|\n)Research ([A-Za-z0-9.^$-]{1,20}) /.exec(prompt)?.[1]
		?? "MARKET";
	const symbol = target === "MARKET" ? "MARKET" : target;
	const marketScope = symbol === "MARKET";
	const executed = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const call of message.tool_calls ?? []) {
			if (call.function?.name) executed.add(call.function.name);
		}
	}

	if (!executed.has("market_technicals")) {
		return [{
			name: "market_technicals",
			args: { scope: marketScope ? "market" : "ticker", ...(marketScope ? {} : { symbol }), research_id: researchId },
		}];
	}
	if (!executed.has("market_discover")) {
		return [{
			name: "market_discover",
			args: { scope: marketScope ? "market" : "ticker", ...(marketScope ? {} : { symbol }), research_id: researchId },
		}];
	}
	if (!executed.has("market_extract")) {
		const lastTool = [...messages].reverse().find((message) => message.role === "tool");
		const ids = [...String(lastTool?.content ?? "").matchAll(/candidate_id=([A-Za-z0-9_-]{8,160})/g)]
			.map((match) => match[1]!)
			.slice(0, 2);
		return ids.map((candidateId) => ({
			name: "market_extract",
			args: { research_id: researchId, candidate_id: candidateId, mode: "text_main" },
		}));
	}
	if (!executed.has("market_canvas")) {
		const sourceIds = CONFORMANCE_FIXTURE_URLS.slice(0, 2).map(sourceIdForUrl);
		return [{
			name: "market_canvas",
			args: {
				symbol,
				title: `${symbol} connected browser brief`,
				research_id: researchId,
				stage: "complete",
				content: "",
				blocks: [
					{
						id: "read",
						kind: "text",
						title: "Summary",
						text: `${symbol} was reviewed from verified public reporting in the connected browser session.`,
						sourceIds,
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
				citations: [{ source_id: sourceIds[0], quote: CONFORMANCE_FIXTURE_SENTENCE.slice(0, 80) }],
			},
		}];
	}
	return [];
}

async function routeOpenRouter(route: Route, requests: WireMessage[][], toolLists: string[][]): Promise<void> {
	const body = route.request().postDataJSON() as { messages?: WireMessage[]; tools?: Array<{ function?: { name?: string } }> };
	const messages = body.messages ?? [];
	requests.push(messages);
	toolLists.push((body.tools ?? []).map((tool) => String(tool.function?.name ?? "")));
	const next = responseForToolCalls(messages);
	const payload = next.length > 0
		? {
			choices: [{
				message: {
					role: "assistant",
					content: null,
					tool_calls: next.map((call, index) => ({
						id: `e2e-${requests.length}-${index}`,
						type: "function",
						function: { name: call.name, arguments: JSON.stringify(call.args) },
					})),
				},
				finish_reason: "tool_calls",
			}],
			usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
		}
		: {
			choices: [{
				message: { role: "assistant", content: "Connected browser research complete." },
				finish_reason: "stop",
			}],
			usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
		};
	await route.fulfill({ status: 200, headers: corsHeaders(), body: JSON.stringify(payload) });
}

async function installNetworkFixtures(context: BrowserContext): Promise<{
	modelRequests: WireMessage[][];
	toolLists: string[][];
	mcpRequests: Array<{ method: string; body?: unknown }>;
	unexpected: string[];
}> {
	const modelRequests: WireMessage[][] = [];
	const toolLists: string[][] = [];
	const mcpRequests: Array<{ method: string; body?: unknown }> = [];
	const unexpected: string[] = [];
	await context.route("**/*", async (route) => {
		const request = route.request();
		const url = request.url();
		if (request.method() === "OPTIONS" && (url === OPENROUTER_URL || url.startsWith("https://query1.finance.yahoo.com/"))) {
			await route.fulfill({ status: 204, headers: corsHeaders() });
			return;
		}
		if (url === OPENROUTER_URL && request.method() === "POST") {
			await routeOpenRouter(route, modelRequests, toolLists);
			return;
		}
		if (url.startsWith("https://query1.finance.yahoo.com/")) {
			await route.fulfill({
				status: 200,
				headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
				body: JSON.stringify(mockMondayChartPayload("AAPL")),
			});
			return;
		}
		if (url.startsWith(MCP_ENDPOINT)) {
			await routeMcp(route, mcpRequests);
			return;
		}
		if (url.startsWith("http://127.0.0.1:45173/") || url === "http://127.0.0.1:45173") {
			await route.continue();
			return;
		}
		if (!ALLOWED_EXTERNAL_PREFIXES.some((prefix) => url.startsWith(prefix))) unexpected.push(`${request.method()} ${url}`);
		await route.abort();
	});
	return { modelRequests, toolLists, mcpRequests, unexpected };
}

async function archiveEntries(page: Page): Promise<Array<{ canvas?: { stage?: string } }>> {
	return page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("unbrowser-fin-terminal", 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await new Promise<Array<{ canvas?: { stage?: string } }>>((resolve, reject) => {
				const request = db.transaction("files", "readonly").objectStore("files").getAll();
				request.onsuccess = () => {
					const record = request.result.find((entry: { path?: string }) => entry.path?.endsWith("market-research-archive.json"));
					if (!record) return resolve([]);
					try {
						resolve(JSON.parse(record.text).entries ?? []);
					} catch (error) {
						reject(error);
					}
				};
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	});
}

test("browser alpha runs a real worker, persists the archive, and reloads the cache", async ({ page, context }) => {
	const { modelRequests, toolLists, mcpRequests, unexpected } = await installNetworkFixtures(context);
	const diagnostics: string[] = [];
	page.on("console", (message) => diagnostics.push(`console ${message.type()}: ${message.text()}`));
	page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.stack ?? error.message}`));
	context.on("requestfailed", (request) => diagnostics.push(`requestfailed ${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`));
	try {
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "Connect your OpenRouter key" })).toBeVisible();
		await page.locator('input[type="password"]').pressSequentially("sk-e2e-only");
		await page.getByRole("button", { name: "Connect" }).click();
		await expect(page.locator(".browser-alpha-shell")).toBeVisible();
		await expect(page.locator("body")).toContainText("MARKET MAP SYNCED");
		await expect(page.locator("body")).not.toContainText("Research pre-warm disabled");

		// The semantic overlay must drive the same canonical Enter path as the
		// terminal keyboard; the ticker's J then starts the brief research flow.
		await page.getByRole("button", { name: "Open market controls" }).click();
		await page.getByRole("button", { name: "Open selected item" }).click();
		await expect(page.locator("body")).toContainText("DAY QUOTE");
		await page.keyboard.press("j");
		try {
			await expect.poll(() => archiveEntries(page), { timeout: 60_000 }).toEqual(
				expect.arrayContaining([expect.objectContaining({ canvas: expect.objectContaining({ stage: "complete" }) })]),
			);
		} catch (error) {
			const modelSummary = modelRequests.map((messages, index) => ({
				index: index + 1,
				lastRole: messages.at(-1)?.role,
				assistantCalls: messages
					.filter((message) => message.role === "assistant")
					.flatMap((message) => (message.tool_calls ?? []).map((call) => call.function?.name)),
				lastTool: String(messages.findLast((message) => message.role === "tool")?.content ?? "").slice(0, 5_000),
			}));
			throw new Error(`${error instanceof Error ? error.message : String(error)}\nDiagnostics:\n${diagnostics.join("\n")}\nModel requests: ${modelRequests.length}\n${JSON.stringify(modelSummary)}\nMCP requests: ${JSON.stringify(mcpRequests)}\nUnexpected: ${unexpected.join("\n")}`);
		}

		// The worker sends exactly the four research tools, not the UI/debug tools.
		expect(modelRequests.length).toBeGreaterThanOrEqual(5);
		expect(toolLists[0]?.sort()).toEqual([
			"market_canvas",
			"market_discover",
			"market_extract",
			"market_technicals",
		].sort());
		const modelRequestCount = modelRequests.length;

		await page.keyboard.press("q");
		await expect(page.getByRole("dialog", { name: "Panel closed" })).toBeVisible();
		await page.getByRole("button", { name: "Reopen Market Map" }).click();
		await expect(page.locator("body")).toContainText("MARKET MAP SYNCED");

		await page.getByRole("button", { name: "Disconnect & clear key" }).click();
		await expect(page.getByRole("heading", { name: "Connect your OpenRouter key" })).toBeVisible();
		await page.locator('input[type="password"]').pressSequentially("sk-e2e-only");
		await page.getByRole("button", { name: "Connect" }).click();
		await expect(page.locator(".browser-alpha-shell")).toBeVisible();
		await expect(page.locator("body")).toContainText("MARKET MAP SYNCED");
		await expect(page.locator("body")).not.toContainText("Research pre-warm disabled");
		await page.keyboard.press("j");
		await expect(page.locator("body")).toContainText("DAY QUOTE");
		await page.keyboard.press("j");
		await expect(page.locator("body")).toContainText("CACHE ^GSPC");
		expect(modelRequests.length).toBe(modelRequestCount);
		expect(unexpected).toEqual([]);
	} finally {
		await context.unroute("**/*");
	}
});
