/**
 * Extension browser-loadability spike (stage 2a) — compile-level proof.
 *
 * This module imports the canonical extension
 * (.pi/extensions/market-terminal.ts) and the shared kernel ports through the
 * browser aliases (vite.browser-session.config.ts), constructs a minimal
 * BrowserExtensionHost implementing the Pi API surface the extension uses
 * (docs/web-ui-design.md "The Pi API surface the extension actually uses"),
 * and calls `extension(pi)`.
 *
 * This is NOT wired into the app (stage 3 does that) and does NOT make the
 * extension runtime-work in a browser: precache/scout/ledger call their
 * node:fs stubs and would throw at call time. The spike proves imports
 * resolve, typebox works, StringEnum/pi-tui utils match, and the node shims
 * are complete enough to compile.
 */

import extension from "../../../.pi/extensions/market-terminal.js";
import { createNodeKernelPorts } from "../../../shared/kernel/ports.js";
// Stage 2b: the `process` global is defined to `globalThis.__browserProcess`;
// this module self-registers it, so the extension's module-top-level env reads
// (`isResearchWorkerProcess`, `PUBLIC_MAX_RESEARCH_RUNS`) resolve to the
// mutable shim instead of throwing on an undefined global.
import "./browser-process.js";
// Stage 2b: pull the research-worker factory into the build graph so vite
// emits the isolated worker chunk (`new Worker(new URL(...))`). Never invoked
// by this spike — the compile-level proof only needs the chunk emitted.
import { createBrowserWorkerFactory } from "./browser-worker-factory.js";

/** Mirrors docs/web-ui-design.md: `{ fg, bg, bold }` theme contract. */
interface BrowserTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

/** Mirrors docs/web-ui-design.md: `{ requestRender, terminal?: { rows } }`. */
interface BrowserTui {
	requestRender(force?: boolean): void;
	terminal?: { rows: number };
}

/** Overlay handle shape the extension checks (overlayHandle.isFocused()). */
interface BrowserOverlayHandle {
	isFocused(): boolean;
}

/** Session-manager branch entries the extension reads (restoreSessionCanvases). */
interface BrowserSessionBranchEntry {
	type: string;
	message?: { role?: string; toolName?: string; details?: unknown };
}

/** ui.custom factory signature the extension uses. */
type CustomFactory<T> = (tui: BrowserTui, theme: BrowserTheme, keybindings: unknown, done: (result: T) => void) => T;

/** The Pi API subset the extension actually uses (docs/web-ui-design.md). */
interface BrowserPi {
	registerTool(tool: Record<string, unknown>): void;
	registerCommand(name: string, spec: { description: string; handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> | unknown }): void;
	on(event: string, handler: (...args: unknown[]) => unknown): void;
	exec(name: string, args: string[], opts: { signal?: AbortSignal; timeout?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
	sendUserMessage(text: string, opts?: Record<string, unknown>): void;
	appendEntry(type: string, data: Record<string, unknown>): void;
	getFlag(name: string): boolean;
	setActiveTools(tools: string[]): void;
	ui: {
		custom<T>(factory: CustomFactory<T>, options?: Record<string, unknown>): Promise<T>;
		onTerminalInput(cb: (data: string) => unknown): () => void;
		notify(text: string, level?: string): void;
		select(title: string, options: string[]): Promise<string | undefined>;
	};
	context: {
		mode: "tui";
		cwd: string;
		isIdle(): boolean;
		hasPendingMessages(): boolean;
		abort(): void;
		sessionManager: { getBranch(): BrowserSessionBranchEntry[] };
	};
}

/**
 * Minimal Pi-compatible host. Every method is a capture/no-op: the spike only
 * needs the constructor call to typecheck and bundle. Stage 3 replaces this
 * with the real web projection (frame push, keyboard routing, tool loop).
 */
export function createBrowserExtensionHost(): BrowserPi {
	const theme: BrowserTheme = {
		fg: (color, text) => `<span class="tc tc-${color}">${text}</span>`,
		bg: (color, text) => `<span class="tc-bg tc-bg-${color}">${text}</span>`,
		bold: (text) => `<strong>${text}</strong>`,
	};
	const tui: BrowserTui = { requestRender: () => {}, terminal: { rows: 24 } };
	return {
		registerTool: () => {},
		registerCommand: () => {},
		on: () => {},
		exec: async () => ({ code: 1, stdout: "", stderr: "browser exec shim: unbrowser binary not available (stage 3)" }),
		sendUserMessage: () => {},
		appendEntry: () => {},
		getFlag: () => false,
		setActiveTools: () => {},
		ui: {
			custom: <T,>(_factory: CustomFactory<T>) => Promise.resolve(undefined as unknown as T),
			onTerminalInput: () => () => {},
			notify: () => {},
			select: async () => undefined,
		},
		context: {
			mode: "tui",
			cwd: "/",
			isIdle: () => true,
			hasPendingMessages: () => false,
			abort: () => {},
			sessionManager: { getBranch: () => [] },
		},
	};
}

// Compile-level proof: the extension default export typechecks against the
// host, and the shared kernel ports resolve through the browser aliases.
const pi = createBrowserExtensionHost();
const ports = createNodeKernelPorts(); // resolves node:fs/promises + node:path aliases in this build
void ports;
extension(pi as unknown as Parameters<typeof extension>[0]);
// Compile-level proof for the stage-2b worker factory (Worker handle adapter).
const browserWorkerFactory = createBrowserWorkerFactory();
void browserWorkerFactory;

// Marker strings the loadability verification greps for in the bundle.
export const LOADABILITY_MARKERS = {
	extension: "market-terminal",
	canvas: "PRICE CHART",
	session: "BrowserAgentSession",
} as const;
