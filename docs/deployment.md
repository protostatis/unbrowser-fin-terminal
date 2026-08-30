# Production Deployment

The production terminal is served at
`https://unchainedsky.com/unbrowser/fin-terminal/`. This repository does not
deploy directly from a branch. Releases are pinned to an immutable source commit
in the [`unchained-infra`](https://github.com/protostatis/unchained-infra)
Compose manifest and deployed through that repository's GitHub Actions workflow.

Use the GitHub Actions path for production releases. Do not use the manual SSH
deployment fallback for a normal terminal release.

## Release Process

1. Validate the source revision:

   ```bash
   npm run typecheck
   npm test
   npm run build
   git diff --check
   ```

2. Push the release branch and resolve it to a full immutable commit SHA:

   ```bash
   git push origin feature/signal-dossier
   git ls-remote --exit-code --refs \
     https://github.com/protostatis/unbrowser-fin-terminal.git \
     refs/heads/feature/signal-dossier
   ```

3. In `unchained-infra`, create a release branch from current `main`. Replace
   the authenticated terminal and public-terminal image refs with that exact
   40-character SHA. Never use a mutable branch ref such as
   `#feature/signal-dossier`.

4. Update both matching SHA assertions in `unchained/test_fin_terminal.py`,
   then run the infrastructure checks:

   ```bash
   python deploy/test_fin_terminal_secrets.py
   cd unchained
   python -m unittest test_fin_terminal
   ```

5. Open and merge the infrastructure PR into `unchained-infra` `main`. Its
   `ci.yml` workflow runs the release checks and places the current `main`
   revision at the protected GitHub `production` environment gate.

6. Approve the `deploy-production` GitHub Actions job only after confirming it
   targets the intended current `main` revision. The workflow runs
   `deploy.sh`, which validates the private-core overlay, deploys the Compose
   stack, checks health, and rolls back a failed candidate.

## Deployment Contract

- Build the authenticated live service with
  `PUBLIC_BASE_PATH=/unbrowser/fin-terminal/`. Build the public gateway client
  at `/unbrowser/fin-terminal-demo/` with
  `VITE_TERMINAL_BUILD_MODE=public-live`.
- `PUBLIC_DEMO=0` is explicit for authenticated live and `PUBLIC_DEMO=1` is
  explicit for replay. Public admission instead uses
  `TERMINAL_RUNTIME_MODE=public-gateway` and must not set `PUBLIC_DEMO`.
- The client build and server mode must pair. `public-gateway` requires a
  `public-live` client; replay requires replay; authenticated live requires
  live. The stable demo URL alone no longer determines whether the deployment
  is replay or public-live. A mismatched pair is unsafe and must fail closed.
- The public-live gateway verifies Turnstile, serializes FIFO admission through
  a Redis lease, reserves conservative per-session research budget, and proxies
  each signed opaque ticket to one isolated worker. The browser never reaches a
  worker directly. Active reservations carry across UTC rollover so work that
  starts after midnight cannot consume the next calendar day's budget twice.
- Production requires an exact allowed origin, Redis, session-signing key,
  separate edge-proxy and worker-proxy tokens, Turnstile keys, and a worker
  endpoint list exactly matching the configured seat count. Turnstile bypass
  and memory persistence are development-only and fail closed in production.
- Disposable workers use `PUBLIC_SESSION_WORKER=1`, one research worker,
  explicit model configuration, matching timeout/run limits, isolated source
  extraction, and no public ingress. A worker reached by a visitor is not
  reusable until a replacement generation passes readiness. The gateway must
  confirm the authenticated worker WebSocket generation header before relaying
  queued browser input or worker output. Probe epochs must discard health
  responses started before a newer assignment, connection, or fencing event.
- Public browser messages are semantically allowlisted, rate-limited, and
  backpressure-bounded. Worker frames are text-only, schema-checked, and bounded
  before crossing the public boundary. Public token/status responses are marked
  `no-store`. Message and attachment limits are ticket-scoped across reconnects;
  attachment leases activate only after a completed browser WebSocket upgrade.
- Replay remains available as a separate static fallback. It starts no
  AgentSession, WebSocket, model, or source request.
- Authenticated/worker containers listen on `8787`; the public gateway uses its
  separately configured port (the pilot overlay uses `8788`). `/api/ready` is
  the readiness check for each mode.
- The authenticated browser-owned variant is a separate service built with
  `Dockerfile.browser-terminal` and `VITE_TERMINAL_BUILD_MODE=browser`. It runs
  `npm run start:browser-terminal`, requires
  `TERMINAL_RUNTIME_MODE=browser`, and must not be pointed at the Pi-backed
  `server/index.ts` image. Its `/data/browser-sessions` directory is the only
  durable state. The service requires server-side OpenRouter and private MCP
  configuration; those values must never be included in Vite build arguments or
  browser responses.
- The browser-owned service is commissioned first on the isolated
  `/fin-terminal-browser/` canary route from the infra repository's
  `docker-compose.browser-terminal.yml` overlay. The overlay requires an
  immutable `FIN_TERMINAL_BROWSER_IMAGE` and a separate
  `FIN_TERMINAL_BROWSER_PROXY_TOKEN`; it must not reuse the Pi singleton or the
  workspace control-plane service. Keep `FIN_TERMINAL_BROWSER_ENABLED=false`
  until both profiled services are healthy and direct commissioning succeeds.
- Release the browser image from a merged application revision using the
  `Publish authenticated browser-terminal image` workflow. Record both the
  application commit and the resulting GHCR manifest digest in the infra
  release; never point infra at a mutable tag or a locally built image.
- Caddy owns authenticated-terminal route authorization and injects its terminal
  proxy token. For public live, Caddy must strip and overwrite `X-Real-IP`; the
  gateway trusts that value only when Caddy also strips and overwrites
  `X-Fin-Terminal-Edge-Token` with `PUBLIC_EDGE_PROXY_TOKEN`, and enforces both
  visitor-IP and proxy-peer admission limits. Do not expose either terminal
  container port directly or bypass Caddy.
- Production research uses the Docker-internal `unbrowser-mcp` endpoint. Do
  not substitute the shared public development endpoint.
- The terminal remains a singleton per process. Approved operators share the
  persistent research archive and should coordinate ownership of the active
  WebSocket session.

## Research Cache Pre-Warming Configuration

The research-cache pre-warm runs at session bootstrap in the authenticated live
server and private-workspace runtimes (public workers stay cold by default —
their research budget belongs to the visitor). It is quality-gated and
fail-closed:

| Env | Default | Production guidance |
|---|---|---|
| `MARKET_PRECACHE_ENABLED` | on (non-public) | Leave on; `0` disables pre-warming entirely. Disposable public workers remain cold even if enabled |
| `MARKET_PRECACHE_STRATEGY` | `single` | **Use `single`.** Runs each exact interactive identity independently through the compact path; `paired` (one shared evidence pass + strict partition split) can reject flash-model output and previously burned the entire daily budget with no usable cache. Keep `paired` only for A/B |
| `MARKET_PRECACHE_QUALITY_GATE` | `1` | Leave on. Prevents evidence-blocked canvases from being cached as warm and runs the extraction canary + identity cooldown |
| `MARKET_PRECACHE_MAX_JOBS` | `24` | Cap the warm plan (story, headline, events, movers). Secondary to budget ceiling |
| `MARKET_PRECACHE_BUDGET` | `2000000` | UTC-day total Pi-reported token budget for pre-cache runs (10 000–10 000 000) |
| `MARKET_PRECACHE_RUN_LIMIT` | `100000` | Conservative reservation per run; at most ~20 attempts/day at defaults (5 000–500 000) |
| `MARKET_RESEARCH_PROMPT` | `legacy` | **Recommended: `compact`** for interactive research; `single`-strategy warm jobs use the same compact path |

Pre-cache strategies:

- **`single` (default):** every exact interactive identity (BRIEF and WHY) is its
  own job through the same compact research path interactive users hit. Order is
  deterministic: Market Story BRIEF → lead SIGNALS headline BRIEF → all three
  EVENT_LANES BRIEF → mover ticker BRIEFs, then the matching WHYs. An identity
  is skipped when it already has a usable same-day archive. No synthetic
  identity is introduced; results are archived under the exact interactive keys.
- **`paired` (opt-in):** one research/evidence extraction for both BRIEF and WHY,
  then split into two independently validated canvases with the exact
  interactive identities. The synthetic `v1/paired/*` identity is never
  archived or exposed as a cache hit. Token-efficient, but the strict
  block-partition contract (`splitPairedCanvas`) rejects model output that the
  interactive compact path produces successfully — observed in production as
  every daily attempt failing after token spend.
- With the quality gate enabled, degraded results remain in archive history for
  cooldown telemetry but are not cache-eligible; a usable sibling remains
  independently eligible.
- The budget ledger lives under `MARKET_DATA_DIR` as
  `market-precache-ledger.json`. Reservations are permanent for the UTC day
  (no refunds); actual usage is telemetry-only. This guarantees at most
  ~20 attempts/day at defaults. The worker checks projected Pi usage before
  every provider turn, including the first. Budget settings cannot change
  after that UTC day's ledger record has been created.

Behavior to expect in production:

- The first dispatched warm job is an **extraction canary**: the rest of the
  plan waits for its verdict, and the warm circuit opens immediately only if a
  completed canary reaches zero sources end-to-end (challenged/limited pages
  prove the extractor is reachable).
- Identities whose recent attempts all failed with infrastructure-class codes
  enter a bounded cooldown (default 2h) and are then re-probed, so a fixed
  extractor or un-blocked source recovers without wasting workers.
- Failed settlements persist **bounded failure telemetry** on the ledger entry:
  a machine classification code, final phase, last tool, an explicit
  `tokenGuard` flag when the per-run token guard aborted, and a redacted worker
  error message — so a failed warm run can be diagnosed from
  `market-precache-ledger.json` alone (worker stdout/stderr is discarded in
  production).
- Completed canvases are archived to `$MARKET_DATA_DIR/market-research-archive.json`
  with typed quality telemetry (`quality`, `generation`), and are shared across
  sessions. One parent process writes both archive and pre-cache ledger per data
  directory (the deployment is a singleton; public workers do not warm).

## Market-Event Scout

The event scout is a separate, opt-in observation loop. It polls official public
RSS/Atom sources through Unbrowser, records deterministic `admit-shadow`, `watch`,
and suppression counters, and evaluates a bounded trigger dry run. Real execution
is a separate, default-off outbox that accepts at most one job per poll and four
attempts per UTC day. It uses `nvidia/nemotron-3.5-lightning:free`, fails closed,
and never falls back to a paid model.

| Env | Default | Production guidance |
|---|---|---|
| `MARKET_SCOUT_ENABLED` | `0` | Enable only on the authenticated singleton parent while collecting shadow evidence. `1/true/on` enables; `0/false/off` disables |
| `MARKET_SCOUT_DISPATCH_ENABLED` | `0` | Enable guarded real trigger dispatch only after validating the adapter. Requires `MARKET_SCOUT_ENABLED`; public/disposable workers remain disabled |
| `MARKET_SCOUT_MODEL_ID` | `nvidia/nemotron-3.5-lightning:free` | The only model accepted by the scout adapter; paid or alternate model IDs fail closed |
| `MARKET_SCOUT_DISPATCH_PER_RUN` | `1` | Maximum trigger jobs accepted from one poll |
| `MARKET_SCOUT_DISPATCH_DAILY_CAP` | `4` | Maximum dispatch attempts per UTC day |
| `UNBROWSER_MCP_URL` | required in production | Use the private Docker-internal MCP endpoint. The local CLI fallback is development-only |
| `MARKET_SCOUT_LOCAL_CLI` | `0` | Keep disabled in every deployed runtime. It is an explicit local-development fallback and cannot replace MCP in production |
| `MARKET_DATA_DIR` | project `.pi/` | The scout journal is `market-event-scout.json`; mount the same exclusive parent-writer data volume used by the archive |

Operational contract:

- The first successful fetch per source is baseline-only, preventing startup
  replay from being mistaken for new events. Subsequent item IDs are bounded and
  persisted atomically for restart deduplication. Truncated, incomplete, and
  over-limit feeds fail without advancing baseline or seen-item state.
- Source cadence is fixed in code: Nasdaq halts every minute; Nasdaq corporate
  actions and SEC current filings every five minutes; Fed, BEA, FTC, and DOJ
  every ten minutes. The scheduler arms from the earliest persisted due time and
  `/market-scout sync` respects those due times. Do not shorten intervals without
  reviewing the source owner's access policy.
- Source failures are isolated and back off; a malformed journal fails closed so
  a restart cannot silently re-admit an unknown backlog.
- `PUBLIC_SESSION_WORKER=1`, `MARKET_RESEARCH_WORKER=1`, and
  `TERMINAL_RUNTIME_MODE=public-gateway` hard-disable scheduling. Do not enable
  the scout in disposable workers.
- Use `/market-scout status` to inspect source health and recent actionable
  observations. The same status view reports dry-run route coverage, UTC daily
  candidate volume, and gate pressure. These are operational measurements, not
  precision, recall, or association-correctness claims; those require reviewed
  labels and an independent denominator. Dispatch records use candidate IDs and
  recover in-flight reservations after a parent restart; settled candidates are
  never redispatched. Failed free-model calls remain failed and do not fall
  back to a paid model.

### Trigger and dispatch contract

Every newly observed non-suppressed decision is mapped from its validated target
only; titles are never reparsed to invent a route:

- ticker target → ticker BRIEF proposal;
- `macro` market target → macro EVENTS BRIEF proposal;
- `story` market target → SIGNALS/Market Story BRIEF proposal.

Only `admit-shadow` decisions can reach `would-trigger`. The version-1 simulation
policy requires priority 80, a two-hour publication TTL, a six-hour per-target
cooldown, and a cap of eight `would-trigger` outcomes per UTC day. Those values
are conservative hypotheses for measuring pressure, not authorization or
evidence-backed production thresholds. `watch` decisions are retained as gated
mapping evidence; current market-story decisions therefore do not qualify.
Gated candidates consume neither cooldown nor daily capacity. The candidate and
its policy snapshot are immutable, while bounded lifetime/day aggregates survive
candidate-record rotation. Once evidence exists, changing any policy value
  requires an explicit policy/schema migration so daily aggregates cannot silently
  blend incomparable cohorts. When execution is enabled, only newly-created
  `would-trigger` candidates enter the durable dispatch outbox; existing dry-run
  history is never backfilled.

The journal schema is version 2. A valid version-1 journal migrates in memory and
is written as version 2 on the next atomic scout commit; retained version-1
decisions are deliberately not backfilled as candidates. Source dedupe, decision
records, candidate outcomes, cooldowns, and daily counts commit in the same
temp-file/fsync/rename operation. An older binary rejects a version-2 journal and
leaves scouting fail-closed instead of deleting unknown evidence. Disable the
scout before an application rollback that predates journal v2; restore compatible
code to resume polling.

## Post-Deployment Verification

- Confirm the GitHub Actions production job succeeded.
- Confirm the deployment host reports `fin-terminal` healthy and
  `GET /api/ready` returns HTTP 200 from inside the container.
- Confirm logged-out requests to `/unbrowser/fin-terminal/` return HTTP 401.
- Confirm an approved user can load the terminal and establish
  `/unbrowser/fin-terminal/ws` through Caddy.
- Confirm a direct container-network request without the injected proxy token
  returns HTTP 403.
- Confirm the demo service reports `GET /api/ready` HTTP 200.
- Confirm `/unbrowser/fin-terminal-demo/api/public/config` returns a signed
  opaque visitor token and only public limits/site-key metadata.
- Confirm invalid origin and Turnstile admission attempts fail closed.
- Confirm Turnstile verification is bound to the production hostname and the
  `public_terminal_admission` widget action.
- Confirm FIFO assignment, queue/ticket expiry, reconnect grace, idle timeout,
  absolute timeout, and per-session research launch limits.
- Confirm the browser WebSocket reaches only the gateway, an assigned worker is
  replaced after session end, and a stale worker generation cannot re-enter the
  ready pool.
- Confirm an overlapping browser reconnect does not let the stale socket close
  expire its replacement, and a generation change between health probe and
  worker WebSocket attachment ends and fences the ticket.
- Confirm a delayed pre-fence health response cannot return the slot to service,
  malformed Host headers do not crash the gateway, and failed/aborted upgrades
  leave an unexposed worker reusable.
- Confirm oversized, binary, malformed, and sustained-rate browser/worker
  traffic is rejected without unbounded gateway or Redis work.
- Confirm the daily reservation ceiling rejects new seats before configured
  spend can be exceeded, including while an active reservation crosses UTC
  midnight.
- When shadow scouting is enabled on the authenticated parent, confirm
  `/market-scout status` shows one baseline per reachable source, no model jobs or
  token reservations, and a durable journal under `MARKET_DATA_DIR`.
- If replay fallback is deployed separately, confirm it serves immutable replay
  artifacts and rejects WebSocket upgrades.

The authoritative infrastructure details, including production secrets and
host safety controls, live in
[`unchained-infra/docs/fin-terminal-route.md`](https://github.com/protostatis/unchained-infra/blob/main/docs/fin-terminal-route.md).

## Private Management API Contract (warm-pool reconciler) — v1

The gateway exposes a **private-only** management listener (default
`TERMINAL_RUNTIME_MANAGEMENT_PORT=8789`, separate from the public port). It is
enabled only when **both** `TERMINAL_RUNTIME_FEATURE_ENABLED` (any of
`1|true|yes|on`, case-insensitive) and `TERMINAL_RUNTIME_MANAGEMENT_TOKEN`
(>= 32 chars) are set. Every request must send the `X-Management-Token` header.
No management path is ever mounted on the public listener; Caddy never proxies
8789. The listener binds `TERMINAL_RUNTIME_MANAGEMENT_HOST` (default
`0.0.0.0`); `0.0.0.0` is safe only because the Compose service publishes no
host port and Caddy never routes to it — the listener is container-private. A
bind failure rejects gateway startup (fail closed when the feature is
required).

Infra reconciler endpoints (POST, JSON):

| Path                             | Body                          | Returns                                        |
| -------------------------------- | ----------------------------- | ---------------------------------------------- |
| `/api/management/reconcile-snapshot` | `{}`                      | `{ version: 1, seats: {workerId: {workerId, status, phase, generation\|null, assigned, idleSeconds, drainRequested, drainId\|null, containerId:""}}, totalAssigned, totalQueued, plan }` |
| `/api/management/reconcile-plan` | `{}`                            | `{ version: 1, reconciled, plan }` desired warm-pool plan |
| `/api/management/drain`          | `{ workerId, drainId, expectedGeneration }` | `{ accepted: true, drainId }` or 409 `{ accepted: false, reason }` |
| `/api/management/activate`       | `{ workerId }`                | `{ accepted: true }` or 409 `{ accepted: false, reason }` |

- `seats` always contains exactly six named records keyed by `workerId`
  (`seat-01`..`seat-06`); `status` is one of `absent|starting|healthy|draining|stopped`
  and `assigned` is derived from the phase. `plan.desiredRunning` is
  authoritative for the reconciler.
- `idleSeconds` is the whole number of elapsed idle seconds (floored) for
  `ready-idle` and `active` seats: ready-idle seats count from the moment the
  slot became healthy and unassigned (persisted across gateway restarts);
  active seats count from the last meaningful activity. Draining seats report
  `0`. The value is monotonic and never negative.
- `drain` is **atomic**: a ready-idle (unassigned) seat is only drainable after
  `TERMINAL_RUNTIME_IDLE_SCALE_DOWN` seconds (default 300) of continuous idle,
  and the **generation CAS** on `expectedGeneration` rejects a stale
  generation with 409 so a replaced worker is never drained. Once accepted the
  warm-pool drain AND the coordinator ineligibility fence are applied in one
  serialized mutation and persisted before the caller sees `accepted: true`.
  The drained seat is immediately removed from the assignable pool: health
  probes (old or new generation) never re-enable it, the fence survives a
  gateway restart, and no session — queued before or admitted after — is ever
  assigned to it.
- `activate` releases a sticky drain only when the process generation changed;
  a same-generation activation is rejected with 409. The explicit activation
  clears both the warm-pool drain and the coordinator ineligibility fence in
  one serialized mutation; the slot becomes assignable again after a fresh
  health probe confirms the replacement process. Activating a seat with no
  drain is an accepted no-op.

Worker→gateway permit surface (same private listener, same header):

| Path                                     | Body                                                        |
| ---------------------------------------- | ----------------------------------------------------------- |
| `/api/management/research-permits/acquire`   | `{ sessionId, workerGeneration, requestId? }`           |
| `/api/management/research-permits/status`    | `{ requestId }`                                        |
| `/api/management/research-permits/heartbeat` | `{ requestId, sessionId? }` (extends the session idle lease) |
| `/api/management/research-permits/release`   | `{ requestId }`                                        |

Workers reach the gateway's private listener via
`TERMINAL_RUNTIME_MANAGEMENT_URL` (e.g. `http://fin-terminal-public-gateway:8789`,
over the private seat networks) and `TERMINAL_RUNTIME_MANAGEMENT_TOKEN`. The
worker exposes its own identity to the permit gate through
`TERMINAL_RUNTIME_WORKER_GENERATION` (set at boot) and
`TERMINAL_RUNTIME_SESSION_ID` (set on public WebSocket attach).

Legacy aliases (`GET /api/management/seats`, `POST /api/management/seats/:id/drain`,
`POST /api/management/seats/:id/activate`, `POST /api/management/reconcile`,
`GET /api/management/research`) remain for existing tooling and return the same
v1 shapes; the reconciler contract paths above are canonical.

The canonical cross-repo contract (wire units, headers, cookie names, env vars,
paths) is `unchained-infra/docs/financial-terminal-cross-repo-contract.md`.

## Workspace Checkpoint / Handoff Contract

Feature-gated by `FINANCIAL_WORKSPACE_CHECKPOINTS` (`1`/`true`/`yes`).
Checkpoint content is always built from the assigned worker's authoritative
state; the browser only sends an explicit opt-in.

- Worker private export: `POST /internal/financial-workspace/checkpoint-export`
  on the live worker (requires `X-Fin-Terminal-Control-Token`, plus the normal
  `X-Fin-Terminal-Proxy-Token` route auth). Body `{ sessionId, generation }`;
  the generation is a deterministic epoch derived from the opaque worker
  generation. The gateway calls this only for the active assigned
  session/generation.
- Browser opt-in: `POST /api/public/workspace-handoff` on the public listener
  (visitor + ticket tokens). The gateway exports from the worker, forwards to
  the workspace service at `FINANCIAL_WORKSPACE_SERVICE_URL` (Bearer
  `FINANCIAL_WORKSPACE_CONTROL_TOKEN`), and sets the handoff secret as an
  HttpOnly cookie. The handoff secret never reaches browser JS.
- The workspace service's create response is **canonical snake_case** with
  `expires_at` in Unix epoch **seconds**
  (`checkpoint_id`, `expires_at`, `handoff_id`, `handoff_secret`, `auth_url`).
  The gateway strictly parses it (`parseCheckpointCreateResponse`), normalizes
  `expires_at` to epoch ms, and uses ms for the cookie's Express `maxAge`. The
  camelCase spelling is tolerated for rollout. A millisecond `expires_at` is
  rejected.
- The gateway only forwards the browser redirect target when `auth_url` is
  HTTPS and starts with the exact configured
  `FINANCIAL_WORKSPACE_AUTH_URL_PREFIX` (origin + path prefix); a missing
  prefix or a mismatched URL fails the handoff closed. Handoff requests are
  rate-limited per session and re-send a deterministic per-session idempotency
  key so a gateway/service timeout ordering race cannot create duplicate
  checkpoints.
- Handoff secret cookie: `fin-terminal-handoff-secret`, host-only
  (`HttpOnly; Secure; SameSite=Lax; Path=/`; optional `Domain` only via
  `FINANCIAL_WORKSPACE_HANDOFF_COOKIE_DOMAIN`). The control plane reads it
  server-side at claim initiation and rotates it away — never from JS, body,
  or URL.
- Private import boot: a fresh in-memory workspace boots from a validated
  checkpoint (`SessionManager.inMemory` + custom entry + bounded continuation
  seed). Raw transcript/process state is never restored. In the private
  workspace runtime image (`TERMINAL_RUNTIME_MODE=private-workspace`), the
  host-side provider provisions `FIN_WORKSPACE_CHECKPOINT_FILE` (default
  `/data/checkpoint.json`) on the per-account volume for an imported workspace
  boot; `TERMINAL_WORKSPACE_IMPORT_FILE` is the legacy alias. Both require
  `FINANCIAL_WORKSPACE_CHECKPOINTS=1` and `NODE_ENV=production` fails closed on
  a missing or bad file. The runtime additionally requires `MARKET_PROXY_TOKEN`,
  `FIN_WORKSPACE_CONTROL_TOKEN`, `FIN_WORKSPACE_SESSION_ID`,
  `TERMINAL_RUNTIME_WORKER_GENERATION`, an explicit model provider/model, and
  `UNBROWSER_MCP_URL` (fail closed at boot).

The canonical cross-repo contract (wire units, headers, cookie names, env vars,
paths) is `unchained-infra/docs/financial-terminal-cross-repo-contract.md`.
