# Implementation Notes — Minimal UI Scope

## UI boundary

Phase 1 is not a Fin Terminal redesign. The production change should be limited to a separate static replay entry, compact status/banner copy, and a small activation prompt layered over the existing terminal visual language.

## Suggested work sequence

1. Build the replay entry without importing `TerminalSocket`, terminal session providers, or stateful extension machinery.
2. Render approved immutable replay rows through the existing terminal-frame presentation contract or an equivalent static presenter that preserves its layout.
3. Reuse existing demo/status and overlay patterns for `REPLAY DEMO`, evidence/freshness, source-check unavailability, and pilot activation.
4. Send identity/activation through UnchainedSky; return with only a compact confirmation for a saved parent/follow action.
5. Keep Phase 2 source-check UI out of the Phase 1 frontend change set.

## Verification

- Replay route creates no WebSocket, terminal seat, agent session, source call, model call, archive mutation, or canonical watchlist mutation.
- Replay/activation fit the existing terminal at 1440×900 and 1280×800 without adding a new app layout.
- Activation overlay preserves only the selected allowlisted save/follow action and returns safely on cancel.
- A Phase 1 fresh-source request shows unavailable status and performs no work.
