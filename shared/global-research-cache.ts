/**
 * Runtime-neutral global research cache contract.
 *
 * One private background runner owns writes. Authenticated browser sessions
 * get read-only exact-identity hits. Account archives stay private and are
 * never merged into this store.
 *
 * This module is framework-free and browser-safe: no node imports, no
 * process.env, no Pi SDK.
 */

import { CHART_SCOPE_CONFIGS, type ChartScope } from "./kernel/quotes.js";
import type { Canvas, EvidencePacket, ResearchIntent } from "./kernel/technicals.js";
import { sanitizePublicUrl } from "./public-url.js";
import { normalizeWatchlistSymbol } from "./watchlist-symbols.js";

export const GLOBAL_CACHE_SCHEMA_VERSION = 1;
export const GLOBAL_CACHE_PRODUCER = "global-scout-runner/v1";
export const GLOBAL_CACHE_PROMPT_CONTRACT = "scout-canonical-brief/v1";
export const GLOBAL_CACHE_POLICY_VERSION = "quality-public/v1";

export type GlobalCacheKind = "ticker-brief" | "macro-event-brief" | "market-story-brief";

export interface GlobalCacheIdentity {
  symbol: string;
  chartScope: ChartScope;
  researchKey: string;
  intent: ResearchIntent;
}

export interface GlobalCacheProvenance {
  candidateId: string;
  decisionId: string;
  sourceId: string;
  sourceUrl?: string;
  title: string;
  publishedAt?: number;
  observedAt: number;
}

export interface GlobalCacheQuality {
  usable: boolean;
  codes: string[];
  fetchedCount: number;
  qualityVersion: number;
}

export interface GlobalCacheEntry {
  schema: typeof GLOBAL_CACHE_SCHEMA_VERSION;
  producer: string;
  cacheKey: string;
  identity: GlobalCacheIdentity;
  kind: GlobalCacheKind;
  canvas: Canvas;
  quality: GlobalCacheQuality;
  provenance: GlobalCacheProvenance;
  asOf: number;
  generatedAt: number;
  expiresAt: number;
  promptContract: string;
  policyVersion: string;
}

const CANDIDATE_ID_PATTERN = /^trg-[a-f0-9]{32}$/;
const DECISION_ID_PATTERN = /^evt-[a-f0-9]{32}$/;
const SOURCE_ID_PATTERN = /^[a-z0-9-]{1,80}$/;
const RESEARCH_KEY_PATTERN = /^v1\/(ticker\/brief|market\/events\/macro\/brief|market\/story\/brief)$/;

export function normalizeGlobalCacheSymbol(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "MARKET") return "MARKET";
  return normalizeWatchlistSymbol(trimmed);
}

function isValidChartScope(value: string): value is ChartScope {
  return Object.hasOwn(CHART_SCOPE_CONFIGS, value);
}

export function globalCacheKindForResearchKey(researchKey: string): GlobalCacheKind | undefined {
  if (researchKey === "v1/ticker/brief") return "ticker-brief";
  if (researchKey === "v1/market/events/macro/brief") return "macro-event-brief";
  if (researchKey === "v1/market/story/brief") return "market-story-brief";
  return undefined;
}

export function validateGlobalCacheIdentity(value: unknown): value is GlobalCacheIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.symbol !== "string" || normalizeGlobalCacheSymbol(raw.symbol) !== raw.symbol) return false;
  if (typeof raw.chartScope !== "string" || !isValidChartScope(raw.chartScope)) return false;
  if (typeof raw.researchKey !== "string" || !RESEARCH_KEY_PATTERN.test(raw.researchKey)) return false;
  if (raw.intent !== "brief") return false;
  const kind = globalCacheKindForResearchKey(raw.researchKey);
  if (!kind) return false;
  if (kind === "ticker-brief" && raw.symbol === "MARKET") return false;
  if (kind !== "ticker-brief" && raw.symbol !== "MARKET") return false;
  return true;
}

