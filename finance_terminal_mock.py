#!/usr/bin/env python3
"""Minimal, dependency-free terminal mock for a financial-information app.

Run: python3 finance_terminal_mock.py
This screen uses static demo content; it is not a market-data feed.
"""

SCREEN = r"""
+--------------------------------------------------------------------------------+
| SIGNAL   ● OPEN                                 4:58 PM  | DELAYED 15m   |
+--------------------------------------------------------------------------------+
| < Watchlist                                                           / Search |
|                                                                                |
| AAPL                                                                           |
| Apple Inc.                                             NASDAQ                   |
|                                                                                |
| $214.47                              ▲ +$2.93 (+1.38%)                        |
| ● OPEN · MARKET CLOSES IN 2M                                                 |
|                                                                                |
| 1D        1W        1M        3M        1Y        ALL                         |
| --        --        --        --        --        ---                         |
|                                                                                |
| $215 |                                                 __/                      |
| $214 |------------  ----  ----  ----  ----  ----  ----/----                    |
| $213 |                                           _____/                         |
|      |                                      ____/                               |
| $211 |                           _____/                                         |
|      |                     _____/                                               |
| $209 |______________ _____/                                                     |
|      +-------------------------------------------------------------------       |
|       9:30 AM              11:30 AM             1:30 PM           Now         |
|                                                                                |
| Today's range  $211.88 - $215.33                         Volume  38.4M        |
+--------------------------------------------------------------------------------+
| NEWS                                                                   See all |
+--------------------------------------------------------------------------------+
| 15m ago   Apple investors await earnings; services and margin outlook in focus |
| 2h ago    Technology stocks lead market rebound as Treasury yields ease        |
| 4h ago    What analysts are watching in Apple's quarterly results              |
+--------------------------------------------------------------------------------+
| ABOUT                                                                          |
| Apple designs consumer electronics, software, and digital services.            |
+--------------------------------------------------------------------------------+
| [ E ] WATCH  [ / ] SEARCH  J open  K why  R refresh  ? help  q quit          |
+--------------------------------------------------------------------------------+
""".strip("\n")

FRAME_WIDTH = 82


def main():
    # Keep every interior row aligned to the terminal frame.
    for line in SCREEN.splitlines():
        if line.startswith("|") and line.endswith("|"):
            print(f"|{line[1:-1][:FRAME_WIDTH - 2].ljust(FRAME_WIDTH - 2)}|")
        else:
            print(line)
    print("\nDEMO ONLY: values and headlines are static mock content, not live data or investment information.")


if __name__ == "__main__":
    main()
