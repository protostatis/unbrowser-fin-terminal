#!/usr/bin/env python3
"""Interactive, dependency-free terminal prototype for a financial information UI.

Run in a real terminal: python3 finance_terminal_tui.py
The application uses static demo data only.
"""

from __future__ import annotations

import curses
from dataclasses import dataclass


INSTRUMENTS = {
    "AAPL": {
        "name": "Apple Inc.", "exchange": "NASDAQ", "price": "$214.47",
        "move": "+$2.93 (+1.38%)", "range": "$211.88 - $215.33", "volume": "38.4M",
        "news": [
            ("15m", "Apple investors await earnings; services and margin outlook in focus"),
            ("2h", "Technology stocks lead market rebound as Treasury yields ease"),
            ("4h", "What analysts are watching in Apple's quarterly results"),
        ],
    },
    "MSFT": {
        "name": "Microsoft Corp.", "exchange": "NASDAQ", "price": "$610.35",
        "move": "-$2.15 (-0.35%)", "range": "$608.10 - $615.09", "volume": "21.7M",
        "news": [
            ("8m", "Microsoft gains as cloud and AI demand remain the central focus"),
            ("1h", "Software shares lead broader technology advance"),
            ("3h", "Investors watch Azure growth and capital-spending commentary"),
        ],
    },
    "AMZN": {
        "name": "Amazon.com Inc.", "exchange": "NASDAQ", "price": "$242.19",
        "move": "+$3.06 (+1.28%)", "range": "$238.51 - $243.72", "volume": "29.4M",
        "news": [
            ("12m", "Amazon investors await AWS growth and spending outlook"),
            ("1h", "E-commerce and cloud shares advance in afternoon trade"),
            ("5h", "Analysts focus on margins, advertising, and AI infrastructure"),
        ],
    },
}

TABS = ["Overview", "Chart", "News"]
RANGES = ["1D", "1W", "1M", "3M", "1Y", "ALL"]
FOCUS_AREAS = ["tabs", "ranges", "news"]


@dataclass
class State:
    symbol: str = "AAPL"
    tab: int = 0
    time_range: int = 0
    focus: int = 0
    news_index: int = 0
    in_watchlist: bool = True
    status: str = "Ready"


def clipped(text: str, width: int) -> str:
    if width <= 0:
        return ""
    return text if len(text) <= width else text[: max(0, width - 1)] + "…"


def put(screen, y: int, x: int, text: str, attr: int = 0) -> None:
    height, width = screen.getmaxyx()
    if y < 0 or y >= height or x >= width:
        return
    try:
        screen.addstr(y, x, clipped(text, width - x), attr)
    except curses.error:
        pass


def rule(screen, y: int, color: int) -> None:
    _, width = screen.getmaxyx()
    try:
        screen.hline(y, 0, curses.ACS_HLINE, width, color)
    except curses.error:
        pass


def draw_topbar(screen, state: State, colors: dict[str, int]) -> int:
    height, width = screen.getmaxyx()
    put(screen, 0, 1, "SIGNAL", colors["brand"] | curses.A_BOLD)
    put(screen, 0, 9, "FINANCIAL INFORMATION", colors["dim"])
    right = "DEMO / DELAYED   4:58 PM"
    x = max(1, width - len(right) - 1)
    put(screen, 0, x, "DEMO / ", colors["dim"])
    put(screen, 0, x + 7, "DELAYED", colors["dim"] | curses.A_BOLD)
    put(screen, 0, x + 14, "   4:58 PM", colors["dim"])
    rule(screen, 1, colors["line"])
    return 2


def draw_quote(screen, y: int, state: State, colors: dict[str, int]) -> int:
    data = INSTRUMENTS[state.symbol]
    put(screen, y, 2, "< Watchlist", colors["dim"])
    put(screen, y, 16, "/ Search", colors["accent"])
    y += 2
    put(screen, y, 2, state.symbol, colors["text"] | curses.A_BOLD)
    put(screen, y, 2 + len(state.symbol) + 2, data["name"], colors["dim"])
    y += 1
    put(screen, y, 2, data["exchange"], colors["dim"])
    y += 2
    put(screen, y, 2, data["price"], colors["text"] | curses.A_BOLD)
    # Prepend ▲/▼ glyph based on move sign
    move = data["move"]
    if move.startswith("+"):
        glyph = "▲ "
        move_color = colors["positive"]
    elif move.startswith("-"):
        glyph = "▼ "
        move_color = colors["negative"]
    else:
        glyph = ""
        move_color = colors["positive"]
    put(screen, y, 16, glyph + move, move_color | curses.A_BOLD)
    y += 1
    put(screen, y, 2, "● OPEN · MARKET CLOSES IN 2M", colors["dim"])
    return y + 2


def draw_tabs(screen, y: int, state: State, colors: dict[str, int]) -> int:
    x = 2
    for index, label in enumerate(TABS):
        selected = index == state.tab
        focused = state.focus == 0 and selected
        text = f" {label.upper()} "
        attr = colors["text"] if selected else colors["dim"]
        if focused:
            attr |= curses.A_REVERSE | curses.A_BOLD
        elif selected:
            attr |= curses.A_BOLD
        put(screen, y, x, text, attr)
        x += len(text) + 1
    return y + 2


