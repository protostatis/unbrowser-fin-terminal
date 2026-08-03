# Screen Contract

## User and job

- Primary user: an anonymous visitor evaluating the live market terminal.
- Primary job: create a credible sourced brief before deciding whether the result deserves a persistent workspace.
- Conversion job: preserve proven value without interrupting public use or implying that signup is required.

## Navigation model

- Admission owns entry and waiting-room states.
- The live terminal owns research and result states.
- Web status chrome owns the claim trigger.
- A modal cartridge owns result-capsule, claim creation, auth handoff, import, recovery, ready, and import-error states.
- Authentication is a same-tab handoff after a server-side one-time claim is issued; provider UI itself is out of scope, but creation, cancellation, return, expiry, and import states are in scope.

## Screen inventory

| Screen | Purpose | Key regions | States covered | Product source | UI source | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Public admission | Explain the bounded public contract and verify a human | Relay header, session contract, verification, primary entry action, sign-in | `entry` | Confirmed public pilot policy | `PublicLiveApp.tsx`, public-admission styles | No signup promotion before value exists; existing-account sign-in stays quiet. |
| Waiting room | Preserve trust while a disposable worker is assigned | Queue position, ticket TTL, assignment track, cancel | `waiting` | FIFO queue and 10-minute ticket policy | `PublicLiveApp.tsx` queued state | Assignment continues automatically. |
| Live terminal | Show real research activity and public limits | `TerminalFrame`, research beacon, evidence control, public footer | `running` | Live research workflow | `main.tsx`, `TerminalFrame.tsx` | No claim action while the first result is still running. |
| Claimable result | Keep the completed result primary while introducing ownership | Completed canvas, status line, evidence, claim action, public footer | `result` | Value-triggered conversion decision | Status/evidence chrome in `main.tsx` | Claim action is outside terminal rows and remains nonblocking. |
| Workspace claim | Explain exactly what transfers and who may receive USD 1.00 | Result backdrop, manifest, new-account balance rack, create/not-now/sign-in | `claim` | Confirmed claim model and starter balance | Evidence overlay/cartridge | No one-time claim exists yet; footer describes result-capsule availability. |
| Claim creation | Acknowledge the durable capsule before starting the auth clock | Result backdrop, three-step progress, cancel | `claiming` | Advisor revision | Evidence cartridge | Claim TTL explicitly has not started. |
| Authentication handoff | Show issued-claim TTL and account path before leaving the app | Claim ID, result-capsule status, account path, continue/cancel | `auth` | Same-tab auth decision | Evidence cartridge | Existing-account and new-account paths stay distinct. |
| Import progress | Explain OAuth return, claim consumption, and atomic import | Private backdrop, verified steps, active import | `importing` | Advisor revision | Evidence cartridge | Import retries cannot create another workspace or starter grant. |
| Session recovery | Preserve conversion after the disposable worker ends | Muted result backdrop, result-capsule countdown | `ended` | Session-end recovery decision | Closed/evidence overlays | Offers workspace transfer or a fresh public session; countdown belongs to the capsule, not a not-yet-issued claim. |
| Auth/retention recovery | Separate cancellation, auth-claim expiry, and capsule deletion | Lifecycle matrix and safe recovery actions | `cancelled`, `expired`, `unavailable` | Advisor revision | Warning/error cartridge variants | A new claim is possible only while the result capsule remains available. |
| Private ready | Confirm import, persistence, authoritative ledger balance, and sleeping compute | Import receipt, state matrix, open-terminal action | `private` | Confirmed private workspace promise | Evidence cartridge + terminal shell | New accounts show USD 1.00; existing accounts show fixture ledger balance rather than receiving the grant. |
| Private terminal | Return the user to the saved work surface | Private terminal frame, saved status, balance footer | `workspace` | Persistent-workspace decision | Existing terminal shell | Production must be account-scoped rather than the current singleton. |
| Import failure | Put recovery next to the affected transfer | Error code, safe-result copy, retry/open-empty actions | `error` | Required claim/provisioning recovery | Toast/error palette + cartridge | User is told that auth succeeded, the claim was consumed, the workspace exists, and only the import transaction is retryable. |

## State contract

