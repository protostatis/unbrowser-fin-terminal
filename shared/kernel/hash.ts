/**
 * framework-free kernel — extracted from .pi/extensions/market-terminal.ts, stage 1 slice 1.
 * SHA-256 hashing with a dual implementation: node:crypto under Node, Web
 * Crypto (globalThis.crypto.subtle) in browsers.
 *
 * Every current runtime host of this package (Pi SDK via jiti, tsx tests,
 * dist-server workers) executes under Node, so the sync `sha256Hex` path
 * always uses node:crypto. Web Crypto's `subtle.digest` is asynchronous;
 * browser builds should use `sha256HexAsync`, which mirrors the same digest.
 */

const nodeCrypto = typeof process !== "undefined" && process.versions?.node
	? await import("node:crypto")
	: undefined;

function hexDigest(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Deterministic SHA-256 hex digest (64 lowercase hex chars). Node path is sync. */
export function sha256Hex(input: string): string {
	if (nodeCrypto) return nodeCrypto.createHash("sha256").update(input, "utf8").digest("hex");
	// Browser fallback: Web Crypto is async-only; the kernel's current hosts
	// all run under Node, so sync callers never hit this branch.
	throw new Error("sha256Hex (sync) requires Node; browser builds must use sha256HexAsync");
}

/** Web Crypto path (browser): same deterministic SHA-256 digest, async. */
export async function sha256HexAsync(input: string): Promise<string> {
	if (nodeCrypto) return nodeCrypto.createHash("sha256").update(input, "utf8").digest("hex");
	const buffer = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return hexDigest(buffer);
}

export function sourceIdForUrl(url: string): string {
	return `S-${sha256Hex(url).slice(0, 12)}`;
}
