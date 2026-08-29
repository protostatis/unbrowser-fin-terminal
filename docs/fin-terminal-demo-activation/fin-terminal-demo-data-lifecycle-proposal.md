# Proposal — Fin Terminal Pilot Data Lifecycle and Support Access

| Field | Proposal |
| --- | --- |
| Status | Proposed — approval required before Phase 1 implementation |
| Applies to | Phase 1 replay/workspace pilot; Phase 2 rules require separate source-license approval |
| Owner | Fin Terminal product owner with UnchainedSky privacy/security review |
| Principle | Store the least private data needed to restore a user-owned workspace; never turn replay browsing into a hidden research profile. |

## Decision requested

Approve the Phase 1 retention, deletion, export, and support-access defaults below. This proposal deliberately does **not** authorize fresh-source collection, raw third-party source retention, or private child dossiers; those remain Phase 2 decisions governed by source-specific license terms.

## Phase 1 data inventory and default lifecycle

| Data class | Minimum data stored | Why | Default retention | Deletion / access rule |
| --- | --- | --- | --- | --- |
| Pilot entitlement | Stable UnchainedSky user ID, opaque Fin Terminal subject, lifecycle state, capability label, terms version/time, activation source | Authorize the pilot without changing global identity | While entitlement is active; then 30 days after final deletion request | Product access ends immediately on deletion request; purge from primary store within 30 days and backups within 90 days |
| Workspace and membership | Opaque workspace ID, opaque owner subject, creation/update times, membership role `owner` | Enforce private ownership | While workspace is active | Purge on the same timeline as the entitlement; no shared/team membership in Phase 1 |
| Saved parent reference | Public artifact ID/version, save time, workspace ID, user-selected label only if separately approved | Restore the exact approved replay without copying browser history or raw third-party material | While workspace is active | Delete with workspace; do not duplicate raw source pages/excerpts into the private store |
| Follow | Normalized approved ticker identifier, workspace ID, creation time | Reopen user-selected follow list | While workspace is active | Delete with workspace; no alert preferences or inferred interests |
| Pending intent | Opaque intent ID, allowlisted artifact/version/action, bounded follows, safe return route, expiry/claim state | Restore one explicit conversion action through sign-in | Maximum 24 hours; delete on claim or expiry | Never include in a URL or document title; do not retain an unclaimed intent as user history |
| Security and lifecycle audit | Entitlement/workspace/intent event type, opaque subject/workspace IDs, actor type, time, request/case correlation ID | Investigate authorization, deletion, and support actions | 12 months | Keep no dossier body, source excerpt, session token, email, or raw IP address in the audit payload unless a separate security policy requires it |
| Product telemetry | Pseudonymous funnel event, phase, capability state, time, and coarse error category | Measure pilot conversion and zero-work guarantee | Raw event data 30 days; aggregated metrics 13 months | Never include dossier content, source excerpts, user email, query text, session token, or full URL |

## Phase 1 access and deletion policy

1. **Access:** An active owner may read and manage only their own saved parent references and follows. A suspended workspace is read-only. A revoked workspace is inaccessible except through the deletion/support process.
2. **Deletion request:** A verified owner can request account-scoped Fin Terminal deletion. The service immediately revokes new access and marks the workspace as deletion-pending, then completes primary-store erasure within 30 days. Disaster-recovery backups age out within 90 days.
3. **Export:** Before deletion completes, an active owner can request an authenticated structured export of their entitlement metadata, saved parent references, and follows. The export contains no data not stored in the workspace and is available through a short-lived authenticated download for 7 days.
4. **Global account relationship:** Deleting or revoking Fin Terminal data does not change the user’s UnchainedSky account, `user_type`, or access to other products. A global-account deletion or legal erasure event must trigger the Fin Terminal deletion workflow.
5. **Public replay withdrawal:** If an approved public artifact is withdrawn, tombstone its public route and stop serving its content. Private saved references show an explanatory unavailable state rather than retaining a private copy of withdrawn material.

## Support-access policy

- There is **no standing staff ability** to browse private workspace content.
- Default support tooling may inspect only entitlement state, workspace ID, lifecycle timestamps, and aggregated job/feature status — not saved research content.
- A break-glass read requires: an explicit user support request or documented security incident; a case ID; a named operator; a time-bounded approval; and an immutable audit event recording scope, reason, and expiration.
- Break-glass access expires after 24 hours, is limited to the minimum workspace/object scope, and may not expose session tokens, authentication headers, or raw third-party source material.
- Support may correct entitlement state or trigger deletion only through audited administrative actions. It may not silently activate access or create a source-check job.

## Source-content boundary

Phase 1 may serve only public replay artifacts whose content, delayed-data wording, excerpt handling, retention, and withdrawal behavior have been explicitly approved. It must not collect fresh sources or persist raw source pages, source-extraction payloads, model prompts, or model outputs generated from fresh source work.

Before Phase 2, each approved source profile must define:

1. what may be fetched, displayed, excerpted, cached, and retained;
2. whether citations, derived summaries, and source metadata may persist in private child dossiers;
3. its required withdrawal/tombstone response and review interval; and
4. user-visible quota, cooldown, and spend-circuit-breaker behavior.

If a source term conflicts with this proposal, the stricter source term controls and the Phase 2 capability remains off until the discrepancy is resolved.

## Approval checklist

- [ ] Product approves the Phase 1 30-day primary-store / 90-day backup deletion schedule.
- [ ] Privacy/security approves the 12-month audit and 30-day raw telemetry defaults.
- [ ] Product approves saved parent references rather than private copies of public dossier/source content.
- [ ] Support approves the break-glass prerequisites, 24-hour expiry, and audit fields.
- [ ] Legal/source owner approves the initial public replay artifact/source allowlist and withdrawal process.
- [ ] A Phase 2 source-license policy is approved before any fresh source-check flag is enabled.
