import assert from "node:assert/strict";
import test from "node:test";
import {
	configureMarketTerminalRuntime,
	fetchQuotes,
	resetMarketTerminalRuntime,
	snapshotUniverseDegraded,
} from "../.pi/extensions/market-terminal.js";
import { CHART_SCOPE_CONFIGS, parseChartPayloadToQuote, type ChartScope, type Quote } from "../shared/kernel/quotes.js";
import type { KernelPorts } from "../shared/kernel/ports.js";

function fixtureQuote(symbol: string, scope: ChartScope): Quote {
	return parseChartPayloadToQuote(symbol, {
		chart: {
			result: [{
				meta: { symbol, regularMarketPrice: 100, chartPreviousClose: 99, dataGranularity: CHART_SCOPE_CONFIGS[scope].yahooInterval },
				timestamp: [1, 2, 3],
				indicators: { quote: [{ close: [99, 100, 100.5], volume: [10, 20, 30] }] },
			}],
		},
	}, { ...CHART_SCOPE_CONFIGS[scope], chartScope: scope });
}

function stubPorts(transport: Partial<KernelPorts["transport"]>): KernelPorts {
	return {
		clock: { now: () => Date.now() },
		storage: {
			resolveDataPath: (relative) => relative,
			readJsonFile: async () => undefined,
			writeJsonFileAtomic: async () => {},
		},
		transport: {
			fetchQuote: async () => { throw new Error("per-symbol fetch must not run when a batch is available"); },
			fetchCryptoPulse: async () => ({ snapshot: {} as never, errors: [] }),
			resolveCryptoPair: async () => null,
			unbrowserEndpoint: () => undefined,
			...transport,
		} as KernelPorts["transport"],
		events: { notify: () => {} },
	};
}

test("fetchQuotes uses the host batch transport for a whole-universe refresh", async () => {
	const batches: Array<{ symbols: readonly string[]; scope: string; timeoutMs: number }> = [];
	configureMarketTerminalRuntime(stubPorts({
		fetchQuotesBatch: async (symbols, scope, _signal, timeoutMs) => {
			batches.push({ symbols, scope, timeoutMs: timeoutMs ?? -1 });
			return symbols.map((symbol) => fixtureQuote(symbol, scope));
		},
	}));
	try {
		const quotes = await fetchQuotes(["AAPL", "MSFT", "NVDA"], "week", undefined, 9_000);
		assert.deepEqual(quotes.map((quote) => quote.symbol), ["AAPL", "MSFT", "NVDA"]);
		assert.deepEqual(batches, [{ symbols: ["AAPL", "MSFT", "NVDA"], scope: "week", timeoutMs: 9_000 }]);
	} finally {
		resetMarketTerminalRuntime();
	}
});

test("fetchQuotes falls back to the per-symbol pool when no batch transport exists", async () => {
	const fetched: string[] = [];
	configureMarketTerminalRuntime(stubPorts({
		fetchQuote: async (symbol) => {
			fetched.push(symbol);
			return fixtureQuote(symbol, "day");
		},
	}));
	try {
		const quotes = await fetchQuotes(["AAPL", "MSFT"], "day");
		assert.deepEqual(fetched, ["AAPL", "MSFT"]);
		assert.deepEqual(quotes.map((quote) => quote.symbol), ["AAPL", "MSFT"]);
	} finally {
		resetMarketTerminalRuntime();
	}
});

test("a failed batch refresh surfaces as an empty universe, not a throw", async () => {
	configureMarketTerminalRuntime(stubPorts({
		fetchQuotesBatch: async () => { throw new Error("quote batch returned HTTP 429"); },
	}));
	try {
		const quotes = await fetchQuotes(["AAPL"], "day");
		assert.deepEqual(quotes, []);
	} finally {
		resetMarketTerminalRuntime();
	}
});

test("snapshotUniverseDegraded rejects a truncated universe at the halfway threshold", () => {
	assert.equal(snapshotUniverseDegraded(0, 126), true);
	assert.equal(snapshotUniverseDegraded(9, 126), true, "the boards-only partial that corrupted the relay must be rejected");
	assert.equal(snapshotUniverseDegraded(62, 126), true, "49% of the universe is degraded");
	assert.equal(snapshotUniverseDegraded(63, 126), false, "exactly half the universe is still usable");
	assert.equal(snapshotUniverseDegraded(126, 126), false);
	assert.equal(snapshotUniverseDegraded(3, 0), false, "an unknown universe size never degrades");
});
