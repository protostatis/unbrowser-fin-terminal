/**
 * Minimal browser shim for node:url (stage 2a loadability spike).
 * Only `fileURLToPath` is needed (research-worker-coordinator imports it at
 * call time); implemented correctly for file: URLs.
 */

export function fileURLToPath(url: string): string {
	if (!url.startsWith("file:")) throw new TypeError(`fileURLToPath: expected a file: URL, got ${url}`);
	const parsed = new URL(url);
	if (parsed.hostname && parsed.hostname !== "localhost") {
		throw new TypeError(`fileURLToPath: unsupported host in file: URL (${parsed.hostname})`);
	}
	return decodeURIComponent(parsed.pathname);
}
