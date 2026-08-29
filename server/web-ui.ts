/**
 * Web UI shim — the ONLY piece we implement. It satisfies the Pi
 * `ExtensionUIContext` the market-terminal extension talks to, and nothing else.
 *
 * In the SDK architecture, the REAL `createAgentSession()` is the
 * `ExtensionAPI`: it owns the agent, tools, events, `pi.exec`, `pi.sendUserMessage`,
 * and model/auth. We only provide the UI surface (`ctx.ui`) so the extension's
 * `ctx.ui.custom()` hands us the live panel component, whose `render()` we
 * project to the browser. Research (J/K) works because it is the real agent in
 * the same process publishing to the same panel instance.
 *
 * The extension uses exactly four UI methods: `custom`, `onTerminalInput`,
 * `notify`, `select`. Every other `ExtensionUIContext` member is a no-op via a
 * Proxy (the extension never calls them; the real session doesn't either for
 * our flow).
 */

import type {
  ExtensionUIContext,
  ExtensionCommandContextActions,
} from "@earendil-works/pi-coding-agent";
import type { WatchlistUpdate, WatchlistUpdateMode } from "../shared/watchlist-symbols.js";
import webTheme from "./theme.js";

/** The runtime shape of a MarketTerminal / MarketHub panel instance. */
export type Panel = {
  render(width: number): string[];
  handleInput(data: string): void;
  debugState?(): unknown;
  applyWatchlist?(symbols: readonly string[], mode: WatchlistUpdateMode): WatchlistUpdate;
};

export interface WebUiHooks {
  /** A panel opened (non-null) or closed (null). */
  onPanel: (panel: Panel | null) => void;
  /** The extension requested a redraw (coalesce aggressively). */
  onRenderRequest: () => void;
  /** Show a toast. */
  onNotify: (message: string, level: string) => void;
  /** Ask the user to pick an option; resolve with the choice or undefined. */
  onSelect: (id: string, title: string, options: string[]) => Promise<string | undefined>;
}

export interface WebUi {
  ui: ExtensionUIContext;
  webTui: { requestRender(force?: boolean): void; terminal: { rows: number } };
  commandContextActions: ExtensionCommandContextActions;
  /** Forward a raw key string to the extension's terminal-input handler. */
  sendInput: (data: string) => void;
  /** Resolve a pending select from the browser. */
  resolveSelect: (id: string, value: string | undefined, cancelled: boolean) => void;
  /** Close an open custom panel and reject no browser resources on teardown. */
  dispose: () => void;
}

export function createWebUi(hooks: WebUiHooks): WebUi {
  const webTui = {
    requestRender: () => hooks.onRenderRequest(),
    terminal: { rows: 35 },
  };

  const pendingSelects = new Map<string, { resolve: (v: string | undefined) => void }>();
  let inputHandler: ((data: string) => unknown) | null = null;
  let closeCustom: (() => void) | null = null;

  const uiBase: Record<string, unknown> = {
    theme: webTheme,
    custom<T>(factory: (...args: unknown[]) => Panel, opts?: { onHandle?: (h: unknown) => void }): Promise<T> {
      return new Promise<T>((resolve) => {
        const done = (result: T) => {
          closeCustom = null;
          hooks.onPanel(null);
          resolve(result);
        };
        closeCustom = () => done(undefined as unknown as T);
        // factory(tui, theme, keybindings, done) => Component
        const panel = factory(webTui as never, webTheme as never, undefined as never, done as never);
        hooks.onPanel(panel);
        // The extension stores the overlay handle and later checks isFocused();
        // in the browser the panel is always focused while open.
        opts?.onHandle?.({ isFocused: () => true });
        hooks.onRenderRequest();
      });
    },
    onTerminalInput(handler: (data: string) => unknown): () => void {
      inputHandler = handler;
      return () => {
        inputHandler = null;
      };
    },
    notify(message: string, type?: string): void {
      hooks.onNotify(message, type ?? "info");
    },
    select(title: string, options: string[]): Promise<string | undefined> {
      const id = `sel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return new Promise<string | undefined>((resolve) => {
        pendingSelects.set(id, { resolve });
        hooks.onSelect(id, title, options);
      });
    },
  };

  // No-op fallback for any other ExtensionUIContext method.
  const ui = new Proxy(uiBase, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === "theme") return webTheme;
      return () => {};
    },
  }) as unknown as ExtensionUIContext;

  const commandContextActions = {
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
  } as unknown as ExtensionCommandContextActions;

  return {
    ui,
    webTui,
    commandContextActions,
    sendInput: (data: string) => {
      inputHandler?.(data);
    },
    resolveSelect: (id: string, value: string | undefined, cancelled: boolean) => {
      const pending = pendingSelects.get(id);
      if (pending) {
        pendingSelects.delete(id);
        pending.resolve(cancelled ? undefined : value);
      }
    },
    dispose: () => {
      const close = closeCustom;
      closeCustom = null;
      close?.();
      inputHandler = null;
      for (const pending of pendingSelects.values()) pending.resolve(undefined);
      pendingSelects.clear();
    },
  };
}
