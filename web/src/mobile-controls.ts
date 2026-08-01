import type { TerminalDossier } from "./dossier";

export const TERMINAL_INPUTS = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
} as const;

export type ChartScope = "day" | "week" | "month" | "year" | "max";
export type ResearchActivity = "seeding" | "fetching" | "extracting" | "synthesizing";
export type ResearchPhase = "queued" | "dispatched" | "running" | "cancelling" | "settled";

export interface TerminalResearchState {
  id?: string;
  symbol?: string;
  outcome?: "queued" | "running" | "partial" | "complete" | "failed" | "cancelled";
  phase?: ResearchPhase;
  activity?: ResearchActivity;
  active?: boolean;
}

/** Scroll window emitted by the canonical extension's story/briefing panes. */
export interface TerminalScrollWindow {
  offset: number;
  rows: number;
  viewportRows: number;
}

export interface TerminalFrameState {
  mode?: "market" | "ticker";
  screen?: string;
  symbol?: string;
  chartScope?: ChartScope;
  watched?: boolean;
  searching?: boolean;
  searchQuery?: string;
  cacheDecision?: unknown;
  research?: TerminalResearchState;
  researchQueue?: TerminalResearchState[];
  /** Optional research dossier; absent on old server frames. */
  dossier?: TerminalDossier;
  demo?: boolean;
  // Fields emitted by the canonical extension's debugState() and consumed by
  // the browser interaction layer (web-interactions.ts). They only exist for
  // states the extension actually publishes them for.
  status?: string;
  selectedIndex?: number;
  selected?: string;
  available?: string[];
  signalsFocus?: "headlines" | "story";
  eventsFocus?: "lanes" | "briefing";
  storyScroll?: TerminalScrollWindow;
  eventScroll?: TerminalScrollWindow;
  hasCanvas?: boolean;
}

export interface MobileAction {
  id: string;
  label: string;
  keyHint: string;
  input?: string;
  tone?: "default" | "accent" | "warning";
  disabled?: boolean;
}

export const SCOPE_ACTIONS: ReadonlyArray<{
  scope: ChartScope;
  label: string;
  input: string;
}> = [
  { scope: "day", label: "1D", input: "1" },
  { scope: "week", label: "1W", input: "2" },
  { scope: "month", label: "1M", input: "3" },
  { scope: "year", label: "1Y", input: "4" },
  { scope: "max", label: "ALL", input: "5" },
];

export function mobileActions(state?: TerminalFrameState): MobileAction[] {
  if (state?.cacheDecision) {
    return [
      { id: "use-cache", label: "Use", keyHint: "U", input: "u", tone: "accent" },
      { id: "refresh-cache", label: "Refresh", keyHint: "F", input: "f" },
      {
        id: "cancel-cache",
        label: "Cancel",
        keyHint: "ESC",
        input: TERMINAL_INPUTS.escape,
        tone: "warning",
      },
    ];
  }

  const isTicker = state?.mode === "ticker";
  const screen = state?.screen?.toUpperCase();
  const hasSplitPane = screen === "SIGNALS" || screen === "EVENTS";
  const watchable =
    isTicker || screen === "MARKET" || screen === "MOVERS" || screen === "WATCH";
  const researchActive = Boolean(state?.research?.active);

  let contextAction: MobileAction;
  if (isTicker) {
    contextAction = {
      id: "back",
      label: "Back",
      keyHint: "ESC",
      input: TERMINAL_INPUTS.escape,
    };
  } else if (hasSplitPane) {
    contextAction = {
      id: "pane",
      label: "Pane",
      keyHint: "TAB",
      input: TERMINAL_INPUTS.tab,
    };
  } else {
    contextAction = { id: "help", label: "Help", keyHint: "?", input: "?" };
  }

  let contextualAction: MobileAction;
  if (researchActive) {
    contextualAction = {
      id: "cancel-research",
      label: "Cancel",
      keyHint: "C",
      input: "c",
      tone: "warning",
    };
  } else if (watchable) {
    contextualAction = {
      id: "watch",
      label: state?.watched ? "Unwatch" : "Watch",
      keyHint: "E",
      input: "e",
    };
  } else if (screen === "SIGNALS") {
    contextualAction = { id: "older", label: "Older", keyHint: "[", input: "[" };
  } else {
    contextualAction = {
      id: "watch",
      label: "Watch",
      keyHint: "E",
      input: "e",
      disabled: true,
    };
  }

  return [
    contextAction,
    // The center Enter action in the navigation row is the primary Open/Brief
    // path. Keep Why available as an explicit, quieter secondary action
    // instead of duplicating the legacy J/K pair in the touch deck.
    { id: "why", label: "Why", keyHint: "K", input: "k" },
    contextualAction,
    { id: "sync", label: "Sync", keyHint: "R", input: "r" },
    { id: "search", label: "Symbol", keyHint: "/", tone: "accent" },
  ];
}

