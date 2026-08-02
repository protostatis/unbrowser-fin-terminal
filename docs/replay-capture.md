# Public replay capture

The public demo replays a checked-in terminal capture. It never connects to
the live terminal, Yahoo Finance, Unbrowser MCP, an agent model, or a source at
visitor runtime.

## Initial approved capture

- Captured from the authenticated Fin Terminal on 2026-08-02 (UTC).
- Scenario: AT&T (`T`) research brief, month chart, technical-analysis rows,
  and the partial-evidence Source Locker state.
- Public-content approval: the product owner approved use of the captured
  public facts, source names/metadata, and replay summaries in this demo.
- The bundle intentionally preserves partial evidence and challenged retrieval;
  it does not claim live prices, current source status, or investment advice.

## Replacement process

1. Capture a representative signed-in terminal state with the existing data
   flow, then review the visible frame and public packet subset.
2. Record the capture time, timezone, source count, packet subset, and any
   omission or retrieval limitation in `web/src/replay-artifacts.ts`.
3. Keep terminal-produced frame rows intact. The replay renderer allows only
   text and renderer palette spans, so a capture cannot add links, scripts, or
   arbitrary styles to the public page.
4. Update artifact tests and run the demo build. Every replacement remains
   immutable until a reviewed source change is committed.
