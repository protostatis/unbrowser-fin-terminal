/**
 * Pure browser interaction model for the terminal frame.
 *
 * These helpers derive compact, render-ready facts from the canonical
 * extension's `debugState()` projection (as typed by TerminalFrameState) for
 * the companion web overlay: the ordered selectable list, the SIGNALS/EVENTS
 * pane choices, which scroll controls are meaningful, and the keyboard
 * guidance that foregrounds arrows/Enter/Tab while keeping J/K as
 * compatibility shortcuts (with Why K explicitly secondary).
 *
 * This module is deliberately React/DOM-free and never parses terminal rows:
 * everything is derived from state fields the extension already publishes.
 */
import {
  TERMINAL_INPUTS,
  type ChartScope,
  type TerminalFrameState,
} from "./mobile-controls";

/**
 * Whitelisted semantic browser actions. The server validates each action
 * against the live terminal state before translating it to canonical inputs.
 */
export type TerminalPane = "headlines" | "story" | "lanes" | "briefing";

export const MARKET_SCREENS = [
  "MARKET",
  "SIGNALS",
  "EVENTS",
  "MOVERS",
  "WATCH",
] as const;

export type MarketScreen = (typeof MARKET_SCREENS)[number];

export type TerminalActionContext =
  | {
      mode: "market";
      screen: string;
      selectedIndex: number;
      selected: string | null;
      pane: TerminalPane | null;
    }
  | {
      mode: "ticker";
      screen: string;
      symbol: string;
    };

export type TerminalWebAction =
  | { action: "navigate-screen"; screen: MarketScreen }
  | { action: "set-chart-scope"; scope: ChartScope }
  | { action: "select"; screen: string; index: number; item: string }
  | {
      action: "focus-pane";
      pane: TerminalPane;
    }
  | { action: "primary"; context: TerminalActionContext }
  | { action: "why"; context: TerminalActionContext }
  | {
      action: "scroll";
      direction: "up" | "down";
      amount?: number;
      /** A hovered split pane, so the first wheel step uses that pane. */
      pane?: TerminalPane;
      /** Rendered screen identity; the server rejects a delayed stale wheel action. */
      screen?: string;
    };

/* ── Selectable list ──────────────────────────────────────────────────── */

export interface SelectableItem {
  label: string;
  index: number;
  selected: boolean;
}

/**
 * Ordered selectable items for the current market screen. Only market states
 * carry an `available` list, and only when the terminal is not locked on a
 * cache decision or an in-terminal search. `selectedIndex` positions the
 * highlighted row.
 */
export function selectableItems(state?: TerminalFrameState): SelectableItem[] {
  if (!state || state.mode !== "market") return [];
  if (state.cacheDecision || state.searching) return [];
  const available = state.available;
  if (!Array.isArray(available) || available.length === 0) return [];
  const selectedIndex =
    typeof state.selectedIndex === "number" && Number.isFinite(state.selectedIndex)
      ? state.selectedIndex
      : 0;
  return available.map((label, index) => ({
    label: String(label),
    index,
    selected: index === selectedIndex,
  }));
}

/* ── Pane choices (SIGNALS / EVENTS) ──────────────────────────────────── */

export interface PaneChoice {
  id: TerminalPane;
  label: string;
  selected: boolean;
}

export interface PaneModel {
  activePaneId: PaneChoice["id"];
  panes: PaneChoice[];
}

/**
 * Split-pane choices for the SIGNALS (headlines | story) and EVENTS
 * (lanes | briefing) screens, with the currently focused pane flagged. Other
 * screens (and the ticker view) have a single pane, so they return undefined.
 */
export function paneChoices(state?: TerminalFrameState): PaneModel | undefined {
  if (!state || state.mode !== "market") return undefined;
  const screen = state.screen?.toUpperCase();
  if (screen === "SIGNALS") {
    const active = state.signalsFocus ?? "headlines";
    return {
      activePaneId: active,
      panes: [
        { id: "headlines", label: "Headlines", selected: active === "headlines" },
        { id: "story", label: "Market Story", selected: active === "story" },
      ],
    };
  }
  if (screen === "EVENTS") {
    const active = state.eventsFocus ?? "lanes";
    return {
      activePaneId: active,
      panes: [
        { id: "lanes", label: "Catalyst Lanes", selected: active === "lanes" },
        { id: "briefing", label: "Briefing", selected: active === "briefing" },
      ],
    };
  }
  return undefined;
}

