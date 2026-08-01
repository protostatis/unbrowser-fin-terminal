/**
 * JSON-safe, versioned types and narrow validators/guards for parent↔worker
 * messages in the concurrent-research-workers architecture.
 *
 * Framework-independent — no Pi SDK imports.
 */

export const WORKER_PROTOCOL_VERSION = 1;

// ── Research request context (immutable per job) ──────────────────────────

export interface ResearchRequestContext {
  symbol: string;
  question: string;
  chartScope: "day" | "week" | "month" | "year" | "max";
  researchKey: string;
  intent: "brief" | "why";
  contextLabel: string;
}

// ── Parent → Worker messages ──────────────────────────────────────────────

export interface WorkerRunMessage {
  version: 1;
  type: "run";
  jobId: string;
  attemptId: string;
  request: ResearchRequestContext;
}

export interface WorkerCancelMessage {
  version: 1;
  type: "cancel";
  jobId: string;
  attemptId: string;
}

export type ParentMessage = WorkerRunMessage | WorkerCancelMessage;

// ── Worker → Parent events ────────────────────────────────────────────────

/** Common header serialised on every worker-to-parent event. */
export interface WorkerEventHeader {
  version: 1;
  type: string;
  jobId: string;
  attemptId: string;
  /** Strictly increasing, starting at 0. */
  sequence: number;
}

/** Worker has forked and is initialising its Pi session. */
export interface WorkerStartedEvent extends WorkerEventHeader {
  type: "started";
}

/** Normalised worker progress / state update. */
export interface WorkerJobEvent extends WorkerEventHeader {
  type: "job";
  outcome: "queued" | "running" | "partial" | "complete" | "failed" | "cancelled";
  activity: "seeding" | "fetching" | "extracting" | "synthesizing";
  toolName?: string;
  error?: string;
}

/** A validated partial or complete canvas (opaque to the coordinator; structurally validated). */
export interface WorkerCanvasEvent extends WorkerEventHeader {
  type: "canvas";
  canvas: Record<string, unknown>;
}

/** Terminal outcome from a worker — last event before exit. */
export interface WorkerSettledEvent extends WorkerEventHeader {
  type: "settled";
  outcome: "complete" | "failed" | "cancelled";
  error?: string;
}

/** Bootstrap or protocol failure. Worker will exit after this. */
export interface WorkerFatalEvent extends WorkerEventHeader {
  type: "fatal";
  error: string;
}

export type WorkerEvent =
  | WorkerStartedEvent
  | WorkerJobEvent
  | WorkerCanvasEvent
  | WorkerSettledEvent
  | WorkerFatalEvent;

// ── String / record helpers ───────────────────────────────────────────────

