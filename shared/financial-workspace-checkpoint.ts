/**
 * Financial Terminal Checkpoint v1 — canonical workspace transfer protocol.
 *
 * This module defines the checkpoint schema, validation, and sanitization rules
 * shared by the public gateway exporter and the private workspace importer.
 *
 * A checkpoint is an explicit, user-opted-in snapshot of the visible terminal
 * work. It NEVER contains raw Pi process logs, tool payloads, credentials,
 * ANSI rendering buffers, or internal system state.
 *
 * === CHECKPOINT V1 SCHEMA ===
 *
 * @version 1 — first deployment; additive fields allowed in future 1.x
 */

import { WATCHLIST_MAX_SYMBOLS } from "./watchlist-symbols.js";

/** Maximum serialized checkpoint size (bytes). Reject larger payloads. */
export const CHECKPOINT_MAX_BYTES = 512 * 1024; // 512 KB

/**
 * Worker-side private checkpoint-export path. The gateway calls this on the
 * assigned worker only for an active session/generation; it is never mounted
 * on a public listener and never reachable from the browser.
 */
export const CHECKPOINT_EXPORT_PATH = "/internal/financial-workspace/checkpoint-export";

/**
 * Workspace-service checkpoint-create path (gateway → workspace control).
 */
export const CHECKPOINT_CREATE_PATH = "/internal/financial-workspace/checkpoints";

/** Maximum event log entries retained in a checkpoint. */
export const CHECKPOINT_MAX_EVENTS = 1_000;

/** Maximum canvases retained in a checkpoint. */
export const CHECKPOINT_MAX_CANVASES = 50;

/** Maximum evidence packets per canvas. */
export const CHECKPOINT_MAX_PACKETS_PER_CANVAS = 200;

/** Maximum watchlist symbols. */
export const CHECKPOINT_MAX_WATCHLIST = WATCHLIST_MAX_SYMBOLS;

/** Bounded string lengths for checkpoint fields. */
const MAX_SYMBOL_LENGTH = 32;
const MAX_SCREEN_LENGTH = 32;
const MAX_PANE_LENGTH = 32;
const MAX_SEARCH_QUERY_LENGTH = 64;
const MAX_PACKET_TITLE_LENGTH = 512;
const MAX_PACKET_DOMAIN_LENGTH = 256;
const MAX_PACKET_EXCERPT_LENGTH = 4_096;
const MAX_PACKET_SOURCE_ID_LENGTH = 160;
const MAX_CANVAS_TITLE_LENGTH = 512;
const MAX_CANVAS_SUMMARY_LENGTH = 8_192;
const MAX_CITATION_QUOTE_LENGTH = 2_048;
const MAX_CONTINUATION_SUMMARY_LENGTH = 4_096;
const MAX_EVENT_DATA_STRING_LENGTH = 512;
const MAX_CANVAS_ID_LENGTH = 128;
const MAX_RETRIEVAL_STATUS_LENGTH = 32;
const MAX_EXTRACTION_MODE_LENGTH = 64;
const MAX_FAILURE_NOTE_LENGTH = 512;

// ──── Type Definitions ──────────────────────────────────────────────────────

export interface CheckpointEvent {
  at: number; // epoch ms
  type: "prompt" | "command" | "navigate" | "research-start" | "research-complete" | "research-failed";
  data: Record<string, unknown>;
}

export interface CheckpointPacket {
  sourceId: string;
  sourceTitle: string;
  sourceDomain: string;
  excerpt?: string;
  retrievalStatus: string;
  extractedAt: number;
}

export interface CheckpointCanvas {
  id: string;
  title?: string;
  intent: "brief" | "why";
  stage: "partial" | "complete";
  summary?: string;
  summarySourceIds?: string[];
  evidenceStatus: "pending" | "available" | "partial" | "blocked" | "none";
  packets: CheckpointPacket[];
}

export interface CheckpointContext {
  screen?: string;
  symbol?: string;
  chartScope?: string;
  pane?: string;
  searchQuery?: string;
  watchlist?: string[];
}

export interface CheckpointInterruptedWork {
  activeResearch?: {
    symbol?: string;
    contextLabel?: string;
    activity?: string;
    phase?: string;
    startedAt?: number;
  };
}

/**
 * The canonical checkpoint v1 payload.
 * Every field is bounded; unknown extra keys are silently dropped by validation.
 */
export interface FinancialTerminalCheckpoint {
  version: 1;
  id: string;
  source: {
    sessionId: string;
    generation: number;
    sourceRevision?: string;
  };
  createdAt: number;
  expiresAt: number;
  eventLog: CheckpointEvent[];
  context: CheckpointContext;
  canvases: CheckpointCanvas[];
  interruptedWork?: CheckpointInterruptedWork;
  continuationSummary: string;
}