/* ── Scroll controls ──────────────────────────────────────────────────── */

export type ScrollTarget = "canvas" | "story" | "briefing";

export interface ScrollControl {
  target: ScrollTarget;
  /** Content exceeds its viewport, so line/paged scrolling is meaningful. */
  scrollable: boolean;
  /** Top visible line, when the extension reports the scroll window. */
  offset?: number;
  /** Total content lines, when the extension reports the scroll window. */
  rows?: number;
  /** Viewport capacity in lines, when the extension reports the scroll window. */
  viewportRows?: number;
}

/**
 * Scroll controls that are meaningful for the current view:
 * - ticker RESEARCH tab with a canvas scrolls the canvas;
 * - SIGNALS story / EVENTS briefing scroll only when the reported content
 *   exceeds the viewport (rows > viewportRows). Normal market lists never
 *   scroll — their arrows move the selection instead (see arrowsMoveSelection).
 */
export function scrollControls(state?: TerminalFrameState): ScrollControl[] {
  const controls: ScrollControl[] = [];
  if (!state) return controls;

  if (state.mode === "ticker") {
    if (state.screen?.toUpperCase() === "RESEARCH" && state.hasCanvas) {
      controls.push({ target: "canvas", scrollable: true });
    }
    return controls;
  }

  const screen = state.screen?.toUpperCase();
  if (screen === "SIGNALS" && state.signalsFocus === "story" && state.storyScroll) {
    controls.push({
      target: "story",
      scrollable: state.storyScroll.rows > state.storyScroll.viewportRows,
      offset: state.storyScroll.offset,
      rows: state.storyScroll.rows,
      viewportRows: state.storyScroll.viewportRows,
    });
  }
  if (screen === "EVENTS" && state.eventsFocus === "briefing" && state.eventScroll) {
    controls.push({
      target: "briefing",
      scrollable: state.eventScroll.rows > state.eventScroll.viewportRows,
      offset: state.eventScroll.offset,
      rows: state.eventScroll.rows,
      viewportRows: state.eventScroll.viewportRows,
    });
  }
  return controls;
}

/**
 * True when the vertical arrows change the list selection on the current
 * screen (normal market lists, SIGNALS headlines, EVENTS lanes) rather than
 * scrolling content (story, briefing, canvas).
 */
export function arrowsMoveSelection(state?: TerminalFrameState): boolean {
  if (!state || state.mode !== "market") return false;
  const screen = state.screen?.toUpperCase();
  if (screen === "SIGNALS") return state.signalsFocus !== "story";
  if (screen === "EVENTS") return state.eventsFocus !== "briefing";
  return screen === "MARKET" || screen === "MOVERS" || screen === "WATCH";
}

/**
 * Whether a mouse wheel / trackpad gesture has a meaningful canonical action
 * in the current view. Lists move the selection; canvases scroll their content.
 */
export function canUsePointerScroll(
  state?: TerminalFrameState,
  pane?: TerminalPane,
): boolean {
  if (pane) {
    if (state?.mode !== "market") return false;
    const screen = state.screen?.toUpperCase();
    if (pane === "headlines") return screen === "SIGNALS";
    if (pane === "lanes") return screen === "EVENTS";
    if (pane === "story") {
      return Boolean(
        screen === "SIGNALS" &&
          state.storyScroll &&
          state.storyScroll.rows > state.storyScroll.viewportRows,
      );
    }
    return Boolean(
      screen === "EVENTS" &&
        state.eventScroll &&
        state.eventScroll.rows > state.eventScroll.viewportRows,
    );
  }
  return (
    arrowsMoveSelection(state) ||
    scrollControls(state).some((control) => control.scrollable)
  );
}

/**
 * Snapshot the target of a primary or Why action. The server compares this
 * identity against its live state so a delayed click cannot act on a different
 * selection, pane, ticker, or tab than the one shown in the browser.
 */
