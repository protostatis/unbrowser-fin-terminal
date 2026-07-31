# unbrowser-fin-terminal

A keyboard-first market terminal for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). It combines delayed market data, deterministic technical analysis, and cited public-web research in a responsive terminal UI.

## Features

- Market Map for US, Asia, crypto, movers, signals, events, and watchlists
- DAY charts with extended-hours PRE / REG / POST session markers
- Deterministic Wilder RSI, EMA, MACD, momentum, and rolling-range analysis
- Agent research through `unbrowser`, rendered as structured charts, metrics, tables, news, risks, and sources
- Incremental background research with cancellation and honest status labels
- Project-local research history with explicit `AS OF` timestamps
- Full-height layouts for narrow and wide terminals

## Requirements

- [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)
- `unbrowser` available on `PATH` for web research

## Run

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

## Controls

| Key | Action |
|---|---|
| `1`–`5` | Change chart scope (DAY / WEEK / MONTH / YEAR / TOTAL) |
| `A` / `D` | Switch screens or tabs |
| `W` / `S` | Select or scroll |
| `Tab` | Switch SIGNALS focus between headlines and Market Story |
| `J` / `K` | Open or research the selected context |
| `E` | Add or remove a ticker from the watchlist |
| `[` / `]` | Browse older or newer research |
| `C` | Cancel active background research |
| `B` / `Esc` | Return from a ticker to the Market Map |
| `Q` | Close the UI without cancelling research |

## How research works

1. `market_technicals` computes sourced TA blocks from aligned Yahoo chart data for the selected chart scope.
2. `market_discover` finds candidate public sources.
3. The agent extracts selected sources with `unbrowser`.
4. `market_canvas` publishes verified structured research back into the terminal.

Completed canvases are stored in `.pi/market-research-archive.json`, which is ignored by Git.

The `1`–`5` keys switch chart range/interval (DAY 5m pre/post, WEEK 15m, MONTH hourly, YEAR daily, TOTAL coarse long-term bars). Yahoo may coarsen the requested total-history interval. Non-day scopes compute last-bar return instead of same-session 1h momentum and label SMA/EMA/RSI/MACD as bar-based with the active scope.

## Data notice

This project uses public, delayed Yahoo Finance chart responses and is intended for research and experimentation—not real-time trading or investment advice. Verify important data with primary sources.

## License

[MIT](LICENSE)
