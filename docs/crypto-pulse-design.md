# Crypto Pulse — Fun-First Crypto Data Integration

> **Status:** DESIGN DECISION — pending fixture-backed ASCII approval (Phase 0)
> **Date:** 2026-08-22
> **Product goal:** make the terminal **fun to use** — glanceable, tactile, discoverable — not merely "more data."
> **Scope:** deterministic crypto data layer (keyless APIs) + a Crypto Pulse experience inside the existing MARKET screen. This doc is a design decision record; it is intentionally **not** a PRD.

## 1. Decision Summary

**Chosen experience:** A **Crypto Pulse** subview — a `GLOBAL ↔ CRYPTO` toggle inside the existing MARKET screen — powered by keyless REST APIs. It shows a market-mood strip, a HOT/COLD movers scoreboard, sync deltas, and rotation breadth. No sixth top-level screen, no new split pane, no Pi/Canvas redesign.

**Data sources (verified live 2026-08-22):**

| Source | Access | What we use it for |
|---|---|---|
| CoinMarketCap **Keyless Public API** (`https://pro-api.coinmarketcap.com/public-api`) | No key, GET-only, IP rate pool, 429→backoff | Fear & Greed, global metrics (total mcap, BTC/ETH dominance), top listings (rank/mcap/volume/supply), CMC ID map |
| DefiLlama (`api.llama.fi`, `coins.llama.fi`, `stablecoins.llama.fi`) | Free, keyless | Chain TVL, protocol TVL, stablecoin supply (Phase 3) |
| CoinGecko demo (`api.coingecko.com/api/v3`) | Free, ~10–30 req/min | Optional depth: ATH/ATL, supply detail, cross-check |
| Coinbase public API (`api.exchange.coinbase.com`) | Free, keyless | Spot cross-check for major pairs (uses `-USD` convention matching Yahoo) |
| **PanicRadar** (`panicradar.ai/api/dashboard/...`) | Public, keyless (frontend API, undocumented) | Contrarian **panic score**, sentiment state, fear/greed, volatility, daily trending signals |
| Yahoo Finance (existing) | Unchanged | Chart/TA baseline, unchanged |

**PanicRadar** (verified 2026-08-22 by probing the frontend API): the SPA calls `panicradar.ai/api/dashboard/{summary|panic-score|sources|coins|coins/{coin}/history|sentiment/daily|posts/recent|beliefs|...}` and `/api/news/trending` with no auth. The `summary` endpoint returns `sentiment_score`/`sentiment_state`, `fear_greed_index`/`label`, `volatility_24h`/`state`, `btc_price` + 24h/7d change, and explicit fear/euphoria/scam phrase rates; `panic-score` returns a contrarian `panic_score` (0–100) plus bearish/bullish post counts. This is a **great mood-strip input** (contrarian early-warning), complementary to CMC's Fear & Greed. Caveats: it is an **undocumented third-party frontend API** with no found ToS/license statement — treat it as opportunistic mood enrichment only, with graceful degradation, a kill switch, and attribution; never build the core experience on it. `/api/coins/{coin}/history` is a future per-coin "radar" view.

**Rejected sources (tested):** Binance public API (geo-blocked from US, HTTP 451), CryptoCompare (now keyed, HTTP 401), Messari/Glassnode/Santiment/Dune/Kaiko (paid; revisit only if a paid tier emerges).

**Rejected product moves:** a sixth top-level DEFI screen; a full DeFi protocol directory; continuous "live" price feed; gamified signal streaks; blocking crypto on the parked Canvas-Frame topology decision ([`docs/retro-terminal-plan.md`](retro-terminal-plan.md)).

## 2. Fun Hypothesis & Core Loops

The product is a keyboard-first, char-cell retro terminal. "Fun" here means: the screen answers a question in under two seconds, rewards a keystroke with motion, and leaves the user feeling like they understand *what kind of day it is*.

Three core loops:

1. **Read the mood in < 2 s.** The mood strip converts Fear & Greed + dominance + total-mcap delta into a single glanceable line.
2. **Chase a mover in ≤ 2 keystrokes.** HOT/COLD scoreboard → `Enter` opens the existing quote view → `B` returns, preserving the crypto ranking context (reuses the strongest interaction pattern: MOVERS).
3. **Know what changed since last sync.** SYNC PULSE marks cells that moved between snapshots — responsive without pretending to be real-time.

## 3. Goals, Invariants, Non-Goals

