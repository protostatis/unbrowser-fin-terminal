/**
 * Minimal browser shim for node:path (stage 2a loadability spike).
 *
 * POSIX-slice semantics only (browser paths are never Windows-style; the
 * storage port resolves data paths itself). The extension graph uses
 * join/dirname/isAbsolute at call time; the shim exists so the module
 * imports resolve in the browser bundle.
 */

const isSep = (char: string): boolean => char === "/";

export function isAbsolute(path: string): boolean {
	return path.length > 0 && isSep(path[0]);
}

export function join(...parts: string[]): string {
	let result = "";
	for (const part of parts) {
		if (!part) continue;
		if (isAbsolute(part)) result = part;
		else if (result.length === 0 || result.endsWith("/")) result += part;
		else result += `/${part}`;
	}
	// Collapse duplicate separators and trailing separators (POSIX join).
	return result.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

export function dirname(path: string): string {
	if (path === "" || path === "/") return ".";
	const trimmed = path.replace(/\/+$/, "");
	if (!trimmed.includes("/")) return ".";
	const idx = trimmed.lastIndexOf("/");
	if (idx === 0) return "/";
	return trimmed.slice(0, idx);
}

export function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

const pathShim = { join, dirname, basename, isAbsolute, resolve: join, normalize: (p: string): string => join(p) || "." };
export default pathShim;