// ──── Server-side handoff types ─────────────────────────────────────────────

export interface CheckpointCreateRequest {
  requestId: string;
  source: {
    sessionId: string;
    workerId: string;
    generation: number;
    sourceRevision?: string;
  };
  checkpoint: FinancialTerminalCheckpoint;
}

/**
 * Internal (normalized) checkpoint-create response used by the gateway.
 *
 * The WIRE format (canonical, see `parseCheckpointCreateResponse`) is
 * snake_case and carries `expires_at` as Unix epoch SECONDS. This internal
 * type is camelCase with `expiresAt` as epoch MILLISECONDS, matching every
 * other timestamp in this module (checkpoint `createdAt`/`expiresAt`,
 * `CheckpointEvent.at`).
 *
 * Wire → internal:
 *   checkpoint_id / checkpointId
 *   expires_at (seconds) → expiresAt (expires_at * 1000)
 *   handoff_id / handoffId
 *   handoff_secret / handoffSecret  (NEVER reaches browser JS)
 *   auth_url / authUrl
 */
export interface CheckpointCreateResponse {
  checkpointId: string;
  expiresAt: number; // epoch ms (normalized from wire epoch seconds)
  handoffId: string;
  handoffSecret: string; // NEVER reaches browser JS — set as HttpOnly cookie
  authUrl: string;
}

/**
 * Exact name of the HttpOnly handoff-secret cookie.
 *
 * The gateway sets it host-only on the public terminal origin
 * (`HttpOnly; Secure; SameSite=Lax; Path=/`; no `Domain` attribute unless
 * `FINANCIAL_WORKSPACE_HANDOFF_COOKIE_DOMAIN` is explicitly configured). The
 * workspace control plane reads it server-side during claim initiation and
 * never from JS, the body, or the URL. The infra side mirrors this constant in
 * `unchained/web_app/handlers/fin_workspace.py`.
 */
export const HANDOFF_SECRET_COOKIE_NAME = "fin-terminal-handoff-secret";

/** Version of the S2S checkpoint-create wire schema. */
export const CHECKPOINT_CREATE_WIRE_VERSION = 1;

export type ParsedCheckpointCreateResponse =
  | { ok: true; value: CheckpointCreateResponse }
  | { ok: false; reason: string };

/**
 * Strictly parse a workspace-service checkpoint-create response.
 *
 * The canonical wire schema is snake_case and emits `expires_at` as Unix
 * epoch SECONDS (the Python control plane's time base). For rollout
 * compatibility the camelCase spelling is also accepted and normalized to the
 * same internal type. Unknown fields are ignored; missing/ill-typed fields
 * reject the whole response so the gateway never forwards a broken handoff.
 */
export function parseCheckpointCreateResponse(value: unknown): ParsedCheckpointCreateResponse {
  if (!isRecord(value)) {
    return { ok: false, reason: "response must be a JSON object" };
  }
  const pick = (snake: string, camel: string): string | undefined => {
    const raw = typeof value[snake] === "string" ? value[snake] : value[camel];
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  };
  const checkpointId = pick("checkpoint_id", "checkpointId");
  const handoffId = pick("handoff_id", "handoffId");
  const handoffSecret = pick("handoff_secret", "handoffSecret");
  const authUrl = pick("auth_url", "authUrl");
  if (!checkpointId || !handoffId || !handoffSecret || !authUrl) {
    return { ok: false, reason: "checkpoint create response is missing required fields" };
  }
  // `expires_at` is Unix epoch SECONDS on the wire. Detect a millisecond value
  // (out of the seconds epoch range) and reject it rather than silently
  // producing a cookie that expires ~1000x too late.
  const rawExpires = value.expires_at ?? value.expiresAt;
  if (typeof rawExpires !== "number" || !Number.isFinite(rawExpires) || rawExpires <= 0) {
    return { ok: false, reason: "expires_at must be a positive epoch-seconds number" };
  }
  if (rawExpires > 9_000_000_000) {
    return { ok: false, reason: "expires_at is not an epoch-seconds timestamp" };
  }
  const expiresAt = Math.floor(rawExpires * 1000);
  return {
    ok: true,
    value: { checkpointId, expiresAt, handoffId, handoffSecret, authUrl },
  };
}

// ──── Validation ────────────────────────────────────────────────────────────

const VALID_EVENT_TYPES = new Set([
  "prompt",
  "command",
  "navigate",
  "research-start",
  "research-complete",
  "research-failed",
]);

