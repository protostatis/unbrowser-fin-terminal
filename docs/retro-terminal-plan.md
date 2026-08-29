# Retro Financial Terminal — Vision & Pi Replacement Plan (Parked)

> **Status:** DOCUMENTED — NOT IN EXECUTION
> **Date:** 2026-08-22
> **Decision:** Park Pi replacement. Address other product issues first. This doc preserves the audit and design branches so we can resume without re-discovery.

## 1. Final Goal (as brainstormed)

A **retro, keyboard-first financial terminal** that lets a user **quickly check all info** and where an **agentic layer consolidates data into a Canvas Frame**.

Interpreted as:
- **Retro:** `#0b0e14` background, `ui-monospace`, `tc-accent/success/warning` palette, scanline/cartridge chrome — not a generic dashboard. Existing `web/src/styles.css` + `EvidenceInspector` cartridge is the visual baseline.
- **Keyboard-based:** Every action reachable via `keyboard.ts` → Pi `handleInput` strings (`\r`, `\t`, `\x1b[A` etc). `web-interactions.ts` already maps semantic `TerminalWebAction` (`navigate-screen`, `select`, `focus-pane`, `primary`, `why`, `scroll`). No mouse-required flow.
- **Quickly check all info:** MARKET / SIGNALS / EVENTS / MOVERS / WATCH / TICKER (quote/research/split) reachable in ≤2 keystrokes. `TerminalFrameState` already carries `mode`, `screen`, `selectedIndex`, `signalsFocus`, `eventsFocus`, `tickerLayout`, `tickerSplitAvailable`.
- **Agentically consolidated Canvas Frame:** `dossier.ts: TerminalDossier` (`summary`, `packets`, `citations`, `evidenceStatus`) + `market-terminal.ts: Canvas` (`CanvasBlock` union `text|metrics|table|news|bullets|sources|chart`). Agent (`ResearchJob` + `UnbrowserMcpClient` + `ResearchWorkerCoordinator`) populates it; browser renders it either beside or over the terminal grid.

## 2. Current Architecture Audit (Pi + Plugin Framework)

**Pi = the brain.** `.pi/extensions/market-terminal.ts` (~4k LOC + `server/` + `shared/`) owns *all* domain logic:
- Market data plane: `MOVER_UNIVERSE` 100 symbols, `rankMovers()` weighted percentile, Yahoo `Quote` fetch (`QUOTE_FETCH_CONCURRENCY 8`), 5 `CHART_SCOPE_CONFIGS`, `MarketSnapshot`.
- Navigation state machine: `MarketHub` / `MarketTerminal` component classes, `MarketHubNavigationState`, `TickerNavigation` (frozen `movers|watch` list context).
- Canvas system: `CanvasBlock` (TypeBox, `MAX_CANVAS_CHARS 12k`), `canvasKey(symbol,scope,researchKey)`, `render()` via `pi-tui` `visibleWidth`/`truncateToWidth`.
- Research agentic plane: `ResearchJob` lifecycle `queued→dispatched→running→settled`, `UnbrowserMcpClient` extraction, `ResearchCandidateRegistry`, `paired` BRIEF+WHY pre-cache (`buildPairedPrecachePlan`), archival to `.pi/market-research-archive.json`, `MarketEventScout`.
- Quality gates: `decidePrecacheCanary()`, `isIdentityPrecacheCooled(streak=2, cooldown 2h)`, circuit-breaker on zero-evidence completes.

**Plugin Framework (`web/`) = the skin.** `TerminalFrame.tsx` is a dumb VT: `rows: string[]` of `<span class="tc tc-{color}">` already escaped by `server/theme.ts` `ansiToHtml()`. `main.tsx:App` opens `TerminalSocket`, subscribes to `frame|notify|select_request|closed` + lifecycle `_open/_close/_connecting`, measures viewport via hidden `rulerRef` + `ResizeObserver`, forwards `keyToData` as `input`. `web-interactions.ts` and `mobile-controls.ts` derive UI facts *only* from `debugState()` — no row parsing.

**Coupling cost:** The skin is coupled to Pi's *implicit* protocol. You distribute a "Pi Client", not a "Terminal Platform". Every interaction round-trips to Pi (no optimistic UI). `web/src/terminal-protocol.ts` was started to formalize `TerminalClient` (5 server→client: `frame|notify|select_request|closed` + lifecycle; 5 client→server: `input|web_action|resize|command|select_response`) — work paused here.

## 3. How Much Work to Replace Pi?

| Scope | What changes | Effort | What you get |
|-------|--------------|--------|--------------|
| **A. Transport abstraction only** | `TerminalSocket` → `TerminalClient` interface, `useTerminalSession` hook | 0.5–2 days | Distribution unlocked (web on Vercel, Pi behind gateway). Pi stays. |
| **B. Fork Pi, keep logic** | Fork `market-terminal.ts`, keep `Quote/telephony/canvas/research` logic, replace `ExtensionAPI` shim (`server/web-ui.ts`) with own `ws` server | 2–3 weeks | Shed `@earendil-works/pi-*@0.83.0` pin, own the deploy gate. Still the same 4k-logic brain. |
| **C. True Pi replacement** | Re-implement data source, `CanvasBlock` schema, research loop (`seeding→fetching→extracting→synthesizing`), `precache` + ledger + archive + scout + quality gates, replicate `pi-tui` truncation semantics | 6–10 weeks for parity | Full independence, offline bundle, Go/Rust backend, own LLM prompts. Must preserve `TerminalDossier` shape or `EvidenceInspector.tsx` breaks. |

