/**
 * Authoritative worker-side checkpoint export.
 *
 * The checkpoint is built from the worker's OWN state — the extension's
 * canonical frame state (screen, symbol, scope, research, dossier, watchlist)
 * and a server-side event log accumulated from validated terminal messages.
 * The browser NEVER contributes checkpoint content; it only initiates the
 * opt-in. Everything is validated/serialized through the shared codec.
 */

import {
  validateCheckpoint,
  serializeCheckpoint,
  buildContinuationSummary,
  sanitizeCheckpoint,
  CHECKPOINT_MAX_EVENTS,
  CHECKPOINT_MAX_PACKETS_PER_CANVAS,
  CHECKPOINT_MAX_WATCHLIST,
  type CheckpointEvent,
  type CheckpointCanvas,
  type CheckpointPacket,
  type CheckpointContext,
  type CheckpointInterruptedWork,
  type FinancialTerminalCheckpoint,
} from "../shared/financial-workspace-checkpoint.js";

// ── Structural worker-state snapshot (subset of the extension's debugState) ─

export interface CheckpointResearchState {
  id?: string;
  contextLabel?: string;
  symbol?: string;
  outcome?: string;
  phase?: string;
  activity?: string;
  active?: boolean;
  updatedAt?: number;
}

export interface CheckpointWorkerPacket {
  sourceId?: string;
  sourceTitle?: string;
  sourceDomain?: string;
  sourceUrl?: string;
  retrievalStatus?: string;
  extractedAt?: number;
  excerpt?: string;
  failureNote?: string;
}

export interface CheckpointWorkerDossier {
  title?: string;
  intent?: string;
  stage?: string;
  summary?: string;
  summarySourceIds?: string[];
  evidenceStatus?: string;
  packets?: CheckpointWorkerPacket[];
}

/**
 * The subset of the worker's frame state that a checkpoint may legally carry.
 * The exporter only reads these fields; anything else is dropped.
 */
export interface CheckpointWorkerState {
  mode?: string;
  screen?: string;
  symbol?: string;
  chartScope?: string;
  searchQuery?: string;
  research?: CheckpointResearchState;
  researchQueue?: CheckpointResearchState[];
  dossier?: CheckpointWorkerDossier;
  /** WATCH-screen symbol list (authoritative watchlist). */
  available?: string[];
}

// ── Server-side event log (authoritative, not browser-sourced) ──────────────

export interface ServerCheckpointEventLog {
  events: CheckpointEvent[];
  researchRunCount: number;
  hasMeaningfulActivity: boolean;
}

export function createServerCheckpointEventLog(): ServerCheckpointEventLog {
  return { events: [], researchRunCount: 0, hasMeaningfulActivity: false };
}

/**
 * Clear a server-observed event log so no session's events bleed into the next
 * public principal/session boundary. Keeps the same object identity so the
 * worker's export closure keeps observing the (now empty) authoritative log.
 */
export function resetServerCheckpointEventLog(log: ServerCheckpointEventLog): void {
  log.events.length = 0;
  log.researchRunCount = 0;
  log.hasMeaningfulActivity = false;
}

/**
 * Record a semantic event observed by the worker server (from a validated
 * terminal message, not from the browser's rendering of it).
 */
export function recordServerCheckpointEvent(
  log: ServerCheckpointEventLog,
  type: CheckpointEvent["type"],
  data: Record<string, unknown>,
  now: number = Date.now(),
): void {
  if (log.events.length >= CHECKPOINT_MAX_EVENTS) return;
  log.events.push({ at: now, type, data });
  if (type === "prompt" || type === "command" || type === "navigate" || type === "research-start") {
    log.hasMeaningfulActivity = true;
  }
  if (type === "research-complete") {
    log.researchRunCount += 1;
  }
}

// ── Builder ─────────────────────────────────────────────────────────────────

export interface BuildAuthoritativeCheckpointOptions {
  state?: CheckpointWorkerState;
  sessionId: string;
  /** Worker generation observed for this session (authoritative). */
  generation: number;
  sourceRevision?: string;
  eventLog: ServerCheckpointEventLog;
  now?: number;
}

const RETRIEVAL_STATUS_KEYS = new Set(["fetched", "challenged", "limited", "failed"]);
const EVIDENCE_STATUS_KEYS = new Set(["pending", "available", "partial", "blocked", "none"]);
const CANVAS_INTENTS = new Set(["brief", "why"]);
const CANVAS_STAGES = new Set(["partial", "complete"]);
const CHART_SCOPES = new Set(["day", "week", "month", "year", "max"]);

function bounded(value: unknown, maximum: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!allowEmpty && value.length === 0) return undefined;
  return value.length <= maximum ? value : undefined;
}