const VALID_CANVAS_INTENTS = new Set(["brief", "why"]);
const VALID_CANVAS_STAGES = new Set(["partial", "complete"]);
const VALID_EVIDENCE_STATUSES = new Set([
  "pending",
  "available",
  "partial",
  "blocked",
  "none",
]);

const VALID_CHART_SCOPES = new Set(["day", "week", "month", "year", "max"]);
const VALID_SCREENS_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const VALID_PANES_PATTERN = /^[a-z]{1,32}$/;

/** Exclude shell injection, path traversal, and control sequences from checkpoint strings. */
const UNSAFE_STRING_PATTERN = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]|(?:\.\.\/)/;

/** Exclude URLs that are internal, loopback, or unsafe. */
const UNSAFE_URL_PATTERN =
  /^(?:https?:\/\/)?(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)(?::\d+)?(?:\/|$)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Portable UTF-8 byte-length (no Node `Buffer` dependency so this module can
 * be imported from both the server and the browser bundle).
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isBoundedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  if (typeof value !== "string") return false;
  if (!allowEmpty && value.length === 0) return false;
  return value.length <= maximum;
}

function isSafeString(value: unknown, maximum: number, allowEmpty = false): value is string {
  if (!isBoundedString(value, maximum, allowEmpty)) return false;
  return !UNSAFE_STRING_PATTERN.test(value);
}

function isSafeOptionalString(value: unknown, maximum: number): boolean {
  if (value === undefined || value === null) return true;
  return isSafeString(value, maximum, true);
}

function isSafeUrlLike(domain: string): boolean {
  return isSafeString(domain, MAX_PACKET_DOMAIN_LENGTH) && !UNSAFE_URL_PATTERN.test(domain);
}

function isInteger(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isArrayOf<T>(
  value: unknown,
  predicate: (item: unknown) => boolean,
  maxLength: number,
): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length > maxLength) return false;
  return value.every(predicate);
}

// ──── Canary / Secret Exclusion ─────────────────────────────────────────────

/**
 * Patterns that indicate a string very probably carries a live secret or
 * credential: an assignment of a value to a secret-like key, a natural-language
 * "my password is …" assignment, a high-entropy bearer/JWT/signed-opaque token,
 * a UUID-shaped worker generation, or one of our own signing/header names.
 *
 * Benign prose that merely mentions a keyword — a user prompt asking about a
 * "password reset policy", an excerpt quoting a company's "credential
 * requirements", or a headline about an "API key breach" — must export. Only
 * probable secret material (an actual value bound to a secret key, or a token
 * shape) is excluded.
 */
