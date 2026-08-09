# unbrowser-fin-terminal

A keyboard-first market terminal for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). It combines delayed market data, deterministic technical analysis, and cited public-web research in a responsive terminal UI.

## Features

- Market Map for US, Asia, crypto, movers, signals, events, and watchlists
- DAY charts with extended-hours PRE / REG / POST session markers
- Deterministic Wilder RSI, EMA, MACD, momentum, and rolling-range analysis
- ASCII price, close-vs-SMA trend, RSI 70/50/30, and MACD-histogram charts
- Automatic MOVERS watch ranks up to 100 liquid US names by price movement and dollar volume
- Agent research through `unbrowser`, rendered as structured charts, metrics, tables, news, risks, and sources
- On-demand EVENTS catalyst monitor for earnings, macro, and global handoff research (not a live calendar feed)
- Opt-in shadow event scouting across official public feeds, with deterministic market/ticker association and no model dispatch
- Independently keyed background research jobs with a visible FIFO queue, contextual cancellation, and honest status labels
- Up to two isolated Pi research workers run concurrently while the Market Map remains responsive
- Scope-aware snapshot age, quote coverage, stale/sync state, mover eligibility, and watchlist coverage
- Project-local research history with explicit `AS OF` timestamps
- Full-height layouts for narrow and wide terminals
- Responsive mobile command deck with touch navigation, scope controls, symbol entry, and horizontal view swipes
- Turnstile-gated public live sessions with FIFO admission, bounded disposable workers, fixed leases, and conservative research-budget reservations

## Requirements

- [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)
- An OpenRouter key or another model configured in Pi for agent research
- An isolated `unbrowser` MCP endpoint for source extraction; local `unbrowser`
  on `PATH` remains a development fallback for discovery and shadow feed scouting

## Run

### Pi terminal

```bash
git clone https://github.com/protostatis/unbrowser-fin-terminal.git
cd unbrowser-fin-terminal
npm ci # required for isolated research workers when running the source extension
pi -e .pi/extensions/market-terminal.ts
```

Then use:

```text
/market                 Open the Market Map
/market AAPL            Open a ticker panel
/market-history AAPL    Browse archived research
/market-scout status    Inspect event health and no-dispatch trigger evidence
/market-scout sync      Poll event sources that are currently due
/market-debug market    Open deterministic debug fixtures
```

### Web UI

The browser UI runs the same extension in a real in-process Pi session and
projects its terminal frames over a local WebSocket:

```bash
npm ci
npm run dev
```

To use Pi through OpenRouter with the hosted public-source extractor:

```bash
export OPENROUTER_API_KEY=sk-or-...
export UNBROWSER_MCP_URL=https://unchainedsky.com/unbrowser-mcp
npm run dev
```

When OpenRouter is configured, the default model is
`deepseek/deepseek-v4-flash-0731`. Override it with `OPENROUTER_MODEL` or set the
provider-neutral pair `MARKET_MODEL_PROVIDER` and `MARKET_MODEL_ID`. Production
deployments should mount a dedicated key and set `OPENROUTER_API_KEY_FILE`
instead of placing the key directly in Compose environment metadata.

The public hosted MCP endpoint is shared and suitable only for public pages. A
production deployment should use a dedicated Docker-internal isolated endpoint,
such as `http://unbrowser-mcp:8767/mcp`. Production startup fails closed when
`UNBROWSER_MCP_URL` is missing.

Open the Vite URL printed in the terminal (normally
`http://localhost:5173`). Quote browsing works immediately; agent research
uses your local Pi model/auth configuration and may consume configured model
resources.

If port `8787` is occupied, start both processes against another backend port,
for example `PORT=8788 npm run dev`.

The bridge listens on `127.0.0.1` by default and accepts browser connections
only from loopback origins. Do not expose it remotely without authentication
and TLS; `ALLOWED_ORIGINS` alone is not authentication.

### Container deployment

The included multi-stage image accepts `PUBLIC_BASE_PATH` at build time. For a
subpath deployment, build with a trailing slash:

```bash
docker build \
  --build-arg PUBLIC_BASE_PATH=/unbrowser/fin-terminal/ \
  -t unbrowser-fin-terminal .
```

Production requires `MARKET_PROXY_TOKEN`; the trusted reverse proxy must
overwrite `X-Fin-Terminal-Proxy-Token` on every HTTP and WebSocket request. It
must also provide an authenticated, opaque `X-Fin-Terminal-User` value. The
first WebSocket principal owns the singleton terminal session until the process
restarts, preventing state transfer between users.