export function globalCacheKey(identity: GlobalCacheIdentity): string {
  return [identity.symbol, identity.chartScope, identity.researchKey, identity.intent].join("|");
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** TTL is versioned policy, not truth: ticker 2h, macro/story 4h, capped by trigger validity. */
export function resolveGlobalCacheExpiry(options: {
  generatedAt: number;
  kind: GlobalCacheKind;
  candidateExpiresAt: number;
}): number {
  const ttlMs = options.kind === "ticker-brief" ? 2 * 60 * 60_000 : 4 * 60 * 60_000;
  return Math.min(options.generatedAt + ttlMs, options.candidateExpiresAt);
}

function isPublicEvidencePacket(packet: EvidencePacket): boolean {
  if (packet.retrievalStatus !== "fetched") return false;
  if (!packet.sourceUrl || sanitizePublicUrl(packet.sourceUrl) !== packet.sourceUrl) return false;
  if (!packet.sourceUrl.startsWith("https://")) return false;
  return true;
}

function validateProvenance(raw: unknown): raw is GlobalCacheProvenance {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  if (typeof value.candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(value.candidateId)) return false;
  if (typeof value.decisionId !== "string" || !DECISION_ID_PATTERN.test(value.decisionId)) return false;
  if (typeof value.sourceId !== "string" || !SOURCE_ID_PATTERN.test(value.sourceId)) return false;
  if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 500) return false;
  if (value.sourceUrl !== undefined && (typeof value.sourceUrl !== "string" || sanitizePublicUrl(value.sourceUrl) !== value.sourceUrl)) return false;
  if (value.publishedAt !== undefined && !validInteger(value.publishedAt, 1, Number.MAX_SAFE_INTEGER)) return false;
  if (!validInteger(value.observedAt, 1, Number.MAX_SAFE_INTEGER)) return false;
  return true;
}

function validateQuality(raw: unknown): raw is GlobalCacheQuality {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  if (typeof value.usable !== "boolean" || !value.usable) return false;
  if (!Array.isArray(value.codes)) return false;
  if (!validInteger(value.fetchedCount, 1, 10_000)) return false;
  if (!validInteger(value.qualityVersion, 1, 1_000)) return false;
  return true;
}

const ALLOWED_CANVAS_KEYS = new Set([
  "symbol",
  "title",
  "content",
  "blocks",
  "updatedAt",
  "stage",
  "chartScope",
  "researchKey",
  "intent",
  "contextLabel",
  "evidencePackets",
]);

const ALLOWED_PACKET_KEYS = new Set([
  "sourceId",
  "sourceTitle",
  "sourceDomain",
  "sourceUrl",
  "excerpt",
  "retrievalStatus",
  "extractedAt",
  "extractionMode",
  "truncated",
]);

const ALLOWED_BLOCK_KEYS: Record<string, Set<string>> = {
  // Note: free-form "text" blocks are deliberately not publishable. Prose
  // outside cited items cannot be mechanically bound to evidence, so global
  // briefs must carry facts in cited bullets/news/metrics/table rows.
  metrics: new Set(["id", "kind", "title", "items", "sourceIds", "dossierHint"]),
  table: new Set(["id", "kind", "title", "columns", "rows", "totalRows", "sourceIds", "dossierHint"]),
  news: new Set(["id", "kind", "title", "items", "sourceIds", "dossierHint"]),
  bullets: new Set(["id", "kind", "title", "items", "sourceIds", "dossierHint"]),
  sources: new Set(["id", "kind", "title", "items", "sourceIds", "dossierHint"]),
  chart: new Set([
    "id", "kind", "title", "symbol", "points", "pointTimes", "pointSessions", "reference",
    "interval", "timezone", "currency", "asOf", "format", "minValue", "maxValue", "height",
    "chartStyle", "chartScope", "annotations", "sourceIds", "dossierHint",
  ]),
};