def draw_ranges(screen, y: int, state: State, colors: dict[str, int]) -> int:
    x = 2
    for index, label in enumerate(RANGES):
        selected = index == state.time_range
        focused = state.focus == 1 and selected
        text = f" {label} "
        attr = colors["text"] if selected else colors["dim"]
        if focused:
            attr |= curses.A_REVERSE | curses.A_BOLD
        elif selected:
            attr |= curses.A_BOLD
        put(screen, y, x, text, attr)
        x += len(text) + 1
    return y + 1


def draw_chart(screen, y: int, state: State, colors: dict[str, int], tall: bool = False) -> int:
    data = INSTRUMENTS[state.symbol]
    y = draw_ranges(screen, y, state, colors) + 1
    lines = [
        "                                                   __/",
        "                                             _____/",
        "                                       _____/",
        "                                  ____/",
        "                           _____/",
        "                     _____/",
        "______________ _____/",
    ]
    if tall:
        lines = ["" for _ in range(2)] + lines + ["" for _ in range(2)]
    labels = ["$215", "", "$213", "", "$211", "", "$209"]
    for index, line in enumerate(lines):
        label = labels[index - (2 if tall else 0)] if 0 <= index - (2 if tall else 0) < len(labels) else ""
        put(screen, y + index, 2, f"{label:>4} |", colors["dim"])
        put(screen, y + index, 8, line, colors["positive"])
    chart_bottom = y + len(lines)
    put(screen, chart_bottom, 7, "+" + "-" * 58, colors["line"])
    put(screen, chart_bottom + 1, 8, "9:30 AM        11:30 AM        1:30 PM        Now", colors["dim"])
    put(screen, chart_bottom + 3, 2, f"Today's range  {data['range']}", colors["dim"])
    put(screen, chart_bottom + 3, 49, f"Volume  {data['volume']}", colors["dim"])
    return chart_bottom + 5


def draw_news(screen, y: int, state: State, colors: dict[str, int], limit: int = 3) -> int:
    data = INSTRUMENTS[state.symbol]
    rule(screen, y, colors["line"])
    put(screen, y + 1, 2, "NEWS", colors["text"] | curses.A_BOLD)
    put(screen, y + 1, 9, "See all", colors["accent"])
    y += 3
    for index, (age, headline) in enumerate(data["news"][:limit]):
        selected = state.focus == 2 and index == state.news_index
        attr = colors["text"] if selected else colors["dim"]
        prefix = ">" if selected else " "
        if selected:
            attr |= curses.A_REVERSE
        put(screen, y + index * 2, 2, f"{prefix} {age:<5} {headline}", attr)
    return y + limit * 2


def draw_overview(screen, y: int, state: State, colors: dict[str, int]) -> int:
    y = draw_chart(screen, y, state, colors)
    return draw_news(screen, y, state, colors)


def draw_chart_tab(screen, y: int, state: State, colors: dict[str, int]) -> int:
    return draw_chart(screen, y, state, colors, tall=True)


def draw_news_tab(screen, y: int, state: State, colors: dict[str, int]) -> int:
    return draw_news(screen, y, state, colors, limit=3)


def draw_footer(screen, state: State, colors: dict[str, int]) -> None:
    height, width = screen.getmaxyx()
    rule(screen, height - 3, colors["line"])
    watch = "WATCHING" if state.in_watchlist else "NOT WATCHING"
    put(screen, height - 2, 2, f"{state.status}  |  {watch}", colors["dim"])
    hints = "W/S ↑↓ select  A/D ←→ screen  J open  K why  / search  E watch  R refresh  ? help  Q quit"
    put(screen, height - 1, 2, clipped(hints, width - 4), colors["dim"])


