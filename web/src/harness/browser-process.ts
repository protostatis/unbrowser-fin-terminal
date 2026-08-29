/**
 * Mutable `process` singleton for the browser session build (stage 2b).
 *
 * vite.browser-session.config.ts replaces the bare `process` global with
 * `globalThis.__browserProcess` (esbuild `define`), and this module registers
 * itself on that global when it is first imported. Unlike the stage-2a static
 * `define: { process: '{"env":{},"versions":{}}' }` object literal, this is a
 * LIVE object: the worker entry sets `process.env.MARKET_RESEARCH_WORKER = "1"`
 * and `process.send = (msg, cb) => self.postMessage(msg)` BEFORE the extension
 * module executes, so the extension's module-top-level reads
 * (`isResearchWorkerProcess`, `PUBLIC_MAX_RESEARCH_RUNS`) and its call-time
 * reads (`UNBROWSER_MCP_URL`, `MARKET_MOCK_MONDAY`, ...) all resolve against
 * the injected environment.
 *
 * Each vite bundle gets its own copy of this module (main bundle and worker
 * chunk), so `process` state never leaks between them.
 *
 * `versions.node` deviation from the stage-2a empty `{}` (flag in the stage-2b
 * report): shared/kernel/hash.ts gates its sync SHA-256 on
 * `process.versions?.node` and `sourceIdForUrl` (called by market_discover at
 * runtime) is a SYNC caller. With `versions: {}` the browser bundle would take
 * the WebCrypto branch and `sha256Hex` would throw "requires Node" the first
 * time a research job discovers candidates. Advertising a node version routes
 * hash.ts to `await import("node:crypto")`, which the vite alias resolves to
 * browser-shims.ts — the pure-JS sync SHA-256 with the same digest.
 */

export const env: Record<string, string | undefined> = {};

export const process = {
	env,
	/** node-compatible crypto surface (browser-shims createHash) — see header comment. */
	versions: { node: "20.0.0" } as Record<string, string>,
	/** Parent-channel emitter; the worker entry installs `(msg, cb) => self.postMessage(msg)`. */
	send: undefined as ((msg: unknown, cb?: () => void) => void) | undefined,
	/** Scopes used by the extension's CLI fallback session ids; 0 = browser worker. */
	pid: 0,
};

export default process;

// Self-register so the esbuild `define` indirection (`process` →
// `globalThis.__browserProcess`) resolves as soon as any bundle module imports
// this file. Both build entries import this module before the extension.
const browserGlobal = globalThis as unknown as {
	__browserProcess?: typeof process;
	process?: typeof process;
};
browserGlobal.__browserProcess = process;

// Vite's dev server serves the canonical extension through an /@fs URL. That
// external module is transpiled without the production `define: { process: ...
// }` replacement, so its bare `process.env` reads need the same browser global
// fallback. Production builds continue to use the private indirection above.
browserGlobal.process = process;
