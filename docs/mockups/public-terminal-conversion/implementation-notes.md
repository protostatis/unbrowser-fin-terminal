# Implementation Notes

## Preview boundary

The preview is intentionally separated from `web/src/main.tsx`:

- `web/public-conversion-preview.html` is a Vite development entry.
- `web/src/public-conversion-preview-main.tsx` mounts only preview code.
- `PublicConversionPreview.tsx` imports `TerminalFrame` but does not import `PublicLiveApp`, socket, admission, auth, billing, or gateway modules.
- `public-conversion-preview.css` is scoped below `.conversion-preview` and does not load in the production entry.

The normal Vite production entry remains `web/index.html`; preview-only code is typechecked but is not wired into production route selection.

## Recommended production components

### `WorkspaceClaimControl`

```ts
type WorkspaceClaimControlProps = {
  eligibility: "none" | "complete";
  disabled?: boolean;
  compact?: boolean;
  onOpen: () => void;
};
```

- Render after `EvidenceControl` in the status line.
- Show only for a complete dossier authorized by the server. Partial-result eligibility is out of scope.
- Use `KEEP THIS IN MY WORKSPACE →`; shorten to `KEEP RESULT →` only at narrow desktop widths.

### `WorkspaceClaimCartridge`

```ts
type WorkspaceClaimCartridgeProps = {
  state:
    | "offer"
    | "creating-claim"
    | "auth-issued"
    | "auth-cancelled"
    | "auth-expired"
    | "auth-return"
    | "importing"
    | "capsule-unavailable"
    | "ready"
    | "error";
  artifact: ClaimableArtifactSummary;
  starterBalance?: Money;
  capsuleExpiresAt?: number;
  claimExpiresAt?: number;
  error?: ClaimImportError;
  onCreate: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  onOpenWorkspace: () => void;
};
```

- Reuse evidence overlay/cartridge focus and keyboard conventions.
- Keep the preview's focus trap and restore focus to `WorkspaceClaimControl` on close.
- Keep the completed terminal mounted beneath the overlay.
- Never claim that a result is safe unless the gateway has acknowledged durable capsule creation.
- Never show `claimExpiresAt` before claim issuance; the result-capsule and auth-claim clocks are distinct.

### Typed server data

```ts
type ClaimableArtifactSummary = {
  capsuleId: string;
  symbol: string;
  title: string;
  stage: "complete";
  blockCount: number;
  evidencePacketCount: number;
  includesWatchlist: boolean;
  includesContext: boolean;
  capsuleExpiresAt?: number;
};

type AuthenticationClaimSummary = {
  claimId: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt?: number;
};

type Money = {
  currency: "USD";
  minorUnits: number;
};
```

Do not scrape counts or state from rendered terminal rows.

## Event and state flow

1. Research settles with a complete dossier.
2. Gateway durably stores the approved result capsule: brief, evidence allowed by source policy, watchlist, and context.
3. Gateway/worker frame includes server-authorized `claimEligibility: "complete"`, capsule identity, and capsule retention.
4. `WorkspaceClaimControl` becomes available in status chrome.
5. Selecting it opens the offer cartridge; no authentication claim exists and no claim TTL is shown.
6. `Create workspace` requests an opaque, single-use server-side authentication claim.
7. After issuance, the 30-minute claim TTL starts and the browser may begin same-tab OAuth with only the opaque claim reference and return nonce.
8. OAuth cancellation leaves the unconsumed claim retryable until expiry. Claim expiry permits reissue only while the result capsule still exists.
9. Auth return provisions or finds the account workspace, atomically consumes the claim, and begins an idempotent import transaction.
10. Ready receipt reads imported state and the authoritative ledger balance from durable account services. Only eligible new accounts receive the USD 1.00 grant.
11. Worker compute starts only when the user opens or acts in the private terminal and sleeps after idle policy.

## Recommended file-level production changes

