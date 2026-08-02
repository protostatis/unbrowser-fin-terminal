# Public Terminal Conversion — Structure Stage

Status: **structure-confirmed**

Output mode: **project-native-preview**

## Source inputs

- Confirmed conversation design: value-triggered workspace claim.
- Existing UI: `web/src/PublicLiveApp.tsx`, `web/src/ReplayApp.tsx`, and `web/src/styles.css`.
- Product decisions:
  - Public demo remains usable without an account.
  - Claim action appears in the status strip after a successful result.
  - Signup creates an account-scoped workspace whose state persists while compute sleeps.
  - New accounts receive a USD 1.00 starter balance.
  - Research shows actual measured cost after completion, not an estimate before launch.

## Screen inventory

1. Public entry / human verification.
2. Waiting room / worker assignment.
3. Active public terminal before a successful result.
4. Active public terminal with a completed brief and claim action.
5. Workspace claim cartridge.
6. One-time claim creation and same-tab authentication handoff.
7. Authentication return / atomic workspace import.
8. Public session complete / result-capsule recovery cartridge.
9. Authentication cancelled, claim expired, and capsule unavailable recovery.
10. Private workspace ready after authentication and claim import.
11. Private terminal after the ready receipt is dismissed.
12. Import transaction failure.

## State model

| State | Trigger | Persistent regions | State-specific region | Primary action | Next/recovery |
| --- | --- | --- | --- | --- | --- |
| `entry` | No public ticket | Admission shell | Turnstile and public-session contract | Start public session | `queued` or `active-public` |
| `queued` | Verified visitor has no seat | Admission shell | Queue position, ticket TTL | Keep page open | `active-public` |
| `active-public` | Worker attached | Terminal frame, status strip | Public run/time limits | Use terminal | `result-claimable` |
| `result-claimable` | First complete result | Terminal frame, research/evidence chrome | Status-strip claim action | Keep result in workspace | `claim-open` |
| `claim-open` | Visitor selects claim action | Completed terminal visible beneath overlay | Transfer manifest and conditional new-account grant | Create workspace | `claim-creating` |
| `claim-creating` | Visitor requests workspace creation | Completed terminal visible beneath overlay | Result-capsule acknowledgement and claim creation progress | Wait or cancel | `auth-handoff` / `result-claimable` |
| `auth-handoff` | Opaque one-time claim is issued | Completed terminal visible beneath overlay | Claim TTL, account path, same-tab sign-in action | Continue to secure sign-in | `importing` / `auth-cancelled` / `claim-expired` |
| `importing` | OAuth return is verified | Private terminal backdrop | Atomic import progress and consumed-claim state | Wait; hide progress | `private-ready` / `import-error` |
| `session-ending` | Two minutes remain | Terminal frame | Urgent but nonblocking save action | Save workspace | `claim-open` |
| `session-ended` | Idle, absolute, or run limit ends session | Terminal backdrop | Durable result-capsule countdown | Create workspace or start new session | `claim-creating` / `entry` |
| `auth-cancelled` | OAuth is cancelled before return | Completed terminal backdrop | Unconsumed claim and capsule status | Retry sign-in or return | `auth-handoff` / `result-claimable` |
| `claim-expired` | One-time auth claim TTL elapses | Completed terminal backdrop | Expired claim and still-valid capsule status | Issue new claim or return | `claim-creating` / `result-claimable` |
| `capsule-unavailable` | Result-capsule retention expires | Frozen terminal snapshot | Deleted-capsule explanation | Start new public session | `entry` |
| `private-ready` | Auth succeeds and claim imports | Private terminal shell | Imported-result receipt and balance | Open terminal | Private active terminal |
| `private-active` | User opens the provisioned workspace | Private terminal shell, saved status strip | Persistent balance and sleeping-compute status | Continue research | Private terminal states |
| `import-error` | Atomic capsule import pauses after auth | Private terminal backdrop | Consumed claim, retryable import transaction | Retry or open empty workspace | `importing` / `private-active` |

## Lifecycle clock contract

