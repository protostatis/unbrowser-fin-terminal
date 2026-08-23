# Terminal UI/UX Current-State Review (screenshot-documented)

Worktree: `unbrowser-fin-terminal-ui-review` (branch `review/ui-overhaul`, base `fe367f8` latest main)
Method: live walkthrough of every screen + source verification of rendering/keyboard paths.

---

## 1. Screenshot inventory

| # | Screen | What it shows |
|---|---|---|
| 1 | MARKET (Market Map) | Global relay, dot-scatter chart, ON THE MOVE, LEAD SIGNAL |
| 2 | Ticker QUOTE + RESEARCH | ^GSPC quote + empty research canvas skeleton |
| 3 | MARKET (post-merge) | Same as #1 + `[G] crypto` hint, LEAD SIGNAL rotated |
| 4 | MOVERS | Ranked 100-name list + selected mover chart |
| 5 | WATCH | 13-ticker watchlist + SPY chart |
| 6 | SIGNALS | Headline list (source titles) + empty Market Story |
| 7 | EVENTS | 3 catalyst lanes + instruction wall |
| 8 | Controls overlay | Semantic action panel (discovered by accident) |
| 9 | CRYPTO PULSE | Sentiment gauge, hottest/coldest lists |
| 10 | Ticker RESEARCH split | Empty 6-section canvas skeleton |
| 11 | Help overlay | Expanded keybinding reference |
| 12 | Research run | SEEDING → BUILDING BRIEF → FAILED (raw JSON in footer) |

---

## 2. What is GOOD (keep)

1. **The market data model is excellent.** MOVERS scoring is transparent (65% move / 35% $VOL, P98 note, session-aware legs). WATCH is one key (`E`) with honest truncation. CRYPTO PULSE mood gauge + hottest/coldest is a novel, concise frame.
2. **Honest staleness.** `POST-MKT DELAYED 21h 14m`, `STALE 2h 23m`, `Quote 20h 28m` are surfaced calmly and consistently. This is more honest than most retail products.
3. **One-key primary action:** `J`/Enter = context-sensitive primary (open ticker / build brief). This is the right model — it never makes you think about *which* command.
4. **Research states are visible:** SEEDING → PARTIAL → BUILDING, plus `[C] cancel` everywhere, top-bar `◎ AGENT … LIVE` job chip. Queue state on FOOTER/EVENTS lanes. Job lifecycle is legible.
5. **Deterministic, cited, quality-gated research** (evidence-blocked never served as cache hits) — trust signal, not UI, but it's the product's core value.
6. **Keyboard-first with mouse as second citizen** — hit targets exist on rows/pane; swipes work. Good foundation.
7. **SIGNALS `Discovery clear` + `NOT A LIVE CALENDAR` honesty** — manages expectations well.
8. **Focused color system** — 8 colors, consistent semantics (success/error/warning), no rainbow overload.

## 3. What is BAD (fix)

### A. Charting (biggest visual weakness)
- **Dot-scatter default.** `chartLines(..., chartStyle: "points")` renders discrete `•/◦/·` cells. There is no line connecting the series, no area, no volume. The `line` and `histogram` styles already exist in code but are never the default on the market map.
- **Truncated y-axis labels.** `truncateToWidth(valueFormatter(value), 8)` produces `$7,69...` / `$76.06` (cut mid-number, 8 chars wide). A price axis that lies is worse than no axis.
- **Sparse data-ink.** Market map chart shows ~16 dot rows × ~60 cols inside a 1074px-wide pane; ~50-55% of the screen is dead black.
- **No crosshair/hover values.** ASCII grid can't show OHLC per bar; web projection adds nothing back.
- **X-axis only 3 ticks** (09:30 / 12:55 / 16:40), no session shading despite PRE/REG/POST legend.
- **No volume bars** despite having the data (Day range + Volume are just text lines below the chart).
- **Session markers exist only in legend**, not on the plot.

### B. News / research reading
- **The "headlines" are not headlines.** SIGNALS lists site `<title>`s ("Stock Markets, Business News, Financials, Earnings — CNBC"). No article, no timestamp, no snippet, no real headline. Same disease on the market-map LEAD SIGNAL slot (rotates homepage titles).
- **Research canvas is all skeleton.** 6 headers (SUMMARY/EVIDENCE/INTERPRETATION/CATALYSTS/RISKS/SOURCES) with empty vertical guide lines ~450px tall. Opening any ticker shows a billboard of empty promises with no content or progress.
- **Instruction walls.** EVENTS/SIGNALS right panes are gray text explaining what J/K do instead of showing any content.
- **Failure state leaks JSON.** `RESEARCH CNBC.COM HEADLINE BRIEF FAILED · DAY · market_canvas:{"content":"[{"type":"text","text":"All candidate sources failed retrieval; publish a degraded brief vi…` — raw protocol payload in the footer status line. (Note: local dev had no `UNBROWSER_MCP_URL`, so retrieval failure was expected; the *presentation* is the bug.)
- **Reading is monospace-only.** No font hierarchy, inline link affordance, or typographic rhythm; citations are bare URLs.

### C. Navigation & keybinding complexity (your instinct — confirmed in code)
- **Two separate key maps with the same keys meaning different things**:
  - Market map: `A/D` = screens, `W/S` = select, `G` = crypto, `Tab` = pane focus.
  - Ticker: `A/D` = QUOTE/RESEARCH layout, `W/S` = cycle tickers (quote) OR scroll canvas (split), `Tab` = WIDE SPLIT.