- Modify `web/src/main.tsx` to render `WorkspaceClaimControl` after `EvidenceControl` and own cartridge open/close state.
- Extend frame/API types in `web/src/socket.ts` with a typed claim-eligibility summary; never include opaque auth credentials in terminal HTML.
- Modify `web/src/PublicLiveApp.tsx` so ended sessions render recovery only when a durable claimable capsule exists.
- Add `web/src/WorkspaceClaimControl.tsx`.
- Add `web/src/WorkspaceClaimCartridge.tsx` and focused component tests.
- Add gateway endpoints for result-capsule status, auth-claim creation/status, atomic consumption, cancellation/expiry, and capsule deletion.
- Add an authenticated account/workspace control plane with USD ledger and worker wake/sleep ownership. This is larger than a frontend extraction.

## Security and privacy constraints

- Claim IDs are opaque, high-entropy, short-lived, single-use, and bound to the initiating browser/session plus OAuth return nonce.
- Capsule IDs are not auth credentials. They have an independent retention policy and must not be accepted as bearer authorization.
- Store no visitor token, public ticket token, worker proxy token, credential, browser cookie, or pending worker process in the private workspace artifact.
- Consume/import claims atomically and make retries idempotent.
- Authorize source/evidence persistence according to retrieval and content policy.
- Never put balances or actual cost under browser authority.
- Log stable support IDs, not claim bearer tokens.

## Billing behavior

- Grant USD 1.00 only to eligible new accounts in the durable account ledger after account/workspace provisioning policy succeeds.
- Existing accounts retain and display their authoritative ledger balance; signing in must never overwrite it with the starter amount.
- UI formats ledger minor units; it does not calculate grant eligibility.
- For a completed research run, the backend posts measured provider/tool usage, then the UI displays actual cost.
- Internal reservation or safety ceilings remain backend-only and are not described as a user charge.

## Session-end behavior

The preview assumes a completed-result capsule can survive worker destruction. Production must choose one explicit design:

1. Preferred: gateway receives and durably snapshots the approved result when research settles, then releases worker independently.
2. Alternative: gateway creates the snapshot during the two-minute ending window and clearly reports whether preservation succeeded.

Do not render the preview's session-end transfer countdown until this contract exists.

The result-capsule retention deadline and 30-minute authentication-claim deadline remain independent even if policy initially assigns similar durations.

## Instrumentation events

- `workspace_claim_eligible` — complete result becomes claimable.
- `workspace_claim_impression` — claim control is shown.
- `workspace_claim_opened` / `workspace_claim_dismissed`.
- `workspace_auth_claim_requested` / `issued` / `failed` / `expired`.
- `workspace_auth_started` / `cancelled` / `returned`.
- `workspace_import_started` / `succeeded` / `retrying` / `failed`.
- `workspace_capsule_expired`.

Events carry stable non-secret IDs and account-path category; never log bearer claim values.

## Tests

- Component: claim trigger absent for no result and failed first run.
- Component: claim trigger present for complete results and absent for partial results.
- Keyboard: evidence precedes claim; open moves focus; Escape and close restore focus.
- API: result-capsule expiry and auth-claim expiry are independent.
- API: claim is opaque, expires 30 minutes after issuance, is single-use, and is bound to OAuth return state.
- API: OAuth cancellation does not consume the claim; expired claims can be reissued only for a live capsule.
- API: import retries are idempotent; concurrent consumption cannot duplicate artifacts or grants.
- Integration: public worker can be destroyed before OAuth return without losing an acknowledged capsule.
- Ledger: grant is applied once to eligible new accounts; existing balances are unchanged; failed import does not duplicate grant or usage entries.
- Cost: completed, failed, and cancelled runs follow explicit measured-cost and reconciliation policy.
- Visual: entry, result, claim, claim creation, auth, importing, ended, expired, unavailable, private, and error at review desktop sizes.
- Accessibility: native controls, visible focus, labeled dialog, status text beyond color, reduced motion.

## Preview-to-production cleanup

- Do not import `PublicConversionPreview` from `main.tsx`.
- Do not copy state selector, literal countdowns, capsule IDs, AAPL rows, or direct `onChange` transitions.
- Extract only approved visual/component behavior after server contracts are defined.
- Delete the separate HTML entry and fixture CSS when implementation and regression screenshots supersede the handoff, or keep them under an explicit nonproduction preview convention.