Authenticated live production sets `PUBLIC_DEMO=0`; replay sets
`PUBLIC_DEMO=1`; the anonymous public gateway instead sets
`TERMINAL_RUNTIME_MODE=public-gateway` and must not set `PUBLIC_DEMO`. The
client build and server mode must match: public-gateway pairs with an explicit
`public-live` client build, replay pairs with replay, and authenticated live
pairs with live.

Set `MARKET_ROOT=/app`, `MARKET_DATA_DIR=/data`, and mount `/data` as the only
persistent volume. `/api/health` is liveness-only; use `/api/ready` for the
container health check. A dedicated, provider-capped OpenRouter key is strongly
recommended rather than sharing another service's key.

The web agent is restricted to `market_technicals`, `market_discover`,
`market_extract`, and `market_canvas`. Pi's shell and filesystem tools are not
registered in the model-facing runtime.

`MARKET_RESEARCH_CONCURRENCY` controls isolated research workers. It defaults
to `6` and accepts integers from `1` through `6`; keep it at `1` when
characterizing a new model or MCP endpoint. Workers inherit the configured
model policy and expose the same four model-facing tools, but the canonical
terminal process remains the sole archive writer.

Run `npm run typecheck` to validate the extension, backend, and browser client,
or `npm run build` for a production browser bundle.

For the production release workflow, including the immutable source-SHA handoff
to `unchained-infra` and GitHub Actions production approval, see
[`docs/deployment.md`](docs/deployment.md).

### Public live-session pilot

The public-live build preserves the stable demo URL while replacing the replay
with bounded real sessions. The browser reaches only an admission gateway; each
admitted ticket is proxied to one isolated disposable terminal worker.

Build the client explicitly as public-live:

```bash
docker build \
  --build-arg PUBLIC_BASE_PATH=/unbrowser/fin-terminal-demo/ \
  --build-arg VITE_TERMINAL_BUILD_MODE=public-live \
  -t unbrowser-fin-terminal-public .
```

The gateway requires `TERMINAL_RUNTIME_MODE=public-gateway`, an exact
`PUBLIC_ALLOWED_ORIGIN`, Redis, a 32+ character session-signing key, an internal
worker proxy token, a separate 32+ character `PUBLIC_EDGE_PROXY_TOKEN`,
Turnstile keys, and an explicit `PUBLIC_WORKER_ENDPOINTS` list matching
`PUBLIC_MAX_SESSIONS`. Production forbids
`PUBLIC_TURNSTILE_BYPASS=1` and `memory://` persistence.

Every worker sets `PUBLIC_SESSION_WORKER=1`,
`MARKET_RESEARCH_CONCURRENCY=1`, an explicit model policy, the same session
timeouts/run limit as the gateway, and the internal worker proxy token. Workers
must be reachable only from the gateway network and replaced after any visitor
reaches them. The gateway reserves the full configured per-session research
budget before assigning a seat, carries active reservations across UTC rollover,
and therefore fails closed at the daily cap.

Before any worker content or queued browser input is relayed, the gateway
compares the worker WebSocket generation header with the generation probed for
that seat. A changed or missing generation ends the ticket and fences the
reached process until replacement. Probe epochs discard health responses that
began before a later assignment or fence transition. Browser upgrades reserve
an attachment first and activate the lease only after the WebSocket handshake;
the possible worker-exposure fence is persisted before dialing the worker.
Both WebSocket directions have payload and backpressure ceilings; browser
messages also pass semantic validation and a ticket-scoped token bucket that
survives reconnects. Attachment attempts are rate- and count-bounded. Ended
ticket tombstones are short-lived and bounded rather than accumulated in Redis
indefinitely.

The defaults bound a visitor to a 10-minute queue ticket, 5-minute idle lease,
15-minute absolute lease, 30-second reconnect grace, and five research launches.
The public edge must strip and overwrite `X-Real-IP`; the gateway applies both
visitor-IP and coarser proxy-peer admission limits. It trusts the forwarded
address only when Caddy also overwrites `X-Fin-Terminal-Edge-Token` with the
configured edge token. Never publish the gateway container port directly.
Turnstile verification always compares the widget action and a hostname derived
from `PUBLIC_ALLOWED_ORIGIN` unless an explicit expected hostname is configured.
See [`docs/deployment.md`](docs/deployment.md) for the release and verification
contract. Account signup, persistent workspaces, claims, and billing shown in
the conversion preview are design handoff only and are not wired into this
public gateway.

