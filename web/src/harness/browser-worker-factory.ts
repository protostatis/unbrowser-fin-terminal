/**
 * Browser Worker factory for the research-worker coordinator (stage 2b).
 *
 * Implements the coordinator's structural `WorkerHandle` contract on top of a
 * Web Worker running web/src/harness/research-worker.browser.ts:
 *
 *   - `new Worker(new URL(...), { type: "module" })` — vite statically
 *     analyzes this pattern and emits the worker as its own chunk.
 *   - Post `{ type: "init", env }` immediately; RUN/CANCEL messages are queued
 *     until the worker replies `init_ack` (the worker must apply env and boot
 *     the extension before it can parse a run payload).
 *   - `onMessage` forwards every worker message EXCEPT the handshake messages
 *     (`init_ack`, `__exit`) — the coordinator validates everything it sees
 *     via `isWorkerEvent`, which would reject both.
 *   - `onExit` fires when the worker posts `{ type: "__exit" }` (posted before
 *     `close()`) or when the worker errors out — Web Workers have no native
 *     exit event, so the adapter synthesizes the lifecycle.
 *   - `kill` terminates the worker and fires onExit (the coordinator releases
 *     the slot via onExit for terminal workers; killAndRelease is idempotent).
 *
 * The factory only depends on browser APIs — no server imports (the design
 * constraint: web/src files keep imports to shared/ + local unless the
 * tsconfig includes server).
 */

export interface BrowserWorkerHandle {
	send(message: unknown): void;
	onMessage(handler: (msg: unknown) => void): void;
	onExit(handler: (code: number | null, signal: string | null) => void): void;
	onError(handler: (err: Error) => void): void;
	kill(signal?: string): void;
}

export type BrowserWorkerFactory = (env: Record<string, string>) => BrowserWorkerHandle;

export interface BrowserWorkerFactoryOptions {
	apiKey?: string;
	model?: string;
	unbrowserEndpoint?: string;
}

const INIT_ACK = "init_ack";
const EXIT = "__exit";

export function createBrowserWorkerFactory(options: BrowserWorkerFactoryOptions = {}): BrowserWorkerFactory {
	return (env: Record<string, string>): BrowserWorkerHandle => {
		const worker = new Worker(new URL("./research-worker.browser.ts", import.meta.url), { type: "module" });
		const browserAlphaConfigured = Boolean(options.apiKey || options.model || options.unbrowserEndpoint);
		const workerEnv = {
			...env,
			...(options.apiKey ? { BROWSER_API_KEY: options.apiKey } : {}),
			...(options.model ? { BROWSER_MODEL: options.model } : {}),
			...(options.unbrowserEndpoint ? { UNBROWSER_MCP_URL: options.unbrowserEndpoint } : {}),
			...(browserAlphaConfigured ? {
				MARKET_PRECACHE_ENABLED: "0",
				MARKET_SCOUT_ENABLED: "0",
				MARKET_RESEARCH_CONCURRENCY: "1",
			} : {}),
		};

		let acked = false;
		let onMessageHandler: ((msg: unknown) => void) | undefined;
		let onExitHandler: ((code: number | null, signal: string | null) => void) | undefined;
		let onErrorHandler: ((err: Error) => void) | undefined;
		let exited = false;
		const pending: unknown[] = [];

		const fireExit = (code: number | null, signal: string | null): void => {
			if (exited) return;
			exited = true;
			onExitHandler?.(code, signal);
		};

		worker.onmessage = (event: MessageEvent) => {
			const msg = event.data as { type?: unknown } | null | undefined;
			if (!msg || typeof msg !== "object") return;
			if (msg.type === INIT_ACK) {
				acked = true;
				for (const queued of pending.splice(0)) worker.postMessage(queued);
				return;
			}
			if (msg.type === EXIT) {
				// Posted by the entry just before close(): treat as a clean exit.
				fireExit(0, null);
				return;
			}
			onMessageHandler?.(msg);
		};
		worker.onerror = (event: ErrorEvent) => {
			const error = event?.error instanceof Error
				? event.error
				: new Error(event?.message ?? "Research worker reported an error");
			onErrorHandler?.(error);
			// An uncaught worker error is also an exit (the worker is dead).
			fireExit(1, null);
		};

		// Kick the handshake: the worker applies env and boots the extension
		// before it can accept a run payload.
		worker.postMessage({ type: "init", env: workerEnv });

		return {
			send(message: unknown): void {
				if (!acked) {
					pending.push(message);
					return;
				}
				worker.postMessage(message);
			},
			onMessage(handler: (msg: unknown) => void): void {
				onMessageHandler = handler;
			},
			onExit(handler: (code: number | null, signal: string | null) => void): void {
				onExitHandler = handler;
			},
			onError(handler: (err: Error) => void): void {
				onErrorHandler = handler;
			},
			kill(_signal?: string): void {
				try {
					worker.terminate();
				} catch {
					// Already dead.
				}
				// Web Workers never emit an exit event; the coordinator waits
				// for onExit to release the slot.
				fireExit(0, null);
			},
		};
	};
}
