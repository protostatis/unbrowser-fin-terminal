# Concurrent Research Workers — Design Specification

## Status

Approved for implementation in this branch.

## Problem

The `/market` UI and every research job currently share one Pi `AgentSession`.
The extension deliberately dispatches only when that session is idle, so a
second BRIEF/WHY request waits for the entire first model turn.  That protects
the live canvas from cross-job writes, but it makes independent research
requests serial.

## Goals

1. Run up to two independent market-research jobs concurrently.
2. Keep the canonical `/market` session responsive while research runs.
3. Preserve the existing canvas, queue, cache, archive, cancellation, and
   production tool-allowlist behavior from the user's point of view.
4. Ensure one worker cannot publish to another job or write the shared archive.
5. Make the feature testable without a configured model or live MCP endpoint.

## Non-goals

- Reduce the latency of a single model run.
- Add distributed execution, cross-host queues, or durable job recovery after a
  server restart.
- Treat a child process as a security sandbox.
- Change the research prompt, source policy, or four-tool model-facing
  allowlist.

## Chosen architecture

```
canonical Pi session + /market extension
          │
          │ ResearchJob / cancellation
          ▼
  ResearchWorkerCoordinator (parent-owned)
          │                         │
       IPC events              bounded FIFO / max 2
          │                         │
          ▼                         ▼
 worker process #1           worker process #2
 one fresh Pi session        one fresh Pi session
 one research-only attempt   one research-only attempt
```

The canonical extension remains the source of truth for `ResearchJob` state,
canvases, the visible queue, and archive writes.  A worker performs one attempt
only, has a fresh Pi session, and exits after reporting a terminal event.

The worker must not load a UI panel, persist archives, or accept arbitrary
commands from the model.  It is created with exactly the existing production
allowlist:

- `market_technicals`
- `market_discover`
- `market_extract`
- `market_canvas`

## Scheduling and lifecycle

1. The UI creates its normal parent `ResearchJob`, identified by `jobId`.
2. The parent coordinator admits FIFO jobs while fewer than
   `MARKET_RESEARCH_CONCURRENCY` workers are active (default 2, constrained to
   1–4).
3. For every launch the coordinator creates a unique `attemptId`, forks a
   worker, and sends an immutable request snapshot.
4. A worker emits ordered IPC events and performs no persistence.
5. The parent accepts events only while the matching `(jobId, attemptId)` is
   active.  It translates worker canvas data to the parent job ID, updates the
   live panel, and remains the only archive writer.
6. A completed/failed/cancelled worker releases its slot and starts the next
   queued parent job.

The initial queue limit remains 24 active-or-queued jobs.  This protects the
model provider and MCP endpoint while allowing two jobs to make progress.

## IPC contract

All messages are JSON-safe and versioned.  Parent-to-worker messages are:

```ts
type WorkerRun = {
  version: 1;
  type: "run";
  jobId: string;
  attemptId: string;
  request: {
    symbol: string;
    question: string;
    chartScope: "day" | "week" | "month" | "year" | "max";
    researchKey: string;
    intent: "brief" | "why";
    contextLabel: string;
  };
};

type WorkerCancel = { version: 1; type: "cancel"; jobId: string; attemptId: string };
```

Worker-to-parent events contain `version`, `jobId`, `attemptId`, and a strictly
increasing `sequence`:

- `started`
- `job` — normalized worker progress/state
- `canvas` — a validated partial or complete canvas
- `settled` — terminal outcome and optional error
- `fatal` — bootstrap/protocol failure

The coordinator ignores stale, duplicate, out-of-order, post-cancellation, or
foreign-attempt events.  Delivery is at-least-once; parent reduction is
idempotent by `(attemptId, sequence)`.

## Cancellation and retries

Cancelling a queued job removes it locally.  Cancelling a dispatched/running
job first fences its attempt in the parent, sends `WorkerCancel`, asks that
worker's Pi session to abort, and force-terminates it after a short grace
period.  A late canvas event must never be rendered or archived.

This implementation has no automatic retries.  Retrying is a later policy
decision once provider/MCP error telemetry exists; a retry must always receive
a new `attemptId`.

## State and persistence boundaries

- Parent only: job map, scheduler state, candidate/canvas presentation,
  `market-research-archive.json`, and active terminal reference.
- Worker only: Pi messages, tool calls, temporary candidate grants, and its
  attempt-local canvas state.
- Workers set worker mode and skip project archive loading/writing.
- Archive writes stay serialized in the parent process.  No worker may inherit
  the shared archive path as a writable destination.

## Operational policy

- `MARKET_RESEARCH_CONCURRENCY`: optional integer 1–4; defaults to 2.
- Production still requires `UNBROWSER_MCP_URL`.
- Workers inherit the configured model policy but not a broader model-facing
  tool registry.
- Child processes are isolation boundaries for state and failure containment,
  not security sandboxes.  A future multi-tenant deployment should use an
  explicit tool broker and container/OS sandboxing.

## Verification and rollout

Unit tests must cover:

1. FIFO scheduling with a two-worker cap.
2. Cancellation fencing and ignored late worker events.
3. Worker crash/fatal handling releases a slot and continues the queue.
4. Environment validation for the concurrency setting.
5. Existing market tool-allowlist assertions.

Manual/live characterization before increasing the cap must measure queue wait,
completion latency, worker startup time, provider/MCP 429s, memory use, and
cross-job contamination.  Roll out behind `MARKET_RESEARCH_CONCURRENCY=1` by
default-compatible configuration, then explicitly set `2` after validation.
