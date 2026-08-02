# Component Map

| UI element | Production component / style source | Reuse / new / modify | Related files | States | Implementation notes |
| --- | --- | --- | --- | --- | --- |
| Public admission shell | `PublicLiveApp`; `.public-admission`, `.public-admission-card` | Modify | `web/src/PublicLiveApp.tsx`, `web/src/styles.css` | Entry, waiting | Keep real Turnstile and API lifecycle; apply the preview's information hierarchy without copying fixture verification. |
| Session contract metrics | No current component | New component needed: `PublicSessionContract` | Proposed `web/src/PublicSessionContract.tsx` | Entry | Values come from `/api/public/config`, not literals. |
| Waiting assignment progress | Current queued branch in `PublicLiveApp` | Modify / extract | `web/src/PublicLiveApp.tsx` | Waiting | Queue position and ticket TTL are server values; “worker attached” derives from admission state. |
| Terminal result canvas | `TerminalFrame` | Reuse unchanged | `web/src/TerminalFrame.tsx` | Running, result, private | Preview rows are fixtures only; production keeps backend-rendered safe rows. |
| Research beacon | Inline region in `App` | Reuse | `web/src/main.tsx`, `web/src/styles.css` | Running | Existing `researchActivityStatus` remains authoritative. |
| Connection status | `.status-line`, `.status-conn`, `.status-dot` | Reuse / modify layout | `web/src/main.tsx`, `web/src/styles.css` | Running, result, private | Status line currently has `pointer-events: none`; interactive child controls already opt back in. |
| Evidence control | `EvidenceControl` | Reuse | `web/src/EvidenceInspector.tsx` | Running, result, private | Keep before claim action in keyboard order. |
| Workspace claim trigger | No current component | New component needed: `WorkspaceClaimControl` | Proposed `web/src/WorkspaceClaimControl.tsx` | Result, session-ending | Reads claim eligibility, never derives eligibility from displayed copy. |
| Workspace claim cartridge | `EvidenceInspector` structural pattern; `.evidence-overlay`, `.evidence-cartridge` | New component using existing pattern | `web/src/EvidenceInspector.tsx`, `web/src/styles.css`; proposed `web/src/WorkspaceClaimCartridge.tsx` | Claim, claiming, auth, importing, ended, cancelled, expired, unavailable, private, error | Port preview focus trap, trigger-focus restoration, typed lifecycle states, and safe close behavior. |
| Transfer manifest | No current component | New subcomponent | Proposed `WorkspaceClaimCartridge.tsx` | Claim, ended, private | Server returns typed counts/status; do not infer from terminal HTML. |
| Result-capsule status | No current component | New subcomponent | Proposed `WorkspaceClaimCartridge.tsx` | Claim, claiming, ended, cancelled, expired, unavailable | Shows gateway-acknowledged retention separately from authentication-claim TTL. |
| Authentication-claim status | No current component | New subcomponent | Proposed `WorkspaceClaimCartridge.tsx` | Claiming, auth, cancelled, expired, importing | Claim clock starts only after issuance; consumed status is explicit after auth return. |
| Atomic import progress | No current component | New subcomponent | Proposed `WorkspaceClaimCartridge.tsx` | Importing, error, private | Represents idempotent import transaction rather than reusing a consumed claim. |
| Starter balance rack | No current component | New subcomponent | Proposed `WorkspaceClaimCartridge.tsx` | Claim, private | Pre-auth copy is new-account-only. Ready receipt reads actual ledger; existing balances are never replaced by USD 1.00. |
| Session-end recovery | Current `PublicLiveApp` ended card | Modify | `web/src/PublicLiveApp.tsx` | Ended | Render a claim cartridge only when gateway confirms a claimable capsule; otherwise use current safe ended copy. |
| Private-ready receipt | No current account workspace UI | New component needed: `WorkspaceImportReceipt` | Future authenticated workspace package | Private | Must be driven by durable import transaction and authoritative ledger state, with separate new/existing account variants. |
| Private terminal footer | Public banner and status chrome | Modify in future authenticated shell | `web/src/main.tsx`, `web/src/styles.css` | Workspace | Account-scoped balance and persistence must replace singleton semantics. |
| Import failure details | Existing error palette and toast styles | New inline recovery state | Proposed `WorkspaceClaimCartridge.tsx` | Error | Error belongs in cartridge, not toast-only UI. Include stable support-safe import transaction ID; do not imply the consumed auth claim remains valid. |
| Text symbols / indicators | Existing CSS dots, text arrows, checkmarks | Reuse convention | `web/src/styles.css` | All | No icon library exists; do not add one solely for this flow. |
| Preview state selector | Preview-only control | Fixture only; never migrate | `web/src/PublicConversionPreview.tsx` | All preview states | Remove or leave isolated when production components are extracted. |
| AAPL terminal rows and IDs | Static preview fixtures | Fixture only; never migrate | `web/src/PublicConversionPreview.tsx` | Preview only | Production values come from frame, dossier, claim, account, and ledger APIs. |

## Token mapping

| Meaning | Existing token / value |
| --- | --- |
| Canvas | `#0b0e14` terminal background |
| Raised panel | `#0d1117` cartridge/admission background |
| Primary text | `#c9d1d9` / `#f0f6fc` |
| Secondary text | `#8b949e` |
| Border | `#30363d` / `#21262d` |
| Action / information | `#58a6ff`, `#1f6feb` |
| Saved / complete | `#3fb950` |
| Waiting / expiring | `#d29922` |
| Failure | `#f85149` |
| Typography | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |

The preview repeats these values in a scoped fixture stylesheet only to avoid changing production CSS during design review. Production integration should consolidate new styles into the existing token/class system rather than retain duplicate variables.