const ALLOWED_ITEM_KEYS: Record<string, Set<string>> = {
  bullets: new Set(["text", "role", "sourceIds"]),
  news: new Set(["headline", "source", "url", "note", "sourceIds"]),
  metrics: new Set(["label", "value", "delta", "note", "sourceIds"]),
  sources: new Set(["id", "label", "url", "status"]),
};

const BULLET_ROLES = new Set(["fact", "interpretation", "risk", "catalyst"]);
const ANNOTATION_ROLES = new Set(["support", "resistance", "signal"]);

// Length caps mirror the extension's canvas block schema so oversized or
// smuggled payloads fail closed instead of reaching another account.
const FIELD_LENGTH_CAPS: Record<string, number> = {
  text: 4_000,
  headline: 500,
  note: 4_000,
  label: 160,
  value: 160,
  source: 160,
  delta: 160,
};

function urlHost(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isCitedIds(value: unknown, fetchedIds: Set<string>): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((id) => typeof id === "string" && fetchedIds.has(id));
}

function isBoundedUrl(value: unknown, fetchedHosts: Set<string>): boolean {
  if (typeof value !== "string" || sanitizePublicUrl(value) !== value || !value.startsWith("https://")) return false;
  const host = urlHost(value);
  return Boolean(host && fetchedHosts.has(host));
}

function isCappedString(value: unknown, field: string): boolean {
  const cap = FIELD_LENGTH_CAPS[field];
  return typeof value === "string" && cap !== undefined && value.length <= cap;
}

/**
 * Deep block audit against fetched public evidence. Block kinds and every
 * nested item shape are key-allowlisted; every item in bullets/news/metrics
 * must carry its own fetched citation (one cited item cannot launder uncited
 * siblings); every URL must be sanitized-public https on a fetched evidence
 * domain; table/chart/sources blocks cite at block level.
 */