### Static replay deployment

Replay mode remains available as a static fallback. It serves
checked-in, immutable replay artifacts of the terminal and an informational
pilot placeholder. It starts no AgentSession, performs no WebSocket, model, or
source work, and creates no auth, entitlement, workspace, or source-check
state. There is no singleton seat, waiting room, or idle watchdog.

Build with the demo base path and set `PUBLIC_DEMO=1`:

```bash
docker build \
  --build-arg PUBLIC_BASE_PATH=/unbrowser/fin-terminal-demo/ \
  -t unbrowser-fin-terminal-demo .
```

`PUBLIC_DEMO=1` must be explicit for replay. Because the stable demo path can
also host public-live, deployment must set `VITE_TERMINAL_BUILD_MODE=public-live`
for the gateway build; omitting that override at the demo path intentionally
produces replay. Any build/runtime mismatch fails closed.

Replay-mode verification:

- `GET /api/ready` returns HTTP 200.
- The static replay artifacts and pilot placeholder are served with no
  authenticated user session.
- `GET /ws` is rejected without an HTTP 101 WebSocket upgrade.

## Controls

The browser keeps the terminal keyboard-first while making visible terminal
rows, panes, and chart selectors directly interactive. Tap the selected market
quote to open its ticker, use a vertical touch drag to move a selection or
scroll research content, and use the compact bottom-right control affordance
for the optional semantic action panel.

On touch or narrow screens, the web UI also adds a bottom command deck. It
exposes previous/next view, selection movement, OPEN, BRIEF, WHY,
watch/cancel, sync, pane/back, chart-range controls, and a native symbol-entry
sheet. Swipe left or right over the terminal canvas to change screens or ticker
tabs. The controls send the same canonical key inputs listed below; connecting
from a newer tab or phone for the same authenticated principal takes control of
the singleton session and preserves its current state.

| Key | Action |
|---|---|
| `1`–`5` | Change chart scope (DAY / WEEK / MONTH / YEAR / TOTAL) |
| `←` / `→` or `A` / `D` | Switch top-level screens or ticker tabs |
| `↑` / `↓` or `W` / `S` | Select in lists; in a Quote opened from MOVERS or WATCH, cycle that source list; otherwise scroll the focused research pane |
| `Tab` | Switch pane focus in SIGNALS and EVENTS. In terminal keyboard mode it stays in the app instead of tabbing through browser controls. |
| `Enter` (or `J`) | Primary action: open a ticker, or build a source-verified factual BRIEF |
| `K` | Secondary WHY analysis with causal channels, scenarios, and disconfirming evidence |
| `E` | Add or remove a ticker from the watchlist |
| `[` / `]` | Browse older or newer research |
| `C` | Cancel research for the currently selected lane, headline, or ticker context |
| `B` / `Esc` | Return from a ticker to the Market Map |
| `Q` | Close the UI without cancelling research |

When a ticker is opened from MOVERS or WATCH, its source order is retained for
that detail session. Press `A` to enter Quote, then `W` / `↑` for the previous
ticker or `S` / `↓` for the next; the list wraps at either end. Research and
wide Split keep those keys for their reading/scroll behavior, so the control
does not change while a canvas loads.

## Movers and watchlists

The default cross-asset watchlist includes `SPY`, `QQQ`, `AAPL`, `MSFT`,
`NVDA`, `AMZN`, `GOOGL`, `TSLA`, `JPM`, `XLE`, `TLT`, `GLD`, and `BTC-USD`.
Changes made with `E` remain session-scoped.

The MOVERS screen is regenerated on each market refresh. It ranks up to 100
eligible names from a maintained 117-ticker liquid-US universe using a transparent score:
65% absolute price-move percentile plus 35% dollar-volume percentile. It is a
delayed liquid-universe monitor—not an exchange-wide real-time scanner. Press
`R` to rescore and `E` to add or remove the selected mover from the session
watchlist.

Changing screens, selections, pane focus, or chart scope does not stop research.
Each symbol/scope/BRIEF-or-WHY context gets its own job and canvas identity. The
terminal dispatches up to six FIFO jobs to isolated one-shot Pi worker sessions,
so independent requests can progress concurrently without mixing tool writes or
locking navigation. Queued jobs can be cancelled without touching a worker;
cancelling a dispatched job fences and aborts only its worker. The footer and
EVENTS lanes expose contextual RUNNING/QUEUED state.

