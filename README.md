# unbrowser-fin-terminal

A keyboard-first market terminal for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). It combines delayed market data, deterministic technical analysis, and cited public-web research in a responsive terminal UI.

## Features

- Market Map for US, Asia, crypto, movers, signals, events, and watchlists
- DAY charts with extended-hours PRE / REG / POST session markers
- Deterministic Wilder RSI, EMA, MACD, momentum, and rolling-range analysis
- ASCII price, close-vs-SMA trend, RSI 70/50/30, and MACD-histogram charts
- Automatic MOVERS watch ranks liquid US names by price movement and dollar volume
- Agent research through `unbrowser`, rendered as structured charts, metrics, tables, news, risks, and sources
- On-demand EVENTS catalyst monitor for earnings, macro, and global handoff research (not a live calendar feed)
- Incremental background research with cancellation and honest status labels
- Project-local research history with explicit `AS OF` timestamps
- Full-height layouts for narrow and wide terminals

## Requirements

- [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)
- `unbrowser` available on `PATH` for web research

## Run

### Pi terminal

```bash
git clone https://github.com/protostatis/unbrowser-fin-terminal.git
cd unbrowser-fin-terminal
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

Run `npm run typecheck` to validate the extension, backend, and browser client,
or `npm run build` for a production browser bundle.

Open the Vite URL printed in the terminal (normally
`http://localhost:5173`). Quote browsing works immediately; agent research
uses your local Pi model/auth configuration and may consume configured model
resources.

If port `8787` is occupied, start both processes against another backend port,
for example `PORT=8788 npm run dev`.

The bridge listens on `127.0.0.1` by default and accepts browser connections
only from loopback origins. Do not expose it remotely without authentication
and TLS; `ALLOWED_ORIGINS` alone is not authentication.

## Controls

| Key | Action |
|---|---|
| `1`–`5` | Change chart scope (DAY / WEEK / MONTH / YEAR / TOTAL) |
| `A` / `D` | Switch screens or tabs |
| `W` / `S` | Select or scroll |
| `Tab` | Switch SIGNALS focus between headlines and Market Story |
| `J` | Open a ticker, or build a source-verified factual BRIEF |
| `K` | Build a WHY analysis with causal channels, scenarios, and disconfirming evidence |
| `E` | Add or remove a ticker from the watchlist |
| `[` / `]` | Browse older or newer research |
| `C` | Cancel active background research |
| `B` / `Esc` | Return from a ticker to the Market Map |
| `Q` | Close the UI without cancelling research |

## Movers and watchlists

The default cross-asset watchlist includes `SPY`, `QQQ`, `AAPL`, `MSFT`,
`NVDA`, `AMZN`, `GOOGL`, `TSLA`, `JPM`, `XLE`, `TLT`, `GLD`, and `BTC-USD`.
Changes made with `E` remain session-scoped.

The MOVERS screen is regenerated on each market refresh. It ranks up to eight
eligible names from a maintained liquid-US universe using a transparent score:
65% absolute price-move percentile plus 35% dollar-volume percentile. It is a
delayed liquid-universe monitor—not an exchange-wide real-time scanner. Press
`R` to rescore and `E` to add or remove the selected mover from the session
watchlist.

## How research works

1. `market_technicals` computes sourced TA blocks from aligned Yahoo chart data for the selected chart scope.
2. `market_discover` finds candidate public sources.
3. The agent extracts selected sources with `unbrowser`.
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
