/**
 * Minimal `Buffer` shim for the browser session build (stage 2b).
 *
 * The extension's worker path calls `Buffer` in two places at runtime:
 * - `.pi/extensions/market-terminal.ts` `parseWorkerRun`:
 *   `Buffer.from(raw, "base64url").toString("utf8")`
 * - `server/research-worker-protocol.ts` `isBoundedJson` (called by
 *   `isParentMessage`, which `parseWorkerRun` uses):
 *   `Buffer.byteLength(JSON.stringify(value), "utf8") <= 64 * 1024`
 *
 * vite.browser-session.config.ts defines the bare `Buffer` identifier to
 * `globalThis.__browserBuffer`, and this module registers itself on that
 * global when imported (the worker entry imports it before the extension
 * module executes). Only the two call shapes above are implemented; anything
 * else throws at call time.
 *
 * Node tests (tsx) never see this module — they use the real Buffer.
 */

function utf8Bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

interface BrowserBufferLike {
	byteLength(value: string, encoding?: string): number;
	from(value: string, encoding?: string): { toString(encoding?: string): string };
}

function fromBase64Url(value: string): string {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return new TextDecoder("utf-8").decode(bytes);
}

export const Buffer: BrowserBufferLike = {
	byteLength(value: string, encoding?: string): number {
		if (encoding && encoding !== "utf8" && encoding !== "utf-8") {
			throw new Error(`browser Buffer shim: unsupported encoding "${encoding}" (utf8 only)`);
		}
		return utf8Bytes(value).length;
	},
	from(value: string, encoding?: string): { toString(encoding?: string): string } {
		if (encoding && encoding !== "base64url" && encoding !== "utf8" && encoding !== "utf-8") {
			throw new Error(`browser Buffer shim: unsupported encoding "${encoding}" (utf8/base64url only)`);
		}
		return {
			toString(innerEncoding?: string): string {
				if (innerEncoding && innerEncoding !== "utf8" && innerEncoding !== "utf-8") {
					throw new Error(`browser Buffer shim: unsupported encoding "${innerEncoding}" (utf8 only)`);
				}
				return encoding === "base64url" ? fromBase64Url(value) : value;
			},
		};
	},
};

export default Buffer;

// Self-register so the esbuild `define` indirection (`Buffer` →
// `globalThis.__browserBuffer`) resolves after the worker entry imports this
// module. See browser-process.ts for the same pattern.
const browserGlobal = globalThis as unknown as {
	__browserBuffer?: BrowserBufferLike;
	Buffer?: BrowserBufferLike;
};
browserGlobal.__browserBuffer = Buffer;

// Match browser-process.ts: Vite's dev server does not apply the production
// `define: { Buffer: ... }` replacement to the canonical extension served via
// /@fs, so the worker's bare Buffer references need a dev-time fallback too.
browserGlobal.Buffer = Buffer;
