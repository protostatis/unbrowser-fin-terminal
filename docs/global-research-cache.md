# Global Research Cache

One private background runner polls public event feeds and (later) publishes
reusable research. Any approved signed-in browser session can read eligible
entries by exact identity without spending a model call. Account archives stay
private and are never merged into global state.

## State ownership

- **Global scout journal** (`<GLOBAL_CACHE_DIR>/market-event-scout.json`):
  feed baselines, observations, decisions, dry-run candidates. Exactly one
  writer holds the SQLite lease at a time.
- **Global research cache** (`<GLOBAL_CACHE_DIR>/global-research-cache.sqlite`):
  published entries keyed by exact canonical identity
  (`symbol + chartScope + researchKey + intent` + prompt/policy version).
  Only the background runner writes.
- **Account archives** (`/data/browser-sessions/<principal>/...`): private per
  account. Global entries are read-only to browsers and never written back.

## What's implemented in this slice

- Runtime-neutral contract (`shared/global-research-cache.ts`): canonical
  brief identities only, versioned prompt/policy, TTL capped by trigger
  validity (ticker 2h, macro/story 4h), public-https evidence gate,
  expiry-aware reads.
- Fenced SQLite store (`server/global-cache-store.ts`): single-writer lease,
  fencing tokens, idempotent publication, no stale overwrites.
- Read-only endpoint (`GET /api/browser/v1/global-cache`): authenticated
  exact-identity lookup. Misses (stale, corrupt, incompatible, absent) are
  404s so callers fall back to live research. Responses carry no trigger/job
  IDs, usage, or account data.
- Shadow runner (`server/global-cache-runner*.ts`, `Dockerfile.global-cache-runner`):
  lease-guarded `MarketEventScout` polling with model dispatch off. No
  ingress, no browser session, no Pi imports in `server/browser-terminal.ts`.

## Explicitly deferred

- Guarded model dispatch and cache publication (pinned free model, 1/poll,
  4/day, per-run token/time bounds, dedicated credentials).
- Extension/browser consumption: surfacing global hits in the terminal flow
  (prefetch at sign-in or research-start lookup). The `fetchGlobalCacheEntry`
  helper (`web/src/harness/global-cache.ts`) is the seam.
- Infra rollout (Compose service, image pins, commissioning workflow).

## Rollout

1. **Shadow, dispatch off**: all seven feeds attempted; require >=4 successes
   across >=3 hosts plus persisted scheduler advancement. Zero model calls,
   zero cache writes.
2. **One bounded dispatch** (follow-up): success means a usable result is
   published, not merely enqueued. Verify pinned model, quality gates, cache
   commit, and restart idempotency.
3. **Two-account sharing**: same digest for two approved accounts, zero
   model/MCP calls on hits, no account-private leakage.
4. **Limited cohort**: independent kill switches for polling, dispatch,
   publication, and consumption.

## Configuration

| Env | Default | Notes |
|---|---|---|
| `GLOBAL_CACHE_RUNNER_ENABLED` | `0` | `1` enables the private runner. |
| `GLOBAL_CACHE_DIR` | `/data/global-cache` | Must be absolute; exclusive single-writer volume. |
| `GLOBAL_CACHE_RUNNER_OWNER` | `global-cache-runner` | Lease owner identity. |
| `GLOBAL_CACHE_RUNNER_INTERVAL_MS` | `60000` | Poll cadence, 30s–10min. |
| `UNBROWSER_MCP_URL` | required when enabled | Private MCP endpoint for feed reads. |

Kill switches: unset `GLOBAL_CACHE_RUNNER_ENABLED` (runner exits 0);
endpoint misses are fail-closed to live research. There is intentionally no
flag that lets browsers write global state.
