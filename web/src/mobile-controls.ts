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
  contextLabel?: string;
  symbol?: string;
  outcome?: "queued" | "running" | "partial" | "complete" | "failed" | "cancelled";
  phase?: ResearchPhase;
  activity?: ResearchActivity;
  active?: boolean;
  updatedAt?: number;
  settledAt?: number;
}

export type ResearchStatusTone =
  | "queued"
  | "active"
  | "synthesizing"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "complete"
  | "partial";

export interface ResearchActivityStatus {
  id?: string;
  contextLabel?: string;
  symbol?: string;
  label: string;
  text: string;
  tone: ResearchStatusTone;
  active: boolean;
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
  recentResearch?: TerminalResearchState[];
  /** Optional research dossier; absent on old server frames. */
  dossier?: TerminalDossier;
  demo?: boolean;
  // Fields emitted by the canonical extension's debugState() and consumed by
  // the browser interaction layer (web-interactions.ts). They only exist for
  // states the extension actually publishes them for.
  status?: string;
  selectedIndex?: number;
  selected?: string;
  /** Canonical ordered watchlist, independent of the current screen rows. */
  watchlist?: string[];
  available?: string[];
  signalsFocus?: "headlines" | "story";
  eventsFocus?: "lanes" | "briefing";
  storyScroll?: TerminalScrollWindow;
  eventScroll?: TerminalScrollWindow;
  /** Ticker canvas scroll state; present on RESEARCH and wide SPLIT layouts. */
  canvasScroll?: TerminalScrollWindow;
  /** Wide ticker view identity emitted by the canonical extension. */
  tickerLayout?: "quote" | "research" | "split";
  /** Whether the current terminal dimensions can render the ticker split. */
  tickerSplitAvailable?: boolean;
  /** MARKET-screen GLOBAL↔CRYPTO subview emitted by the canonical extension. */
  marketView?: "global" | "crypto";
  /** Frozen source-list context when a ticker was opened from MOVERS or WATCH. */
  tickerNavigation?: {
    source: "movers" | "watch";
    index: number;
    count: number;
  };
  hasCanvas?: boolean;
  /** Present only while an archived research canvas is displayed. */
  archive?: {
    position: number;
    count: number;
    asOf?: number;
  };
  /**
   * Live layout geometry published by the extension's debugState(). The browser
   * interaction layer uses this (instead of hardcoded row counts) so it stays
   * correct as the extension reclaims/collapses header & footer rows.
   */
  layout?: {
    headerRows: number;
    footerRows: number;
    width: number;
    totalRows: number;
    splitPane: boolean;
  };
}

export interface MobileAction {
  id: string;
  label: string;
  keyHint: string;
  input?: string;
  tone?: "default" | "accent" | "warning";
  disabled?: boolean;
}

/** A full ticker view can restore Split only when the terminal confirms it fits. */
export function canRestoreTickerSplit(state?: TerminalFrameState): boolean {
  return state?.mode === "ticker"
    && state.tickerSplitAvailable === true
    && (state.tickerLayout === "quote" || state.tickerLayout === "research");
}

export function isWatchImportContext(state?: TerminalFrameState): boolean {
  return state?.mode === "market" && state?.screen?.toUpperCase() === "WATCH";
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
  const archive = state?.archive;

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

  // Archive browsing is otherwise keyboard-only ([ / ]). When an archive is
  // open, give both directions their own touch actions instead of burying the
  // user behind an Older-only route.
  if (!researchActive && archive) {
    const atOldest = archive.position >= Math.max(0, archive.count - 1);
    return [
      contextAction,
      { id: "why", label: "Why", keyHint: "K", input: "k" },
      { id: "older", label: "Older", keyHint: "[", input: "[", disabled: atOldest },
      { id: "newer", label: "Newer", keyHint: "]", input: "]" },
      { id: "sync", label: "Sync", keyHint: "R", input: "r" },
      { id: "search", label: "Symbol", keyHint: "/", tone: "accent" },
    ];
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
    ...(screen === "MARKET"
      ? [{
          id: "crypto",
          label: state?.marketView === "crypto" ? "Global" : "Crypto",
          keyHint: "G",
          input: "g",
          tone: "accent" as const,
        }]
      : []),
    { id: "sync", label: "Sync", keyHint: "R", input: "r" },
    { id: "search", label: "Symbol", keyHint: "/", tone: "accent" },
  ];
}

function researchStatusFor(job: TerminalResearchState): ResearchActivityStatus {
  const id = job.id;
  const contextLabel = job.contextLabel?.trim() || undefined;
  const symbol = job.symbol?.trim() || undefined;
  const prefix = contextLabel ? `RESEARCH ${contextLabel}` : symbol ? `RESEARCH ${symbol}` : "RESEARCH";
  const status = (
    label: string,
    tone: ResearchStatusTone,
    active: boolean,
  ): ResearchActivityStatus => ({
    id,
    contextLabel,
    symbol,
    label,
    text: `${prefix} · ${label}`,
    tone,
    active,
  });
  const isActive = job.active ?? (job.phase !== "settled");

  if (job.outcome === "failed") return status("RESEARCH FAILED", "failed", false);
  if (job.phase === "cancelling") return status("CANCELLING", "cancelling", true);
  if (job.outcome === "cancelled") return status("CANCELLED", "cancelled", false);
  if (job.phase === "queued") return status("QUEUED", "queued", true);
  if (job.phase === "dispatched") return status("STARTING", "active", true);
  if (job.outcome === "complete") {
    return isActive
      ? status("FINALIZING BRIEF", "synthesizing", true)
      : status("RESULTS READY", "complete", false);
  }
  if (job.phase === "settled" && job.outcome === "partial") {
    return status("PARTIAL RESULTS", "partial", false);
  }
  switch (job.activity) {
    case "seeding": return status("SEARCHING SOURCES", "active", true);
    case "fetching": return status("FETCHING SOURCES", "active", true);
    case "extracting": return status("EXTRACTING EVIDENCE", "active", true);
    case "synthesizing": return status("BUILDING BRIEF", "synthesizing", true);
    default: return status("SEARCHING", "active", isActive);
  }
}

/** Return the clearest currently active research job. */
export function researchActivityStatus(state?: TerminalFrameState): ResearchActivityStatus | undefined {
  if (state?.research?.active) return researchStatusFor(state.research);
  const queued = state?.researchQueue ?? [];
  const active = queued.find((job) => job.phase === "running")
    ?? queued.find((job) => job.phase === "dispatched")
    ?? queued.find((job) => job.phase === "cancelling")
    ?? queued.find((job) => job.phase === "queued");
  if (active) return researchStatusFor(active);
  return undefined;
}

/** Settled jobs are buffered by the app shell so concurrent outcomes are not lost. */
export function recentResearchStatuses(state?: TerminalFrameState): ResearchActivityStatus[] {
  return (state?.recentResearch ?? [])
    .filter((job) => job.phase === "settled")
    .map(researchStatusFor);
}

/** Text-only form retained for compact consumers and terminal-status tests. */
export function activeResearchStatus(state?: TerminalFrameState): string | undefined {
  return researchActivityStatus(state)?.text;
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
