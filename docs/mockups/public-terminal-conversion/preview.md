# Preview and Verification Record

Preview route:

```text
/public-conversion-preview.html?state=result
```

When running with the public-live base path:

```text
/fin-terminal-live-pilot/public-conversion-preview.html?state=result
```

Use `state=entry|waiting|running|result|claim|claiming|auth|importing|ended|private|workspace|cancelled|expired|unavailable|error`. Append `&clean=1` for screenshots without preview controls. Set `account=existing` to review the existing-account ledger path.

## Browser review checklist

- [x] Entry is a bounded operational admission screen, not a signup landing page.
- [x] Running state has no workspace claim action.
- [x] Completed result remains unobstructed until the user opens claim.
- [x] Claim action is adjacent to evidence in status chrome.
- [x] Claim cartridge keeps the result visible beneath it.
- [x] Transfer manifest names the preserved objects.
- [x] USD 1.00 copy is explicitly new-account-only; existing-account mode retains its fixture ledger balance.
- [x] Offer state describes result-capsule retention and does not show a not-yet-issued claim TTL.
- [x] Claim creation says the 30-minute auth clock has not started.
- [x] Auth state starts and displays the one-time claim TTL only after issuance.
- [x] Import state shows claim consumption and an idempotent atomic import transaction.
- [x] Session-end state explains worker release and remaining result-capsule window.
- [x] Session-end conversion is dismissible and offers a fresh public session.
- [x] Cancelled auth, expired claim, and unavailable capsule states have object-specific recovery paths.
- [x] Private-ready state confirms import, persistence, balance, and sleeping compute.
- [x] Error state identifies completed steps, retryability, and fallback.
- [x] Buttons and focused dialog headings have visible focus states; modal focus is contained and Escape dismisses.
- [x] Reduced-motion media query disables preview animation.

## Verification results

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; 45 modules transformed |
| `npm test` | Passed; 218 / 218 tests |
| Mockup package checker with `--implementation` | Passed |
| Browser route load | Passed under `/fin-terminal-live-pilot/` base path |
| Modal initial focus | Passed; labeled `h2` receives focus |
| Modal focus containment | Passed; Shift+Tab from heading wraps to last action and Tab wraps back to close |
| Claim-trigger focus restoration | Passed; close returns focus to `KEEP THIS IN MY WORKSPACE →` |
| Escape dismissal | Passed; ended state returns to public entry rather than forcing signup |
| Screenshot dimensions via `sips` | Passed; exact target sizes confirmed |

## Screenshots

1440x900:

- `screenshots/entry-1440x900.png`
- `screenshots/result-1440x900.png`
- `screenshots/claim-1440x900.png`
- `screenshots/claiming-1440x900.png`
- `screenshots/auth-1440x900.png`

1280x800:

- `screenshots/importing-1280x800.png`
- `screenshots/ended-1280x800.png`
- `screenshots/expired-1280x800.png`
- `screenshots/unavailable-1280x800.png`
- `screenshots/private-1280x800.png`
- `screenshots/private-existing-1280x800.png`
- `screenshots/error-1280x800.png`

## UI/UX review disposition

The specialist review passed the visual direction and implementation-handoff quality. Its valid high-severity findings were resolved in the preview:

- Added modal focus containment and verified wrap behavior.
- Restored a visible focused-heading outline while retaining native button focus rings.
- Increased legal/status microcopy contrast and size.
- Removed the session-ended signup dead end with close, Escape, backdrop dismissal, and `NEW PUBLIC SESSION`.
- Added safe dismissal from the private-ready receipt.
- Associated each dialog title with explanatory copy through `aria-describedby`.

An advisor second-opinion review then identified lifecycle-semantic gaps. The revision pass resolved them in the preview and contracts:

- Separated durable result-capsule retention from the auth claim's 30-minute post-issuance TTL.
- Added claim creation, auth handoff, OAuth cancellation, auth-claim expiry, import progress, and capsule-unavailable states.
- Restricted eligibility to complete results.
- Made USD 1.00 new-account-only and added an existing-account ledger variant.
- Renamed the anonymous environment from workspace to public session.
- Implemented and browser-verified return focus to the status-strip claim trigger.

Remaining production work is architectural: durable result capsules, OAuth return binding, account-scoped workspaces, atomic import, USD ledger, actual-cost reconciliation policy, and worker wake/sleep behavior.