Cached-research choices are modal: choose `U` to use the cache, `F` to refresh,
or `Esc` to cancel the prompt before navigating elsewhere.

## How research works

1. `market_technicals` computes sourced TA blocks from aligned Yahoo chart data for the selected chart scope.
2. `market_discover` finds candidate public sources and issues short-lived,
   research-bound candidate IDs.
3. The agent calls `market_extract` for up to four selected IDs. The typed tool
   uses isolated `unbrowser` MCP infrastructure and does not accept arbitrary
   URLs.
4. `market_canvas` publishes verified structured research back into the terminal.

Completed canvases are stored in `.pi/market-research-archive.json`, which is ignored by Git.

BRIEF and WHY results use separate cache identities. Event lanes and headline
contexts are isolated as well, so an earnings WHY result cannot satisfy a macro
BRIEF cache request. Older archives without identity metadata remain browsable
as `LEGACY`, but are never reused for a newly keyed request.

### Shadow public-feed event scout

Set `MARKET_SCOUT_ENABLED=1` to poll a bounded graph of primary public RSS/Atom
sources through Unbrowser: Nasdaq trade halts and corporate actions, SEC current
filings, Federal Reserve monetary-policy releases, BEA releases, FTC press
releases, and DOJ news. Production uses `UNBROWSER_MCP_URL`; local development
can use a short-lived `unbrowser` CLI session only when explicitly enabled with
`MARKET_SCOUT_LOCAL_CLI=1` and no MCP endpoint is set.

| Variable | Default | Meaning |
|---|---|---|
| `MARKET_SCOUT_ENABLED` | `0` | Enable the singleton background scheduler with `1/true/on`. Public and research workers remain hard-disabled. |
| `MARKET_SCOUT_LOCAL_CLI` | `0` | Explicit development-only fallback when `UNBROWSER_MCP_URL` is absent. Ignored in production. |

The first successful poll of each source establishes a baseline and emits no
events. Later unseen items are classified and associated deterministically:
exchange-provided symbols are strongest, explicit exchange/ticker notation is
next, and intentionally market-wide macro sources map to the macro lane.
High-confidence items are labeled `admit-shadow`; ambiguous items are retained
as `watch`; unsupported or stale items are counted as `suppress` but not stored
in the recent-decision list.

This is intentionally observation-only. Every new non-suppressed decision is
also mapped into an immutable dry-run BRIEF candidate for a ticker, the macro
EVENT lane, or SIGNALS/Market Story. A fixed simulation policy records whether
the candidate would trigger or would be gated by disposition, route coverage,
priority, freshness, target cooldown, or daily volume. It never starts agent
research, reserves tokens, writes research canvases, or scrapes unattended
search-result pages. Use `/market-scout status` to inspect source health,
candidate volume, route coverage, and gate pressure, and
`/market-scout sync` to poll only sources whose configured interval is due. The
bounded atomic journal is
`$MARKET_DATA_DIR/market-event-scout.json` (or `.pi/market-event-scout.json`).
The scheduler is off by default and is always disabled in disposable public
workers and the public gateway, even if the environment variable is set.
Truncated, incomplete, or over-limit feeds fail the source poll without
advancing its baseline or dedupe state.

### Research cache pre-warming

When a session starts (the `/market` flow in TUI, the live server, or a private
workspace), the terminal bootstraps the shared research cache with the agent
requests a fresh session is most likely to make. Each warm job builds BRIEF and
WHY from one shared evidence pass, in this order: Market Story, the bootstrap
snapshot's lead SIGNALS headline, all three EVENTS lanes, then ticker pairs by
snapshot mover rank. There is no watchlist fallback. If snapshot discovery
fails, Market Story and the EVENTS lanes still warm.

The host strictly partitions a completed paired canvas and writes only the exact
interactive BRIEF/WHY identities. A pair is skipped when both halves already
have usable same-day archives; if only one half is stale, the pair runs but the
fresh half is not overwritten. Completed exact canvases are shared with later
sessions, so the first matching request can use a current-date cache instead of
starting cold research.

Pre-warm jobs never compete with interactive research: at most
`MARKET_RESEARCH_CONCURRENCY - 1` warm jobs are in flight at once (one worker
slot stays reserved for user requests; `MARKET_RESEARCH_CONCURRENCY=1`
disables pre-warming), and warm submission pauses entirely while any
user-triggered research is active, resuming as slots open. Warm jobs appear in
the normal research queue and are cancellable with `C`. A session transition
that cancels an in-flight warm run re-plans on the next fresh session instead
of staying cold.

