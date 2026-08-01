# Web UI Design Spec — Map `market-terminal.ts` to a browser app

## Goal

Run the canonical Pi Market Terminal extension directly and project its
terminal rendering into a browser. The same `render()` and `handleInput()`
logic that powers the TUI must produce the web layout.

Hard constraint: **the web UI must not fork or copy
`.pi/extensions/market-terminal.ts`.** Extension improvements apply to both
the TUI and browser projection.

## Why this is possible (findings)

1. All extension dependencies are public on npm:
   `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
   `@earendil-works/pi-tui` (all `0.83.0`) and `typebox` (`1.3.8`). So the
   extension compiles and runs outside Pi.

2. The extension is a default-export function `(pi: ExtensionAPI) => void` that
   registers tools and commands against a small Pi API surface. We can supply a
   **Pi-compatible harness** implementing only that surface.

3. `MarketTerminal` / `MarketHub` are module-private (not exported) **but** the
   extension constructs them inside a `ctx.ui.custom(factory)` callback and
   **returns the live instance** from that factory. The harness's `ui.custom`
   receives the instance and can duck-type `render(width)`, `handleInput(data)`,
   `setCanvas(...)`, `debugState()`. We never need to export the classes.

4. The `Theme` interface is tiny:
   `{ fg(color, text), bg(color, text), bold(text) }`. A web implementation
   wraps text in `<span class="...">` instead of ANSI codes.

5. `Tui` is tiny: `{ requestRender(force?), terminal?: { rows } }`. A web
   implementation triggers a re-render push and reports the browser viewport's
   row count.

Net: the **same** layout/composition/scroll/chart-positioning code executes;
only the color/token encoding and the transport change.

## Architecture

```
Browser (React + Vite)              Node backend (Express + ws)
+-----------------------+           +------------------------------+
| Terminal panel        |  <--ws--- | Pi-harness                   |
|  monospace row grid   |           |  real @earendil-works deps   |
|  CSS from <span> cls  |           |  canonical market-terminal.ts|
| Keyboard capture      |  --ws-->  |  input listener -> handleInput|
| Resize -> cols/rows   |  --ws-->  |  webTui.terminal.rows = rows |
| (opt) SVG chart layer |  <-rest-- | data-layer tools (quotes,    |
+-----------------------+           |   technicals, canvas blocks) |
                                    | pi.exec("unbrowser",...)     |
                                    +------------------------------+
