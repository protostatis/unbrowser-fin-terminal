/**
 * Isolated research worker — browser Worker entry (stage 2b).
 *
 * Message protocol with the parent (createBrowserWorkerFactory adapter):
 *
 *   parent → worker:  { type: "init", env: Record<string,string> }
 *   worker → parent:  { type: "init_ack" }
 *   parent → worker:  { type: "run", ... } | { type: "cancel", jobId, attemptId }
 *   worker → parent:  WorkerEvent stream (started/job/canvas/settled/fatal —
 *                     server/research-worker-protocol.ts shape) then
 *                     { type: "__exit" } before close()
 *
 * Ordering is critical: the extension module reads `process.env` at module
 * top-level (`isResearchWorkerProcess`), so the env is applied to the mutable
 * process shim and `process.send` is installed BEFORE the extension is
 * imported (dynamic import after env setup). `process` and `Buffer` here are
 * the vite-defined shims (browser-process.ts / browser-buffer.ts), imported
 * statically so their `globalThis` registration happens first.
 */

import process from "./browser-process.js";
import "./browser-buffer.js";

interface InitMessage {
	type: "init";
	env?: Record<string, string>;
}

interface RunMessage {
	type: "run";
	version?: unknown;
	jobId?: unknown;
	attemptId?: unknown;
	request?: unknown;
}

interface CancelMessage {
	type: "cancel";
}

type ParentMessageLike = InitMessage | RunMessage | CancelMessage;

let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let resolveRunMessage: ((msg: RunMessage) => void) | undefined;
let runMessagePromise: Promise<RunMessage> | undefined;
let booted = false;

async function createRuntime() {
	const core = await import("./research-worker-core.js");
	return core.createBrowserResearchWorkerRuntime({
		env: process.env as Record<string, string>,
		emit: (msg: unknown) => self.postMessage(msg),
		getRunMessage: () => {
			if (!runMessagePromise) {
				runMessagePromise = new Promise<RunMessage>((resolve) => {
					resolveRunMessage = resolve;
				});
			}
			return runMessagePromise as Promise<import("./research-worker-core.js").WorkerRunMessageLike>;
		},
	});
}

/** Exit handshake: flush the terminal event stream, then self-close. */
async function exitWorker(): Promise<void> {
	self.postMessage({ type: "__exit" });
	// The coordinator's terminal-grace timer would terminate us anyway, but
	// closing promptly releases the concurrency slot sooner. The small delay
	// lets the parent's message handler drain the final postMessage queue
	// before close() destroys the worker's event loop.
	await new Promise((resolve) => setTimeout(resolve, 150));
	self.close();
}

self.onmessage = (event: MessageEvent) => {
	const message = event.data as ParentMessageLike;
	if (!message || typeof message !== "object") return;

	if (message.type === "init" && !booted) {
		booted = true;
		// Apply the parent-supplied environment BEFORE the extension module
		// executes (module-top-level env reads: MARKET_RESEARCH_WORKER,
		// PUBLIC_MAX_RESEARCH_RUNS).
		if (message.env && typeof message.env === "object") {
			for (const [key, value] of Object.entries(message.env)) {
				if (value !== undefined) process.env[key] = value;
			}
		}
		process.env.MARKET_RESEARCH_WORKER = "1";
		process.send = (msg: unknown, cb?: () => void) => {
			self.postMessage(msg);
			cb?.();
		};
		void createRuntime().then((created) => {
			runtime = created;
			self.postMessage({ type: "init_ack" });
			// Wait for the run message, dispatch, then exit. Any rejection is
			// already surfaced as a fatal by the core; the coordinator's
			// deadline remains the backstop.
			void runtime!.run().then(exitWorker, (error: unknown) => {
				console.error("[research-worker] run failed:", error);
				void exitWorker();
			});
		});
		return;
	}

	if (!runtime) return;
	if (message.type === "run") {
		resolveRunMessage?.(message);
		return;
	}
	if (message.type === "cancel") {
		runtime.handleCancel();
		return;
	}
};

// Keep the worker alive until the parent sends init (the coordinator's
// deadline terminates us if it never does).
