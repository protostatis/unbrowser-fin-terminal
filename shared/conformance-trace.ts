/**
 * Conformance trace — versioned, bounded record of a canonical Pi research
 * run used to define the kernel/adapter boundary for the browser session
 * migration (Stage 0 of the strangler plan).
 *
 * A trace is a JSONL file of `ConformanceTraceEvent` lines. The capture tool
 * (`scripts/capture-pi-trace.ts`) records it from a REAL AgentSession with a
 * deterministic conformance model + mock MCP endpoint, so the fixture is
 * reproducible without a model key. The replay tool
 * (`scripts/replay-pi-trace.ts`) validates the schema and asserts the
 * behavioral invariants a browser adapter must reproduce:
 *
 *   - boot → panel open → research job lifecycle (queued → dispatched →
 *     running → partial → complete/settled) → archive write → close
 *   - every tool execution is recorded with tool name + bounded args
 *   - canvas mutations (seed/extracted/complete) appear as state snapshots
 *   - usage accounting is present at settle
 *   - cancellation of a queued job settles as cancelled
 *
 * Framework-independent: no Pi SDK imports (mirrors research-worker-protocol).
 */

export const CONFORMANCE_TRACE_VERSION = 1;
export const CONFORMANCE_TRACE_MAX_EVENT_BYTES = 64 * 1024;

export type ConformanceTraceKind =
  | "meta"
  | "command"
  | "input"
  | "session_event"
  | "panel"
  | "state"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "archive"
  | "settle";

export interface ConformanceTraceMeta {
  /** Capture script version (bump when the scenario changes). */
  captureVersion: string;
  /** Scenario id recorded by the capture script. */
  scenario: string;
  /** Model identity used during capture (provider/id). */
  model: string;
  /** Runtime configuration that affects behavior. */
  env: Record<string, string>;
  cwd: string;
  capturedAt: number;
}

export interface ConformanceTraceEvent {
  version: typeof CONFORMANCE_TRACE_VERSION;
  /** Monotonic, starting at 1. */
  seq: number;
  /** Wall-clock timestamp (informational; not part of conformance). */
  ts: number;
  kind: ConformanceTraceKind;
  payload: Record<string, unknown>;
}

// ── Validation ─────────────────────────────────────────────────────────────

const KINDS = new Set<ConformanceTraceKind>([
  "meta", "command", "input", "session_event", "panel", "state",
  "tool_call", "tool_result", "usage", "archive", "settle",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidConformanceTraceEvent(value: unknown): value is ConformanceTraceEvent {
  if (!isRecord(value)) return false;
  const v = value;
  if (v.version !== CONFORMANCE_TRACE_VERSION) return false;
  if (!isFiniteNumber(v.seq) || !Number.isInteger(v.seq) || v.seq < 1) return false;
  if (!isFiniteNumber(v.ts) || v.ts < 0) return false;
  if (typeof v.kind !== "string" || !KINDS.has(v.kind as ConformanceTraceKind)) return false;
  if (!isRecord(v.payload)) return false;
  try {
    return JSON.stringify(v).length <= CONFORMANCE_TRACE_MAX_EVENT_BYTES;
  } catch {
    return false;
  }
}

/** Parse a JSONL trace file into validated, sequence-checked events. */
export function parseConformanceTrace(text: string): {
  events: ConformanceTraceEvent[];
  error?: string;
} {
  const events: ConformanceTraceEvent[] = [];
  let lastSeq = 0;
  let lineNo = 0;
  for (const rawLine of text.split("\n")) {
    lineNo++;
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { events, error: `line ${lineNo}: invalid JSON` };
    }
    if (!isValidConformanceTraceEvent(parsed)) {
      return { events, error: `line ${lineNo}: schema violation` };
    }
    if (parsed.seq <= lastSeq) {
      return { events, error: `line ${lineNo}: non-monotonic seq ${parsed.seq} after ${lastSeq}` };
    }
    lastSeq = parsed.seq;
    events.push(parsed);
  }
  return { events };
}

/** Bounded snapshot of a payload: never exceed the IPC-style event ceiling. */
export function boundedTracePayload(
  kind: ConformanceTraceKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    return { kind: "unserializable" };
  }
  if (json.length <= CONFORMANCE_TRACE_MAX_EVENT_BYTES) return payload;
  // Drop the heaviest candidates (dossier packets/excerpts) and retry once.
  const redacted: Record<string, unknown> = { ...payload };
  if (isRecord(redacted.dossier)) {
    redacted.dossier = { ...redacted.dossier, packets: undefined };
  }
  if (Array.isArray(redacted.researchQueue)) {
    redacted.researchQueue = redacted.researchQueue.map((job) =>
      isRecord(job) ? { ...job, error: undefined, evidencePackets: undefined } : job,
    );
  }
  json = JSON.stringify(redacted);
  if (json.length <= CONFORMANCE_TRACE_MAX_EVENT_BYTES) return redacted;
  return { kind, truncated: true };
}
