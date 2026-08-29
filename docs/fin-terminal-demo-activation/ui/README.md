# Fin Terminal Demo Activation — Minimal Visual Handoff

## Purpose

This package documents the smallest visual change that supports the Phase 1 pilot. It is a **visual reference, not production code**.

- Source PRD: `../fin-terminal-demo-activation-prd.md`
- Visual constraint: preserve the existing Fin Terminal frame, terminal grid, status line, `demo-banner`, interaction overlay, and Source Locker.
- Allowed Phase 1 UI additions: replay-specific copy/status treatment and one compact pilot-activation prompt using the existing overlay/modal language.
- Explicitly excluded: a new dashboard, three-column shell, persistent inspector, redesigned workspace canvas, mover rail, and a source-check UI.

## Included states

- **Replay:** the unchanged terminal form displays approved static rows, a compact demo marker, existing status treatment, and a small pilot-workspace affordance.
- **Activation:** a compact overlay preserves the selected save/follow action while existing UnchainedSky sign-in completes.

Open `mockup.html?state=replay` or `mockup.html?state=activation`. Any unsupported state falls back to replay; Phase 2 source-check UI is intentionally not mocked.

## Migration boundary

- Do not copy the standalone HTML into production.
- Do not mount the terminal socket/provider in the replay entry.
- Do not modify the legacy terminal layout to accommodate this feature.
- Reuse existing terminal CSS/overlay patterns when an approved implementation plan exists.