### Goals
- Crypto structure (mood, rank, mcap, dominance, movement) rendered deterministically — no model dispatch.
- Entry to any crypto view in ≤ 2 keystrokes; return path that preserves context.
- Every selectable row has an explicit open behavior; rows that cannot open a quote are visually display-only.

### Invariants
- **Five-screen topology preserved** (`MARKET SIGNALS EVENTS MOVERS WATCH`, [`market-terminal.ts:767`](../.pi/extensions/market-terminal.ts)). With wrap-around single-step navigation, a sixth screen would require up to three presses and crowd the tab header.
- **Deterministic layer owns market data; Canvas owns narrative.** Crypto snapshots are provider-neutral domain objects, not Canvas storage. Canvas blocks may be *derived* from snapshots for BRIEF/WHY, but Canvas is not the market-data model.
- Crypto screens **do not choose or redefine Canvas topology.** No ad hoc split pane may prejudge the parked Hybrid A+C decision.
- Keyboard-first and char-cell clean at every supported width (54/80/84/110).

### Non-goals
- No trading, no wallets, no portfolio. No full DeFi directory. No Pi replacement. No "live" feed.
- No predictive language: "live," "winning streak," and "signal accuracy" are banned without an explicit horizon + outcome methodology.

## 4. Information Architecture & Key Budget

