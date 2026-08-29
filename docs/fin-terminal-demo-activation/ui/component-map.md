# Component and Style Map — Minimal Treatment

| UI element | Reuse / change | Related files | Notes |
| --- | --- | --- | --- |
| Full-height terminal frame | Reuse unchanged | `web/src/main.tsx`, `web/src/TerminalFrame.tsx`, `web/src/styles.css` | Replay entry must render static rows without constructing `TerminalSocket` or an agent session |
| Public-demo marker | Reuse/adjust copy only | `web/src/main.tsx`, `web/src/styles.css` (`.demo-banner`) | Identify replay/static status; do not create a new navigation layer |
| Status line | Reuse/adjust copy only | `web/src/main.tsx`, `web/src/styles.css` (`.status-line`) | Show replay, freshness, evidence, and source-check-unavailable status compactly |
| Source Locker | Reuse existing control/overlay concept | `web/src/EvidenceInspector.tsx` | Public approved replay data only; no permanent inspector column |
| Pilot activation prompt | Narrow new product-specific overlay | `web/src/main.tsx`, `web/src/styles.css` (`.select-overlay`, `.select-modal`) | Preserve a bounded save/follow intent; existing UnchainedSky owns sign-in |
| Existing interaction controls | Reuse unchanged | `web/src/InteractionOverlay.tsx` | Do not add a replacement action rail or dashboard controls |

## Guardrail

If the implementation requires a new persistent terminal pane, rail, canvas, or dashboard to deliver Phase 1, stop and revisit the product scope rather than adding it incrementally.
