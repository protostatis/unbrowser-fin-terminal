# Public Terminal Conversion Preview

Status: **project-native preview; not production integration**

Structure: **structure-confirmed**

## Purpose

This package turns the confirmed public-terminal conversion flow into a high-fidelity, fixture-only React preview. It demonstrates when signup appears, what moves into a private workspace, how the new-account-only USD 1.00 starter balance is explained, and how claim, auth, retention, and import failures recover.

The preview intentionally does not call admission, authentication, billing, workspace, gateway, worker, model, or source APIs.

## Source inputs

- Product source: confirmed conversation decisions summarized in `ascii-layout.md`; no standalone PRD was supplied.
- UI specification: no separate UI spec was supplied. Existing project UI is the visual source of truth.
- Real frontend project: `/Users/zhiminzou/Projects/unbrowser-fin-terminal-public-live/web`.
- Existing evidence inspected:
  - `web/src/PublicLiveApp.tsx`
  - `web/src/TerminalFrame.tsx`
  - `web/src/ReplayApp.tsx`
  - `web/src/styles.css`
  - `web/src/main.tsx`

## Discovered UI constraints

1. The app is a full-height, no-document-scroll terminal; terminal frame or cartridge body owns overflow.
2. The canonical visual language is a dense monospace console using the blue/green/amber/red palette in `web/src/styles.css`.
3. `TerminalFrame` is the canonical row renderer and accepts backend-style HTML-safe terminal rows.
4. The existing `status-line` is noninteractive by default; evidence and conversion controls must explicitly restore pointer events.
5. Evidence uses a centered overlay and physical “cartridge” metaphor, making it the closest production pattern for a workspace-transfer prompt.
6. Public admission already uses a bounded single-card shell, Turnstile, and terminal copy rather than a marketing landing page.
7. There is no component library or icon package; local UI uses text symbols and small CSS status marks.
8. The app has no frontend router. A separate Vite HTML entry is the safest preview boundary because it cannot alter production route selection or socket bootstrapping.

## Preview files

- HTML entry: `web/public-conversion-preview.html`
- React entry: `web/src/public-conversion-preview-main.tsx`
- Preview component and fixtures: `web/src/PublicConversionPreview.tsx`
- Preview-only styling: `web/src/public-conversion-preview.css`

## Run

From the worktree root:

```bash
npm run dev:web -- --port 5174
```

Open:

```text
http://127.0.0.1:5174/public-conversion-preview.html?state=result
```

If the dev server was started with `PUBLIC_BASE_PATH=/fin-terminal-live-pilot/`, use:

```text
http://127.0.0.1:5174/fin-terminal-live-pilot/public-conversion-preview.html?state=result
```

Use the preview-only state rail or set `state` to:

- `entry`
- `waiting`
- `running`
- `result`
- `claim`
- `claiming`
- `auth`
- `importing`
- `ended`
- `private`
- `workspace`
- `cancelled`
- `expired`
- `unavailable`
- `error`

Append `&clean=1` to hide the state rail for review captures. Set `account=existing` to inspect the existing-account ledger variant; the default is `account=new`.

## Included states

- Public entry after human verification.
- Waiting room and worker assignment.
- Active research/synthesis.
- Completed AAPL result with status-strip claim action.
- Result-capsule offer before any auth claim exists.
- Auth-claim creation, issuance, same-tab handoff, and atomic import.
- Public session complete recovery with an independent capsule countdown.
- Authentication cancellation, auth-claim expiry, and result-capsule deletion.
- Private workspace ready receipts for new and existing account ledger paths.
- Private persistent terminal.
- Retryable post-auth import failure.

## Verification

- Full TypeScript check: `npm run typecheck` — passed.
- Production build: `npm run build` — passed; the normal production entry remains unchanged.
- Test suite: `npm test` — 218 passed.
- Mockup package contract: passed with implementation handoff files present.
- Browser review and exact 1440x900 / 1280x800 captures: see `preview.md` and `screenshots/`.

## Assumptions and open product dependencies

- A completed public result first becomes a durable result capsule. A separate one-time 30-minute auth claim is created only after the user selects `Create workspace`.
- Session-end recovery requires the result capsule to outlive destruction of the disposable worker; the retention mechanism and exact duration are not implemented yet.
- OAuth provider selection and account form details are intentionally outside this flow.
- The authenticated product does not yet have account-scoped persistence, workspace wake/sleep, a USD ledger, or the new-account-only USD 1.00 grant.
- Actual-cost display needs authoritative usage data from the research provider after completion.
- Partial-result claiming is out of scope; only complete results are eligible in this handoff.

## Migration boundary

Production-aligned:

- Existing terminal frame, palette, typography, status chrome, admission pattern, evidence-cartridge pattern, copy hierarchy, and responsive constraints.
- Product state sequence and conversion placement.

Preview-only:

- Static AAPL rows, queue values, countdowns, capsule/claim/import IDs, fixture ledger balances, state selector, direct state transitions, and simulated verification.
- All classes prefixed `conversion-` and the separate preview HTML entry.

Do not connect the preview selector or fixture transitions to production. Production implementation should extract the mapped components and drive them from authenticated server state as described in `implementation-notes.md`.