- `MARKET` screen toggles `GLOBAL ↔ CRYPTO` with a single key (candidate: `G`). `CRYPTO` is a subview, not a screen — it reuses the MARKET slot, so the five-screen invariant and the single-row tab header are untouched.
- **Entry:** from MARKET with `G`. **Exit:** `G` or `B` returns to the previous MARKET state; selection is preserved.
- **Wide (≥110 cols):** Crypto Pulse can render mood strip + HOT/COLD side-by-side (left scoreboard, right COLD) using the existing `twoColumn` pattern.
- **Narrow (80/54):** stacked blocks via `stretchBlocks`, exactly like the existing MARKET render paths ([`renderMarket`](..//.pi/extensions/market-terminal.ts)).
- Research (`J`/`K`) from a crypto row routes through the existing quote/research/overlay behavior; the parked Hybrid A+C choice later decides where that research appears, without touching `CryptoSnapshot` or the deterministic layouts.

## 5. Screen & State Contracts (fixture scope)

Phase 0 must produce fixture-backed ASCII for **80×24 and 110×26**, covering at minimum these states: loading, fresh, stale, partial-source, 429, empty, refresh-pulse, and selected-row. High-fidelity styling belongs to the UI mockup handoff, not here.

Concept sketch (80 cols, fresh state):

```
┌─ CRYPTO PULSE ──────────────────────────────────────────────┐
│ MOOD [██████░░░░] 72 GREED ▲9 · BTC.D 58.2% ▼0.4            │
│ TOTAL $3.42T ▲2.1% · 24H VOL $118B ▼6% · AS OF 08:12 UTC     │
│─────────────────────────────────────────────────────────────│
│ HOT           24H            COLD            24H            │
│ ► BTC  $77,231 ▲4.2%         ● DOGE $0.1080   ▼3.1%          │
│   SOL  $144.80 ▲7.8%         ● XRP  $0.6240   ▼1.8%          │
│   ETH  $2,427  ▲2.9%         ● SHIB $0.00001  ▼2.2%          │
│─────────────────────────────────────────────────────────────│
│ ROTATION  ADV 14 / DEC 6 · ALT SEASON 68% (ALTS)            │
│ ΔSYNC 3 CHANGES SINCE 08:12 · [J] brief [K] why [R] sync     │
└─────────────────────────────────────────────────────────────┘
```

## 6. Normalized Domain Model & Identity

**Do not build a 50–100 asset manual registry up front.** CMC warns that symbols collide and recommends numeric IDs as the stable key.

- **Canonical internal ID = CMC permanent ID** (BTC=1, ETH=1027, SOL=5426). It is the only ID we persist.
- **Display universe ≠ drill-down universe.** A dynamic top-N list includes stablecoins and assets with no reliable Yahoo chart mapping. Every row must resolve to an explicit behavior: openable (has Yahoo pair + TA) or display-only (visibly marked).
- Maintain a **small, checked-in registry** mapping CMC ID → Yahoo pair → CoinGecko slug → name **only for the interactive universe** (tens of assets, like the existing `MARKET_BOARDS`/`MOVER_UNIVERSE` tables).
- **No silent runtime refresh of the registry.** Runtime maps may *propose* additions, but rebrands, wrapped assets, and symbol collisions require human validation before the registry changes.

## 7. Source Ownership Matrix

| Field group | Owner | Notes |
|---|---|---|
| Chart / TA / quote price | Yahoo (existing) | Unchanged |
| Rank, market cap, volume, supply | CMC | CMC listings payload includes rank/mcap/supply + period changes, **not** ATH |
| Fear & Greed, total mcap, BTC/ETH dominance | CMC | Mood strip inputs |
| Panic score, sentiment state, volatility | PanicRadar | Contrarian mood-strip input (opportunistic, kill-switched) |
| Trending crypto signals | PanicRadar `/api/news/trending` | Narrative SIGNALS candidate (Phase 4; publisher-grade, not event authority) |
| Chain TVL, protocol TVL, stablecoin supply | DefiLlama | Phase 3 |
| ATH/ATL, extra depth | CoinGecko (optional) | If we want ATH in Phase 1, CoinGecko is the cheap source — add a second freshness contract |
| Spot cross-check | Coinbase | Optional validation only |

Each field group carries its own `sourceUpdatedAt`; a row may show "price 08:12 · rank 08:15" to avoid false precision from mixed timestamps/methodologies.

## 8. Data Flow & Deployment Topology

```
Provider adapters (CMC / DefiLlama / CoinGecko / PanicRadar)
  → bounded, normalized CryptoSnapshot (typed, schema-validated, size-capped)
  → central shared cache (single durable owner)
  → terminal renderer + deterministic detectors
  → optional Canvas adapter (BRIEF/WHY evidence only)
```

- **One durable polling owner.** Crypto polling must not run in disposable public workers (scouts are already disabled there; [`docs/deployment.md`](deployment.md)). Public workers consume cached snapshots; they never independently poll.
- **Two universes, explicitly.** The interactive board is the **dynamic CMC top-100** (stablecoins excluded), fetched from `listings/latest?limit=100` — no static registry, so rebrands and new listings flow in automatically. Yahoo pairs are derived as `<SYMBOL>-USD` with a small override/exclusion registry for known collisions (POL→MATIC-USD, and PEPE/SUI/UNI/APT which Yahoo has never hosted stay display-only). The CMC top-N listings also feed the **display-only TOP-20 MOVERS strip** (leaders/laggards + breadth), which is never selectable and never opens. This replaces the earlier intersection contract ("universe ∩ top-N"), which silently dropped universe assets ranked below the top-N.
- **Relative, not sign-based.** The board ranks the 14 by signed 24h change into relative **HOTTEST** (top half) and **COLDEST** (bottom half, ascending). Both columns stay populated in one-directional markets; COLDEST rows carry signed percentages. Assets without a finite 24h change go to an `UNRANKED · NO QUOTE` section (still selectable/openable, never falsely classified).
- **Stablecoin detection is tag-first** (CMC `stablecoin` tag) with an uppercased-symbol denylist as a defensive fallback — not a primary classifier.
- **Bounded payloads.** DefiLlama `/protocols` and CMC `/map` are large — require field projection, response-size limits, timeouts, and schema validation on every adapter.
- **Fallback discipline.** A CMC/DefiLlama failure degrades only the crypto enrichment. It must never take down the existing Yahoo charts, watchlist, or research.
- **Shared-IP rate discipline.** CMC keyless and CoinGecko keyless are IP-pooled. For a public deployment behind NAT, one noisy poll loop can exhaust the pool for every user. Phase 1 ships **deferred** on this: request jitter, `Retry-After` honoring, and a per-provider circuit breaker are documented requirements but not implemented — the single-user terminal relies on timeouts + byte caps + the 60s stale-while-revalidate cache. The **deploy topology** phase (single durable poller + shared cache) must add them before this reaches the public-worker topology.

## 9. Freshness & Anomaly Semantics

- **Freshness is not one timestamp.** F&G, global metrics, listings, TVL, and news have different cadences. The existing five-minute snapshot-stale rule cannot describe all of them. Model per-dataset `ttl`, `sourceUpdatedAt`, `observedAt`, `staleAt`.
- **Crypto is 24/7.** The header session badge derives from a US quote ([`market-terminal.ts:5886-5894`](../.pi/extensions/market-terminal.ts)). A crypto view must not imply US market-open state describes crypto availability.
- **No instant TVL-spike detector.** Latest `/protocols` or `/tvl/{slug}` values alone cannot establish a spike. Persist prior samples and account for token-price movement, migrations, and reclassification.
- **Detectors, when added (Phase 4):** structured regime changes (F&G regime flip, dominance break), sustained TVL anomalies (needs multiple samples + hysteresis), depegs, and rank jumps. Add cooldowns like the scout's trigger policy.
- **Event TTL confusion (if/when scout integrates crypto):** the scout admits publications up to 72 h old while its dry-run trigger expires after 2 h ([`market-event-scout.ts:238,246`](../shared/market-event-scout.ts)). Crypto needs separate display-age, admission-age, and trigger-age policies. Also: **crypto is a domain, not an event family** — model `domain: crypto` with `kind: protocol-incident | depeg | listing | regulatory | market-dislocation`, rather than adding a `"crypto"` family.

## 10. Phases with Evidence Gates

Each phase states the product question it answers and the condition for proceeding — not implementation tickets.

| Phase | Work | Product question | Gate to proceed |
|---|---|---|---|
| **0 — Fun & data contract** | Fixture-backed ASCII (80×24, 110×26); asset identity; source ownership; freshness/cache placement; interaction budget | "Does Crypto Pulse read as fun in char-cell form?" | Fixtures approved; contract locked |
| **1 — Crypto Pulse vertical slice** | Mood strip + HOT/COLD scoreboard from CMC keyless + **PanicRadar panic score/sentiment as a second mood input**; central cache; stale fallback; timestamps; one-key drill-down | "Can a user know the market mood and chase a mover in < 5 s?" | Release criteria include central caching, stale fallback, and drill-down — not later hardening |
| **2 — "What changed?" loop** | Since-last-sync watchlist deltas, rank movement, breadth, short retained history; **fix provider-aware research routing** (discovery currently appends `stock` to every symbol — crypto pairs get a wrong query) | "Does the screen feel alive between syncs?" | Delta loop + routing fix verified |
| **3 — DeFi experiment** | Compact DeFi pulse inside Crypto Pulse: chain TVL, stablecoin supply, a few power bars (DefiLlama) | "Is on-chain data fun or just data?" | Collect multiple snapshots before claiming "spikes"; a top-level DEFI screen only if usage earns it |
| **4 — Deterministic detectors** | Structured regime changes, sustained TVL anomalies, depegs, rank jumps | "Can the terminal surface *something I didn't ask for* correctly?" | Detector precision over recall, with cooldowns |
| **5 — Research tuning (optional)** | Crypto-aware discovery/prompts; prefer APIs for fundamentals, unbrowser only for narrative | — | Only after the deterministic experience works |

## 11. Failure, Compliance, Observability

- **Rate-limit telemetry** per provider (429 count, circuit-open time) surfaced in an existing debug/status path.
- **Partial-source health** — a row may be fresh on price, stale on rank; show it, don't hide it.
- **Attribution & data notice.** Extend the existing delayed-data notice to cover CMC/DefiLlama/CoinGecko. "Keyless" ≠ unrestricted redistribution: review each provider's commercial/display, caching, retention, and withdrawal terms before launch.
- **PanicRadar is undocumented.** No ToS/license found on the site; probe failures, shape changes, and 429s are expected. Isolate it behind one adapter with its own timeout, schema validation, kill switch, and stale fallback so a PanicRadar outage never degrades the CMC-backed mood strip or the rest of the terminal.
- **Kill switches** per provider (env-gated), matching the existing `MARKET_SCOUT_ENABLED` pattern.
- **Language discipline:** "delayed," "as of," "since last sync" stay visible. No "live," "streak," or "signal accuracy."

## 12. Handoff Boundaries

- **This doc:** decisions, contracts, constraints, unresolved tradeoffs.
- **PRD (`prd-architect`):** user-facing requirements + acceptance criteria.
- **UI mockup (`ui-mockup-desktop-workbench`):** visual/state treatment of the ASCII contracts.
- **Issues (`prd-to-issues`):** implementation breakdown.

## References

- [`docs/retro-terminal-plan.md`](retro-terminal-plan.md) — parked Canvas-Frame topology decision (Hybrid A+C). Crypto does not wait on it and does not prejudge it.
- `.pi/extensions/market-terminal.ts` — `MARKET_BOARDS` (:740), `MOVER_UNIVERSE` (:751), `normalizeSymbol` (:921), `renderMarket` (:5977), session badge (:5886).
- `shared/market-event-scout.ts` — scout source graph, families, trigger policy (future crypto domain integration).
- `docs/deployment.md` — public-worker cold discipline (crypto polling stays host-owned).

---
*Reviewed with advisor. Consolidated from the crypto-source integration analysis (2026-08-22) and reframed against the "fun to use" product goal.*
