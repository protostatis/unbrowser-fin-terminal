/**
 * JSON-safe, versioned types and narrow validators/guards for parent↔worker
 * messages in the concurrent-research-workers architecture.
 *
 * Framework-independent — no Pi SDK imports.
 */

import { pairedPairKey } from "../shared/research-precache-ledger.js";
import type { ResearchWorkerUsage } from "../shared/research-worker-usage.js";
import { MARKET_SCOUT_MODEL_ID } from "../shared/market-event-scout.js";

export const WORKER_PROTOCOL_VERSION = 1;
const MAX_IPC_BYTES = 64 * 1024;
const MAX_CANVAS_CONTENT_CHARS = 12_000;

// ── Paired target (optional, for paired pre-cache runs) ───────────────────

export interface PairedTargetIdentity {
  researchKey: string;
  intent: "brief" | "why";
  contextLabel: string;
  question: string;
}

export interface PairedTarget {
  brief: PairedTargetIdentity;
  why: PairedTargetIdentity;
  neededBrief: boolean;
  neededWhy: boolean;
}

// ── Research request context (immutable per job) ──────────────────────────

export interface ResearchRequestContext {
  symbol: string;
  question: string;
  chartScope: "day" | "week" | "month" | "year" | "max";
  researchKey: string;
  intent: "brief" | "why";
  contextLabel: string;
  /** Optional paired pre-cache target. Never exposed as a cache hit. */
  pairedTarget?: PairedTarget;
  /** Only for paired pre-cache workers. */
  origin?: "precache" | "scout";
  /** Per-run token limit for pre-turn abort guard (paired pre-cache only). */
  tokenLimit?: number;
  /** Scout-only model override; interactive and pre-cache jobs remain global-configured. */
  modelProvider?: "openrouter";
  modelId?: string;
  /** Durable scout candidate identity used for dispatch idempotency and settlement. */
  scoutCandidateId?: string;
}

// ── Worker usage (reported on settled events) ─────────────────────────────

export type WorkerUsage = ResearchWorkerUsage;

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
  usage?: WorkerUsage;
  /** True when the per-run token guard aborted this run (telemetry only). */
  tokenGuard?: boolean;
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

function isBoundedString(value: unknown, maxLen: number): value is string {
  return typeof value === "string" && value.length <= maxLen;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isBoundedJson(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_IPC_BYTES;
  } catch {
    return false;
  }
}

// ── Known value sets ──────────────────────────────────────────────────────

const CHART_SCOPES = new Set(["day", "week", "month", "year", "max"]);
const INTENTS = new Set(["brief", "why"]);
const RESEARCH_OUTCOMES = new Set(["queued", "running", "partial", "complete", "failed", "cancelled"]);
const RESEARCH_ACTIVITIES = new Set(["seeding", "fetching", "extracting", "synthesizing"]);
const SETTLED_OUTCOMES = new Set(["complete", "failed", "cancelled"]);
const EVENT_TYPES = new Set(["started", "job", "canvas", "settled", "fatal"]);
// ── Paired target guard (strict) ──────────────────────────────────────────

function isValidPairedIdentity(value: unknown): value is PairedTargetIdentity {
  if (!isRecord(value)) return false;
  const rk = value.researchKey;
  const i = value.intent;
  const cl = value.contextLabel;
  const q = value.question;
  return (
    isNonEmptyString(rk, 200) &&
    typeof i === "string" && INTENTS.has(i) &&
    isNonEmptyString(cl, 200) &&
    isNonEmptyString(q, 4000)
  );
}

function isValidPairedTarget(value: unknown): value is PairedTarget {
  if (!isRecord(value)) return false;
  const brief = value.brief;
  const why = value.why;
  if (!isValidPairedIdentity(brief) || !isValidPairedIdentity(why)) return false;
  // Strict: brief.intent must be "brief", why.intent must be "why"
  if (brief.intent !== "brief" || why.intent !== "why") return false;
  if (!brief.researchKey.endsWith("/brief") || !why.researchKey.endsWith("/why")) return false;
  // Keys must be distinct and non-synthetic (not v1/paired/*)
  if (brief.researchKey === why.researchKey) return false;
  if (brief.researchKey.startsWith("v1/paired/") || why.researchKey.startsWith("v1/paired/")) return false;
  if (typeof value.neededBrief !== "boolean" || typeof value.neededWhy !== "boolean") return false;
  if (!value.neededBrief && !value.neededWhy) return false;
  return true;
}