Configure it with environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `MARKET_PRECACHE_ENABLED` | `1` (private/live/TUI), `0` (public workers) | Master switch, `1/true/on` or `0/false/off`. Disposable public workers are always cold, even if this variable is enabled. |
| `MARKET_PRECACHE_MAX_JOBS` | `24` | Cap on the pre-warm plan per bootstrap (story + headline + events + movers), `1`–`24`. Secondary to budget ceiling. In-flight warm jobs are additionally capped at `MARKET_RESEARCH_CONCURRENCY - 1`. |
| `MARKET_PRECACHE_QUALITY_GATE` | `1` | A/B switch for the quality gates. When on (default): a pre-warm identity is fresh only when the archive holds a **usable** same-day canvas (complete, fetched-evidence, item-level sourced read, no scenarios in a BRIEF) — evidence-blocked or unsupported canvases never satisfy the cache and are re-warmed; and a missing `UNBROWSER_MCP_URL` skips the source pre-warm entirely (extraction has no local fallback, so it would only produce degraded TA-only canvases). Set to `0` to restore the baseline date-only freshness and fan-out. |
| `MARKET_PRECACHE_BUDGET` | `2000000` | UTC-day total Pi-reported token budget for paired pre-cache runs (10 000–10 000 000). See `market-precache-ledger.json`. |
| `MARKET_PRECACHE_RUN_LIMIT` | `100000` | Conservative reservation per paired run; at most ~20 attempts/day at defaults (5 000–500 000). |

The synthetic `v1/paired/*` worker identity is never archived or exposed as a
cache hit. Before dispatch, the parent durably reserves the full per-run limit
in `$MARKET_DATA_DIR/market-precache-ledger.json` (or `.pi/` without a data
directory). Reservations are permanent for their UTC day; actual Pi usage and
cost are settlement telemetry. The worker checks projected Pi usage before
every provider turn, including the first. Budget settings are fixed once that
UTC day's ledger record exists and can be changed for the next day.

With the quality gate enabled, degraded split halves are retained in archive
history for cooldown telemetry but are never published as cache-eligible
results. Usable halves from the same paired run remain independently eligible.

Quality is enforced host-side, not by the model: `assessCanvasQuality` requires a
complete canvas with at least one fetched packet whose read (and any evidence
blocks) carry item-level `sourceIds` referring to fetched sources, so a search-title
hallucination like "Q2 beat expectations" with no fetched support can never be
served as a warm brief. Duplicate agent `sources` blocks are coalesced (fetched
status wins; `ta-*` sources preserved), and a stale `evidenceBlocker` is cleared
only when new fetched evidence actually arrives. The cache prompt labels degraded
hits (`CACHED … · EVIDENCE BLOCKED · [U] USE [F] REFRESH`). If three consecutive
pre-warm completions come back non-usable — e.g. a configured-but-broken
extractor — the warm circuit opens for 15 minutes and the remaining plan pauses
instead of re-fanning out on every session.

The ledger (typed quality telemetry persisted on every archived record, plus the
generation's prompt variant and origin) drives a bounded **identity cooldown**:
after two consecutive attempts that all failed with infrastructure-class codes
(evidence blocked/none/no-fetched), an identity is skipped until the cooldown
expires (default 2h), then probed again — so a fixed extractor or un-blocked
source is recovered, while structural violations (missing read, scenarios in a
BRIEF) never trigger a cooldown because those are prompt/cohort problems, not
per-identity ones. The first dispatched warm job is an **extraction canary**: the
rest of the plan waits for its verdict, and the circuit opens immediately only if
a completed canary reaches zero sources end-to-end (challenged/limited pages
prove the extractor was reachable).

The shared archive, pre-cache budget ledger, and event-scout journal assume one
parent terminal process writes per `MARKET_DATA_DIR`; use a single writer (or
exclusive mounts) when multiple processes share storage.

The `1`–`5` keys switch chart range/interval (DAY 5m pre/post, WEEK 15m, MONTH
hourly, YEAR daily, TOTAL coarse long-term bars). Yahoo may coarsen the
requested total-history interval. Non-day scopes compute last-bar return
instead of same-session 1h momentum and label SMA/EMA/RSI/MACD as bar-based
with the active scope.

## Data notice

This project uses public, delayed Yahoo Finance chart responses and is intended for research and experimentation—not real-time trading or investment advice. Verify important data with primary sources.

## License

[MIT](LICENSE)