function researchStatusFor(job: TerminalResearchState): string {
  const prefix = job.symbol ? `RESEARCH ${job.symbol}` : "RESEARCH";
  if (job.phase === "queued") return `${prefix} · QUEUED`;
  if (job.phase === "dispatched") return `${prefix} · STARTING`;
  if (job.phase === "cancelling" || job.outcome === "cancelled") return `${prefix} · CANCELLING`;
  if (job.outcome === "complete") return `${prefix} · FINALIZING`;
  switch (job.activity) {
    case "seeding": return `${prefix} · SEARCHING SOURCES`;
    case "fetching": return `${prefix} · FETCHING SOURCES`;
    case "extracting": return `${prefix} · EXTRACTING EVIDENCE`;
    case "synthesizing": return `${prefix} · BUILDING BRIEF`;
    default: return `${prefix} · SEARCHING`;
  }
}

/** Return the clearest active research status even when the user navigates away from its original context. */
export function activeResearchStatus(state?: TerminalFrameState): string | undefined {
  if (state?.research?.active) return researchStatusFor(state.research);
  const queued = state?.researchQueue ?? [];
  const active = queued.find((job) => job.phase === "running")
    ?? queued.find((job) => job.phase === "dispatched")
    ?? queued.find((job) => job.phase === "queued");
  return active ? researchStatusFor(active) : undefined;
}

/** Keep mobile symbol entry aligned with the extension's accepted ticker form. */
export function normalizeSymbolInput(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9.^-]/g, "").slice(0, 11);
}

export function isValidSymbolInput(value: string): boolean {
  const symbol = normalizeSymbolInput(value);
  return /^(\^?[A-Z][A-Z0-9.-]{0,9}|[0-9]{6}\.(SS|SZ))$/.test(symbol);
}

export function symbolSearchInputs(value: string): string[] {
  const symbol = normalizeSymbolInput(value);
  if (!isValidSymbolInput(symbol)) return [];
  return ["/", ...symbol, TERMINAL_INPUTS.enter];
}

export interface SwipePoint {
  x: number;
  y: number;
  at: number;
}

/**
 * Map a deliberate horizontal finger swipe to the terminal's previous/next
 * screen input. Vertical movement remains available to browser/OS gestures.
 */
export function horizontalSwipeInput(
  start: SwipePoint,
  end: SwipePoint,
): string | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const elapsed = end.at - start.at;
  if (elapsed < 0 || elapsed > 900) return null;
  if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.25) return null;
  // Finger left reveals the next screen; finger right returns to the previous.
  return dx < 0 ? TERMINAL_INPUTS.right : TERMINAL_INPUTS.left;
}

export function verticalSwipeScroll(
  start: SwipePoint,
  end: SwipePoint,
): { direction: "up" | "down"; amount: number } | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const elapsed = end.at - start.at;
  if (elapsed < 0 || elapsed > 900) return null;
  if (Math.abs(dy) < 48 || Math.abs(dy) < Math.abs(dx) * 1.25) return null;
  return {
    direction: dy < 0 ? "down" : "up",
    amount: Math.min(8, Math.max(1, Math.floor(Math.abs(dy) / 48))),
  };
}