| Object | Created | Lifetime shown to user | Expiry effect |
| --- | --- | --- | --- |
| Result capsule | Gateway durably acknowledges a completed brief | While the public session is live; after worker release, explicit remaining retention such as `28:14` | Server-side transferable artifact is deleted; a frozen browser snapshot may remain visible. |
| Authentication claim | After `Create workspace`, before same-tab authentication | 30 minutes from successful issuance | Claim is deleted; issue a new claim only if the result capsule still exists. |
| Import transaction | OAuth return is verified and the claim is atomically consumed | Retry window controlled by the workspace service | Retry idempotently; never consume the claim or grant starter balance twice. |

## Desktop layout — public entry

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ faint terminal grid / relay coordinates                                     │
│                                                                              │
│                   ┌──────────────────────────────────┐                       │
│                   │ SIGNAL // LIVE MARKET TERMINAL   │                       │
│                   │                                  │                       │
│                   │ Open a live market terminal.     │                       │
│                   │ Live sourced briefs in an        │                       │
│                   │ isolated 15-minute session.      │                       │
│                   │                                  │                       │
│                   │ 15 MIN     5 RUNS     NO ACCOUNT │                       │
│                   │                                  │                       │
│                   │ [ HUMAN VERIFICATION ]           │                       │
│                   │ [ START PUBLIC SESSION ]         │                       │
│                   │                                  │                       │
│                   │ Have a workspace? SIGN IN →      │                       │
│                   └──────────────────────────────────┘                       │
│                                                                              │
│ NOT FINANCIAL ADVICE · PUBLIC/DELAYED · UNSAVED PUBLIC DATA IS DISCARDED     │
└──────────────────────────────────────────────────────────────────────────────┘
```

The page does not scroll. The card is vertically centered, with a fixed disclaimer at the viewport edge.

## Desktop layout — result is claimable

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ LIVE TERMINAL FRAME                                                          │
│                                                                              │
│ DISCOVERY CANVAS · AAPL · BRIEF · DAY                                       │
│ AAPL earnings-drop re-rating                                                 │
│ COMPLETE · 12 BLOCKS · 9 SOURCES · EVIDENCE AVAILABLE                       │
│ ...                                                                          │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ ● CONNECTED  BRIEF COMPLETE · EVIDENCE 4/4      [ KEEP IN MY WORKSPACE → ]   │
├──────────────────────────────────────────────────────────────────────────────┤
│ PUBLIC SESSION · 4 RUNS · 11:42 LEFT                                         │
└──────────────────────────────────────────────────────────────────────────────┘
```

The claim control belongs to status chrome, not the terminal row grid. It remains reachable by keyboard and pointer without covering the result.

## Desktop layout — claim cartridge