function isNonEmptyString(value: unknown, maxLen: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

// ── Known value sets ──────────────────────────────────────────────────────

const CHART_SCOPES = new Set(["day", "week", "month", "year", "max"]);
const INTENTS = new Set(["brief", "why"]);
const RESEARCH_OUTCOMES = new Set(["queued", "running", "partial", "complete", "failed", "cancelled"]);
const RESEARCH_ACTIVITIES = new Set(["seeding", "fetching", "extracting", "synthesizing"]);
const SETTLED_OUTCOMES = new Set(["complete", "failed", "cancelled"]);
const EVENT_TYPES = new Set(["started", "job", "canvas", "settled", "fatal"]);

// ── Request guard ─────────────────────────────────────────────────────────

export function isValidResearchRequest(
  value: unknown,
): value is ResearchRequestContext {
  if (!isRecord(value)) return false;
  const s = value.symbol;
  const q = value.question;
  const cs = value.chartScope;
  const rk = value.researchKey;
  const i = value.intent;
  const cl = value.contextLabel;
  return (
    isNonEmptyString(s, 20) &&
    isNonEmptyString(q, 4000) &&
    typeof cs === "string" &&
    CHART_SCOPES.has(cs) &&
    isNonEmptyString(rk, 200) &&
    typeof i === "string" &&
    INTENTS.has(i) &&
    isNonEmptyString(cl, 200)
  );
}

// ── Event header guard ────────────────────────────────────────────────────

function isWorkerEventHeader(value: unknown): value is WorkerEventHeader {
  if (!isRecord(value)) return false;
  const v = value.version;
  const t = value.type;
  const j = value.jobId;
  const a = value.attemptId;
  const s = value.sequence;
  return (
    v === WORKER_PROTOCOL_VERSION &&
    isNonEmptyString(t, 64) &&
    typeof t === "string" &&
    EVENT_TYPES.has(t) &&
    isNonEmptyString(j, 256) &&
    isNonEmptyString(a, 256) &&
    isFiniteInteger(s) &&
    s >= 0
  );
}

// ── Per-event type guards ─────────────────────────────────────────────────

export function isWorkerStartedEvent(
  value: unknown,
): value is WorkerStartedEvent {
  return isWorkerEventHeader(value) && value.type === "started";
}

export function isWorkerJobEvent(value: unknown): value is WorkerJobEvent {
  if (!isWorkerEventHeader(value) || value.type !== "job") return false;
  const rec = value as unknown as Record<string, unknown>;
  const o = rec.outcome;
  const a = rec.activity;
  return (
    typeof o === "string" &&
    RESEARCH_OUTCOMES.has(o) &&
    typeof a === "string" &&
    RESEARCH_ACTIVITIES.has(a)
  );
}

export function isWorkerCanvasEvent(
  value: unknown,
): value is WorkerCanvasEvent {
  if (!isWorkerEventHeader(value) || value.type !== "canvas") return false;
  const canvas = (value as unknown as Record<string, unknown>).canvas;
  // At minimum a canvas must carry symbol, title, content, and updatedAt.
  return (
    isRecord(canvas) &&
    isNonEmptyString(canvas.symbol, 20) &&
    isNonEmptyString(canvas.title, 4000) &&
    typeof canvas.content === "string" &&
    typeof canvas.updatedAt === "number" &&
    Number.isFinite(canvas.updatedAt)
  );
}

export function isWorkerSettledEvent(
  value: unknown,
): value is WorkerSettledEvent {
  if (!isWorkerEventHeader(value) || value.type !== "settled") return false;
  const o = (value as unknown as Record<string, unknown>).outcome;
  return typeof o === "string" && SETTLED_OUTCOMES.has(o);
}

export function isWorkerFatalEvent(
  value: unknown,
): value is WorkerFatalEvent {
  if (!isWorkerEventHeader(value) || value.type !== "fatal") return false;
  const err = (value as unknown as Record<string, unknown>).error;
  return isNonEmptyString(err, 4000);
}

// ── Top-level event discriminator ─────────────────────────────────────────

export function isWorkerEvent(value: unknown): value is WorkerEvent {
  if (!isWorkerEventHeader(value)) return false;
  switch (value.type) {
    case "started":
      return isWorkerStartedEvent(value);
    case "job":
      return isWorkerJobEvent(value);
    case "canvas":
      return isWorkerCanvasEvent(value);
    case "settled":
      return isWorkerSettledEvent(value);
    case "fatal":
      return isWorkerFatalEvent(value);
    default:
      return false;
  }
}

// ── Parent message guard ──────────────────────────────────────────────────

export function isParentMessage(value: unknown): value is ParentMessage {
  if (!isRecord(value)) return false;
  const v = value.version;
  const t = value.type;
  const j = value.jobId;
  const a = value.attemptId;
  if (v !== WORKER_PROTOCOL_VERSION) return false;
  if (!isNonEmptyString(j, 256) || !isNonEmptyString(a, 256)) return false;
  if (t === "run") {
    return isValidResearchRequest(
      (value as unknown as Record<string, unknown>).request,
    );
  }
  return t === "cancel";
}

// ── Message constructors ──────────────────────────────────────────────────

export function makeRunMessage(
  jobId: string,
  attemptId: string,
  request: ResearchRequestContext,
): WorkerRunMessage {
  return { version: 1, type: "run", jobId, attemptId, request };
}

export function makeCancelMessage(
  jobId: string,
  attemptId: string,
): WorkerCancelMessage {
  return { version: 1, type: "cancel", jobId, attemptId };
}
