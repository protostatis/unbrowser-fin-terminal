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
- Independently keyed background research jobs with a visible FIFO queue, contextual cancellation, and honest status labels
- Up to two isolated Pi research workers run concurrently while the Market Map remains responsive
- Scope-aware snapshot age, quote coverage, stale/sync state, mover eligibility, and watchlist coverage
- Project-local research history with explicit `AS OF` timestamps
- Full-height layouts for narrow and wide terminals
- Responsive mobile command deck with touch navigation, scope controls, symbol entry, and horizontal view swipes

## Requirements

- [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)
- An OpenRouter key or another model configured in Pi for agent research
- An isolated `unbrowser` MCP endpoint for source extraction; local `unbrowser`
  on `PATH` remains a development fallback for discovery only

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

Set `MARKET_ROOT=/app`, `MARKET_DATA_DIR=/data`, and mount `/data` as the only
persistent volume. `/api/health` is liveness-only; use `/api/ready` for the
container health check. A dedicated, provider-capped OpenRouter key is strongly
recommended rather than sharing another service's key.

Run `npm run typecheck` to validate the extension, backend, and browser client,
or `npm run build` for a production browser bundle.

For the production release workflow, including the immutable source-SHA handoff
to `unchained-infra` and GitHub Actions production approval, see
[`docs/deployment.md`](docs/deployment.md).

### Public demo deployment

An anonymous kiosk deployment is supported for public demos. Build with the
demo base path and set `PUBLIC_DEMO=1`:

```bash
docker build \
  --build-arg PUBLIC_BASE_PATH=/unbrowser/fin-terminal-demo/ \
  -t unbrowser-fin-terminal-demo .
```

In demo mode the trusted proxy injects a fixed `guest` principal instead of an
authenticated one, the frame state carries `demo: true` (the UI shows a PUBLIC
DEMO banner and a waiting room when the singleton seat is taken), and the
process exits after `DEMO_IDLE_SECONDS` (default 300, minimum 60) without any
WebSocket activity so the container restart policy hands the seat to the next
visitor. Use a tmpfs `/data` so every reset starts pristine. Research (BRIEF/WHY)
remains enabled; prefer a dedicated, provider-capped OpenRouter key for the
demo build.

Open the Vite URL printed in the terminal (normally
`http://localhost:5173`). Quote browsing works immediately; agent research
uses your local Pi model/auth configuration and may consume configured model
resources.

If port `8787` is occupied, start both processes against another backend port,
for example `PORT=8788 npm run dev`.

The bridge listens on `127.0.0.1` by default and accepts browser connections
only from loopback origins. Do not expose it remotely without authentication
and TLS; `ALLOWED_ORIGINS` alone is not authentication.

The web agent is restricted to `market_technicals`, `market_discover`,
`market_extract`, and `market_canvas`. Pi's shell and filesystem tools are not
registered in the model-facing runtime.

`MARKET_RESEARCH_CONCURRENCY` controls isolated research workers. It defaults
to `6` and accepts integers from `1` through `6`; keep it at `1` when
characterizing a new model or MCP endpoint. Workers inherit the configured
model policy and expose the same four model-facing tools, but the canonical
terminal process remains the sole archive writer.

## Controls

The browser keeps the terminal keyboard-first while adding a web-only
interaction layer. Use **Web controls** to select the current event or ticker,
change a split pane, start the explicit Open / Brief / Why action, and scroll a
research canvas without relying on a keyboard. Its item list is a semantic
mirror of the terminal state, so it remains reliable across responsive terminal
layouts.

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
| `↑` / `↓` or `W` / `S` | Select in lists, or scroll the focused research pane |
| `Tab` | Switch pane focus in SIGNALS and EVENTS. In terminal keyboard mode it stays in the app instead of tabbing through browser controls. |
| `Enter` (or `J`) | Primary action: open a ticker, or build a source-verified factual BRIEF |
| `K` | Secondary WHY analysis with causal channels, scenarios, and disconfirming evidence |
| `E` | Add or remove a ticker from the watchlist |
| `[` / `]` | Browse older or newer research |
| `C` | Cancel research for the currently selected lane, headline, or ticker context |
| `B` / `Esc` | Return from a ticker to the Market Map |
| `Q` | Close the UI without cancelling research |

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

The `1`–`5` keys switch chart range/interval (DAY 5m pre/post, WEEK 15m, MONTH hourly, YEAR daily, TOTAL coarse long-term bars). Yahoo may coarsen the requested total-history interval. Non-day scopes compute last-bar return instead of same-session 1h momentum and label SMA/EMA/RSI/MACD as bar-based with the active scope.

## Data notice

This project uses public, delayed Yahoo Finance chart responses and is intended for research and experimentation—not real-time trading or investment advice. Verify important data with primary sources.

## License

[MIT](LICENSE)