```text
┌──────────────────────────────── terminal backdrop ───────────────────────────┐
│                                                                              │
│       ┌──────────────────────────────────────────────────────────────┐       │
│       │ SIGNAL // PRIVATE WORKSPACE                         [X] CLOSE │       │
│       ├──────────────────────────────────────────────────────────────┤       │
│       │ KEEP THIS BRIEF. MAKE THE TERMINAL YOURS.                    │       │
│       │                                                              │       │
│       │ ✓ AAPL brief + 4 evidence packets                            │       │
│       │ ✓ Watchlist and research history                             │       │
│       │ ✓ State preserved while compute sleeps                       │       │
│       │                                                              │       │
│       │ NEW-ACCOUNT STARTER BALANCE                                   │       │
│       │ $1.00  / existing accounts retain their ledger balance       │       │
│       │                                                              │       │
│       │ [ CREATE WORKSPACE ]       [ NOT NOW ]                       │       │
│       │ Already have an account? SIGN IN                             │       │
│       ├──────────────────────────────────────────────────────────────┤       │
│       │ RESULT CAPSULE · AVAILABLE WHILE SESSION IS LIVE   ESC CLOSE │       │
│       └──────────────────────────────────────────────────────────────┘       │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

The terminal remains visible and dimmed beneath the cartridge so the signup promise stays attached to the result.

## Desktop layout — claim creation and auth handoff

```text
┌──────────────────────────────── terminal backdrop ───────────────────────────┐
│       ┌──────────────────────────────────────────────────────────────┐       │
│       │ CREATING A ONE-TIME SIGN-IN CLAIM                           │       │
│       │ ✓ RESULT CAPSULE   ● CREATE AUTH CLAIM   · OPEN SIGN-IN      │       │
│       │ CLAIM TTL NOT STARTED                              [ CANCEL ] │       │
│       └──────────────────────────────────────────────────────────────┘       │
│                                   ↓ automatic                               │
│       ┌──────────────────────────────────────────────────────────────┐       │
│       │ AUTH CLAIM ISSUED · SINGLE USE · 29:58                      │       │
│       │ RESULT CAPSULE  AVAILABLE       ACCOUNT PATH  NEW/EXISTING   │       │
│       │ [ CONTINUE TO SECURE SIGN-IN ]             [ CANCEL ]       │       │
│       └──────────────────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────────────────┘
```

The result-capsule clock and authentication-claim clock are separate. No claim TTL is shown before the gateway confirms issuance.

## Desktop layout — auth return and import

```text
┌──────────────────────────────── private backdrop ────────────────────────────┐
│       ┌──────────────────────────────────────────────────────────────┐       │
│       │ AUTH RETURN VERIFIED · CLAIM CONSUMED                       │       │
│       │ ✓ IDENTITY VERIFIED                                         │       │
│       │ ✓ WORKSPACE PROVISIONED / EXISTING WORKSPACE FOUND          │       │
│       │ ● ATTACH AAPL CAPSULE                                       │       │
│       │ · CONFIRM LEDGER + SLEEP POLICY                             │       │
│       │ IMPORT CONTINUES AUTOMATICALLY · SAFE TO HIDE               │       │
│       └──────────────────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Desktop layout — private workspace ready

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ PRIVATE TERMINAL BACKDROP                                                    │
│                                                                              │
│       ┌──────────────────────────────────────────────────────────────┐       │
│       │ SIGNAL // PRIVATE WORKSPACE                                  │       │
│       ├──────────────────────────────────────────────────────────────┤       │
│       │ PRIVATE WORKSPACE READY                                      │       │
│       │                                                              │       │
│       │ AAPL BRIEF IMPORTED          4 EVIDENCE PACKETS              │       │
│       │ WATCHLIST RESTORED            STATE SAVED                     │       │
│       │                                                              │       │
│       │ LEDGER              $1.00 NEW / AUTHORITATIVE EXISTING       │       │
│       │ COMPUTE                       SLEEPS WHEN IDLE                │       │
│       │                                                              │       │
│       │ [ OPEN MY TERMINAL ]                                         │       │
│       └──────────────────────────────────────────────────────────────┘       │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ PRIVATE · SAVED · AUTHORITATIVE LEDGER BALANCE                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Narrow desktop behavior — 1280×800

- Preserve the full terminal backdrop.
- Cartridges use `min(620px, calc(100vw - 32px))`.
- Metadata wraps to two rows; primary CTA remains full width.
- Status-strip claim copy may shorten to `KEEP RESULT →`.
- No horizontal document scrolling; only cartridge body or terminal canvas may scroll.

## Interaction notes

- `Tab` reaches the claim action after the evidence control.
- Selecting the action opens the claim cartridge and moves focus to its heading/close control.
- `Escape` closes the cartridge and restores focus to the status-strip action.
- `Create workspace` first requests an opaque server-side claim. Its 30-minute TTL starts only after issuance, then same-tab authentication begins.
- `Not now` never consumes or invalidates the claimable public result.
- A failed first research run exposes retry, not signup.
- Only complete results are claimable. Partial-result eligibility is explicitly out of scope until separately approved.
- Closing claim/recovery cartridges restores focus to the status-strip claim action when the public result remains usable.

## Region ownership

- Terminal extension: terminal rows, research canvas, quote and navigation state.
- Web app shell: connection state, evidence control, claim control, cartridges.
- Public gateway: anonymous ticket, durable result-capsule retention, and one-time auth-claim authorization.
- Account/workspace control plane: authentication, USD ledger, state import, worker wake/sleep.

## Structure review

Result: **confirmed with advisor revisions incorporated**. The user selected value-triggered, status-strip conversion; complete-result-only eligibility; separate result-capsule and auth-claim lifetimes; a persistent workspace that sleeps while idle; a new-account-only USD 1.00 starter balance; and actual-cost-only user-facing metering.