- **`Tab` has 3 meanings**: SIGNALS pane focus / EVENTS pane focus / ticker split. It's a context switch, not a gesture.
- **`G` silently does nothing** outside MARKET (`if (data === "g") && this.screen === MARKET_SCREEN.market`) — no status message, no hint change. Footer *does* advertise `[G] crypto` on Market only; CRYPTO footer shows `[G] global` even though G only works on Market.
- **`W/S` = select vs scroll is invisible**: the user must know whether the current focus is a list or a canvas to predict what W/S does.
- **Three parallel web UI layers exist** for the same actions: `ContextHud` chips, `InteractionOverlay` panel (the ▸ drawer), `MobileControls` deck. Each duplicates keyboard actions with slightly different labels/keys.
- **Footer hint placement varies by screen** but panels (InteractionOverlay) and HUD can coexist with different affordances.
- (Verified in source: the web ContextHud/InteractionOverlay hint rows actually agree with footers on `J`=brief/`K`=why — an early screenshot read suggested an `E`-vs-`K` mismatch, but code shows `keyHint: "K"` in `mobile-controls.ts` and `web-interactions.ts`. Still worth noting that the overlay's tiny `<kbd>` glyphs are easy to misread at 11px — a legibility issue.)
- **`[` / `]` archive browsing** only on SIGNALS/story and ticker research contexts — invisible binding.

### D. Dead space (systemic)
- Signal: 6 headline rows + instruction wall → ~75% black.
- EVENTS: 3 lanes + instruction wall → ~80% black.
- MARKET: chart bottom emptiness + right pane 2/3 empty.
- Research canvas: skeleton fills the pane with nothing.
- CRYPTO: bottom half entirely empty.
- Root cause: fixed hero layouts (chart height max 26 rows) + panes sized for max content, not actual content.

### E. Data-quality quirks visible in UI
- COLDEST list shows `▼ BTC $7,314.39 -0.14%` vs headline `BTC 24H $66,024 +4.65%` (dollar units + disagreeing values).
- `SOL` appears on BOTH hottest and coldest lists.
- WATCH name column truncates mid-word (`Microsoft Cor…`, `Invesco QQQ T…`).

---

## 4. Options under consideration

### Option A — TUI-native polish (stay ASCII, make it great)
- Default **candle** chart style, y-axis from truncated prices to **delta (%) vs reference**, volume row under the chart, session bands, PRE/REG/POST markers on the plot.
- Fill dead space: compact panels (quote stats row, tape, upcoming catalysts), taller charts.
- Key simplification: single map, J/K primary, arrows everywhere, remove G's conditional.
- Cost: modest. Consistent TUI+web. Limit: still ASCII — no hover, no typography.

### Option B — Web-native rich client (terminal stays canonical; web becomes first-class)
- Backend publishes structured data over the existing WS (chart points/sessions/ranges, real headlines w/ timestamps, canvas sections) — the `debugState()` projection already exists as the seam.
- Web renders SVG line/area charts with hover crosshair + volume; news feed with real headlines/timestamps; research reader with typographic hierarchy.
- Keyboard map shrinks to: `1-5` scope · `←→` nav · `↑↓` select/scroll · `J` primary · `K` why · `B` back · `E` watch (`?` help).
- Cost: largest. Two rendering surfaces to keep consistent; needs data contract + client chart components. TUI unchanged or lightly improved.

### Option C — Hybrid (recommended)
- **Immediately** do A's low-hanging fruit (candle chart default, %-axis, volume row, key-map unification, kill the raw-JSON failure state) — benefits both surfaces for ~2-3 focused changes.
- **Then** do B incrementally: web-only chart component from structured data; keep the terminal row rendering as fallback for public/TUI parity; news reading upgrades follow the same seam.
- Cost: medium. Each step shippable; no big-bang rewrite.

### ✅ Phase 1 IMPLEMENTED (review branch `review/ui-overhaul`)
1. **Candle charts** — new `candles` chartStyle in `chartLines`: compact 1-cell-per-bar bodies (`█` up / `▓` down) with `│` wicks, per-candle direction coloring (green/red), extended-session bars dimmed. Quote model + Yahoo parser extended with per-bar OHLC (`pointOpens/Highs/Lows` — already in the payload, previously discarded).
2. **Δ% axis** — y-axis labels now read as percent deltas vs previous close (day) or first bar (other scopes): `+0.71%` / `+0.27%` instead of truncated `$7,69...`.
3. **Volume strip** — `VOL` row of block glyphs under the price plot (sqrt scale keeps small bars visible; positive volumes render at least `▁`).
4. **G key fixed** — no longer a silent no-op off the Market screen: from any screen it jumps to Market and toggles crypto/global. Footer hint now shows `[G]` everywhere.
5. **Raw-JSON failure fix** — `summarizeResearchError` unwraps `tool:{json}` protocol payloads into a calm one-line reason; status line shows e.g. `EARNINGS BRIEF EVIDENCE BLOCKED · DAY · 2 BLOCKS` instead of `market_canvas:{"content":...`.

Status: typecheck clean; 619/619 tests pass; visually verified on Market map, ticker DAY + WEEK scopes, crypto view.

Open question that decides the branch: **is the primary audience the browser/web experience (public demo, private workspace) with TUI as secondary — or the opposite?** If web-first → B leans; if TUI-first → A/C.
