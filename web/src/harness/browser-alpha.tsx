/**
 * Browser alpha — one private, ephemeral session backed by the canonical
 * market-terminal extension. The API key is retained only by the live runtime
 * and is never written to IndexedDB, the URL, or a session message.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalFrame } from "../TerminalFrame";
import { keyToData } from "../keyboard";
import { ContextHud } from "../ContextHud";
import { EvidenceControl, EvidenceInspector } from "../EvidenceInspector";
import { InteractionOverlay, type TerminalWebAction } from "../InteractionOverlay";
import { MobileControls } from "../MobileControls";
import { WatchlistImport } from "../WatchlistImport";
import { researchActivityStatus, type TerminalFrameState } from "../mobile-controls";
import type { WatchlistImportResult } from "../socket";
import { createWebUi, type Panel } from "../../../server/web-ui.js";
import { resolveWebAction } from "../../../server/web-actions.js";
import { ansiToHtml } from "../../../server/theme.js";
import { createBrowserKernelPorts } from "./browser-ports.js";
import { browserApiUrl } from "./browser-api.js";
import { createBrowserRuntimeHost, type BrowserRuntimeHost } from "./browser-runtime-host.js";
import { acquireBrowserRuntimeLock, type BrowserRuntimeLease } from "./browser-runtime-lock.js";
import browserProcess from "./browser-process.js";
import { createBrowserHttpStoragePort } from "./browser-storage.js";
import "./browser-buffer.js";

const DEFAULT_MODEL = import.meta.env.VITE_OPENROUTER_MODEL
	|| import.meta.env.VITE_MARKET_MODEL_ID
	|| "deepseek/deepseek-v4-flash-0731";

type BrowserRuntime = {
	host: BrowserRuntimeHost;
	controller: AbortController;
	ctx: ReturnType<BrowserRuntimeHost["createContext"]>;
	lease: BrowserRuntimeLease;
	marketCommand: { handler(args: string, ctx: unknown): Promise<void> | void };
	sendInput: (data: string) => void;
	disposeUi: () => void;
	resetExtension: () => void;
	setTerminalRows: (rows: number) => void;
	disposed: boolean;
};

/**
 * The browser build intentionally uses the same ANSI theme as the Node web
 * projection. This keeps pi-tui width calculations correct and converts to
 * escaped HTML only at the final DOM boundary.
 */
function renderRows(panel: Panel | null, columns: number): string[] {
	return panel?.render(columns).map(ansiToHtml) ?? [];
}