| State | Trigger | Visible regions | Primary actions | Recovery / next state | Product source | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `entry` | No valid public ticket | Admission shell and public limits | Start public session | `waiting` or admitted terminal | Public pilot policy | Turnstile mock is fixture-only. |
| `waiting` | Verified ticket has no assigned seat | Queue readout and assignment track | Keep tab open; cancel ticket | `running` or `entry` | Queue policy | Ticket TTL is visible. |
| `running` | Worker attached and first research active | Terminal, live beacon, pending evidence | Continue/monitor research | `result`; research failure in production | Research lifecycle | Signup is absent. |
| `result` | First complete brief settles | Completed terminal, evidence, claim chip | Keep in my workspace | `claim`; terminal remains usable | Value-triggered conversion | Tab reaches evidence then claim action. |
| `claim` | Claim chip selected | Dimmed terminal and result-capsule cartridge | Create workspace | `claiming`; terminal remains usable | Claim model | Not now returns to the result; no auth claim exists yet. |
| `claiming` | Workspace creation selected | Claim creation progress | Wait; cancel | `auth` or `result` | Advisor revision | The 30-minute claim TTL has not started. |
| `auth` | Gateway confirms opaque claim issuance | Claim TTL, capsule status, account path | Continue to secure sign-in; cancel | `importing`, `cancelled`, or `expired` | Same-tab auth model | Claim TTL begins at issuance. |
| `importing` | OAuth return nonce is verified and claim consumed | Private backdrop and atomic import progress | Wait; hide progress | `private` or `error` | Import model | Retry is idempotent and cannot duplicate the new-account grant. |
| `ended` | Idle/absolute/run limit releases worker | Muted snapshot and result-capsule countdown | Create workspace; request new public session; dismiss | `claiming` or `entry` | Public timeout policy | Result-capsule retention after worker destruction is a production dependency; signup is never the only exit. |
| `cancelled` | OAuth provider returns cancellation | Unconsumed auth claim and available capsule | Retry sign-in; return to terminal | `auth` or `result` | Required recovery | Cancellation does not imply claim consumption. |
| `expired` | Auth claim reaches its TTL | Expired claim and still-valid capsule | Issue new claim; return to terminal | `claiming` or `result` | Required recovery | Reissue is allowed only while capsule TTL remains. |
| `unavailable` | Result capsule reaches its retention deadline | Frozen snapshot and deleted-capsule explanation | Start new public session | `entry` | Required recovery | Browser snapshot is not represented as a recoverable server artifact. |
| `private` | Auth and result import succeed | Private-ready receipt | Open my terminal | `workspace` | Private workspace promise | New accounts show USD 1.00; existing accounts retain authoritative ledger balance. |
| `workspace` | Ready receipt dismissed | Saved private terminal | Continue research | Private product states | Private workspace promise | Fixture shows imported AAPL context. |
| `error` | Workspace exists but atomic import pauses after claim consumption | Error cartridge and retryable import transaction | Retry import; open empty workspace | `importing`, `workspace`, or support | Required recovery | Do not describe the consumed auth claim as still valid. |

## Traceability

| Requirement | UI evidence |
| --- | --- |
| Public terminal remains usable without signup | Entry says no account; claim cartridge has `NOT NOW`; result stays visible. |
| Signup appears only after value | Claim action exists in `result`, not `entry`, `waiting`, or `running`. |
| Claim action is status chrome | `conversion-claim-chip` is rendered beside evidence, outside `TerminalFrame`. |
| Preserve brief, evidence, watchlist, context | Transfer manifest and private receipt enumerate those objects. |
| New-account-only USD 1.00 starter balance | Pre-auth rack says `NEW-ACCOUNT`; new ready receipt shows USD 1.00; `account=existing` shows the fixture ledger balance instead. |
| Show actual usage only after completion | Balance copy explicitly says actual measured cost appears after completed research. |
| Persistent state with sleeping compute | Private receipt and terminal footer state `SLEEPS WHEN IDLE`. |
| Separate result-capsule and auth-claim clocks | Offer/ended states describe capsule retention; the 30-minute claim clock appears only after issuance in `auth`. |
| Complete-result-only eligibility | Claim action exists only on the completed fixture; contracts exclude stable partial results. |
| Recover from auth, retention, and import failures | Dedicated `cancelled`, `expired`, `unavailable`, `ended`, and `error` cartridges expose object-specific recovery. |

## Accessibility and interaction contract

- Every conversion control is a native button.
- Claim cartridge uses `role="dialog"`, `aria-modal="true"`, a labeled heading, and an associated description.
- Opening a cartridge moves focus to its heading; focus is contained inside the modal until dismissal.
- `Escape`, backdrop selection, and the close action dismiss every cartridge; ended and private states resolve to safe non-signup destinations.
- Dismissing a cartridge back to the public result restores focus to `KEEP THIS IN MY WORKSPACE →`.
- Blue, green, amber, and red never carry status alone; each state has explicit text.
- Focus indicators use a 2px high-contrast blue outline.
- Reduced-motion preferences disable cartridge and pulsing animations.

## Open questions for production

1. Which service stores a result capsule, when is durability acknowledged, and what exact live/post-session retention policy applies?
2. Which OAuth providers are offered, and what happens when the identity already owns a workspace?
3. Is the USD 1.00 grant promotional credit with an expiry, and where are terms disclosed?
4. Is a payment method required at any point? Until policy is confirmed, the CTA remains `CREATE WORKSPACE`, not `CREATE FREE WORKSPACE`.
5. What usage record is authoritative for completed, failed, and cancelled run costs and reconciliation?
6. Partial-result claiming remains out of scope and requires a separate product decision before eligibility expands.
