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
  queued browser input or worker output.
- Public browser messages are semantically allowlisted, rate-limited, and
  backpressure-bounded. Worker frames are text-only, schema-checked, and bounded
  before crossing the public boundary. Public token/status responses are marked
  `no-store`.
- Replay remains available as a separate static fallback. It starts no
  AgentSession, WebSocket, model, or source request.
- Authenticated/worker containers listen on `8787`; the public gateway uses its
  separately configured port (the pilot overlay uses `8788`). `/api/ready` is
  the readiness check for each mode.
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
- Confirm oversized, binary, malformed, and sustained-rate browser/worker
  traffic is rejected without unbounded gateway or Redis work.
- Confirm the daily reservation ceiling rejects new seats before configured
  spend can be exceeded, including while an active reservation crosses UTC
  midnight.
- If replay fallback is deployed separately, confirm it serves immutable replay
  artifacts and rejects WebSocket upgrades.

The authoritative infrastructure details, including production secrets and
host safety controls, live in
[`unchained-infra/docs/fin-terminal-route.md`](https://github.com/protostatis/unchained-infra/blob/main/docs/fin-terminal-route.md).
