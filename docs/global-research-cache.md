# Global Research Cache

One private background runner polls public event feeds and (later) publishes
reusable research. Any approved signed-in browser session can read eligible
entries by exact identity without spending a model call. Account archives stay
private and are never merged into global state.

## State ownership

- **Global scout journal** (`<GLOBAL_CACHE_DIR>/market-event-scout.json`):
  feed baselines, observations, decisions, dry-run candidates. Only the
  lease holder polls, with heartbeat renewal while polling. Each poll runs
  against an isolated temp copy and commits through one indivisible store
  operation (lease check + stale-base detection + file replacement inside a
  single transaction); a fenced-out or superseded leader discards its temp
  copy, so it can neither publish nor replace a newer journal with a stale
  snapshot. Cache publication itself stays transactionally fenced on the
  lease token.
- **Global research cache** (`<GLOBAL_CACHE_DIR>/global-research-cache.sqlite`):
  published entries keyed by exact canonical identity
  (`symbol + chartScope + researchKey + intent`); prompt/policy versions are
  pinned by equality and the TTL ceiling at validation. Only the background
  runner writes.
- **Account archives** (`/data/browser-sessions/<principal>/...`): private per
  account. Global entries are read-only to browsers and never written back.

## What's implemented in this slice

- Runtime-neutral contract (`shared/global-research-cache.ts`): canonical
  brief identities only, versioned prompt/policy, TTL capped by trigger
  validity (ticker 2h, macro/story 4h, 4h storage ceiling), publishable
  canvas projection (allowlisted block/packet keys, URLs bound to fetched
  evidence domains, every block cited, at least one read block, canvas
  identity bound to entry identity), and the `buildGlobalCacheEntry`
  constructor that future publication code must use. The sanitizer rejects
  rather than strips: the publisher must deliberately construct a
  publishable canvas (no research IDs, blocker notes, uncited prose, or
  off-evidence URLs) or the entry misses instead of publishing.
- Fenced SQLite store (`server/global-cache-store.ts`): single-writer lease
  with renewal/observation, fencing tokens, idempotent publication, no
  stale overwrites, deterministic last-writer-wins on equal-timestamp
  conflicts. Browser and runner default to the same database
  (`<MARKET_DATA_DIR>/global-cache/global-research-cache.sqlite`); deploy
  both against the same volume path or set explicit paths.
- Read-only endpoint (`GET /api/browser/v1/global-cache`): authenticated
  exact-identity lookup. Misses (stale, corrupt, incompatible, absent) are
  404s so callers fall back to live research. Responses cross the
  publishable canvas projection (per-kind key allowlists, URLs bound to
  fetched evidence domains, every item cited, at least one read block, no
  free-form text blocks or content prose, no research IDs / blocker notes /
  failure details) and carry no trigger/job IDs, usage, or account data.
  The `globalCache` session feature advertises the endpoint's presence, not
  a warm cache.
- Shadow runner (`server/global-cache-runner*.ts`, `Dockerfile.global-cache-runner`,
  `.github/workflows/publish-global-cache-runner.yml`):
  lease-guarded `MarketEventScout` polling with model dispatch off, heartbeat
  renewal, and temp-copy journal commits. No ingress, no browser session, no
  Pi imports in `server/browser-terminal.ts`. Renewal failures are silent by
  design (the post-run fencing check is authoritative); a lost lease stops
  the poll's effects but not the scout's in-temp work, which is discarded.

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
| `GLOBAL_CACHE_DIR` | `<MARKET_DATA_DIR>/global-cache` | Must be absolute; honored by both the runner and the browser default path, sharing one volume. |
| `GLOBAL_CACHE_RUNNER_OWNER` | `global-cache-runner` | Lease owner identity. |
| `GLOBAL_CACHE_RUNNER_INTERVAL_MS` | `60000` | Poll cadence, 30s–10min. |
| `UNBROWSER_MCP_URL` | required when enabled | Private MCP endpoint for feed reads. |

Kill switches: unset `GLOBAL_CACHE_RUNNER_ENABLED` (runner exits 0);
endpoint misses are fail-closed to live research. A missing/unopenable store
surfaces as 500 (not a silent miss); the deferred consumer must treat
transport errors as misses and fall back to live research. There is
intentionally no flag that lets browsers write global state.

## Deploy prep (infra follow-up)

1. Merge this PR; publish both images from the merged revision:
   `browser-terminal-v*` via `publish-browser-terminal.yml`,
   `global-cache-v*` via `publish-global-cache-runner.yml`.
2. In `unchained-infra`, add a `fin-terminal-global-cache` service from the
   runner image digest with `GLOBAL_CACHE_RUNNER_ENABLED=0`, sharing one
   volume mounted at the browser's `<MARKET_DATA_DIR>/global-cache` path.
3. Commission with dispatch off: all seven feeds attempted, >=4 successes
   across >=3 hosts, persisted scheduler advancement, zero model calls.
4. Only then consider the dispatch/publication follow-up; do not enable the
   runner in production before the shared volume and MCP wiring are verified.