function isValidWorkerUsage(value: unknown): value is WorkerUsage {
  if (!isRecord(value)) return false;
  const u = value as Record<string, unknown>;
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;
  for (const field of fields) {
    const v = u[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000_000 || !Number.isInteger(v)) return false;
  }
  const input = u.inputTokens as number;
  const output = u.outputTokens as number;
  const total = u.totalTokens as number;
  const cacheRead = u.cacheReadTokens as number;
  const cacheWrite = u.cacheWriteTokens as number;
  if (total !== input + output + cacheRead + cacheWrite) return false;
  if (u.cost !== undefined) {
    if (typeof u.cost !== "number" || !Number.isFinite(u.cost) || u.cost < 0 || u.cost > 1_000_000) return false;
  }
  return true;
}

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
  const baseValid = (
    isNonEmptyString(s, 20) &&
    isNonEmptyString(q, 4000) &&
    typeof cs === "string" &&
    CHART_SCOPES.has(cs) &&
    isNonEmptyString(rk, 200) &&
    typeof i === "string" &&
    INTENTS.has(i) &&
    isNonEmptyString(cl, 200)
  );
  if (!baseValid) return false;
  const pt = value.pairedTarget;
  if (pt !== undefined && !isValidPairedTarget(pt)) return false;
  const origin = value.origin;
  if (origin !== undefined && origin !== "precache" && origin !== "scout") return false;
  const tokenLimit = value.tokenLimit;
  if (tokenLimit !== undefined && (
    typeof tokenLimit !== "number" || !Number.isFinite(tokenLimit)
    || tokenLimit < 5_000 || tokenLimit > 500_000 || !Number.isInteger(tokenLimit)
  )) return false;
  const modelProvider = value.modelProvider;
  const modelId = value.modelId;
  if (modelProvider !== undefined && modelProvider !== "openrouter") return false;
  if (modelId !== undefined && (
    typeof modelId !== "string" || modelId.length < 3 || modelId.length > 200
    || !/^[a-z0-9][a-z0-9._/-]{1,198}(?::[a-z0-9._-]+)?$/.test(modelId)
  )) return false;
  const scoutCandidateId = value.scoutCandidateId;
  if (scoutCandidateId !== undefined && (typeof scoutCandidateId !== "string" || !/^trg-[a-f0-9]{32}$/.test(scoutCandidateId))) return false;
  if (origin === "scout") {
    if (i !== "brief" || modelProvider !== "openrouter" || modelId !== MARKET_SCOUT_MODEL_ID || scoutCandidateId === undefined
      || pt !== undefined || tokenLimit !== undefined) return false;
  } else if (origin === "precache") {
    if (modelProvider !== undefined || modelId !== undefined || scoutCandidateId !== undefined) return false;
  } else if (modelProvider !== undefined || modelId !== undefined || scoutCandidateId !== undefined) {
    return false;
  }
  if (pt) {
    if (origin !== "precache" || tokenLimit === undefined || i !== "brief" || !/^v1\/paired\/[a-f0-9]{32}$/.test(String(rk))) return false;
    const pairedTarget = pt as PairedTarget;
    const expected = pairedPairKey(String(s), String(cs), pairedTarget.brief.researchKey, pairedTarget.why.researchKey);
    if (rk !== `v1/paired/${expected.slice("pair-".length)}`) return false;
  } else {
    // Single-strategy pre-cache jobs carry origin=precache and a token limit
    // with the exact interactive research key (never the synthetic v1/paired/
    // identity). Interactive jobs carry neither.
    const precacheSingle = origin === "precache";
    if (String(rk).startsWith("v1/paired/")) return false;
    if (precacheSingle && (
      typeof tokenLimit !== "number" || !Number.isFinite(tokenLimit)
      || tokenLimit < 5_000 || tokenLimit > 500_000 || !Number.isInteger(tokenLimit)
    )) return false;
    if (origin !== "scout" && !precacheSingle && (origin !== undefined || tokenLimit !== undefined)) return false;
  }
  return true;
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
  const toolName = rec.toolName;
  const error = rec.error;
  return (
    typeof o === "string" &&
    RESEARCH_OUTCOMES.has(o) &&
    typeof a === "string" &&
    RESEARCH_ACTIVITIES.has(a) &&
    (toolName === undefined || isNonEmptyString(toolName, 160)) &&
    (error === undefined || isBoundedString(error, 500))
  );
}

export function isWorkerCanvasEvent(
  value: unknown,
): value is WorkerCanvasEvent {
  if (!isWorkerEventHeader(value) || value.type !== "canvas") return false;
  const canvas = (value as unknown as Record<string, unknown>).canvas;
  // At minimum a canvas must carry bounded, JSON-safe terminal fields.
  return (
    isRecord(canvas) &&
    isNonEmptyString(canvas.symbol, 20) &&
    isNonEmptyString(canvas.title, 160) &&
    isBoundedString(canvas.content, MAX_CANVAS_CONTENT_CHARS) &&
    typeof canvas.updatedAt === "number" &&
    Number.isFinite(canvas.updatedAt) &&
    canvas.updatedAt > 0 &&
    canvas.updatedAt <= 9_000_000_000_000_000 &&
    (canvas.blocks === undefined || (Array.isArray(canvas.blocks) && canvas.blocks.length <= 12)) &&
    isBoundedJson(canvas)
  );
}

export function isWorkerSettledEvent(
  value: unknown,
): value is WorkerSettledEvent {
  if (!isWorkerEventHeader(value) || value.type !== "settled") return false;
  const rec = value as unknown as Record<string, unknown>;
  const o = rec.outcome;
  const baseValid = typeof o === "string" && SETTLED_OUTCOMES.has(o)
    && (rec.error === undefined || isBoundedString(rec.error, 500))
    && (rec.tokenGuard === undefined || typeof rec.tokenGuard === "boolean");
  if (!baseValid) return false;
  const usage = rec.usage;
  if (usage !== undefined && !isValidWorkerUsage(usage)) return false;
  return true;
}

export function isWorkerFatalEvent(
  value: unknown,
): value is WorkerFatalEvent {
  if (!isWorkerEventHeader(value) || value.type !== "fatal") return false;
  const err = (value as unknown as Record<string, unknown>).error;
  return isNonEmptyString(err, 500);
}

// ── Top-level event discriminator ─────────────────────────────────────────

export function isWorkerEvent(value: unknown): value is WorkerEvent {
  if (!isBoundedJson(value)) return false;
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
  if (!isRecord(value) || !isBoundedJson(value)) return false;
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
  return { version: 1, type: "run", jobId, attemptId, request: { ...request } };
}

export function makeCancelMessage(
  jobId: string,
  attemptId: string,
): WorkerCancelMessage {
  return { version: 1, type: "cancel", jobId, attemptId };
}