const SECRET_CANARY_PATTERNS = [
  // key=value / key: value assignment with a non-trivial secret value.
  /(?:api[_-]?key|apikey|passwd|password|secret|token|credential|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S{4,}/i,
  // Natural-language secret assignments ("my/your/the <kind> is <value>").
  /\b(?:my|your|the|our|their|his|her)\s+(?:api\s*key|password|passwd|passphrase|secret|credential)s?\s+(?:is|was|are|were|==)\s+[A-Za-z0-9._~+/=-]{6,}/i,
  // Bearer tokens and JWT / signed-opaque token shapes.
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /[A-Za-z0-9_-]{32,128}\.[A-Za-z0-9_-]{32,128}/,
  // Our own signing/header names (case-insensitive).
  /x-fin-terminal-(?:edge|proxy|worker)-token/i,
  /PUBLIC_SESSION_SIGNING_KEY/i,
  /PUBLIC_WORKER_PROXY_TOKEN/i,
  /PUBLIC_EDGE_PROXY_TOKEN/i,
  /TURNSTILE_SECRET/i,
  // UUID-like worker generation strings.
  /worker(?:-|_)?[a-z0-9]{8,}[-_][a-z0-9]{8,}[-_][a-z0-9]{8,}[-_][a-z0-9]{8,}/i,
  // Long-lived opaque ticket/session ids.
  /ticket(?:-|_)?[a-z0-9]{8,}/i,
  /session(?:-|_)?[a-z0-9]{16,}/i,
];

export function containsSecretCanary(value: string): boolean {
  return SECRET_CANARY_PATTERNS.some((pattern) => pattern.test(value));
}

// ──── Field Validators ──────────────────────────────────────────────────────

function validateEventLog(value: unknown): value is CheckpointEvent[] {
  if (!isArrayOf(value, isRecord, CHECKPOINT_MAX_EVENTS)) return false;
  return (value as unknown[]).every((item) => {
    const event = item as Record<string, unknown>;
    if (
      !VALID_EVENT_TYPES.has(String(event.type))
      || !isInteger(event.at, 0, 9_000_000_000_000)
      || !isRecord(event.data)
    ) {
      return false;
    }
    // Reject any event data containing secret-like patterns
    for (const v of Object.values(event.data)) {
      if (typeof v === "string" && containsSecretCanary(v)) return false;
      if (typeof v === "string" && v.length > MAX_EVENT_DATA_STRING_LENGTH) return false;
    }
    return true;
  });
}

function validateCheckpointPacket(packet: unknown): packet is CheckpointPacket {
  if (!isRecord(packet)) return false;
  if (
    !isSafeString(packet.sourceId, MAX_PACKET_SOURCE_ID_LENGTH)
    || !isSafeString(packet.sourceTitle, MAX_PACKET_TITLE_LENGTH)
    || !isSafeUrlLike(String(packet.sourceDomain))
    || !isSafeString(packet.retrievalStatus, MAX_RETRIEVAL_STATUS_LENGTH)
    || !isInteger(packet.extractedAt, 0, 9_000_000_000_000)
  ) {
    return false;
  }
  if (packet.excerpt !== undefined && packet.excerpt !== null) {
    if (!isSafeString(packet.excerpt, MAX_PACKET_EXCERPT_LENGTH, true)) return false;
  }
  // Validate any string field doesn't contain secrets
  for (const v of Object.values(packet)) {
    if (typeof v === "string" && containsSecretCanary(v)) return false;
  }
  return true;
}

function validateCanvas(value: unknown): value is CheckpointCanvas {
  if (!isRecord(value)) return false;
  if (
    !isSafeString(value.id, MAX_CANVAS_ID_LENGTH)
    || !VALID_CANVAS_INTENTS.has(String(value.intent))
    || !VALID_CANVAS_STAGES.has(String(value.stage))
    || !VALID_EVIDENCE_STATUSES.has(String(value.evidenceStatus))
    || !isArrayOf(value.packets, validateCheckpointPacket, CHECKPOINT_MAX_PACKETS_PER_CANVAS)
  ) {
    return false;
  }
  if (
    value.summary !== undefined
    && value.summary !== null
    && !isSafeString(value.summary, MAX_CANVAS_SUMMARY_LENGTH, true)
  ) {
    return false;
  }
  if (
    value.title !== undefined
    && value.title !== null
    && !isSafeString(value.title, MAX_CANVAS_TITLE_LENGTH, true)
  ) {
    return false;
  }
  // Validate no secrets in any canvas string
  for (const v of Object.values(value)) {
    if (typeof v === "string" && containsSecretCanary(v)) return false;
  }
  return true;
}

function validateContext(value: unknown): value is CheckpointContext {
  if (!isRecord(value)) return false;
  if (value.symbol !== undefined) {
    if (!isSafeString(value.symbol, MAX_SYMBOL_LENGTH)) return false;
  }
  if (value.screen !== undefined) {
    if (!VALID_SCREENS_PATTERN.test(String(value.screen))) return false;
  }
  if (value.chartScope !== undefined) {
    if (!VALID_CHART_SCOPES.has(String(value.chartScope))) return false;
  }
  if (value.pane !== undefined) {
    if (!VALID_PANES_PATTERN.test(String(value.pane))) return false;
  }
  if (value.searchQuery !== undefined) {
    if (!isSafeString(value.searchQuery, MAX_SEARCH_QUERY_LENGTH, true)) return false;
  }
  if (value.watchlist !== undefined) {
    if (!isArrayOf(value.watchlist, (s) => isSafeString(s, MAX_SYMBOL_LENGTH), CHECKPOINT_MAX_WATCHLIST)) {
      return false;
    }
  }
  return true;
}

function validateInterruptedWork(value: unknown): value is CheckpointInterruptedWork {
  if (!isRecord(value)) return false;
  if (value.activeResearch !== undefined && value.activeResearch !== null) {
    if (!isRecord(value.activeResearch)) return false;
    const ar = value.activeResearch as Record<string, unknown>;
    if (ar.symbol !== undefined && (!isSafeString(ar.symbol, MAX_SYMBOL_LENGTH) || containsSecretCanary(ar.symbol))) return false;
    if (ar.contextLabel !== undefined && (!isSafeString(ar.contextLabel, 128, true) || containsSecretCanary(ar.contextLabel))) return false;
    if (ar.activity !== undefined && (!isSafeString(ar.activity, 64) || containsSecretCanary(ar.activity))) return false;
    if (ar.phase !== undefined && (!isSafeString(ar.phase, 64) || containsSecretCanary(ar.phase))) return false;
    if (ar.startedAt !== undefined && !isInteger(ar.startedAt, 0, 9_000_000_000_000)) return false;
    // Fail closed on secret-like content in any string, including undeclared
    // fields, matching the canvas validator's whole-object scan.
    for (const v of Object.values(ar)) {
      if (typeof v === "string" && containsSecretCanary(v)) return false;
    }
  }
  return true;
}

// ──── Top-Level Validation ──────────────────────────────────────────────────

/**
 * Strictly validate a checkpoint payload. Returns a descriptive error string on
 * failure, or undefined if the checkpoint is valid.
 */
export function validateCheckpoint(value: unknown):
  | { valid: true; checkpoint: FinancialTerminalCheckpoint }
  | { valid: false; reason: string } {
  if (!isRecord(value)) return { valid: false, reason: "checkpoint must be a JSON object" };

  // Version gate
  if (value.version !== 1) {
    return { valid: false, reason: `unsupported checkpoint version ${String(value.version)}` };
  }

  // ID
  if (!isSafeString(value.id, 128)) {
    return { valid: false, reason: "checkpoint.id is required and must be a safe string" };
  }
  if (containsSecretCanary(value.id as string)) {
    return { valid: false, reason: "checkpoint.id contains prohibited content" };
  }

  // Source
  if (!isRecord(value.source)) {
    return { valid: false, reason: "checkpoint.source is required" };
  }
  if (!isSafeString(value.source.sessionId, 128)) {
    return { valid: false, reason: "checkpoint.source.sessionId is required" };
  }
  if (containsSecretCanary(value.source.sessionId as string)) {
    return { valid: false, reason: "checkpoint.source.sessionId contains prohibited content" };
  }
  if (!isInteger(value.source.generation, 0, 9_000_000_000_000)) {
    return { valid: false, reason: "checkpoint.source.generation must be a non-negative integer" };
  }
  if (
    value.source.sourceRevision !== undefined
    && !isSafeString(value.source.sourceRevision, 160, true)
  ) {
    return { valid: false, reason: "checkpoint.source.sourceRevision must be a safe string" };
  }

  // Creation / expiry
  if (!isInteger(value.createdAt, 0, 9_000_000_000_000)) {
    return { valid: false, reason: "checkpoint.createdAt must be a timestamp" };
  }
  if (!isInteger(value.expiresAt, 0, 9_000_000_000_000)) {
    return { valid: false, reason: "checkpoint.expiresAt must be a timestamp" };
  }
  if ((value.expiresAt as number) < (value.createdAt as number)) {
    return { valid: false, reason: "checkpoint.expiresAt must be after createdAt" };
  }

  // Event log
  if (!validateEventLog(value.eventLog)) {
    return { valid: false, reason: "checkpoint.eventLog exceeds bounds or contains invalid entries" };
  }

  // Context
  if (!validateContext(value.context)) {
    return { valid: false, reason: "checkpoint.context contains invalid fields" };
  }

  // Canvases
  if (!isArrayOf(value.canvases, validateCanvas, CHECKPOINT_MAX_CANVASES)) {
    return { valid: false, reason: "checkpoint.canvases exceeds bounds or contains invalid entries" };
  }

  // Interrupted work (optional)
  if (value.interruptedWork !== undefined && value.interruptedWork !== null) {
    if (!validateInterruptedWork(value.interruptedWork)) {
      return { valid: false, reason: "checkpoint.interruptedWork is invalid" };
    }
  }

  // Continuation summary
  if (!isSafeString(value.continuationSummary, MAX_CONTINUATION_SUMMARY_LENGTH, true)) {
    return { valid: false, reason: "checkpoint.continuationSummary is required" };
  }
  if (containsSecretCanary(value.continuationSummary)) {
    return { valid: false, reason: "checkpoint.continuationSummary contains prohibited content" };
  }

  // Size gate
  const serialized = JSON.stringify(value);
  if (utf8ByteLength(serialized) > CHECKPOINT_MAX_BYTES) {
    return { valid: false, reason: `checkpoint exceeds ${CHECKPOINT_MAX_BYTES} bytes` };
  }

  return { valid: true, checkpoint: value as unknown as FinancialTerminalCheckpoint };
}

// ──── Round-Trip Strip (keep known fields, drop any attackers attempt to inject) ──

/**
 * Serialize a valid checkpoint. Extra fields are silently dropped.
 * This function assumes the checkpoint has already passed validation.
 */
export function serializeCheckpoint(checkpoint: FinancialTerminalCheckpoint): string {
  // Reconstruct from known fields to ensure no extra data sneaks through
  const clean: FinancialTerminalCheckpoint = {
    version: 1,
    id: checkpoint.id,
    source: {
      sessionId: checkpoint.source.sessionId,
      generation: checkpoint.source.generation,
      ...(checkpoint.source.sourceRevision
        ? { sourceRevision: checkpoint.source.sourceRevision }
        : {}),
    },
    createdAt: checkpoint.createdAt,
    expiresAt: checkpoint.expiresAt,
    eventLog: checkpoint.eventLog.slice(0, CHECKPOINT_MAX_EVENTS),
    context: {
      ...(checkpoint.context.screen ? { screen: checkpoint.context.screen } : {}),
      ...(checkpoint.context.symbol ? { symbol: checkpoint.context.symbol } : {}),
      ...(checkpoint.context.chartScope ? { chartScope: checkpoint.context.chartScope } : {}),
      ...(checkpoint.context.pane ? { pane: checkpoint.context.pane } : {}),
      ...(checkpoint.context.searchQuery ? { searchQuery: checkpoint.context.searchQuery } : {}),
       ...(checkpoint.context.watchlist !== undefined
         ? { watchlist: checkpoint.context.watchlist.slice(0, CHECKPOINT_MAX_WATCHLIST) }
        : {}),
    },
    canvases: checkpoint.canvases.slice(0, CHECKPOINT_MAX_CANVASES).map((canvas) => ({
      id: canvas.id,
      ...(canvas.title ? { title: canvas.title } : {}),
      intent: canvas.intent,
      stage: canvas.stage,
      ...(canvas.summary ? { summary: canvas.summary } : {}),
      ...(canvas.summarySourceIds?.length
        ? { summarySourceIds: canvas.summarySourceIds.slice(0, CHECKPOINT_MAX_PACKETS_PER_CANVAS) }
        : {}),
      evidenceStatus: canvas.evidenceStatus,
      packets: canvas.packets.slice(0, CHECKPOINT_MAX_PACKETS_PER_CANVAS).map((packet) => ({
        sourceId: packet.sourceId,
        sourceTitle: packet.sourceTitle,
        sourceDomain: packet.sourceDomain,
        ...(packet.excerpt ? { excerpt: packet.excerpt } : {}),
        retrievalStatus: packet.retrievalStatus,
        extractedAt: packet.extractedAt,
      })),
    })),
    ...(checkpoint.interruptedWork
      ? {
          interruptedWork: {
            ...(checkpoint.interruptedWork.activeResearch
              ? {
                  activeResearch: {
                    ...(checkpoint.interruptedWork.activeResearch.symbol
                      ? { symbol: checkpoint.interruptedWork.activeResearch.symbol }
                      : {}),
                    ...(checkpoint.interruptedWork.activeResearch.contextLabel
                      ? { contextLabel: checkpoint.interruptedWork.activeResearch.contextLabel }
                      : {}),
                    ...(checkpoint.interruptedWork.activeResearch.activity
                      ? { activity: checkpoint.interruptedWork.activeResearch.activity }
                      : {}),
                    ...(checkpoint.interruptedWork.activeResearch.phase
                      ? { phase: checkpoint.interruptedWork.activeResearch.phase }
                      : {}),
                    ...(checkpoint.interruptedWork.activeResearch.startedAt !== undefined
                      ? { startedAt: checkpoint.interruptedWork.activeResearch.startedAt }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    continuationSummary: checkpoint.continuationSummary,
  };
  return JSON.stringify(clean);
}

// ──── Field Sanitization ─────────────────────────────────────────────────────

/**
 * Drop every checkpoint field whose value contains a probable secret, so a
 * single tainted excerpt or event value cannot take down an otherwise valid
 * export. Identity fields (`id`, `source.sessionId`, `source.sourceRevision`)
 * are intentionally NOT sanitized — a secret there is a hard validation
 * failure. The result still passes `validateCheckpoint` (which remains the
 * final defense-in-depth gate).
 */
export function sanitizeCheckpoint(
  checkpoint: FinancialTerminalCheckpoint,
): FinancialTerminalCheckpoint {
  const eventLog: CheckpointEvent[] = checkpoint.eventLog.map((event) => {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event.data)) {
      if (typeof value === "string" && containsSecretCanary(value)) continue;
      data[key] = value;
    }
    return { ...event, data };
  });

  const context: CheckpointContext = { ...checkpoint.context };
  if (typeof context.symbol === "string" && containsSecretCanary(context.symbol)) {
    delete context.symbol;
  }
  if (typeof context.searchQuery === "string" && containsSecretCanary(context.searchQuery)) {
    delete context.searchQuery;
  }
  if (context.watchlist !== undefined) {
    const watchlist = context.watchlist.filter((symbol) => !containsSecretCanary(symbol));
    if (watchlist.length > 0 || context.watchlist.length === 0) context.watchlist = watchlist;
    else delete context.watchlist;
  }

  const canvases: CheckpointCanvas[] = checkpoint.canvases
    .map((canvas): CheckpointCanvas | undefined => {
      if (containsSecretCanary(canvas.id)) return undefined;
      const packets: CheckpointPacket[] = [];
      for (const packet of canvas.packets) {
        if (
          containsSecretCanary(packet.sourceId)
          || containsSecretCanary(packet.sourceTitle)
          || containsSecretCanary(packet.sourceDomain)
        ) {
          continue; // required packet fields tainted → drop the packet
        }
        packets.push({
          ...packet,
          ...(packet.excerpt !== undefined && containsSecretCanary(packet.excerpt)
            ? { excerpt: undefined }
            : {}),
        } as CheckpointPacket);
      }
      const clean: CheckpointCanvas = {
        id: canvas.id,
        intent: canvas.intent,
        stage: canvas.stage,
        evidenceStatus: canvas.evidenceStatus,
        packets,
        ...(canvas.title !== undefined && !containsSecretCanary(canvas.title)
          ? { title: canvas.title }
          : {}),
        ...(canvas.summary !== undefined && !containsSecretCanary(canvas.summary)
          ? { summary: canvas.summary }
          : {}),
        ...(canvas.summarySourceIds !== undefined
          ? {
              summarySourceIds: canvas.summarySourceIds.filter(
                (sourceId) => !containsSecretCanary(sourceId),
              ),
            }
          : {}),
      };
      if (clean.summarySourceIds !== undefined && clean.summarySourceIds.length === 0) {
        delete clean.summarySourceIds;
      }
      return clean;
    })
    .filter((canvas): canvas is CheckpointCanvas => canvas !== undefined);

  let interruptedWork: CheckpointInterruptedWork | undefined = checkpoint.interruptedWork;
  if (interruptedWork?.activeResearch) {
    const active = interruptedWork.activeResearch;
    const cleanActive: NonNullable<CheckpointInterruptedWork["activeResearch"]> = {};
    if (active.symbol !== undefined && !containsSecretCanary(active.symbol)) {
      cleanActive.symbol = active.symbol;
    }
    if (active.contextLabel !== undefined && !containsSecretCanary(active.contextLabel)) {
      cleanActive.contextLabel = active.contextLabel;
    }
    if (active.activity !== undefined && !containsSecretCanary(active.activity)) {
      cleanActive.activity = active.activity;
    }
    if (active.phase !== undefined && !containsSecretCanary(active.phase)) {
      cleanActive.phase = active.phase;
    }
    if (active.startedAt !== undefined) cleanActive.startedAt = active.startedAt;
    interruptedWork = { activeResearch: cleanActive };
  }

  let continuationSummary = checkpoint.continuationSummary;
  if (containsSecretCanary(continuationSummary)) {
    continuationSummary = "Continue from a saved checkpoint.";
  }

  return {
    ...checkpoint,
    eventLog,
    context,
    canvases,
    ...(interruptedWork ? { interruptedWork } : {}),
    continuationSummary,
  };
}

// ──── Continuation Summary Builder ──────────────────────────────────────────

/**
 * Build a deterministic continuation summary from the semantic event projection.
 * This is the text displayed when a user re-opens the checkpoint in a private workspace.
 */
export function buildContinuationSummary(checkpoint: FinancialTerminalCheckpoint): string {
  const lines: string[] = [];

  const researchCount = checkpoint.eventLog.filter(
    (e) => e.type === "research-complete",
  ).length;
  const failedResearch = checkpoint.eventLog.filter(
    (e) => e.type === "research-failed",
  ).length;
  const promptCount = checkpoint.eventLog.filter((e) => e.type === "prompt").length;

  if (checkpoint.context.symbol) {
    lines.push(`Continue from a saved checkpoint: ${checkpoint.context.symbol}`);
  } else {
    lines.push("Continue from a saved checkpoint");
  }

  if (checkpoint.canvases.length > 0) {
    const completed = checkpoint.canvases.filter((c) => c.stage === "complete").length;
    const partial = checkpoint.canvases.filter((c) => c.stage === "partial").length;
    const sections: string[] = [];
    if (completed > 0) sections.push(`${completed} completed`);
    if (partial > 0) sections.push(`${partial} partial`);
    lines.push(`Research: ${sections.join(", ")} canvas${checkpoint.canvases.length !== 1 ? "es" : ""}`);
  }

  if (researchCount > 0) {
    lines.push(`${researchCount} research run${researchCount !== 1 ? "s" : ""} completed`);
  }
  if (failedResearch > 0) {
    lines.push(`${failedResearch} research attempt${failedResearch !== 1 ? "s" : ""} failed`);
  }
  if (promptCount > 0) {
    lines.push(`${promptCount} user prompt${promptCount !== 1 ? "s" : ""} submitted`);
  }

  if (checkpoint.interruptedWork?.activeResearch) {
    const ar = checkpoint.interruptedWork.activeResearch;
    const label = ar.contextLabel ?? ar.symbol ?? "unknown";
    lines.push(`Interrupted research on ${label} — state available for continuation`);
  }

  if (checkpoint.context.watchlist && checkpoint.context.watchlist.length > 0) {
    lines.push(
      `Watchlist: ${checkpoint.context.watchlist.slice(0, 10).join(", ")}${
        checkpoint.context.watchlist.length > 10 ? "…" : ""
      }`,
    );
  }

  const canvasTitles = checkpoint.canvases
    .filter((c) => c.title)
    .map((c) => c.title!);
  if (canvasTitles.length > 0) {
    lines.push(`Saved canvases: ${canvasTitles.join(", ")}`);
  }

  return lines.join(". ") + ".";
}

// ──── Feature Flag ──────────────────────────────────────────────────────────

/** Portable process-env shaped object (avoids a Node-only dependency). */
export type WorkspaceEnv = { [key: string]: string | undefined };

/**
 * Default env source for the helpers below. When called from Node (server)
 * with no explicit env they must read the real `process.env`; in a browser
 * bundle there is no `process` so the default is an empty object. This is
 * what makes a bare `isWorkspaceCheckpointEnabled()` in `server/index.ts`
 * actually see the container's `FINANCIAL_WORKSPACE_CHECKPOINTS`.
 */
function defaultEnv(): WorkspaceEnv {
  const nodeEnv = (globalThis as { process?: { env?: WorkspaceEnv } }).process?.env;
  return nodeEnv ?? {};
}

/**
 * Check if financial workspace checkpoints are enabled in this deployment.
 * Feature-gated: requires explicit opt-in via env var. Accepts the boolean
 * spellings used by Compose interpolation (`1`, `true`, `yes`) so the same
 * master flag can drive both the control plane and the gateway without a
 * separate translation layer.
 */
export function isWorkspaceCheckpointEnabled(env: WorkspaceEnv = defaultEnv()): boolean {
  return /^(?:1|true|yes)$/i.test((env.FINANCIAL_WORKSPACE_CHECKPOINTS ?? "").trim());
}

/**
 * Optional parent domain for the HttpOnly handoff-secret cookie.
 *
 * The gateway and the workspace control plane share the public terminal host
 * (`unbrowser.unchainedsky.com`), so the default host-only cookie (no
 * `Domain` attribute) is already sent on every path of that host — including
 * `/fin-terminal-workspace/*`. Only set this when the two surfaces are ever
 * split across different subdomains.
 */
export function handoffCookieDomain(env: WorkspaceEnv = defaultEnv()): string | undefined {
  const domain = env.FINANCIAL_WORKSPACE_HANDOFF_COOKIE_DOMAIN?.trim();
  if (!domain) return undefined;
  return domain.startsWith(".") ? domain : `.${domain}`;
}

/**
 * Resolve the internal workspace service URL from env (or undefined if disabled).
 */
export function workspaceServiceUrl(env: WorkspaceEnv = defaultEnv()): string | undefined {
  const url = env.FINANCIAL_WORKSPACE_SERVICE_URL?.trim();
  if (!url) return undefined;
  try {
    new URL(url);
    return url;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the bearer control token for server-to-server communication.
 * This token NEVER reaches the browser.
 *
 * Canonical spelling: `FIN_WORKSPACE_CONTROL_TOKEN` (used by the control
 * plane and the host-side runtime provider). The gateway deployment passes
 * `FINANCIAL_WORKSPACE_CONTROL_TOKEN` (derived from the same value), which is
 * accepted as an alias so both the private runtime and the public gateway
 * resolve the same shared secret.
 */
export function workspaceControlToken(env: WorkspaceEnv = defaultEnv()): string | undefined {
  const token = (
    env.FIN_WORKSPACE_CONTROL_TOKEN?.trim()
    || env.FINANCIAL_WORKSPACE_CONTROL_TOKEN?.trim()
  );
  if (!token || token.length < 32) return undefined;
  return token;
}