def draw_help(screen, colors: dict[str, int]) -> None:
    screen.erase()
    height, width = screen.getmaxyx()
    lines = [
        "KEYBOARD SHORTCUTS",
        "",
        "W / S  or  Up / Down     Move focus between tabs, chart range, and news",
        "A / D  or  Left / Right  Change the selected tab or chart range",
        "J  or  Enter             Open the focused item (drill down)",
        "K                        Context-aware \"Why?\" explanation",
        "/                        Search ticker (AAPL, MSFT, AMZN)",
        "E                        Add / remove ticker from Watchlist",
        "R                        Refresh mock data",
        "Q  or  Esc               Quit",
        "",
        "Press any key to return",
    ]
    start = max(1, (height - len(lines)) // 2)
    for index, line in enumerate(lines):
        attr = colors["brand"] | curses.A_BOLD if index == 0 else colors["text"]
        put(screen, start + index, max(2, (width - len(line)) // 2), line, attr)
    screen.refresh()
    screen.getch()


def search_symbol(screen, state: State, colors: dict[str, int]) -> None:
    height, _ = screen.getmaxyx()
    prompt = "Search ticker (AAPL, MSFT, AMZN): "
    screen.move(height - 2, 2)
    screen.clrtoeol()
    put(screen, height - 2, 2, prompt, colors["accent"] | curses.A_BOLD)
    curses.echo()
    curses.curs_set(1)
    try:
        value = screen.getstr(height - 2, 2 + len(prompt), 12).decode("utf-8", "ignore").strip().upper()
    finally:
        curses.noecho()
        curses.curs_set(0)
    if value in INSTRUMENTS:
        state.symbol = value
        state.news_index = 0
        state.status = f"Loaded {value} (static demo data)"
    elif value:
        state.status = f"{value} is not in this prototype; try AAPL, MSFT, or AMZN"


def handle_key(screen, key: int, state: State, colors: dict[str, int]) -> bool:
    # Quit
    if key in (ord("q"), ord("Q"), 27):
        return False
    # Help
    if key in (ord("?"), curses.KEY_F1):
        draw_help(screen, colors)
    # Search ticker
    elif key == ord("/"):
        search_symbol(screen, state, colors)
    # Watchlist toggle (E key)
    elif key in (ord("e"), ord("E")):
        state.in_watchlist = not state.in_watchlist
        state.status = "Added to Watchlist" if state.in_watchlist else "Removed from Watchlist"
    # Why? explanation (K key)
    elif key in (ord("k"), ord("K")):
        sym = state.symbol
        data = INSTRUMENTS[sym]
        state.status = f"Why is {sym} moving? {data['news'][0][1]}"
    # Refresh (R key)
    elif key in (ord("r"), ord("R")):
        state.status = "Mock data refreshed at 4:58 PM"
    # Navigation: focus down (S / Down / Tab)
    elif key in (curses.KEY_DOWN, ord("s"), ord("S"), 9):
        state.focus = (state.focus + 1) % len(FOCUS_AREAS)
    # Navigation: focus up (W / Up / Shift+Tab)
    elif key in (curses.KEY_UP, ord("w"), ord("W"), curses.KEY_BTAB):
        state.focus = (state.focus - 1) % len(FOCUS_AREAS)
    # Navigation: left (A / H / Left)
    elif key in (curses.KEY_LEFT, ord("a"), ord("A"), ord("h"), ord("H")):
        if state.focus == 0:
            state.tab = (state.tab - 1) % len(TABS)
        elif state.focus == 1:
            state.time_range = (state.time_range - 1) % len(RANGES)
        elif state.focus == 2:
            state.news_index = (state.news_index - 1) % len(INSTRUMENTS[state.symbol]["news"])
    # Navigation: right (D / L / Right)
    elif key in (curses.KEY_RIGHT, ord("d"), ord("D"), ord("l"), ord("L")):
        if state.focus == 0:
            state.tab = (state.tab + 1) % len(TABS)
        elif state.focus == 1:
            state.time_range = (state.time_range + 1) % len(RANGES)
        elif state.focus == 2:
            state.news_index = (state.news_index + 1) % len(INSTRUMENTS[state.symbol]["news"])
    # Open / drill (J or Enter)
    elif key in (curses.KEY_ENTER, 10, 13, ord("j"), ord("J")):
        if state.focus == 2:
            headline = INSTRUMENTS[state.symbol]["news"][state.news_index][1]
            state.status = f"Opened story: {headline}"
        else:
            state.status = f"Selected {TABS[state.tab]} / {RANGES[state.time_range]}"
    return True


def run(screen) -> None:
    curses.curs_set(0)
    screen.keypad(True)
    curses.start_color()
    curses.use_default_colors()
    curses.init_pair(1, curses.COLOR_GREEN, -1)
    curses.init_pair(2, curses.COLOR_CYAN, -1)
    curses.init_pair(3, curses.COLOR_WHITE, -1)
    curses.init_pair(4, curses.COLOR_BLACK, -1)
    curses.init_pair(5, curses.COLOR_YELLOW, -1)
    curses.init_pair(6, curses.COLOR_RED, -1)
    colors = {
        "brand": curses.color_pair(1), "positive": curses.color_pair(1),
        "accent": curses.color_pair(2), "text": curses.color_pair(3),
        "dim": curses.A_DIM, "line": curses.A_DIM,
        "negative": curses.color_pair(6),
    }
    state = State()

    while True:
        screen.erase()
        height, width = screen.getmaxyx()
        if height < 25 or width < 74:
            put(screen, 1, 2, "Terminal too small. Resize to at least 74 columns x 25 rows.", colors["accent"])
            put(screen, 3, 2, "Press q to quit.", colors["dim"])
        else:
            y = draw_topbar(screen, state, colors)
            y = draw_quote(screen, y, state, colors)
            y = draw_tabs(screen, y, state, colors)
            if state.tab == 0:
                draw_overview(screen, y, state, colors)
            elif state.tab == 1:
                draw_chart_tab(screen, y, state, colors)
            else:
                draw_news_tab(screen, y, state, colors)
            draw_footer(screen, state, colors)
        screen.refresh()
        if not handle_key(screen, screen.getch(), state, colors):
            break


if __name__ == "__main__":
    curses.wrapper(run)
