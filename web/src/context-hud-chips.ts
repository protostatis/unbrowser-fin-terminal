import {
  canRestoreTickerSplit,
  TERMINAL_INPUTS,
  type ResearchActivityStatus,
  type TerminalFrameState,
} from "./mobile-controls";

/**
 * Pure model for the touch ContextHud (Option C). Kept separate from the React
 * component so the chip set — including the modal cache decision — is unit
 * tested per screen. The component renders whatever these return.
 */

export interface ContextHudChip {
  id: string;
  label: string;
  input: string;
  tone?: "default" | "accent" | "warning";
}

/**
 * Whether the persistent ‹ Back button shows. Back is ticker-only and is
 * suppressed by modal states (cache decision, symbol search) that lock
 * navigation until resolved.
 */
export function contextHudShowBack(state?: TerminalFrameState): boolean {
  return state?.mode === "ticker" && !state?.cacheDecision && !state?.searching;
}

/**
 * The chip set for the active partition.
 *
 * The cache-decision modal is screen-agnostic and takes priority: on ANY
 * screen (ticker, MARKET, SIGNALS, EVENTS, …) a pending cache decision surfaces
 * Use / Refresh / Cancel and nothing else, because the prompt blocks all other
 * input until resolved. Otherwise the chips follow the current screen/mode.
 */
export function contextHudChips(
  state?: TerminalFrameState,
  researchStatus?: ResearchActivityStatus,
): ContextHudChip[] {
  if (state?.cacheDecision) {
    return [
      { id: "use", label: "Use", input: "u", tone: "accent" },
      { id: "refresh-cache", label: "Refresh", input: "f" },
      { id: "cancel-cache", label: "Cancel", input: TERMINAL_INPUTS.escape, tone: "warning" },
    ];
  }

  const chips: ContextHudChip[] = [];
  if (state?.searching) return chips;

  if (researchStatus?.active) {
    chips.push({ id: "cancel", label: "■ Cancel", input: "c", tone: "warning" });
  }

  const screen = state?.screen?.toUpperCase();
  if (state?.mode === "ticker") {
    if (canRestoreTickerSplit(state)) {
      chips.push({ id: "split", label: "▦ Split", input: TERMINAL_INPUTS.tab, tone: "accent" });
    }
    if (state.tickerLayout === "quote" && (state.tickerNavigation?.count ?? 0) > 1) {
      const source = state.tickerNavigation?.source === "watch" ? "Watch" : "Movers";
      chips.push({ id: "previous-ticker", label: `‹ ${source}`, input: TERMINAL_INPUTS.up });
      chips.push({ id: "next-ticker", label: `${source} ›`, input: TERMINAL_INPUTS.down });
    }
    chips.push({ id: "brief", label: "Brief", input: "j" });
    chips.push({ id: "why", label: "Why", input: "k", tone: "accent" });
    if (screen === "RESEARCH" || screen === "SPLIT") {
      chips.push({ id: "older", label: "Older", input: "[" });
      if (state.archive) chips.push({ id: "newer", label: "Newer", input: "]" });
    }
    chips.push({ id: "watch", label: state?.watched ? "★ Unwatch" : "★ Watch", input: "e" });
    chips.push({ id: "refresh", label: "⟳ Refresh", input: "r" });
  } else if (screen === "SIGNALS" || screen === "EVENTS") {
    // Split-pane screens need an explicit focus toggle on touch: the narrow
    // stacked layout renders both panes, but Tab is the only way to give the
    // brief room and make it scrollable. Tap-to-focus only works when wide.
    const toStory = screen === "SIGNALS" && state?.signalsFocus !== "story";
    const toBriefing = screen === "EVENTS" && state?.eventsFocus !== "briefing";
    chips.push({
      id: "pane",
      label: toStory ? "Story ▸" : toBriefing ? "Briefing ▸" : "◂ List",
      input: TERMINAL_INPUTS.tab,
      tone: "accent",
    });
    chips.push({ id: "brief", label: "Brief", input: "j" });
    chips.push({ id: "why", label: "Why", input: "k" });
    if (screen === "SIGNALS") {
      chips.push({ id: "older", label: "Older", input: "[" });
      if (state?.archive) chips.push({ id: "newer", label: "Newer", input: "]" });
    }
    chips.push({ id: "refresh", label: "⟳ Refresh", input: "r" });
  } else if (state?.mode === "market") {
    // MARKET / MOVERS / WATCH: quote rows are tight on a phone, so expose a
    // reliable Open (Enter) for the selected ticker alongside Refresh.
    if (screen === "MARKET") {
      chips.push({
        id: "crypto",
        label: state.marketView === "crypto" ? "Global" : "Crypto",
        input: "g",
        tone: "accent",
      });
    }
    chips.push({ id: "open", label: "Open", input: TERMINAL_INPUTS.enter, tone: "accent" });
    chips.push({ id: "refresh", label: "⟳ Refresh", input: "r" });
  }

  return chips;
}
