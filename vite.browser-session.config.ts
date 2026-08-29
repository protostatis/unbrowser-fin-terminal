import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

/**
 * Scoped build for the stage 2a/2b browser-session migration.
 *
 * Proves the canonical extension (.pi/extensions/market-terminal.ts) bundles
 * for the browser: node: built-ins are aliased to shims, @earendil-works
 * runtime imports resolve to vendored browser-safe code, and the `process`
 * global is redirected to a MUTABLE per-bundle singleton
 * (web/src/harness/browser-process.ts) via esbuild `define` indirection.
 * Stage 2b also emits the isolated research worker chunk
 * (web/src/harness/research-worker.browser.ts, referenced from
 * browser-worker-factory.ts via `new Worker(new URL(...))`).
 *
 * Why `define`, not `resolve.alias`, for `process`: the extension references
 * the bare `process` global (never `import process from "process"`), so an
 * import alias cannot intercept it. The define points the identifier at
 * `globalThis.__browserProcess`, which browser-process.ts registers when
 * imported — giving a MUTABLE object (the stage-2a static object literal
 * could not carry the worker env). Each bundle instance (main entry chunk vs
 * worker chunk) imports its own copy, so state never crosses bundles. The
 * same indirection covers the `Buffer` global (browser-buffer.ts), needed by
 * the worker's base64url run-message parser.
 *
 * This config is additive: the production vite.config.ts, `npm run build`,
 * and `npm run dev` flows are untouched. Run with:
 *   npx vite build --config vite.browser-session.config.ts
 */
export default defineConfig({
	root: "web",
	// The isolated research worker is an ES-module worker whose chunk imports
	// shared chunks (the extension), so it must be built with `es` format —
	// the default "iife" cannot code-split.
	worker: {
		format: "es",
	},
	// NOTE: build target must stay esnext — shared/kernel/hash.ts uses top-level
	// await and the vendored pi-tui utils use the ES2024 /v regexp flag.
	build: {
		target: "esnext",
		outDir: "../dist-browser-session",
		emptyOutDir: true,
		rollupOptions: {
			input: fileURLToPath(new URL("./web/src/harness/extension-loadability.ts", import.meta.url)),
			output: {
				entryFileNames: "extension-loadability.js",
				chunkFileNames: "chunks/[name]-[hash].js",
			},
		},
	},
	resolve: {
		alias: [
			// node: built-ins → browser shims / stubs (call-time throws).
			{ find: "node:crypto", replacement: fileURLToPath(new URL("./web/src/harness/browser-shims.ts", import.meta.url)) },
			{ find: "node:fs/promises", replacement: fileURLToPath(new URL("./web/src/harness/node-fs-stub.ts", import.meta.url)) },
			{ find: "node:fs", replacement: fileURLToPath(new URL("./web/src/harness/node-fs-stub.ts", import.meta.url)) },
			{ find: "node:path", replacement: fileURLToPath(new URL("./web/src/harness/node-path-shim.ts", import.meta.url)) },
			{ find: "node:child_process", replacement: fileURLToPath(new URL("./web/src/harness/node-child-process-stub.ts", import.meta.url)) },
			{ find: "node:url", replacement: fileURLToPath(new URL("./web/src/harness/node-url-shim.ts", import.meta.url)) },
			// @earendil-works runtime imports → vendored browser-safe code.
			{ find: "@earendil-works/pi-tui", replacement: fileURLToPath(new URL("./web/src/vendor/pi-tui-utils.ts", import.meta.url)) },
			{ find: "@earendil-works/pi-ai", replacement: fileURLToPath(new URL("./web/src/vendor/pi-ai-shim.ts", import.meta.url)) },
			{ find: "@earendil-works/pi-coding-agent", replacement: fileURLToPath(new URL("./web/src/vendor/pi-coding-agent-shim.ts", import.meta.url)) },
		],
	},
	define: {
		// Mutable process singleton: `process.env.X` reads become
		// `globalThis.__browserProcess.env.X`. browser-process.ts registers
		// itself on that global when imported (both entries import it before
		// the extension). `versions.node` is advertised so hash.ts's sync
		// SHA-256 takes the node:crypto alias path (pure-JS shim, same digest).
		process: "globalThis.__browserProcess",
		// Minimal Buffer for the worker's base64url run-message parser.
		Buffer: "globalThis.__browserBuffer",
	},
});
