/**
 * framework-free kernel ports — stage 1 slice 2.
 *
 * The mutable/research side of the market-terminal extension talks to its
 * environment exclusively through these ports so the Pi runtime (Node) and the
 * future browser adapter can share one MarketState container. The Node
 * implementation below mirrors the exact behavior of the code it was extracted
 * from (.pi/extensions/market-terminal.ts); it must not fork that behavior.
 *
 * Port contract:
 * - clock:   wall-clock time source (Node default = Date.now).
 * - storage: JSON-file semantics (IndexedDB implements the same contract in
 *            the browser slice). resolveDataPath resolves the DIRECTORY the
 *            archive/ledger/scout files live in: MARKET_DATA_DIR when set
 *            (absolute only), otherwise <cwd>/.pi — mirroring
 *            marketEventScoutFilePath / precacheLedgerFilePath / the
 *            extension's readProjectArchive logic. Existing path helpers in
 *            shared/market-event-scout.ts and shared/research-precache-ledger.ts
 *            stay as-is; the port only owns the directory resolution.
 * - transport: quote fetching (Yahoo chart API through fetch) + the Unbrowser
 *            MCP endpoint discovery.
 * - events:  UI notification sink (Node default no-op; the extension wires
 *            ctx.ui.notify at session construction in the browser slice).
 */

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
	CHART_SCOPE_CONFIGS,
	mockMondayChartPayload,
	parseChartPayloadToQuote,
	readMarketMockMonday,
	type ChartScope,
	type Quote,
} from "./quotes.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** Per-request quote fetch timeout (moved from the extension, exported for reuse). */
export const QUOTE_REQUEST_TIMEOUT_MS = 12_000;
/** Max concurrent quote requests within one universe refresh (moved from the extension). */
export const QUOTE_FETCH_CONCURRENCY = 8;

// ── Port interfaces ─────────────────────────────────────────────────────────

export interface ClockPort {
	now(): number;
}

/**
 * JSON-file storage semantics. The browser adapter implements the same
 * contract on IndexedDB transactions; callers must treat `readJsonFile`
 * returning `undefined` as "file does not exist" (ENOENT) and must handle
 * malformed JSON themselves (throws).
 */
export interface StoragePort {
	/**
	 * Resolve the DIRECTORY a relative data file lives in. `baseCwd` is the
	 * session working directory (the Pi extension passes ctx.cwd); when omitted
	 * the Node implementation falls back to process.cwd().
	 */
	resolveDataPath(relative: string, baseCwd?: string): string;
	/** Read + parse a JSON file; undefined when it does not exist (ENOENT). */
	readJsonFile(path: string): Promise<unknown | undefined>;
	/** Atomic write: tmp file + write + fsync + rename + directory fsync. */
	writeJsonFileAtomic(path: string, value: unknown): Promise<void>;
}

export interface TransportPort {
	/**
	 * Fetch one delayed quote for the given chart scope. Node impl = the
	 * extension's fetchQuote body verbatim (including the MARKET_MOCK_MONDAY
	 * gate for day scope); `timeoutMs` defaults to QUOTE_REQUEST_TIMEOUT_MS.
	 */
	fetchQuote(symbol: string, scope: ChartScope, signal?: AbortSignal, timeoutMs?: number): Promise<Quote>;
	/** Trimmed UNBROWSER_MCP_URL, or undefined when unset. */
	unbrowserEndpoint(): string | undefined;
}

export interface EventSinkPort {
	notify(message: string, level: string): void;
}

/**
 * Structural worker-factory seam (stage 2b): lets a host inject a browser
 * Worker factory instead of the Node fork default. The shape mirrors
 * server/research-worker-coordinator.ts WorkerHandle/WorkerFactory exactly,
 * but is declared locally so the framework-free kernel never imports server
 * modules. createNodeKernelPorts leaves it undefined → the extension falls
 * back to createDefaultWorkerFactory (fork).
 */