function auditBlocks(blocks: unknown, fetchedIds: Set<string>, fetchedHosts: Set<string>): boolean {
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  let readBlocks = 0;
  for (const rawBlock of blocks) {
    if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) return false;
    const block = rawBlock as Record<string, unknown>;
    if (typeof block.kind !== "string") return false;
    const allowed = ALLOWED_BLOCK_KEYS[block.kind];
    if (!allowed) return false;
    for (const key of Object.keys(block)) {
      if (!allowed.has(key)) return false;
    }
    if (typeof block.title !== "string" || block.title.length > 160) return false;
    if (block.dossierHint === "read") readBlocks += 1;
    if (block.sourceIds !== undefined && !isCitedIds(block.sourceIds, fetchedIds)) return false;

    if (block.kind === "bullets" || block.kind === "news" || block.kind === "metrics") {
      if (!Array.isArray(block.items) || block.items.length === 0) return false;
      const itemKeys = ALLOWED_ITEM_KEYS[block.kind]!;
      for (const rawItem of block.items) {
        if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return false;
        const item = rawItem as Record<string, unknown>;
        for (const key of Object.keys(item)) {
          if (!itemKeys.has(key)) return false;
        }
        // Per-item citation: no laundering through cited siblings.
        if (!isCitedIds(item.sourceIds, fetchedIds)) return false;
        if (block.kind === "bullets") {
          if (!isCappedString(item.text, "text")) return false;
          if (item.role !== undefined && (typeof item.role !== "string" || !BULLET_ROLES.has(item.role))) return false;
        } else if (block.kind === "news") {
          if (!isCappedString(item.headline, "headline")) return false;
          if (item.source !== undefined && !isCappedString(item.source, "source")) return false;
          if (item.note !== undefined && !isCappedString(item.note, "note")) return false;
          if (item.url !== undefined && !isBoundedUrl(item.url, fetchedHosts)) return false;
        } else {
          if (!isCappedString(item.label, "label")) return false;
          if (!isCappedString(item.value, "value")) return false;
          if (item.delta !== undefined && !isCappedString(item.delta, "delta")) return false;
          if (item.note !== undefined && !isCappedString(item.note, "note")) return false;
        }
      }
    } else if (block.kind === "table") {
      if (!Array.isArray(block.columns) || block.columns.length < 1 || block.columns.length > 8) return false;
      if (!block.columns.every((column) => typeof column === "string" && column.length <= 160)) return false;
      if (!Array.isArray(block.rows) || block.rows.length > 12) return false;
      for (const row of block.rows) {
        if (!Array.isArray(row) || row.length > 8) return false;
        if (!row.every((cell) => typeof cell === "string" && cell.length <= 160)) return false;
      }
      if (block.totalRows !== undefined && !(typeof block.totalRows === "number" && Number.isFinite(block.totalRows))) return false;
      if (!isCitedIds(block.sourceIds, fetchedIds)) return false;
    } else if (block.kind === "sources") {
      if (!Array.isArray(block.items) || block.items.length === 0) return false;
      for (const rawItem of block.items) {
        if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return false;
        const item = rawItem as Record<string, unknown>;
        for (const key of Object.keys(item)) {
          if (!ALLOWED_ITEM_KEYS.sources!.has(key)) return false;
        }
        // Listed sources must be the fetched evidence set, not a reopened
        // door to unfetched origins.
        if (typeof item.id !== "string" || !fetchedIds.has(item.id)) return false;
        if (item.label !== undefined && (typeof item.label !== "string" || item.label.length > 160)) return false;
        if (item.url !== undefined && !isBoundedUrl(item.url, fetchedHosts)) return false;
        if (item.status !== undefined && item.status !== "fetched") return false;
      }
    } else if (block.kind === "chart") {
      if (block.points !== undefined) {
        if (!Array.isArray(block.points) || !block.points.every((point) => typeof point === "number" && Number.isFinite(point))) return false;
      }
      if (block.annotations !== undefined) {
        if (!Array.isArray(block.annotations)) return false;
        for (const rawAnnotation of block.annotations) {
          if (!rawAnnotation || typeof rawAnnotation !== "object" || Array.isArray(rawAnnotation)) return false;
          const annotation = rawAnnotation as Record<string, unknown>;
          for (const key of Object.keys(annotation)) {
            if (key !== "label" && key !== "value" && key !== "role") return false;
          }
          if (annotation.label !== undefined && (typeof annotation.label !== "string" || annotation.label.length > 160)) return false;
          if (annotation.value !== undefined && (typeof annotation.value !== "number" || !Number.isFinite(annotation.value))) return false;
          if (annotation.role !== undefined && (typeof annotation.role !== "string" || !ANNOTATION_ROLES.has(annotation.role))) return false;
        }
      }
      for (const key of ["symbol", "interval", "timezone", "currency", "format", "chartStyle", "chartScope"] as const) {
        if (block[key] !== undefined && typeof block[key] !== "string") return false;
      }
      if (!isCitedIds(block.sourceIds, fetchedIds)) return false;
    }
  }
  // At least one read block anchors the brief to cited evidence, mirroring
  // the extension's exactly-one-read quality bar (one side enforces >= 1).
  return readBlocks >= 1;
}

/**
 * Publishable canvas projection: only the fields a browser may see, only
 * fetched public evidence, and every cited sourceId linked to fetched
 * evidence. Returns undefined when the canvas cannot be published as-is.
 * Internal fields (researchId, evidenceBlocker, evidenceCitations,
 * failure notes, non-fetched packets) never cross the account boundary.
 */
