/**
 * Browser stub for node:fs / node:fs/promises (stage 2a loadability spike).
 *
 * Import-safe: the extension's shared modules (research-precache-ledger,
 * market-event-scout), shared/kernel/ports.ts and server coordinator import
 * these names, but the browser alpha has no filesystem — every function
 * throws "browser storage port not implemented (stage 3)" when CALLED.
 * The stage-3 IndexedDB storage port implements the StoragePort contract
 * (shared/kernel/ports.ts) instead of node:fs.
 */

function notImplemented(name: string): never {
	throw new Error(`${name}: browser storage port not implemented (stage 3)`);
}

export function mkdir(): Promise<never> {
	return Promise.reject(notImplemented("fs/promises.mkdir"));
}
export function open(): Promise<never> {
	return Promise.reject(notImplemented("fs/promises.open"));
}
export function readFile(): Promise<never> {
	return Promise.reject(notImplemented("fs/promises.readFile"));
}
export function rename(): Promise<never> {
	return Promise.reject(notImplemented("fs/promises.rename"));
}
export function rm(): Promise<never> {
	return Promise.reject(notImplemented("fs/promises.rm"));
}
export function existsSync(): never {
	return notImplemented("fs.existsSync");
}
