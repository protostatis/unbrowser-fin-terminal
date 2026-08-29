# Screen Contract — Minimal Existing-Terminal Treatment

## Screens

| Surface | Purpose | Existing UI retained | New behavior | Notes |
| --- | --- | --- | --- | --- |
| Replay terminal | Show an approved static replay without live work | Full-screen terminal grid, status line, demo marker, interaction language, Source Locker | Replay-specific status copy and a compact pilot-workspace affordance | No new page layout or terminal session |
| Activation prompt | Preserve a selected save/follow action through sign-in | Existing select-overlay/modal visual language | Product-specific copy and return behavior | Not a standalone sign-in or workspace page |

## State contract

| State | Trigger | Visible change | User action | Non-negotiable behavior |
| --- | --- | --- | --- | --- |
| Replay | Visitor opens the approved artifact | Terminal rows identify replay/freshness/evidence; small demo marker | Inspect, use existing Source Locker, activate pilot workspace | No WebSocket, agent session, source/model call, or terminal-seat claim |
| Activation required | Visitor chooses an allowed durable save/follow action | Compact overlay over the unchanged terminal | Continue with UnchainedSky or return to replay | Preserve only the bounded action; do not start a job |
| Pilot active | Identity and eligibility succeed | Compact confirmation/status copy in the existing visual language | Continue using saved parent/follows | Do not introduce a new workspace canvas in Phase 1 |
| Source checks unavailable | A visitor asks for fresh work in Phase 1 | Compact explanatory copy only | Save/follow or return to replay | Do not imply a queue or collect fresh-source/model work |

## Out of visual scope

Phase 2 source-check progress, version comparison, partial-result UI, and retry controls have product-contract requirements in the PRD but deliberately have no visual design in this package.
