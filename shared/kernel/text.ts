/**
 * framework-free kernel — extracted from .pi/extensions/market-terminal.ts, stage 1 slice 1.
 * Text normalization helpers. No framework, no runtime imports.
 */

export function cleanText(value: unknown): string {
	return String(value ?? "")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\x1B\u202A-\u202E\u2066-\u2069]/g, "")
		.replace(/\r\n?/g, "\n");
}
