/** Browser host ports for the personal alpha. */
import {
	CHART_SCOPE_CONFIGS,
	mockMondayChartPayload,
	parseChartPayloadToQuote,
	readMarketMockMonday,
	type ChartScope,
	type Quote,
} from "../../../shared/kernel/quotes.js";
import type { EventSinkPort, KernelPorts, StoragePort } from "../../../shared/kernel/ports.js";
import { createBrowserWorkerFactory, type BrowserWorkerFactory } from "./browser-worker-factory.js";
import { createBrowserStoragePort, createMemoryStoragePort } from "./browser-storage.js";

interface BrowserPortsOptions {
	apiKey?: string;
	model?: string;
	unbrowserEndpoint?: string;
	storage?: StoragePort;
	workerFactory?: BrowserWorkerFactory;
	fetchImpl?: typeof fetch;
	events?: EventSinkPort;
	/** Use the in-memory port for a research worker; workers never archive. */
	workerProcess?: boolean;
}

function browserEnv(): Record<string, string | undefined> {
	return ((globalThis as typeof globalThis & { __browserProcess?: { env: Record<string, string | undefined> } }).__browserProcess?.env) ?? {};
}

function browserQuoteBase(): string {
	const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
	const configured = viteEnv?.VITE_QUOTE_ENDPOINT?.trim();
	if (configured) return configured;
	// Vite dev serves this path through its same-origin Yahoo proxy. Preview and
	// production keep the direct URL unless the deployment supplies a transport.
	return viteEnv?.DEV ? "/yahoo" : "https://query1.finance.yahoo.com";
}

function quoteUrl(symbol: string): URL {
	const base = browserQuoteBase().replace(/\/$/, "");
	const path = `/v8/finance/chart/${encodeURIComponent(symbol)}`;
	if (base.startsWith("/")) {
		return new URL(`${base}${path}`, globalThis.location?.origin ?? "http://localhost");
	}
	return new URL(`${base}${path}`);
}

function createBrowserTransport(options: BrowserPortsOptions) {
	const request = options.fetchImpl ?? globalThis.fetch;
	return {
		async fetchQuote(symbol: string, scope: ChartScope, signal?: AbortSignal, timeoutMs = 12_000): Promise<Quote> {
			const cfg = CHART_SCOPE_CONFIGS[scope];
			if (readMarketMockMonday(browserEnv()) && scope === "day") {
				return parseChartPayloadToQuote(symbol, mockMondayChartPayload(symbol), { ...cfg, chartScope: scope });
			}
			const url = quoteUrl(symbol);
			url.searchParams.set("range", cfg.yahooRange);
			url.searchParams.set("interval", cfg.yahooInterval);
			url.searchParams.set("includePrePost", String(cfg.includePrePost));
			const timeout = AbortSignal.timeout(timeoutMs);
			const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const response = await request(url, { headers: { accept: "application/json" }, signal: requestSignal });
			if (!response.ok) throw new Error(`quote request returned HTTP ${response.status}`);
			return parseChartPayloadToQuote(symbol, await response.json(), { ...cfg, chartScope: scope });
		},
		unbrowserEndpoint(): string | undefined {
			const configured = options.unbrowserEndpoint?.trim() || browserEnv().UNBROWSER_MCP_URL?.trim();
			return configured || undefined;
		},
	};
}

/**
 * Build ports before registering the canonical extension. The worker factory
 * captures the BYOK settings and adds them to each isolated worker's init
 * environment; the key is never put in IndexedDB or a session message.
 */
export function createBrowserKernelPorts(options: BrowserPortsOptions = {}): KernelPorts {
	const endpoint = options.unbrowserEndpoint?.trim() || browserEnv().UNBROWSER_MCP_URL?.trim();
	const storage = options.storage ?? (options.workerProcess ? createMemoryStoragePort() : createBrowserStoragePort());
	const workerFactory = options.workerFactory ?? (options.workerProcess ? undefined : createBrowserWorkerFactory({
		apiKey: options.apiKey,
		model: options.model,
		unbrowserEndpoint: endpoint,
	}));
	return {
		clock: { now: () => Date.now() },
		storage,
		transport: createBrowserTransport(options),
		events: options.events ?? { notify: () => {} },
		...(workerFactory ? { workerFactory } : {}),
	};
}