export interface KernelWorkerFactory {
	(env: Record<string, string>): {
		send(message: unknown): void;
		onMessage(handler: (msg: unknown) => void): void;
		onExit(handler: (code: number | null, signal: string | null) => void): void;
		onError(handler: (err: Error) => void): void;
		kill(signal?: string): void;
	};
}

export interface KernelPorts {
	clock: ClockPort;
	storage: StoragePort;
	transport: TransportPort;
	events: EventSinkPort;
	/** Browser worker factory (stage 2b); undefined under Node → fork default. */
	workerFactory?: KernelWorkerFactory;
}

// ── Node implementations ────────────────────────────────────────────────────

function createNodeClockPort(): ClockPort {
	return { now: () => Date.now() };
}

function createNodeStoragePort(): StoragePort {
	return {
		resolveDataPath(relative: string, baseCwd?: string): string {
			const configured = process.env.MARKET_DATA_DIR?.trim();
			if (configured) {
				if (!isAbsolute(configured)) throw new Error("MARKET_DATA_DIR must be an absolute path");
				return join(configured, relative);
			}
			return join(baseCwd ?? process.cwd(), ".pi", relative);
		},
		async readJsonFile(path: string): Promise<unknown | undefined> {
			let text: string;
			try {
				text = await readFile(path, "utf8");
			} catch (error) {
				if ((error as { code?: string }).code === "ENOENT") return undefined;
				throw error;
			}
			return JSON.parse(text);
		},
		async writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
			// Mirrors the shared/research-precache-ledger.ts writeLedger pattern:
			// tmp file + write + fsync + rename + directory fsync; pretty-printed
			// like the extension's writeResearchArchive (JSON.stringify(value, null, 2)).
			await mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
			try {
				const handle = await open(tmp, "wx");
				try {
					await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(tmp, path);
				const directory = await open(dirname(path), "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			} catch (error) {
				await rm(tmp, { force: true }).catch(() => {});
				throw error;
			}
		},
	};
}

export function createNodeTransportPort(options: { fetchImpl?: typeof fetch } = {}): TransportPort {
	const { fetchImpl } = options;
	return {
		async fetchQuote(
			symbol: string,
			scope: ChartScope,
			signal?: AbortSignal,
			timeoutMs = QUOTE_REQUEST_TIMEOUT_MS,
		): Promise<Quote> {
			const cfg = CHART_SCOPE_CONFIGS[scope];
			if (readMarketMockMonday() && scope === "day") {
				return parseChartPayloadToQuote(symbol, mockMondayChartPayload(symbol), { ...cfg, chartScope: scope });
			}
			const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
			url.searchParams.set("range", cfg.yahooRange);
			url.searchParams.set("interval", cfg.yahooInterval);
			url.searchParams.set("includePrePost", String(cfg.includePrePost));

			const timeout = AbortSignal.timeout(timeoutMs);
			const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			// Resolved per call so tests that patch globalThis.fetch after port
			// construction (quote-refresh-timeout) keep working.
			const request = fetchImpl ?? globalThis.fetch;
			const response = await request(url, {
				headers: { accept: "application/json", "user-agent": "signal-terminal-mvp/0.1" },
				signal: requestSignal,
			});
			if (!response.ok) throw new Error(`quote request returned HTTP ${response.status}`);

			const payload = await response.json();
			return parseChartPayloadToQuote(symbol, payload, { ...cfg, chartScope: scope });
		},
		unbrowserEndpoint(): string | undefined {
			const value = process.env.UNBROWSER_MCP_URL?.trim();
			return value || undefined;
		},
	};
}

export function createNodeEventSinkPort(): EventSinkPort {
	return { notify: () => {} };
}

/**
 * Assemble the default Node kernel ports. Individual ports can be overridden
 * (tests inject fixtures/deterministic fakes here).
 */
export function createNodeKernelPorts(overrides: Partial<KernelPorts> = {}): KernelPorts {
	return {
		clock: overrides.clock ?? createNodeClockPort(),
		storage: overrides.storage ?? createNodeStoragePort(),
		transport: overrides.transport ?? createNodeTransportPort(),
		events: overrides.events ?? createNodeEventSinkPort(),
	};
}