export function terminalActionContext(
  state?: TerminalFrameState,
): TerminalActionContext | undefined {
  if (!state?.mode || !state.screen) return undefined;

  if (state.mode === "ticker") {
    if (!state.symbol) return undefined;
    return { mode: "ticker", screen: state.screen, symbol: state.symbol };
  }

  const selectedIndex = state.selectedIndex;
  if (
    typeof selectedIndex !== "number" ||
    !Number.isInteger(selectedIndex) ||
    selectedIndex < 0
  ) {
    return undefined;
  }

  const screen = state.screen.toUpperCase();
  const pane: TerminalPane | null =
    screen === "SIGNALS"
      ? state.signalsFocus ?? "headlines"
      : screen === "EVENTS"
        ? state.eventsFocus ?? "lanes"
        : null;
  return {
    mode: "market",
    screen: state.screen,
    selectedIndex,
    selected: state.selected ?? null,
    pane,
  };
}

/* ── Key guidance ─────────────────────────────────────────────────────── */

export type KeyHintTone = "primary" | "secondary" | "why";

export interface ContextKeyHint {
  /** Display keys, e.g. "↑/↓", "Enter", "Tab", "J", "K". */
  keys: string;
  /** Action label, e.g. "Select", "Open", "Pane", "Brief", "Why". */
  label: string;
  /** primary = arrows/Enter/Tab foreground; why = deliberately secondary. */
  tone: KeyHintTone;
  /** Terminal input this hint sends when activated (absent for arrow pairs). */
  input?: string;
}

/**
 * Ordered key guidance that foregrounds arrows + Enter (and Tab on split-pane
 * screens) for navigation/primary action. J remains a compatibility shortcut,
 * and Why (K) is explicitly secondary instead of being foregrounded alongside
 * J. While the terminal is locked (cache decision) or an in-terminal search
 * is active, no navigation hints are shown because the keys are busy.
 */
export function contextKeyHints(state?: TerminalFrameState): ContextKeyHint[] {
  if (!state || state.cacheDecision || state.searching) return [];
  const hints: ContextKeyHint[] = [];

  const navigation = navigationHint(state);
  if (navigation) hints.push(navigation);

  if (state.mode === "market") {
    hints.push({
      keys: "Enter",
      label: "Open",
      tone: "primary",
      input: TERMINAL_INPUTS.enter,
    });
    const panes = paneChoices(state);
    if (panes && panes.panes.length > 1) {
      hints.push({ keys: "Tab", label: "Pane", tone: "primary", input: TERMINAL_INPUTS.tab });
    }
  } else {
    hints.push({
      keys: "Enter",
      label: "Brief",
      tone: "primary",
      input: TERMINAL_INPUTS.enter,
    });
  }

  // Compatibility shortcuts: J (brief/open) and K (why), with K de-emphasized.
  hints.push({
    keys: "J",
    label: state.mode === "market" ? "Open" : "Brief",
    tone: "secondary",
    input: "j",
  });
  hints.push({ keys: "K", label: "Why", tone: "why", input: "k" });

  return hints;
}

function navigationHint(state: TerminalFrameState): ContextKeyHint | undefined {
  if (state.mode === "ticker") {
    if (state.screen?.toUpperCase() === "RESEARCH" && state.hasCanvas) {
      return { keys: "↑/↓", label: "Scroll canvas", tone: "primary", input: TERMINAL_INPUTS.up };
    }
    return { keys: "←/→", label: "Switch tab", tone: "primary", input: TERMINAL_INPUTS.right };
  }

  const screen = state.screen?.toUpperCase();
  if (screen === "SIGNALS") {
    if (state.signalsFocus === "story") {
      const scroll = state.storyScroll;
      return scroll && scroll.rows > scroll.viewportRows
        ? { keys: "↑/↓", label: "Scroll story", tone: "primary", input: TERMINAL_INPUTS.up }
        : undefined;
    }
    return { keys: "↑/↓", label: "Select headline", tone: "primary", input: TERMINAL_INPUTS.up };
  }
  if (screen === "EVENTS") {
    if (state.eventsFocus === "briefing") {
      const scroll = state.eventScroll;
      return scroll && scroll.rows > scroll.viewportRows
        ? { keys: "↑/↓", label: "Scroll briefing", tone: "primary", input: TERMINAL_INPUTS.up }
        : undefined;
    }
    return { keys: "↑/↓", label: "Select lane", tone: "primary", input: TERMINAL_INPUTS.up };
  }
  if (screen === "MARKET" || screen === "MOVERS" || screen === "WATCH") {
    return { keys: "↑/↓", label: "Select", tone: "primary", input: TERMINAL_INPUTS.up };
  }
  return undefined;
}
