/** Browser host ports for the personal alpha and authenticated terminal. */
import {
	CHART_SCOPE_CONFIGS,
	mockMondayChartPayload,
	parseChartPayloadToQuote,
	readMarketMockMonday,
	type ChartScope,
	type Quote,
} from "../../../shared/kernel/quotes.js";
import {
	fetchCryptoPulse,
	resolveYahooPair,
	type CryptoPulseFetchOptions,
	type CryptoPulseSnapshot,
} from "../../../shared/crypto-pulse.js";
import type { EventSinkPort, KernelPorts, StoragePort } from "../../../shared/kernel/ports.js";
import { createBrowserWorkerFactory, type BrowserWorkerFactory } from "./browser-worker-factory.js";
import { createBrowserStoragePort, createMemoryStoragePort } from "./browser-storage.js";
import { browserApiUrl } from "./browser-api.js";

interface BrowserPortsOptions {
	apiKey?: string;
	model?: string;
	unbrowserEndpoint?: string;
	storage?: StoragePort;
	workerFactory?: BrowserWorkerFactory;
	fetchImpl?: typeof fetch;
	events?: EventSinkPort;
	/** Route provider calls through the authenticated same-origin broker. */
	serverBroker?: boolean;
	/** OpenRouter-compatible endpoint used by isolated research workers. */
	apiEndpoint?: string;
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

function serverQuoteUrl(symbol: string, scope: ChartScope): URL {
	const url = new URL(browserApiUrl(`/api/browser/v1/quotes/${encodeURIComponent(symbol)}`));
	url.searchParams.set("scope", scope);
	return url;
}

function createBrowserTransport(options: BrowserPortsOptions) {
	const request = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	return {
		async fetchQuote(symbol: string, scope: ChartScope, signal?: AbortSignal, timeoutMs = 12_000): Promise<Quote> {
			const cfg = CHART_SCOPE_CONFIGS[scope];
			if (readMarketMockMonday(browserEnv()) && scope === "day") {
				return parseChartPayloadToQuote(symbol, mockMondayChartPayload(symbol), { ...cfg, chartScope: scope });
			}
			const url = options.serverBroker ? serverQuoteUrl(symbol, scope) : quoteUrl(symbol);
			if (!options.serverBroker) {
				url.searchParams.set("range", cfg.yahooRange);
				url.searchParams.set("interval", cfg.yahooInterval);
				url.searchParams.set("includePrePost", String(cfg.includePrePost));
			}
			const timeout = AbortSignal.timeout(timeoutMs);
			const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const response = await request(url, { headers: { accept: "application/json" }, signal: requestSignal });
			if (!response.ok) throw new Error(`quote request returned HTTP ${response.status}`);
			const payload = await response.json();
			return options.serverBroker
				? payload as Quote
				: parseChartPayloadToQuote(symbol, payload, { ...cfg, chartScope: scope });
		},
		// Only the authenticated broker can serve a whole universe in one
		// request; the direct-Yahoo dev alpha keeps the per-symbol pool, so the
		// batch seam stays undefined there and fetchQuotes falls back.
		...(options.serverBroker ? {
			async fetchQuotesBatch(symbols: readonly string[], scope: ChartScope, signal?: AbortSignal, timeoutMs = 12_000): Promise<Quote[]> {
				const cfg = CHART_SCOPE_CONFIGS[scope];
				if (readMarketMockMonday(browserEnv()) && scope === "day") {
					return symbols.map((symbol) => parseChartPayloadToQuote(symbol, mockMondayChartPayload(symbol), { ...cfg, chartScope: scope }));
				}
				const url = new URL(browserApiUrl("/api/browser/v1/quotes/batch"));
				url.searchParams.set("scope", scope);
				url.searchParams.set("symbols", symbols.join(","));
				const timeout = AbortSignal.timeout(timeoutMs);
				const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
				const response = await request(url, { headers: { accept: "application/json" }, signal: requestSignal });
				if (!response.ok) throw new Error(`quote batch returned HTTP ${response.status}`);
				const payload = await response.json() as { quotes?: unknown };
				return Array.isArray(payload?.quotes) ? payload.quotes as Quote[] : [];
			},
		} : {}),
		async fetchCryptoPulse(
			pulseOptions: Pick<CryptoPulseFetchOptions, "panicRadarEnabled"> = {},
			signal?: AbortSignal,
		): Promise<{ snapshot: CryptoPulseSnapshot; errors: string[] }> {
			if (!options.serverBroker) return fetchCryptoPulse(pulseOptions, signal);
			const url = new URL(browserApiUrl("/api/browser/v1/crypto/pulse"));
			if (pulseOptions.panicRadarEnabled === false) url.searchParams.set("panicRadar", "0");
			const response = await request(url, { headers: { accept: "application/json" }, signal });
			if (!response.ok) throw new Error(`crypto pulse request returned HTTP ${response.status}`);
			return await response.json() as { snapshot: CryptoPulseSnapshot; errors: string[] };
		},
		async resolveCryptoPair(symbol: string, signal?: AbortSignal): Promise<string | null> {
			if (!options.serverBroker) return resolveYahooPair(symbol, request, undefined, undefined, signal);
			const url = new URL(browserApiUrl(`/api/browser/v1/crypto/pair/${encodeURIComponent(symbol)}`));
			const response = await request(url, { headers: { accept: "application/json" }, signal });
			if (!response.ok) throw new Error(`crypto pair request returned HTTP ${response.status}`);
			const payload = await response.json() as { yahooSymbol?: unknown };
			return typeof payload.yahooSymbol === "string" && payload.yahooSymbol ? payload.yahooSymbol : null;
		},
		unbrowserEndpoint(): string | undefined {
			const configured = options.unbrowserEndpoint?.trim() || browserEnv().UNBROWSER_MCP_URL?.trim();
			return configured || undefined;
		},
	};
}

/**
 * Build ports before registering the canonical extension. The worker factory
 * captures either legacy alpha settings or the authenticated broker endpoint
 * and adds them to each isolated worker's init environment. Provider keys are
 * never put in IndexedDB or a session message.
 */
export function createBrowserKernelPorts(options: BrowserPortsOptions = {}): KernelPorts {
	const endpoint = options.unbrowserEndpoint?.trim() || browserEnv().UNBROWSER_MCP_URL?.trim();
	const storage = options.storage ?? (options.workerProcess ? createMemoryStoragePort() : createBrowserStoragePort());
	const workerFactory = options.workerFactory ?? (options.workerProcess ? undefined : createBrowserWorkerFactory({
		apiKey: options.apiKey,
		model: options.model,
		unbrowserEndpoint: endpoint,
		apiEndpoint: options.apiEndpoint,
	}));
	return {
		clock: { now: () => Date.now() },
		storage,
		transport: createBrowserTransport(options),
		events: options.events ?? { notify: () => {} },
		...(workerFactory ? { workerFactory } : {}),
	};
}