export function sanitizeGlobalCacheCanvas(raw: unknown): Canvas | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const canvas = raw as Record<string, unknown>;
  for (const key of Object.keys(canvas)) {
    if (!ALLOWED_CANVAS_KEYS.has(key)) return undefined;
  }
  if (typeof canvas.symbol !== "string" || typeof canvas.title !== "string") return undefined;
  if (canvas.title.length < 1 || canvas.title.length > 500) return undefined;
  // Publishable briefs carry facts in cited blocks only; free-form content
  // prose cannot be bound to evidence and never publishes.
  if (canvas.content !== "") return undefined;
  if (canvas.stage !== "complete") return undefined;
  if (!validInteger(canvas.updatedAt, 1, Number.MAX_SAFE_INTEGER)) return undefined;
  if (!Array.isArray(canvas.evidencePackets) || canvas.evidencePackets.length === 0) return undefined;
  const packets: EvidencePacket[] = [];
  for (const rawPacket of canvas.evidencePackets) {
    if (!rawPacket || typeof rawPacket !== "object" || Array.isArray(rawPacket)) return undefined;
    for (const key of Object.keys(rawPacket as Record<string, unknown>)) {
      if (!ALLOWED_PACKET_KEYS.has(key)) return undefined;
    }
    const packet = rawPacket as EvidencePacket;
    if (!isPublicEvidencePacket(packet)) return undefined;
    if (typeof packet.excerpt !== "string" || packet.excerpt.length > 8_000) return undefined;
    packets.push(packet);
  }
  const fetchedIds = new Set(packets.map((packet) => packet.sourceId));
  const fetchedHosts = new Set(
    packets.map((packet) => urlHost(packet.sourceUrl)).filter((host): host is string => Boolean(host)),
  );
  // Blocks are mandatory and fully audited: allowlisted keys, public URLs
  // bound to fetched evidence domains, cited sourceIds, and at least one
  // read block. Uncited prose never publishes.
  if (canvas.blocks === undefined || !auditBlocks(canvas.blocks, fetchedIds, fetchedHosts)) return undefined;
  return {
    symbol: canvas.symbol as string,
    title: canvas.title as string,
    content: canvas.content as string,
    blocks: canvas.blocks as Canvas["blocks"],
    updatedAt: canvas.updatedAt as number,
    stage: "complete",
    ...(typeof canvas.chartScope === "string" ? { chartScope: canvas.chartScope as Canvas["chartScope"] } : {}),
    ...(typeof canvas.researchKey === "string" ? { researchKey: canvas.researchKey } : {}),
    ...(typeof canvas.intent === "string" ? { intent: canvas.intent as Canvas["intent"] } : {}),
    ...(typeof canvas.contextLabel === "string" ? { contextLabel: canvas.contextLabel } : {}),
    evidencePackets: packets,
  };
}

function validateCanvas(raw: unknown): raw is Canvas {
  return sanitizeGlobalCacheCanvas(raw) !== undefined;
}

export function validateGlobalCacheEntry(value: unknown): value is GlobalCacheEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== GLOBAL_CACHE_SCHEMA_VERSION) return false;
  if (typeof raw.producer !== "string" || raw.producer.length < 1 || raw.producer.length > 160) return false;
  if (!validateGlobalCacheIdentity(raw.identity)) return false;
  const identity = raw.identity as GlobalCacheIdentity;
  if (typeof raw.cacheKey !== "string" || raw.cacheKey !== globalCacheKey(identity)) return false;
  const expectedKind = globalCacheKindForResearchKey(identity.researchKey);
  if (raw.kind !== expectedKind) return false;
  if (!validateCanvas(raw.canvas)) return false;
  if (!validateQuality(raw.quality)) return false;
  if (!validateProvenance(raw.provenance)) return false;
  if (raw.promptContract !== GLOBAL_CACHE_PROMPT_CONTRACT) return false;
  if (raw.policyVersion !== GLOBAL_CACHE_POLICY_VERSION) return false;
  // The stored canvas must agree with the entry identity: a mismatched
  // symbol/scope/key/intent is a miss, never a cross-identity hit.
  const canvas = raw.canvas as Record<string, unknown>;
  if (canvas.symbol !== identity.symbol) return false;
  if (canvas.chartScope !== identity.chartScope) return false;
  if (canvas.researchKey !== identity.researchKey) return false;
  if (canvas.intent !== identity.intent) return false;
  if (!validInteger(raw.asOf, 1, Number.MAX_SAFE_INTEGER)) return false;
  if (!validInteger(raw.generatedAt, 1, Number.MAX_SAFE_INTEGER)) return false;
  if (!validInteger(raw.expiresAt, (raw.generatedAt as number) + 1, Number.MAX_SAFE_INTEGER)) return false;
  // Storage-level TTL ceiling: no entry may outlive the longest versioned
  // policy window (macro/story 4h). The builder derives tighter per-kind
  // expiries; this bound keeps hand-built writes inside the policy.
  if ((raw.expiresAt as number) - (raw.generatedAt as number) > 4 * 60 * 60_000) return false;
  return true;
}