```

### Backend responsibilities (`server/`)

- Install real `@earendil-works/*` + `typebox` so the extension type-checks.
- Build `PiHarness` implementing the subset of `ExtensionAPI` the extension uses:
  - `registerTool`, `registerCommand`, `on`, `sendUserMessage` — capture/store.
  - `exec(name, args, opts)` — spawn the real binary (`unbrowser`) when present;
    return `{code, stdout, stderr}`. Used for discovery/headlines.
- Build `HarnessUI` implementing `ExtensionUI` subset:
  - `custom<T>(factory, opts)`: invoke `factory(webTui, webTheme, undefined, done)`,
    **keep the returned component**, keep the returned promise pending until
    `done()` is called. Store `activeComponent`.
  - `onTerminalInput(cb)`: store `inputCb`. Harness routes keyboard to it.
  - `notify(msg, level)`: forward to browser as a toast event.
  - `select(title, options)`: forward to browser, await choice.
- `webTheme`: `{ fg: (c,t)=>`§F${c}§${t}§/F§`, ... }` — or HTML spans directly.
  **Token protocol** chosen so the browser can map colors deterministically
  (recommended: emit `<span class="tc tc-{color}">…</span>`; backend HTML-escapes
  inner text to prevent injection from untrusted page content).
- `webTui`: `{ requestRender: schedulePush, terminal: { rows } }`. `rows` set from
  the browser's reported viewport.
- On `requestRender` or input: call `activeComponent.render(width)` → `string[]`
  of HTML-ish rows → push over WebSocket as `{type:"frame", rows, state}`.
- Expose REST for richer widgets:
  - `GET /api/quote?symbol=` → invoke stored `market_quote` tool
  - `GET /api/technicals?scope=&symbol=` → `market_technicals`
  - `GET /api/discover?scope=&symbol=&question=` → `market_discover`
  - These return the extension's structured JSON (Quote, TechnicalSnapshot,
    Canvas+blocks). The frontend may render real SVG charts from `CanvasBlock`
    `chart` blocks as an enhancement layer over the ASCII grid.
- Boot: load extension default export, call it with the harness, then invoke the
  stored `market` command handler (no symbol → Market Map). Drive the resulting
  component via WebSocket.

### Frontend responsibilities (`web/`)

- Vite + React + TypeScript. Dev server proxies `/api` and `/ws` to backend.
- **TerminalFrame**: a fixed-pitch `<pre>`-like grid. Receives `rows: string[]`,
  renders each as a line; CSS classes `.tc-success/.tc-error/.tc-accent/...` map
  to a terminal palette. Escapes are already-safe spans from backend.
- **Viewport sizing**: measure char cell size; compute `cols` and `rows` from the
  container; send `{type:"resize", cols, rows}` on resize. Backend updates
  `webTui.terminal.rows` and re-renders at the new width.
- **Keyboard**: capture `keydown`; map to the extension's key tokens (`a`,`d`,
  arrows, `tab`, `enter`, `pageUp`, etc. — exact strings `handleInput` expects,
  including escape sequences like `\x1b[5~` for PageUp). Send
  `{type:"input", data}`. Use the same key-name table the extension's
  `matchesKey` recognizes.
- **Search input**: when backend reports `searching` state (via `debugState`),
  show a text input and forward typed chars (extension handles `/` + chars +
  Enter internally; alternatively the frontend drives `inputCb` directly).
- **Toasts / select**: render `notify` and `select` events.
- **Optional chart enhancement**: parse `chart` blocks from the current canvas
  (backend can push `debugState()` + active canvas each frame) and overlay a
  lightweight SVG sparkline aligned to the ASCII chart region. Phase 2.

## The Pi API surface the extension actually uses (harness must implement)

Confirmed by reading the extension end-to-end:

- `pi.registerTool({name,label,description,promptSnippet,promptGuidelines,parameters,execute})`
- `pi.registerCommand(name,{description,handler})`
- `pi.on(event,handler)` — events: `session_start`, `session_tree`, `agent_start`,
  `tool_execution_start`, `tool_execution_end`, `agent_settled`
- `pi.exec(name,args,{signal,timeout})` → `{code,stdout,stderr}`
- `pi.sendUserMessage(text)`
- `ctx.ui.custom<T>(factory,options)` → `Promise<T>`
- `ctx.ui.onTerminalInput(cb)` → disposer
- `ctx.ui.notify(text,level)`, `ctx.ui.select(title,options)` → `Promise<string|undefined>`
- `ctx.mode` (`"tui"`), `ctx.cwd`, `ctx.isIdle()`, `ctx.hasPendingMessages()`,
  `ctx.abort()`, `ctx.sessionManager.getBranch()`
- `Theme` = `{fg,bg,bold}`, `Tui` = `{requestRender,terminal?.rows}`,
  `OverlayHandle` = `{isFocused()}`

The harness only needs these. `ctx.mode` returns `"tui"` so command guards pass.

## Key-name mapping (frontend → extension `handleInput`)

The extension reads raw `data: string`. `matchesKey(data, name)` recognizes:
single chars (`a`,`A`,`j`,...), and escape sequences for special keys. The
frontend must emit the **same bytes**:

| Key        | data string     |
|------------|-----------------|
| letters    | the lowercase/uppercase letter (`"a"`,`"A"`,...) |
| Enter      | `"\r"`          |
| Tab        | `"\t"`          |
| Escape     | `"\x1b"`        |
| Backspace  | `"\x7f"`        |
| Space      | `" "`           |
| Arrows     | `"\x1b[A"` etc. (confirm against `matchesKey` in pi-tui) |
| PageUp/Dn  | `"\x1b[5~"` / `"\x1b[6~"` |
| Home/End   | `"\x1b[H"` / `"\x1b[F"` |

**Action item for implementer:** before finalizing, read the installed
`@earendil-works/pi-tui` `matchesKey` source to confirm exact escape sequences,
then encode the matching table in the frontend.

## Fidelity vs. enhancement

- **Fidelity (Phase 1, this build):** 1:1 terminal grid in the browser. ASCII
  charts render as monospace glyphs exactly as in the terminal. Proves zero
  logic change.
- **Enhancement (Phase 2, later):** overlay real SVG/Recharts from `CanvasBlock`
  `chart` data; styled metric cards from `metrics` blocks; clickable source
  links from `sources` blocks. All driven by the *same* data the extension
  already produces — still no extension edits.

## Dependencies / runtime

- Node backend: `express`, `ws`, `typebox`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`. TypeScript.
- Frontend: `vite`, `react`, `react-dom`, TypeScript.
- `unbrowser` on `$PATH` is **optional** — required only for headlines/discovery.
  Quotes + technicals work without it (direct Yahoo `fetch`). If absent, the
  harness returns a clear "unbrowser not available" error for those tools.

## Out of scope / risks

- **Agent-driven research** (`pi.sendUserMessage` dispatches a real LLM agent).
  In standalone mode there is no agent, so `J`/`K` research dispatch will fail.
  Phase-1 mitigation: harness reports "agent not connected" gracefully; the
  `/market-debug ... research` deterministic simulation works fully because it
  never calls the agent. Phase-2: connect a real Pi agent process.
- **Archive persistence**: extension writes `.pi/market-research-archive.json`
  via `node:fs`. Works in Node backend as-is (cwd = worktree root).
- **Color fidelity**: the web palette must cover every color token the extension
  emits: `accent, text, muted, dim, success, error, warning, borderMuted,
  selectedBg` plus bg variants. Implement all in CSS.

## File layout (to create in the worktree)

```
package.json              # workspaces or simple scripts
tsconfig.json
server/
  harness.ts              # PiHarness + HarnessUI + webTheme + webTui
  index.ts                # express + ws, load extension, drive /market
  unbrowser.ts            # pi.exec proxy (spawn binary)
  theme.ts                # color token -> HTML span encoder (XSS-safe)
web/
  index.html
  src/main.tsx
  src/TerminalFrame.tsx   # row grid + CSS palette
  src/keyboard.ts         # keydown -> extension data strings
  src/socket.ts           # ws client + resize reporting
  src/styles.css          # .tc-* palette
docs/web-ui-design.md     # this file
```

## WebSocket protocol (authoritative — backend & frontend both implement this)

All messages are JSON. `rows` are strings containing `<span class="tc tc-{color}">…</span>`
segments produced by the web theme; the frontend sets `innerHTML` per line (the
backend HTML-escapes all dynamic text, so this is XSS-safe).

Client → server:
- `{ "type": "input", "data": "<raw key string>" }` — forward to `handleInput`
- `{ "type": "web_action", "data": { ... } }` — a whitelisted browser-only
  semantic action. The server validates it against the current `debugState()`
  and translates it to canonical raw inputs, so a click on a distant mover does
  not send dozens of client messages. Supported actions are `select`
  (`screen`, `index`, `item`), `focus-pane` (`pane`), `scroll` (`direction`,
  optional `amount`), `primary`, and `why`. Primary and Why actions include
  the rendered mode/screen/selection-or-symbol context and are rejected when
  that identity is stale.
- `{ "type": "resize", "cols": number, "rows": number }` — update
  `webTui.terminal.rows` and re-render at `cols`
- `{ "type": "command", "name": "market", "args": "AAPL" }` — (re)open a panel
- `{ "type": "select_response", "id": string, "value"?: string, "cancelled"?: true }`
  — answer a `select_request`
- `{ "type": "search_text", "text": string }` — optional: drive the in-panel
  `/` search incrementally (the extension handles `/` input internally; this is
  an alternate path)

Server → client:
- `{ "type": "frame", "rows": string[], "width": number, "rows_count": number,
  "state"?: object }` — a rendered frame; `state` is the component's
  `debugState()` (cheap, helps optional enhancements)
- `{ "type": "notify", "level": "info"|"warning"|"error", "message": string }`
- `{ "type": "select_request", "id": string, "title": string, "options": string[] }`
  — the frontend shows a picker and replies `select_response`
- `{ "type": "closed" }` — panel closed (`done()` was called)

Render cadence: backend renders on every `requestRender()` and on every input,
debounced via `process.nextTick` / microtask coalescing so a burst of inputs
produces one frame.

## Verified Pi API reference (from `@earendil-works/pi-coding-agent@0.83.0`)

Implement EXACTLY these in the harness. The extension calls nothing else.

```ts
// ExtensionAPI subset (cast harness as unknown as ExtensionAPI)
registerTool<TParams, TDetails, TState>(tool): void
registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>|void }): void
on(event, handler): void              // store all; events used: session_start, session_tree, agent_start, tool_execution_start, tool_execution_end, agent_settled
exec(command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }): Promise<{ code: number; stdout: string; stderr: string }>
sendUserMessage(content: string | ...[], options?): void   // standalone: no-op + notify "agent not connected"

// ExtensionContext / ExtensionCommandContext (ctx passed to command handlers)
mode: ExtensionMode                   // return "tui" so command guards pass
cwd: string                           // worktree root (so .pi/market-research-archive.json resolves)
isIdle(): boolean                     // true
hasPendingMessages(): boolean         // false
abort(): void                         // no-op
sessionManager: { getBranch(): any[] } // return []  (restoreSessionCanvases iterates it; empty is fine)
// (modelRegistry, model, signal, etc. are unused by the market extension)

// ExtensionUIContext (ctx.ui)
custom<T>(factory, options?): Promise<T>
  // factory: (tui: TUI, theme: Theme, keybindings, done: (result:T)=>void) => Component
  // options: { overlay?: boolean; overlayOptions?; onHandle?: (handle: OverlayHandle)=>void }
  // HARNESS: call factory(webTui, webTheme, undefined as any, done); keep returned component;
  //          call options.onHandle({ isFocused: () => true } as OverlayHandle); return a promise
  //          that resolves when done(result) is called.
onTerminalInput(handler: (data: string) => {consume?: boolean} | undefined): () => void
  // HARNESS: store handler; return a disposer. Route keyboard here.
notify(message: string, type?: "info"|"warning"|"error"): void   // forward to client as {type:"notify"}
select(title: string, options: string[], opts?): Promise<string | undefined>
  // HARNESS: emit select_request to client; await select_response; return value or undefined.

// Theme (a class with fg/bg/bold; cast a plain object as Theme)
// fg(color: ThemeColor, text: string): string
// bg(color: ThemeBg, text: string): string
// bold(text: string): string
// ThemeColor names the extension actually emits:
//   accent | text | muted | dim | success | error | warning | borderMuted
// ThemeBg names: selectedBg   (the only bg the extension uses)
// Theme impl must be XSS-safe: HTML-escape inner text, then wrap in span.

// OverlayHandle: { isFocused(): boolean }  -> harness returns () => true

// TUI (tui passed to factory): { requestRender(force?: boolean): void; terminal?: { rows: number } }
```

`Component` duck-type used by the harness (the runtime instance returned by the
factory is a MarketTerminal or MarketHub, which both expose):
```ts
interface PanelComponent {
  render(width: number): string[];     // -> HTML-ish rows (web theme)
  handleInput(data: string): void;     // dispatch a key
  invalidate(): void;
  // optional, used for enhancements: setCanvas, setResearchJob, debugState
}
```

## Verified key sequences (from `@earendil-works/pi-tui@0.83.0` `matchesKey`)

Kitty protocol is INACTIVE in Node (no terminal), so **legacy sequences** apply.
The frontend must emit these EXACT `data` strings:

| DOM key             | `data` to send        |
|---------------------|-----------------------|
| letters A–Z/a–z     | the literal char (`"a"`, `"A"`) — case-sensitive; extension checks both |
| digits / `?` `/` `[` `]` | the literal char |
| Enter               | `"\r"`                |
| Tab                 | `"\t"`                |
| Escape              | `"\x1b"`              |
| Backspace           | `"\x7f"`              |
| Space               | `" "`                 |
| ArrowUp             | `"\x1b[A"`            |
| ArrowDown           | `"\x1b[B"`            |
| ArrowRight          | `"\x1b[C"`            |
| ArrowLeft           | `"\x1b[D"`            |
| PageUp              | `"\x1b[5~"`           |
| PageDown            | `"\x1b[6~"`           |
| Home                | `"\x1b[H"`            |
| End                 | `"\x1b[F"`            |

Letters are matched by the extension as raw chars (e.g. `data === "q"`), so send
the literal character (respect shift for upper/lower where the extension reads
both cases — it reads both for most keys, so either works).

## Verification

1. `npm install` succeeds; `npm run typecheck` passes for the extension, server,
   and web client.
2. `npm run dev` starts backend + Vite; browser opens Market Map.
3. Arrow keys / `J` / `K` / `R` / `Q` behave identically to the TUI.
4. Resize the browser; rows/width update and layout reflows like the terminal.
5. `/market-debug AAPL canvas` shows the fixture canvas in the browser.
6. `npm run build` and deterministic extension/runtime checks pass without
   maintaining a separate browser-specific extension copy.

## Implementation status (built)

Two layers, both verified:

### Research agent — linked via the in-process Pi SDK (replaces the fake harness)
The original `PiHarness` (a fake `ExtensionAPI` with no agent) is gone. The
backend now creates a **real** `AgentSession` via `createAgentSession()` from
`@earendil-works/pi-coding-agent`. `DefaultResourceLoader({ cwd })` discovers
the canonical `.pi/extensions/market-terminal.ts`; `session.bindExtensions({
uiContext: <our web-ui shim>, mode: "tui" })` plugs in our UI. The session IS
the `ExtensionAPI` — it owns the agent, tools, `pi.exec`, `pi.sendUserMessage`,
events, and model/auth (resolved from `~/.pi/agent`). We only implement the
`ExtensionUIContext` (`server/web-ui.ts`).

`/market` is run via `session.prompt("/market")`. Pressing **J/K** calls the
extension's `pi.sendUserMessage`, which drives the **real agent** in the same
process; its tool calls (`market_technicals`, `market_discover`, `unbrowser`,
`market_canvas`) publish canvases to the **same** panel instance — no
cross-process state. Proven by `server/spike-sdk.ts`:
`J → agent_start → market_technicals (canvas partial, 5 blocks) →
market_discover (6 blocks) → market_canvas (7 blocks)`, with the research state
machine advancing on real `pi.on` events.

### Rendering layer
- `server/theme.ts` — ANSI-emitting web Theme + `ansiToHtml()` (see lesson below).
- `server/web-ui.ts` — the only UI code: `custom`/`onTerminalInput`/`notify`/
  `select` (+ Proxy no-ops for the rest), `webTui` with microtask render coalescing.
- `server/index.ts` — Express + WebSocket: boots the SDK session, serves
  `dist-web/` at `/`, streams ANSI→HTML frames, routes input/resize/command/select.
- `web/` — React + Vite: `TerminalFrame`, `keyboard.ts`
  (DOM→extension key strings), `socket.ts`, `main.tsx` (viewport-exact sizing),
  `styles.css`.

Verified: server + web `tsc --noEmit` pass; `vite build` succeeds; a WS client
sees the Market Map, screen switching on `d`, and **J transitioning research to
`queued/seeding`** (real agent linkage) in the browser-facing flow.

### Key lesson — theme must emit ANSI, not HTML
The web Theme emits **ANSI** (truecolor SGR), converted to HTML only at the WS
boundary by `ansiToHtml()`. Emitting HTML spans breaks the extension's layout:
it routes every string through pi-tui `visibleWidth`/`truncateToWidth`
(`@earendil-works/pi-tui` `dist/utils.js`), which strip `\x1b[...m` when
measuring width and preserve it when truncating. HTML tags are counted as
visible width, causing spurious truncation (`...` + stray `\x1b[0m`). ANSI makes
the backend render identically to a real terminal.
