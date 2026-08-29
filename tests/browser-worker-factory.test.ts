/**
 * Stage 2b: browser worker-factory adapter tests.
 *
 * The factory constructs a real Web Worker via `new Worker(new URL(...))`;
 * in Node (tsx) we install a FAKE global Worker class that records
 * postMessage calls and lets the test simulate messages (init_ack, events,
 * __exit) and errors, so the adapter's handshake/queueing/lifecycle semantics
 * are verified without spawning a browser.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserWorkerFactory, type BrowserWorkerHandle } from "../web/src/harness/browser-worker-factory.js";

interface FakeWorkerInstance {
	postMessage(msg: unknown): void;
	terminate(): void;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: { message?: string; error?: Error }) => void) | null;
}

interface FakeWorkerClass {
	instances: FakeWorkerInstance[];
	lastUrl: string | undefined;
	lastOptions: unknown;
	emitMessage(index: number, msg: unknown): void;
	emitError(index: number, msg?: string): void;
}

function installFakeWorker(): FakeWorkerClass {
	const fake: FakeWorkerClass = {
		instances: [],
		lastUrl: undefined,
		lastOptions: undefined,
		emitMessage(index, msg) {
			fake.instances[index]?.onmessage?.({ data: msg });
		},
		emitError(index, msg) {
			fake.instances[index]?.onerror?.({ message: msg ?? "worker error", error: new Error(msg ?? "worker error") });
		},
	};
	class FakeWorker {
		onmessage: ((event: { data: unknown }) => void) | null = null;
		onerror: ((event: { message?: string; error?: Error }) => void) | null = null;
		constructor(url: URL, options?: unknown) {
			fake.lastUrl = String(url);
			fake.lastOptions = options;
			fake.instances.push(this);
		}
		postMessage(msg: unknown): void {
			received.push(msg);
		}
		terminate(): void {
			terminated += 1;
		}
	}
	let received: unknown[] = [];
	let terminated = 0;
	(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
	Object.defineProperty(fake, "received", { get: () => received });
	Object.defineProperty(fake, "terminatedCount", { get: () => terminated });
	return fake;
}

test("factory posts init with the env and queues run messages until init_ack", () => {
	const fake = installFakeWorker();
	const factory = createBrowserWorkerFactory();
	const handle = factory({ MARKET_RESEARCH_WORKER: "1", UNBROWSER_MCP_URL: "http://x" });

	const received = (fake as unknown as { received: unknown[] }).received;
	// init posted immediately with the env map.
	assert.equal(received.length, 1);
	assert.deepEqual(received[0], { type: "init", env: { MARKET_RESEARCH_WORKER: "1", UNBROWSER_MCP_URL: "http://x" } });

	// Run message before ack: queued, not posted.
	const runMessage = { version: 1, type: "run", jobId: "job-1", attemptId: "attempt-1", request: {} };
	handle.send(runMessage);
	assert.equal(received.length, 1, "run message queued until init_ack");

	// Ack: queued run message flushes.
	fake.emitMessage(0, { type: "init_ack" });
	assert.equal(received.length, 2);
	assert.deepEqual(received[1], runMessage);

	// Later sends flow immediately.
	handle.send({ version: 1, type: "cancel", jobId: "job-1", attemptId: "attempt-1" });
	assert.equal(received.length, 3);
});

test("browser alpha worker receives BYOK settings only in the in-memory init envelope", () => {
	const fake = installFakeWorker();
	const factory = createBrowserWorkerFactory({
		apiKey: "sk-or-test",
		model: "openrouter/test-model",
		unbrowserEndpoint: "https://mcp.example.test",
	});
	factory({ MARKET_RESEARCH_WORKER: "1" });
	const init = (fake as unknown as { received: unknown[] }).received[0] as { type: string; env: Record<string, string> };
	assert.equal(init.type, "init");
	assert.equal(init.env.BROWSER_API_KEY, "sk-or-test");
	assert.equal(init.env.BROWSER_MODEL, "openrouter/test-model");
	assert.equal(init.env.UNBROWSER_MCP_URL, "https://mcp.example.test");
	assert.equal(init.env.MARKET_PRECACHE_ENABLED, "0");
	assert.equal(init.env.MARKET_SCOUT_ENABLED, "0");
	assert.equal(init.env.MARKET_RESEARCH_CONCURRENCY, "1");
});

test("init_ack and __exit are filtered from onMessage; worker events are forwarded", () => {
	const fake = installFakeWorker();
	const handle = createBrowserWorkerFactory()({});
	const seen: unknown[] = [];
	handle.onMessage((msg) => seen.push(msg));

	fake.emitMessage(0, { type: "init_ack" });
	assert.deepEqual(seen, [], "init_ack never reaches onMessage");

	const started = { version: 1, type: "started", jobId: "j", attemptId: "a", sequence: 0 };
	fake.emitMessage(0, started);
	assert.deepEqual(seen, [started]);

	const canvas = { version: 1, type: "canvas", jobId: "j", attemptId: "a", sequence: 1, canvas: {} };
	fake.emitMessage(0, canvas);
	assert.deepEqual(seen, [started, canvas]);

	fake.emitMessage(0, { type: "__exit" });
	assert.deepEqual(seen, [started, canvas], "__exit is a lifecycle signal, not an event");
});

test("onExit fires on __exit with code 0, and worker errors fire onError then onExit", () => {
	const fake = installFakeWorker();
	const handle = createBrowserWorkerFactory()({});
	const exits: Array<[number | null, string | null]> = [];
	const errors: Error[] = [];
	handle.onExit((code, signal) => exits.push([code, signal]));
	handle.onError((err) => errors.push(err));

	fake.emitMessage(0, { type: "__exit" });
	assert.deepEqual(exits, [[0, null]]);

	// A second lifecycle signal must not double-fire.
	fake.emitMessage(0, { type: "__exit" });
	assert.deepEqual(exits, [[0, null]]);

	// An error after a clean exit surfaces onError only (exit already fired).
	fake.emitError(0, "boom");
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /boom/);
	assert.deepEqual(exits, [[0, null]]);
});

test("worker error before exit fires onError then onExit", () => {
	const fake = installFakeWorker();
	const handle = createBrowserWorkerFactory()({});
	const exits: Array<[number | null, string | null]> = [];
	const errors: Error[] = [];
	handle.onExit((code, signal) => exits.push([code, signal]));
	handle.onError((err) => errors.push(err));

	fake.emitError(0, "boom");
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /boom/);
	assert.deepEqual(exits, [[1, null]]);
});

test("kill terminates the worker and fires onExit once", () => {
	const fake = installFakeWorker();
	const handle = createBrowserWorkerFactory()({});
	const exits: Array<[number | null, string | null]> = [];
	handle.onExit((code, signal) => exits.push([code, signal]));

	handle.kill("SIGTERM");
	assert.equal((fake as unknown as { terminatedCount: number }).terminatedCount, 1);
	assert.deepEqual(exits, [[0, null]]);

	// Idempotent: the coordinator may kill again after the slot was released.
	handle.kill("SIGKILL");
	assert.equal((fake as unknown as { terminatedCount: number }).terminatedCount, 2);
	assert.deepEqual(exits, [[0, null]]);
});

test("factory targets the worker entry as an ES module worker", () => {
	const fake = installFakeWorker();
	createBrowserWorkerFactory()({});
	assert.ok(fake.lastUrl?.includes("research-worker.browser"), `worker URL: ${fake.lastUrl}`);
	assert.deepEqual(fake.lastOptions, { type: "module" });
});