**Why C is large:** `FrameMessage.state` (30+ fields: `layout`, `canvasScroll`, `archive`, `research/researchQueue/recentResearch`, etc.) and `CanvasBlock` (TypeBox union, 7 kinds, citations) *are* the contract. Rebuilding them without pi-tui's width math introduces truncation bugs (`...` + stray `\x1b[0m` — see `docs/web-ui-design.md` lesson).

**Recommendation parked with this doc:** Do **A** now when we resume, defer **B/C** until a distribution blocker appears (private npm, Pi version break, worker scaling cost). The retro UX can ship entirely on Pi's `rows` — no engine swap needed for V1.

## 4. Design Branches for the Canvas Frame (Brainstorm Open)

The single branching question from the brainstorm — *Canvas Frame Topology* — was left unanswered. Three options for next product pass:

### Option A: Persistent Split Canvas
- **Precondition:** Wide terminal (≥110 cols, ≥26 rows). `tickerSplitAvailable` already gates this.
- **Core:** Canvas lives persistently beside the grid (right/bottom pane). Grid shrinks; both visible at once.
- **Strengths:** Fastest glanceability (trader mode); no navigation loss.
- **Costs:** Responsive complexity, char-cell math for split ratio (`TICKER_SPLIT_LEFT_RATIO 0.45`), narrower grid.
- **Risk:** Two compromised panes on small screens.
- **Not if:** Primary users are on 80-col or mobile.

### Option B: Full-Screen Canvas as a Screen
- **Precondition:** Canvas is a first-class `screen` like `MARKET`/`RESEARCH`.
- **Core:** `Tab`/`←→` into Canvas; it takes the whole grid (Bloomberg `GP`-style).
- **Strengths:** Purest retro, simplest renderer, maximal reading space.
- **Costs:** Lose market context while reading.
- **Risk:** Feels like navigation, not an overlay.
- **Not if:** Promise is "check all info *without* leaving context".

### Option C: Overlay Drawer Canvas (current `evidence-overlay`)
- **Precondition:** Canvas pushed agentically (research complete) or on-demand `K/Why`.
- **Core:** Cartridge slides over terminal (`EvidenceInspector`), `ESC` ejects, terminal state preserved underneath.
- **Strengths:** Best for agent notifications; zero layout thrash; matches built `evidence-cartridge`.
- **Costs:** Modal feel; not a "terminal pane".
- **Risk:** User misses canvas if not looking at overlay trigger.
- **Not if:** Goal is persistent side-by-side comparison.

**Recommended bias when we resume:** **Hybrid A+C** — split on wide (`≥110` cols) where `tickerSplitAvailable` is true, overlay drawer otherwise. This reuses existing `tickerLayout: split|research|quote` and `evidence-overlay` without a new layout primitive. Overturn if `canvasScroll` user tests prefer full-screen focus.

## 5. Parked Plan — Next Steps When Resumed

1. **Confirm topology** (A vs B vs C vs Hybrid) — one decision unblocks layout spec.
2. **Lock `TerminalClient` protocol** — finish `web/src/terminal-protocol.ts` (already scaffolded), make `TerminalSocket` implement it, keep `ClosedMessage` with `code: number` omitted initially for compat, add `_close` payload typing.
3. **Extract `useTerminalSession`** — move `App` ref+`forceUpdate` state into `useReducer`/`useSyncExternalStore` hook; inject `TerminalClient` via props/context.
4. **Spec the retro keymap** — document `J/K` (brief/why), `R` (refresh), `[/]` (archive), `Tab` (split/pane), `Enter` (primary), `/` search — keep `web-interactions.ts: contextKeyHints` as source of truth.
5. **Visual spec** — audit `styles.css` tokens, confirm `visual-design-standards.md` discovery gate, then mock Hybrid A+C in `docs/mockups/`.
6. **Handoff** — `prd-architect` → `ui-mockup-desktop-workbench` → `prd-to-issues`.

## 6. Open Items

- [ ] Choose Canvas topology (Q1 above) — blocks spec.
- [ ] Scope of "all info" — does MVP include `MOVERS` ranking explanation and `WATCH` mutation?
- [ ] Agentic trigger policy — autonomous precache on `MARKET` load vs on-demand `J` only? Current `precacheWarmCapacity(concurrency-1)` keeps one slot for interactive.
- [ ] Distribution target — Vercel standalone vs Pi-harnessed `server/index.ts` vs browser extension? Determines if A is sufficient.
- [ ] `TerminalSocket.CLOSED` shape alignment — preserve existing `{code}` in transcript vs strict protocol.

## 7. References

- `docs/web-ui-design.md` — authoritative Pi harness + theme ANSI→HTML lesson.
- `web/src/terminal-protocol.ts` — scaffolded interface (paused).
- `web/src/TerminalFrame.tsx`, `web/src/dossier.ts`, `web/src/keyboard.ts`, `web/src/web-interactions.ts` — skin contract.
- `.pi/extensions/market-terminal.ts:1-100` / `CanvasBlock` + `ResearchJob` + `Precache` — brain contract.

---
*This doc is intentionally not a PRD. When product reprioritizes this, run `brainstorming` → `prd-architect` with topology choice.*
