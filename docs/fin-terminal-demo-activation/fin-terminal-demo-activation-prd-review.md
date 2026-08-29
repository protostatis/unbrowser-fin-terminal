# PRD Readiness Review — Fin Terminal Replay Demo, Account Activation, and Personal Workspace

| Field | Result |
| --- | --- |
| Reviewed artifact | [PRD](fin-terminal-demo-activation-prd.md), diagrams, and visual handoff |
| Review date | 2026-08-01 |
| Overall verdict | **Conditionally ready for Phase 1 technical planning** after data-lifecycle approval; Phase 2 fresh source checks remain gated |
| Decision status | Launch choices recorded in the PRD; a data-lifecycle proposal is ready for review |

## What is implementation-ready

- The public replay is clearly separated from the existing singleton terminal: no terminal WebSocket, `AgentSession`, live source/model work, archive mutation, or canonical watchlist mutation.
- The product correctly treats Fin Terminal as an additive entitlement and product subject, not a new global `user_type`.
- The one-time intent, owner-bound workspace, authorization, callback replay, and failure-preservation principles are coherent and testable; parent/child source-check behavior remains Phase 2 only.
- The visual handoff preserves the current terminal frame and covers only replay plus a compact activation prompt; Phase 2 UI is intentionally not designed. Both editable diagrams validate structurally.

## Decision log

| ID | Decision | Result |
| --- | --- | --- | --- |
| D1 | Launch access | Phase 1 is a no-billing, pilot-allowlisted workspace activation. |
| D2 | Legacy terminal scope | Entitlement grants the new personal workspace only; the existing singleton terminal remains independently allowlisted. |
| D3 | Service boundary | A dedicated durable Fin Terminal workspace service owns private data and later jobs; UnchainedSky remains identity authority. |
| D4 | Source launch posture | Phase 1 uses approved immutable replay only. Fresh-source work, model spend, private child versions, and source jobs are feature-flagged off. |
| D5 | Data lifecycle | A proposal was requested and added: [data lifecycle and support access](fin-terminal-demo-data-lifecycle-proposal.md). |

## Remaining approval and design gates

| ID | Gate | Affects | Required before proceeding |
| --- | --- | --- | --- |
| G1 | Approve the proposed retention, deletion, export, and support-access policy. | Phase 1 | Product/privacy/security approval of the linked proposal. |
| G2 | Choose the concrete durable relational store and job mechanism for the separate workspace service. | Phase 1 technical design | Deployment-compatible persistence design with transactional uniqueness/claim semantics. |
| G3 | Approve named source profiles, licensing/retention/excerpt terms, quotas/cooldowns, and spend circuit breaker. | Phase 2 only | Source/legal and operations approval before enabling source-check jobs. |

## Important corrections applied in this review

| ID | Correction | Disposition |
| --- | --- | --- |
| I1 | Defined entitlement lifecycle states and suspended/read-only versus revoked/no-access behavior. | Added to PRD §2. |
| I2 | Defined changed, unchanged, partial, blocked, failed, and cancelled source-check outcomes. | Added to PRD §§8–9. |
| I3 | Defined the job idempotency tuple and required job audit fields. | Added to PRD §9. |
| I4 | Prevented intent/product identifiers from appearing in URLs, titles, or referrers. | Added to PRD §14 and acceptance criteria. |
| I5 | Made legacy forward-auth/principal behavior explicitly legacy-only. | Added to PRD appendix compatibility plan. |
| I6 | Expanded the activation-flow canvas so all nodes remain within its page bounds. | Updated editable Draw.io artifact. |
| I7 | Removed the proposed terminal redesign after scope feedback; documented a minimal existing-terminal treatment instead. | Updated PRD §7 and the complete visual handoff. |

## Before launch, after planning begins

- Phase 1: define the analytics event schema, retention, and redaction rules for replay/activation/save/follow events, then verify zero source/model work.
- Phase 1: verify accessibility, keyboard operation, reduced-motion behavior, and responsive behavior in the production implementation rather than treating the static mockup as sufficient evidence.
- Phase 2: establish source-profile rules that make the configured “minimum source profile” measurable per dossier type.
- Phase 2: set concrete SLOs for queue latency, source-check timeout, retry backoff, cost circuit breaker, and concurrent replay load.

## Verification performed

- `check_prd_shape.py … --type ai-native --allow-handoff` — passed.
- `validate_drawio.py` for both editable diagrams — passed.
