# Retired Pi Web Projection

> This document describes the retired Pi-backed WebSocket projection. It is
> preserved as historical context only and is not a development or deployment
> contract.

The canonical `.pi/extensions/market-terminal.ts` plugin remains available for
the Pi TUI:

```bash
pi -e .pi/extensions/market-terminal.ts
```

The old `server/index.ts` + `server/web-ui.ts` projection is retained in the
repository only for compatibility with existing local tooling and historical
tests. It is not started by `npm run dev`, is not the production container
target, and must not be used as the route implementation for
`/fin-terminal-browser/`.

## Current development path

`npm run dev` starts the browser-owned runtime (`server/browser-terminal-main.ts`)
and Vite. The browser terminal uses its server-side broker and the
`Dockerfile.browser-terminal` runtime contract. It does not start the retired
Pi-backed WebSocket server.

## Current deployment path

Deploy the browser-terminal image with a public discovery shell and an
authenticated workspace at:

```text
https://unbrowser.unchainedsky.com/fin-terminal-browser/
https://unbrowser.unchainedsky.com/fin-terminal-browser/terminal/
```

Build it with `Dockerfile.browser-terminal`,
`PUBLIC_BASE_PATH=/fin-terminal-browser/`, and
`VITE_TERMINAL_BUILD_MODE=browser`. See
[`deployment.md`](deployment.md) for the authoritative release and
verification contract.

The public gateway and static replay are separate modes with separate
contracts. Neither revives the retired `/fin-terminal/` Pi singleton.
