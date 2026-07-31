/**
 * Web Theme — emits ANSI escape codes (NOT HTML) so the extension's layout
 * math works correctly.
 *
 * WHY ANSI: the extension pipes every rendered string through pi-tui's
 * `visibleWidth` / `truncateToWidth`, which are built for ANSI strings — they
 * strip `\x1b[...m` sequences when measuring width and preserve them when
 * truncating. If the theme emitted HTML spans, those functions would count the
 * tag characters as visible width and wrongly truncate (injecting stray
 * `...` markers and ANSI resets). Emitting ANSI makes the backend render
 * IDENTICALLY to a real terminal; we convert ANSI → HTML at the WebSocket
 * boundary via `ansiToHtml()` below.
 *
 * The extension calls only `theme.fg(color, text)`, `theme.bg(color, text)`,
 * `theme.bold(text)`.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Color palette (RGB) — matches the dark "terminal" look. Keys are the only
// ThemeColor / ThemeBg names the market extension actually emits.
// ---------------------------------------------------------------------------

const FG_RGB: Record<string, [number, number, number]> = {
	accent: [88, 166, 255],
	text: [201, 209, 217],
	muted: [139, 148, 158],
	dim: [110, 118, 129],
	success: [63, 185, 80],
	error: [248, 81, 73],
	warning: [210, 153, 34],
	borderMuted: [48, 54, 61],
};

const BG_RGB: Record<string, [number, number, number]> = {
	selectedBg: [31, 111, 235],
};

const ESC = "\x1b[";

function rgbFg([r, g, b]: [number, number, number]): string {
	return `${ESC}38;2;${r};${g};${b}m`;
}
function rgbBg([r, g, b]: [number, number, number]): string {
	return `${ESC}48;2;${r};${g};${b}m`;
}

// ---------------------------------------------------------------------------
// Web theme object (cast as Theme for TypeScript)
// ---------------------------------------------------------------------------

const webTheme = {
	/** Foreground color — wraps text in ANSI truecolor SGR. */
	fg(color: string, text: string): string {
		const rgb = FG_RGB[color] ?? FG_RGB.text;
		return `${rgbFg(rgb)}${text}${ESC}0m`;
	},

	/** Background color — wraps text in ANSI truecolor background SGR. */
	bg(color: string, text: string): string {
		const rgb = BG_RGB[color];
		if (!rgb) return text; // unknown bg — leave plain
		return `${rgbBg(rgb)}${text}${ESC}0m`;
	},

	/** Bold — SGR intensity bold (1) … bold-off (22). */
	bold(text: string): string {
		return `${ESC}1m${text}${ESC}22m`;
	},

	// ---- Stubs for methods the extension never calls ----
	italic: (() => "") as Theme["italic"],
	underline: (() => "") as Theme["underline"],
	inverse: (() => "") as Theme["inverse"],
	strikethrough: (() => "") as Theme["strikethrough"],
	getFgAnsi: (() => "") as Theme["getFgAnsi"],
	getBgAnsi: (() => "") as Theme["getBgAnsi"],
	getColorMode: (() => "truecolor") as Theme["getColorMode"],
	getThinkingBorderColor: (() => () => "") as Theme["getThinkingBorderColor"],
	getBashModeBorderColor: (() => () => "") as Theme["getBashModeBorderColor"],
	name: undefined,
	sourcePath: undefined,
	sourceInfo: undefined,
} as unknown as Theme;

export default webTheme;

// ---------------------------------------------------------------------------
// ANSI → HTML converter (applied at the WebSocket boundary)
// ---------------------------------------------------------------------------

/** Escape the five XML-significant characters. */
function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Convert a single rendered row (ANSI-encoded) into XSS-safe HTML.
 *
 * Strategy: walk the string, splitting out CSI SGR sequences (`\x1b[...m`).
 * Maintain the active attribute set {fg, bg, bold}. For each maximal run of
 * visible text, emit it wrapped in a single `<span style="...">` reflecting the
 * attributes active for that run (HTML-escaped). Unknown CSI sequences are
 * dropped. This yields clean, nested-span-free HTML and is safe because all
 * untrusted text (headlines, source labels) passes through escapeXml.
 */
export function ansiToHtml(row: string): string {
	let out = "";
	let i = 0;
	let fg: [number, number, number] | null = null;
	let bg: [number, number, number] | null = null;
	let bold = false;

	const flush = (text: string) => {
		if (text.length === 0) return;
		const styles: string[] = [];
		if (fg) styles.push(`color:rgb(${fg[0]},${fg[1]},${fg[2]})`);
		if (bg) styles.push(`background-color:rgb(${bg[0]},${bg[1]},${bg[2]})`);
		if (bold) styles.push("font-weight:700");
		out += styles.length ? `<span style="${styles.join(";")}">${escapeXml(text)}</span>` : escapeXml(text);
	};

	let textRun = "";
	while (i < row.length) {
		// OSC 8 hyperlinks and other ESC sequences we don't model: skip to BEL or ST.
		if (row[i] === "\x1b" && row[i + 1] === "]") {
			flush(textRun);
			textRun = "";
			let j = i + 2;
			while (j < row.length && row[j] !== "\x07" && !(row[j] === "\x1b" && row[j + 1] === "\\")) j++;
			i = row[j] === "\x07" ? j + 1 : j + 2;
			continue;
		}
		// CSI sequence: \x1b[ ... <final byte>
		if (row[i] === "\x1b" && row[i + 1] === "[") {
			flush(textRun);
			textRun = "";
			let j = i + 2;
			while (j < row.length && !/[0-9;]/.test(row[j] ?? "")) j++; // skip non-params (shouldn't happen)
			const paramStart = j;
			while (j < row.length && /[0-9;]/.test(row[j] ?? "")) j++;
			const params = row.slice(paramStart, j);
			const final = row[j] ?? "";
			j++; // consume final byte
			i = j;
			if (final === "m") applySgr(params);
			continue;
		}
		// Lone ESC or other control char: drop.
		if (row[i] === "\x1b") {
			i++;
			continue;
		}
		textRun += row[i];
		i++;
	}
	flush(textRun);
	return out;

	function applySgr(params: string) {
		// Empty params means [0m (reset).
		const codes = params === "" ? [0] : params.split(";").map((p) => (p === "" ? 0 : Number(p)));
		let k = 0;
		while (k < codes.length) {
			const c = codes[k];
			if (c === 0) {
				fg = null;
				bg = null;
				bold = false;
			} else if (c === 1) {
				bold = true;
			} else if (c === 22) {
				bold = false;
			} else if (c === 39) {
				fg = null; // default fg
			} else if (c === 49) {
				bg = null; // default bg
			} else if (c === 38 && codes[k + 1] === 2) {
				// truecolor fg: 38;2;R;G;B
				fg = [codes[k + 2] ?? 0, codes[k + 3] ?? 0, codes[k + 4] ?? 0];
				k += 4;
			} else if (c === 48 && codes[k + 1] === 2) {
				// truecolor bg: 48;2;R;G;B
				bg = [codes[k + 2] ?? 0, codes[k + 3] ?? 0, codes[k + 4] ?? 0];
				k += 4;
			}
			k++;
		}
	}
}