function normalizeDossier(state: CheckpointWorkerState): CheckpointCanvas[] {
  const dossier = state.dossier;
  if (!dossier) return [];
  const packets: CheckpointPacket[] = [];
  for (const raw of dossier.packets ?? []) {
    const sourceId = bounded(raw.sourceId, 160);
    const sourceTitle = bounded(raw.sourceTitle, 512);
    const sourceDomain = bounded(raw.sourceDomain, 256);
    if (!sourceId || !sourceTitle || !sourceDomain) continue;
    const retrievalStatus = bounded(raw.retrievalStatus, 32) ?? "fetched";
    const packet: CheckpointPacket = {
      sourceId,
      sourceTitle,
      sourceDomain,
      ...(bounded(raw.excerpt, 4096, true) ? { excerpt: raw.excerpt! } : {}),
      retrievalStatus: RETRIEVAL_STATUS_KEYS.has(retrievalStatus) ? retrievalStatus : "fetched",
      extractedAt: Number.isFinite(raw.extractedAt) ? raw.extractedAt! : Date.now(),
    };
    packets.push(packet);
    if (packets.length >= CHECKPOINT_MAX_PACKETS_PER_CANVAS) break;
  }
  const id = bounded(dossier.title, 128, true) ?? `canvas-${Date.now().toString(36)}`;
  const canvas: CheckpointCanvas = {
    id,
    ...(bounded(dossier.title, 512, true) ? { title: dossier.title! } : {}),
    intent: dossier.intent && CANVAS_INTENTS.has(dossier.intent) ? dossier.intent as "brief" | "why" : "brief",
    stage: dossier.stage && CANVAS_STAGES.has(dossier.stage) ? dossier.stage as "partial" | "complete" : "partial",
    ...(bounded(dossier.summary, 8192, true) ? { summary: dossier.summary! } : {}),
    ...(Array.isArray(dossier.summarySourceIds)
      ? { summarySourceIds: dossier.summarySourceIds.slice(0, CHECKPOINT_MAX_PACKETS_PER_CANVAS) }
      : {}),
    evidenceStatus: dossier.evidenceStatus && EVIDENCE_STATUS_KEYS.has(dossier.evidenceStatus)
      ? dossier.evidenceStatus as CheckpointCanvas["evidenceStatus"]
      : "pending",
    packets,
  };
  return [canvas];
}

function normalizeContext(state: CheckpointWorkerState): CheckpointContext {
  const context: CheckpointContext = {};
  const screen = bounded(state.screen, 32);
  if (screen) context.screen = screen;
  const symbol = bounded(state.symbol, 32);
  if (symbol) context.symbol = symbol;
  if (state.chartScope && CHART_SCOPES.has(state.chartScope)) context.chartScope = state.chartScope;
  const searchQuery = bounded(state.searchQuery, 64, true);
  if (searchQuery !== undefined) context.searchQuery = searchQuery;
  if (Array.isArray(state.available) && state.available.length > 0) {
    const watchlist = state.available
      .filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 32)
      .slice(0, CHECKPOINT_MAX_WATCHLIST);
    if (watchlist.length > 0) context.watchlist = watchlist;
  }
  return context;
}

function normalizeInterruptedWork(state: CheckpointWorkerState): CheckpointInterruptedWork | undefined {
  const candidates = [
    state.research,
    ...(Array.isArray(state.researchQueue) ? state.researchQueue : []),
  ].filter((job): job is CheckpointResearchState => Boolean(job));
  const active = candidates.find((job) => job.active === true)
    ?? candidates.find((job) => job.phase === "queued" || job.phase === "dispatched" || job.phase === "running" || job.phase === "cancelling");
  if (!active) return undefined;
  return {
    activeResearch: {
      ...(bounded(active.symbol, 32) ? { symbol: active.symbol! } : {}),
      ...(bounded(active.contextLabel, 128, true) ? { contextLabel: active.contextLabel! } : {}),
      ...(bounded(active.activity, 64) ? { activity: active.activity! } : {}),
      ...(bounded(active.phase, 64) ? { phase: active.phase! } : {}),
      ...(Number.isFinite(active.updatedAt) && (active.updatedAt ?? 0) > 0 ? { startedAt: active.updatedAt! } : {}),
    },
  };
}

/**
 * Build a validated, serialized checkpoint from authoritative worker state.
 * Throws when the assembled checkpoint fails the shared codec validation.
 *
 * Field-level sanitization runs before validation: any packet/event/context
 * field carrying a probable secret is dropped so one tainted excerpt cannot
 * block a legitimate export, while identity fields (id/sessionId) and any
 * residue that survives sanitization are still hard-rejected by the codec.
 */
export function buildAuthoritativeCheckpoint(
  options: BuildAuthoritativeCheckpointOptions,
): FinancialTerminalCheckpoint {
  const now = options.now ?? Date.now();
  const state = options.state ?? {};
  const context = normalizeContext(state);
  const canvases = normalizeDossier(state);
  const interruptedWork = normalizeInterruptedWork(state);

  const checkpoint: FinancialTerminalCheckpoint = {
    version: 1,
    id: `checkpoint-${options.sessionId.slice(0, 24).replace(/[^A-Za-z0-9_-]/g, "")}-${now.toString(36)}`,
    source: {
      sessionId: options.sessionId,
      generation: options.generation,
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    },
    createdAt: now,
    // 1-hour unclaimed handoff retention.
    expiresAt: now + 60 * 60 * 1000,
    eventLog: options.eventLog.events.slice(0, CHECKPOINT_MAX_EVENTS),
    context,
    canvases,
    ...(interruptedWork ? { interruptedWork } : {}),
    continuationSummary: "",
  };

  const sanitized = sanitizeCheckpoint(checkpoint);
  sanitized.continuationSummary = buildContinuationSummary(sanitized);

  const validation = validateCheckpoint(sanitized);
  if (!validation.valid) {
    throw new Error(`authoritative checkpoint failed validation: ${validation.reason}`);
  }
  return validation.checkpoint;
}

export function serializeAuthoritativeCheckpoint(
  checkpoint: FinancialTerminalCheckpoint,
): string {
  return serializeCheckpoint(checkpoint);
}

/**
 * Deterministic bounded integer derived from an opaque worker-generation
 * string. Both the worker (when exporting) and the gateway (when requesting
 * that export) compute the same value, so the export can be authorized against
 * the exact assigned generation without leaking the generation string itself.
 */
export function workerGenerationEpoch(generation: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < generation.length; i += 1) {
    hash ^= generation.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash) % 2_000_000_000;
}