/** Reader-side eligibility: corrupt, stale, incompatible, or non-public entries are misses. */
export function isGlobalCacheEntryEligible(entry: GlobalCacheEntry, now: number): boolean {
  if (!validateGlobalCacheEntry(entry)) return false;
  if (!Number.isFinite(now) || now < entry.generatedAt) return false;
  if (now >= entry.expiresAt) return false;
  return true;
}

export interface BuildGlobalCacheEntryInput {
  identity: GlobalCacheIdentity;
  canvas: unknown;
  quality: GlobalCacheQuality;
  provenance: GlobalCacheProvenance;
  generatedAt: number;
  /** Trigger validity cap: expiry never extends past the candidate's own expiry. */
  candidateExpiresAt: number;
  asOf?: number;
}

/**
 * Blessed publisher constructor: sanitizes the canvas, enforces version pins,
 * and derives expiry from the versioned TTL policy capped by trigger
 * validity. Future dispatch/publication code must build entries through here
 * so stored expiry always obeys the published policy.
 */
export function buildGlobalCacheEntry(input: BuildGlobalCacheEntryInput): GlobalCacheEntry {
  if (!validateGlobalCacheIdentity(input.identity)) throw new Error("global cache identity is invalid");
  const kind = globalCacheKindForResearchKey(input.identity.researchKey);
  if (!kind) throw new Error("global cache research key is not publishable");
  const canvas = sanitizeGlobalCacheCanvas(input.canvas);
  if (!canvas) throw new Error("global cache canvas is not publishable");
  if (
    !input.quality || typeof input.quality !== "object" || input.quality.usable !== true
    || !validInteger(input.quality.fetchedCount, 1, 10_000)
  ) {
    throw new Error("global cache quality is not usable");
  }
  if (!validateProvenance(input.provenance)) throw new Error("global cache provenance is invalid");
  if (!validInteger(input.generatedAt, 1, Number.MAX_SAFE_INTEGER)) throw new Error("global cache generatedAt is invalid");
  if (!validInteger(input.candidateExpiresAt, input.generatedAt + 1, Number.MAX_SAFE_INTEGER)) {
    throw new Error("global cache candidate expiry is invalid");
  }
  const expiresAt = resolveGlobalCacheExpiry({ generatedAt: input.generatedAt, kind, candidateExpiresAt: input.candidateExpiresAt });
  const asOf = input.asOf ?? canvas.updatedAt;
  if (!validInteger(asOf, 1, Number.MAX_SAFE_INTEGER)) throw new Error("global cache asOf is invalid");
  const entry: GlobalCacheEntry = {
    schema: GLOBAL_CACHE_SCHEMA_VERSION,
    producer: GLOBAL_CACHE_PRODUCER,
    cacheKey: globalCacheKey(input.identity),
    identity: input.identity,
    kind,
    canvas,
    quality: { ...input.quality },
    provenance: { ...input.provenance },
    asOf,
    generatedAt: input.generatedAt,
    expiresAt,
    promptContract: GLOBAL_CACHE_PROMPT_CONTRACT,
    policyVersion: GLOBAL_CACHE_POLICY_VERSION,
  };
  if (!validateGlobalCacheEntry(entry)) throw new Error("global cache entry failed validation");
  return entry;
}