export function BrowserAlphaApp({ authenticated = false }: { authenticated?: boolean } = {}) {
	const [apiKey, setApiKey] = useState("");
	const [model, setModel] = useState(DEFAULT_MODEL);
	const [connected, setConnected] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [panel, setPanel] = useState<Panel | null>(null);
	const [panelWasOpened, setPanelWasOpened] = useState(false);
	const [selectReq, setSelectReq] = useState<{ id: string; title: string; options: string[] } | null>(null);
	const [renderVersion, setRenderVersion] = useState(0);
	const [terminalSize, setTerminalSize] = useState({ columns: 120, rows: 35 });
	const [evidenceOpen, setEvidenceOpen] = useState(false);
	const [watchlistImportOpen, setWatchlistImportOpen] = useState(false);
	const runtimeRef = useRef<BrowserRuntime | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const rulerRef = useRef<HTMLSpanElement>(null);
	const terminalFrameRef = useRef<HTMLDivElement>(null);
	const evidenceTriggerRef = useRef<HTMLButtonElement>(null);
	const selectResolverRef = useRef<((id: string, value: string | undefined, cancelled: boolean) => void) | null>(null);
	const persistenceWritesRef = useRef(new Set<Promise<void>>());
	const persistenceTailRef = useRef(Promise.resolve());

	const dispose = useCallback(async () => {
		const runtime = runtimeRef.current;
		if (!runtime || runtime.disposed) return;
		runtime.disposed = true;
		runtime.controller.abort();
		runtime.sendInput = () => {};
		runtime.disposeUi();
		try {
			delete browserProcess.env.BROWSER_API_KEY;
			delete browserProcess.env.BROWSER_MODEL;
			delete browserProcess.env.BROWSER_API_ENDPOINT;
			delete browserProcess.env.UNBROWSER_MCP_URL;
			await Promise.allSettled([...persistenceWritesRef.current]);
			await runtime.host.fireEventAsync({ type: "session_shutdown" }, runtime.ctx);
		} finally {
			runtime.resetExtension();
			runtimeRef.current = null;
			setPanel(null);
			setPanelWasOpened(false);
			setSelectReq(null);
			setConnected(false);
			setApiKey("");
			setEvidenceOpen(false);
			setWatchlistImportOpen(false);
			await runtime.lease.release();
		}
	}, []);

	useEffect(() => () => { void dispose(); }, [dispose]);

	const connect = useCallback(async () => {
		if (connecting || runtimeRef.current) return;
		const secret = apiKey.trim();
		if (!authenticated && !secret) {
			setError("Enter your OpenRouter API key");
			return;
		}
		setConnecting(true);
		setError(null);
		let lease: BrowserRuntimeLease | undefined;
		let runtime: BrowserRuntime | undefined;
		let resetExtension: (() => void) | undefined;
		try {
			lease = await acquireBrowserRuntimeLock();
			const controller = new AbortController();
			let sessionModel = model.trim() || DEFAULT_MODEL;
			if (authenticated) {
				const sessionResponse = await fetch(browserApiUrl("/api/browser/v1/session"), {
					headers: { accept: "application/json" },
				});
				if (!sessionResponse.ok) throw new Error(`authenticated browser session returned HTTP ${sessionResponse.status}`);
				const sessionConfig = await sessionResponse.json() as { model?: unknown };
				if (typeof sessionConfig.model !== "string" || !sessionConfig.model.trim()) throw new Error("Authenticated browser session did not provide a model");
				sessionModel = sessionConfig.model.trim();
				setModel(sessionModel);
			}
			const mcpEndpoint = authenticated
				? browserApiUrl("/api/browser/v1/mcp")
				: import.meta.env.VITE_UNBROWSER_MCP_URL?.trim() || undefined;
			const apiEndpoint = authenticated ? browserApiUrl("/api/browser/v1/chat/completions") : undefined;
			const storage = authenticated ? createBrowserHttpStoragePort() : undefined;
			const watchlistPath = storage?.resolveDataPath("market-watchlist.json", "/browser");
			const savedWatchlist = storage && watchlistPath
				? await storage.readJsonFile(watchlistPath)
				: undefined;
			const savedSymbols = savedWatchlist && typeof savedWatchlist === "object" && !Array.isArray(savedWatchlist)
				&& Array.isArray((savedWatchlist as { symbols?: unknown }).symbols)
				? (savedWatchlist as { symbols: unknown[] }).symbols.filter((symbol): symbol is string => typeof symbol === "string")
				: [];
			const sessionBranch = savedSymbols.length > 0
				? [{ type: "custom", customType: "market-watchlist", data: { symbols: savedSymbols } }]
				: [];
			browserProcess.env.MARKET_RESEARCH_WORKER = "0";
			browserProcess.env.MARKET_PRECACHE_ENABLED = "0";
			browserProcess.env.MARKET_SCOUT_ENABLED = "0";
			browserProcess.env.MARKET_RESEARCH_CONCURRENCY = "1";
			browserProcess.env.BROWSER_MODEL = sessionModel;
			if (authenticated) browserProcess.env.BROWSER_API_ENDPOINT = apiEndpoint;
			else browserProcess.env.BROWSER_API_KEY = secret;
			if (mcpEndpoint) browserProcess.env.UNBROWSER_MCP_URL = mcpEndpoint;
			const ui = createWebUi({
				onPanel: (next) => {
					setPanel(next);
					if (next) setPanelWasOpened(true);
					if (!next) {
						setEvidenceOpen(false);
						setWatchlistImportOpen(false);
						setSelectReq(null);
					}
					setRenderVersion((version) => version + 1);
				},
				onRenderRequest: () => setRenderVersion((version) => version + 1),
				onNotify: (message, level) => setError(`${level.toUpperCase()}: ${message}`),
				onSelect: (id, title, options) => {
					setSelectReq({ id, title, options });
					return Promise.resolve(undefined as string | undefined);
				},
			});
			selectResolverRef.current = ui.resolveSelect;
			const host = createBrowserRuntimeHost({
				ui: ui.ui,
				cwd: "/browser",
				hasUI: true,
				sessionBranch,
				appendEntry: (type, data) => {
					if (!storage || !watchlistPath || type !== "market-watchlist" || !Array.isArray(data.symbols) || runtimeRef.current?.disposed) return;
					const write = persistenceTailRef.current
						.catch(() => {})
						.then(() => storage.writeJsonFileAtomic(watchlistPath, { version: 1, symbols: data.symbols }));
					persistenceTailRef.current = write.catch((writeError: unknown) => {
						if (!runtimeRef.current?.disposed) setError(writeError instanceof Error ? writeError.message : String(writeError));
					});
					persistenceWritesRef.current.add(write);
					void write.finally(() => persistenceWritesRef.current.delete(write)).catch(() => {});
				},
			});
			const ports = createBrowserKernelPorts({
				...(authenticated ? {} : { apiKey: secret }),
				model: sessionModel,
				unbrowserEndpoint: mcpEndpoint,
				apiEndpoint,
				serverBroker: authenticated,
				storage,
				events: { notify: (message, level) => setError(`${level.toUpperCase()}: ${message}`) },
			});
			const extensionModule = await import("../../../.pi/extensions/market-terminal.js");
			const configure = extensionModule.configureMarketTerminalRuntime;
			resetExtension = extensionModule.resetMarketTerminalRuntime;
			if (typeof configure !== "function" || typeof resetExtension !== "function") throw new Error("Browser runtime configuration seam is unavailable");
			configure(ports, { browserSession: true });
			const extension = extensionModule.default as (pi: unknown) => void;
			extension(host as unknown as Parameters<typeof extension>[0]);
			const ctx = host.createContext(controller);
			const command = host.commands.get("market");
			if (!command) throw new Error("Market command was not registered");
			runtime = {
				host,
				controller,
				ctx,
				lease,
				marketCommand: command,
				sendInput: ui.sendInput,
				disposeUi: ui.dispose,
				resetExtension,
				setTerminalRows: (rows) => { ui.webTui.terminal.rows = rows; },
				disposed: false,
			};
			runtimeRef.current = runtime;
			await host.fireEventAsync({ type: "session_start", reason: "startup" }, ctx);
			// The command remains pending while the terminal panel is open.
			void Promise.resolve(command.handler("", ctx)).catch((commandError: unknown) => {
				if (!runtime?.disposed) setError(commandError instanceof Error ? commandError.message : String(commandError));
			});
			setConnected(true);
		} catch (connectError) {
			if (runtime) await dispose();
			else {
				delete browserProcess.env.BROWSER_API_KEY;
				delete browserProcess.env.BROWSER_MODEL;
				delete browserProcess.env.BROWSER_API_ENDPOINT;
				delete browserProcess.env.UNBROWSER_MCP_URL;
				resetExtension?.();
				if (lease) await lease.release();
			}
			setApiKey("");
			setPanel(null);
			setPanelWasOpened(false);
			setSelectReq(null);
			setError(connectError instanceof Error ? connectError.message : String(connectError));
		} finally {
			setConnecting(false);
		}
	}, [apiKey, authenticated, connecting, dispose, model]);

	const sendInput = useCallback((data: string) => {
		const runtime = runtimeRef.current;
		runtime?.sendInput(data);
	}, []);

	const terminalState = (panel?.debugState?.() ?? undefined) as TerminalFrameState | undefined;
	const researchStatus = researchActivityStatus(terminalState);
	const dossier = terminalState?.dossier;

	const handleWebAction = useCallback((action: TerminalWebAction) => {
		if (!terminalState || evidenceOpen || selectReq || watchlistImportOpen) return;
		const result = resolveWebAction(action, terminalState);
		if (!Array.isArray(result)) return;
		for (const input of result) sendInput(input);
	}, [evidenceOpen, selectReq, sendInput, terminalState, watchlistImportOpen]);

	const handleWatchlistImport = useCallback(async (
		mode: "merge" | "replace",
		symbols: string[],
	): Promise<WatchlistImportResult> => {
		if (!panel?.applyWatchlist || evidenceOpen || selectReq) return { ok: false, error: "The browser market session is not ready to update the watchlist." };
		panel.applyWatchlist(symbols, mode);
		setRenderVersion((version) => version + 1);
		return { ok: true };
	}, [evidenceOpen, panel, selectReq]);

	const focusTerminal = useCallback(() => {
		requestAnimationFrame(() => terminalFrameRef.current?.focus({ preventScroll: true }));
	}, []);

	const handleWatchlistImportOpenChange = useCallback((open: boolean) => {
		setWatchlistImportOpen(open);
		if (!open) focusTerminal();
	}, [focusTerminal]);

	const resolveSelect = useCallback((value: string | undefined, cancelled = false) => {
		const request = selectReq;
		if (!request) return;
		selectResolverRef.current?.(request.id, value, cancelled);
		setSelectReq(null);
		focusTerminal();
	}, [focusTerminal, selectReq]);

	const reopenMarket = useCallback(() => {
		const runtime = runtimeRef.current;
		if (!runtime || runtime.disposed) return;
		setError(null);
		void Promise.resolve(runtime.marketCommand.handler("", runtime.ctx)).catch((commandError: unknown) => {
			if (!runtime.disposed) setError(commandError instanceof Error ? commandError.message : String(commandError));
		});
	}, []);

	const isEditableTarget = (target: EventTarget | null): boolean => {
		if (!(target instanceof HTMLElement)) return false;
		return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
	};

	useEffect(() => {
		if (!connected) return;
		const container = containerRef.current;
		const ruler = rulerRef.current;
		if (!container || !ruler) return;
		const measure = () => {
			const frame = container.querySelector(".terminal-frame") as HTMLElement | null;
			if (!frame) return;
			const charRect = ruler.getBoundingClientRect();
			if (charRect.width === 0 || charRect.height === 0) return;
			const style = getComputedStyle(frame);
			const horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
			const verticalPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
			const next = {
				columns: Math.max(54, Math.floor((frame.clientWidth - horizontalPadding) / charRect.width)),
				rows: Math.max(12, Math.floor((frame.clientHeight - verticalPadding) / charRect.height)),
			};
			runtimeRef.current?.setTerminalRows(next.rows);
			setTerminalSize((current) => current.columns === next.columns && current.rows === next.rows ? current : next);
		};
		requestAnimationFrame(() => requestAnimationFrame(measure));
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		return () => observer.disconnect();
	}, [connected]);

	useEffect(() => {
		if (!connected) return;
		focusTerminal();
	}, [connected, focusTerminal]);

	useEffect(() => {
		if (!connected) return;
		const handler = (event: KeyboardEvent) => {
			if (selectReq) {
				if (event.key === "Escape") {
					event.preventDefault();
					resolveSelect(undefined, true);
				}
				return;
			}
			if (watchlistImportOpen) {
				if (event.key === "Escape") {
					event.preventDefault();
					setWatchlistImportOpen(false);
					focusTerminal();
				}
				return;
			}
			if (evidenceOpen) {
				if (event.key === "Escape") {
					event.preventDefault();
					setEvidenceOpen(false);
					focusTerminal();
				}
				return;
			}
			if (isEditableTarget(event.target)) return;
			const data = keyToData(event);
			if (data === null) return;
			event.preventDefault();
			sendInput(data);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [connected, evidenceOpen, focusTerminal, resolveSelect, selectReq, sendInput, watchlistImportOpen]);

	if (!connected) {
		return (
			<div className="terminal browser-alpha-connect-shell">
			<div className="browser-alpha-connect">
				<div className="browser-alpha-eyebrow">{authenticated ? "AUTHENTICATED · SERVER BROKER · PRIVATE SESSION" : "BROWSER ALPHA · EPHEMERAL · BYOK IN MEMORY"}</div>
				<h2>{authenticated ? "Open your market terminal" : "Connect your OpenRouter key"}</h2>
				<p>{authenticated ? "Your account session owns the broker, research, feeds, and archive. No provider key is sent to this browser." : "Stored only in this tab’s memory. Reload or disconnect to clear it. One research worker; scout and pre-cache are disabled."}</p>
				{!authenticated && <>
					<input type="password" placeholder="sk-or-…" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" />
					<input value={model} onChange={(event) => setModel(event.target.value)} aria-label="OpenRouter model" />
				</>}
				{error && <div className="browser-alpha-error">{error}</div>}
				<button onClick={() => void connect()} disabled={connecting}>{connecting ? "Opening…" : authenticated ? "Open terminal" : "Connect"}</button>
			</div>
			</div>
		);
	}

	return (
		<div className="terminal browser-alpha-shell" ref={containerRef} data-render-version={renderVersion}>
			<span ref={rulerRef} className="term-row ruler" aria-hidden="true">M</span>
			<div className="browser-alpha-banner">
				<span className="browser-alpha-session-label">
					{authenticated ? "AUTHENTICATED · SERVER BROKER · PRIVATE SESSION" : "BROWSER ALPHA · EPHEMERAL · BYOK IN MEMORY"}
				</span>
				<div className="browser-alpha-actions">
					{!evidenceOpen && (
						<button
							type="button"
							className="watchlist-import-trigger"
							onClick={() => setWatchlistImportOpen(true)}
							disabled={!panel || evidenceOpen || Boolean(selectReq)}
							title="Import a watchlist from a screenshot"
						>
							<span aria-hidden="true">+</span> IMPORTER
						</button>
					)}
					<button type="button" className="browser-alpha-disconnect" onClick={() => void dispose()}>
						{authenticated ? "Disconnect session" : "Disconnect &amp; clear key"}
					</button>
				</div>
			</div>
			<TerminalFrame
				rows={renderRows(panel, terminalSize.columns)}
				state={terminalState}
				columns={terminalSize.columns}
				onInput={sendInput}
				onWebAction={handleWebAction}
				terminalRef={terminalFrameRef}
			/>
			<div className="status-line">
				{dossier && (
					<EvidenceControl
						dossier={dossier}
						open={evidenceOpen}
						onOpen={() => setEvidenceOpen(true)}
						triggerRef={evidenceTriggerRef}
					/>
				)}
			</div>
			<InteractionOverlay
				state={terminalState}
				disabled={!panel || evidenceOpen || Boolean(selectReq)}
				onAction={handleWebAction}
				onReturnToTerminal={focusTerminal}
			/>
			<MobileControls
				state={terminalState}
				researchStatus={researchStatus}
				disabled={!panel || evidenceOpen || Boolean(selectReq)}
				onInput={sendInput}
				onReturnToTerminal={focusTerminal}
			/>
			<ContextHud
				state={terminalState}
				researchStatus={researchStatus}
				disabled={!panel || evidenceOpen || Boolean(selectReq)}
				onInput={sendInput}
			/>
			<WatchlistImport
				open={watchlistImportOpen}
				onOpenChange={handleWatchlistImportOpenChange}
				onApply={handleWatchlistImport}
			/>
			{panelWasOpened && !panel && (
				<div className="closed-overlay" role="dialog" aria-modal="true" aria-label="Panel closed">
					<div className="closed-modal">
						<div className="closed-title">Panel closed</div>
						<button type="button" className="closed-reopen" onClick={reopenMarket} autoFocus>
							Reopen Market Map
						</button>
					</div>
				</div>
			)}
			{selectReq && (
				<div className="select-overlay" onClick={() => resolveSelect(undefined, true)} role="dialog" aria-modal="true" aria-label={selectReq.title}>
					<div className="select-modal" onClick={(event) => event.stopPropagation()}>
						<div className="select-title">{selectReq.title}</div>
						<div className="select-options">
							{selectReq.options.map((option, index) => (
								<button type="button" className="select-option" key={`${selectReq.id}-${index}`} onClick={() => resolveSelect(option)} autoFocus={index === 0}>
									{option}
								</button>
							))}
						</div>
						<button type="button" className="select-cancel" onClick={() => resolveSelect(undefined, true)}>Cancel (Esc)</button>
					</div>
				</div>
			)}
			{evidenceOpen && dossier && <EvidenceInspector dossier={dossier} onClose={() => setEvidenceOpen(false)} />}
			{error && <div className="browser-alpha-toast">{error}</div>}
		</div>
	);
}
