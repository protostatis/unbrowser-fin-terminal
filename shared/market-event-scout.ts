/**
 * Deterministic market-event scout with a guarded trigger dispatch outbox.
 *
 * Public RSS/Atom feeds are acquired through Unbrowser, parsed with bounded
 * helpers, associated to a tracked security or market lane, and persisted for
 * inspection. It also records bounded "would trigger" evidence under a fixed
 * simulation policy. Real dispatch is opt-in through an injected adapter and
 * remains disabled unless the caller explicitly supplies one.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { UnbrowserDocument } from "./unbrowser-mcp.js";
import { sanitizePublicUrl } from "./public-url.js";

export type MarketEventFamily = "halt" | "corporate-action" | "filing" | "macro" | "regulatory";
export type MarketEventClass = MarketEventFamily | "other";
export type MarketEventDisposition = "admit-shadow" | "watch" | "suppress";
export type MarketEventAssociation = "structured-symbol" | "explicit-symbol" | "market-wide" | "unresolved";

/** The only model permitted for authenticated market-event scout dispatch. */
export const MARKET_SCOUT_MODEL_ID = "nvidia/nemotron-3.5-lightning:free";

export interface MarketEventSource {
  id: string;
  label: string;
  url: string;
  family: MarketEventFamily;
  format: "rss" | "atom";
  pollIntervalMs: number;
  /** XML element names whose text contains exchange-provided symbols. */
  symbolTags?: readonly string[];
  /** XML fields used only to derive a stable opaque ID when no GUID/link exists. */
  identityTags?: readonly string[];
  /** Source-owned title convention that can safely provide a symbol. */
  symbolFromTitle?: "trailing-parentheses";
  /** Market lane used when the source reports intentionally market-wide events. */
  marketLane?: "macro" | "story";
}

export interface PublicFeedItem {
  id: string;
  title: string;
  url?: string;
  summary: string;
  publishedAt?: number;
  categories: string[];
  structuredSymbols: string[];
}

export interface MarketEventTarget {
  kind: "ticker" | "market";
  symbol?: string;
  lane?: "macro" | "story";
}

export interface MarketEventDecision {
  id: string;
  sourceId: string;
  sourceLabel: string;
  eventId: string;
  observedAt: number;
  publishedAt?: number;
  title: string;
  url?: string;
  eventClass: MarketEventClass;
  association: MarketEventAssociation;
  symbols: string[];
  target?: MarketEventTarget;
  disposition: MarketEventDisposition;
  priority: number;
  reasonCodes: string[];
}

export type MarketEventTriggerRoute =
  | { kind: "ticker-brief"; symbol: string }
  | { kind: "macro-event-brief" }
  | { kind: "market-story-brief" };

export type MarketEventTriggerGateReason =
  | "not-admitted"
  | "unsupported-route"
  | "below-priority"
  | "expired"
  | "target-cooldown"
  | "daily-cap";

export interface MarketEventTriggerPolicy {
  version: 1;
  minPriority: number;
  ttlMs: number;
  targetCooldownMs: number;
  dailyCap: number;
}

export interface MarketEventTriggerCandidate {
  id: string;
  mappingVersion: 1;
  decisionId: string;
  sourceId: string;
  observedAt: number;
  publishedAt?: number;
  evaluatedAt: number;
  title: string;
  url?: string;
  eventClass: MarketEventClass;
  association: MarketEventAssociation;
  disposition: MarketEventDisposition;
  priority: number;
  decisionReasonCodes: string[];
  route?: MarketEventTriggerRoute;
  targetKey?: string;
  expiresAt: number;
  outcome: "would-trigger" | "gated";
  gateReasonCodes: MarketEventTriggerGateReason[];
  /** Snapshot the simulated policy so retained evidence stays interpretable. */
  policy: MarketEventTriggerPolicy;
}

export type MarketEventTriggerDispatchStatus = "pending" | "reserved" | "enqueued" | "settled" | "failed";

export interface MarketEventTriggerDispatchRecord {
  candidateId: string;
  status: MarketEventTriggerDispatchStatus;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  modelId: string;
  /** One entry per adapter attempt; this makes the daily cap restart-safe. */
  dispatchDays?: string[];
  /** Legacy v3 field retained for reading journals written before attempt history. */
  dispatchDay?: string;
  jobId?: string;
  error?: string;
}

export interface MarketEventTriggerDispatchPolicy {
  /** Maximum number of model jobs accepted from one scout poll. */
  perRunCap: number;
  /** Maximum number of dispatch attempts per UTC day. */
  dailyCap: number;
}

export const DEFAULT_MARKET_EVENT_TRIGGER_DISPATCH_POLICY: Readonly<MarketEventTriggerDispatchPolicy> = Object.freeze({
  perRunCap: 1,
  dailyCap: 4,
});

export interface MarketEventTriggerDispatcher {
  modelId: string;
  policy?: MarketEventTriggerDispatchPolicy;
  dispatch(candidate: MarketEventTriggerCandidate): Promise<{
    accepted: boolean;
    jobId?: string;
    error?: string;
    /** Keep the candidate pending when the parent queue is temporarily busy. */
    retryable?: boolean;
  }> | {
    accepted: boolean;
    jobId?: string;
    error?: string;
    retryable?: boolean;
  };
}

export interface MarketEventTriggerAggregate {
  evaluated: number;
  mapped: number;
  wouldTrigger: number;
  gated: number;
  missingPublishedAt: number;
  routes: {
    tickerBrief: number;
    macroEventBrief: number;
    marketStoryBrief: number;
    unsupported: number;
  };
  associations: {
    structuredSymbol: number;
    explicitSymbol: number;
    marketWide: number;
    unresolved: number;
  };
  gates: {
    notAdmitted: number;
    unsupportedRoute: number;
    belowPriority: number;
    expired: number;
    targetCooldown: number;
    dailyCap: number;
  };
}

export interface MarketEventTriggerDayState {
  day: string;
  aggregate: MarketEventTriggerAggregate;
}

export interface MarketEventTriggerCooldownState {
  targetKey: string;
  lastWouldTriggerAt: number;
}

export interface MarketEventTriggerDryRunState {
  policy: MarketEventTriggerPolicy;
  candidates: MarketEventTriggerCandidate[];
  totals: MarketEventTriggerAggregate;
  days: MarketEventTriggerDayState[];
  cooldowns: MarketEventTriggerCooldownState[];
}

export interface MarketEventScoutSourceState {
  sourceId: string;
  baselineComplete: boolean;
  seenEventIds: string[];
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  nextPollAt: number;
  lastStatus: "never" | "ok" | "error";
  lastError?: string;
  lastItemCount: number;
  baselineItems: number;
  newItems: number;
  admitted: number;
  watched: number;
  suppressed: number;
}

export interface MarketEventScoutState {
  version: 3;
  updatedAt: number;
  sources: MarketEventScoutSourceState[];
  /** Recent actionable observations only; suppressed events remain counters. */
  decisions: MarketEventDecision[];
  /** Durable trigger evaluation evidence. */
  triggerDryRun: MarketEventTriggerDryRunState;
  /** Durable, candidate-ID keyed execution outbox. */
  triggerDispatches: MarketEventTriggerDispatchRecord[];
}

export interface MarketEventScoutRunResult {
  startedAt: number;
  completedAt: number;
  polledSources: number;
  successfulSources: number;
  failedSources: number;
  baselineItems: number;
  newItems: number;
  admitted: number;
  watched: number;
  suppressed: number;
  decisions: MarketEventDecision[];
  triggerCandidates: MarketEventTriggerCandidate[];
  candidateEvaluated: number;
  wouldTrigger: number;
  gated: number;
  dispatchEnqueued: number;
  dispatchFailed: number;
  dispatchPending: number;
}

export interface MarketEventDocumentClient {
  readDocument(url: string, signal?: AbortSignal): Promise<UnbrowserDocument>;
}

export interface MarketEventScoutOptions {
  client: MarketEventDocumentClient;
  statePath: string;
  sources?: readonly MarketEventSource[];
  getTrackedSymbols?: () => Iterable<string>;
  now?: () => number;
  maxSeenPerSource?: number;
  maxStoredDecisions?: number;
  maxStoredTriggerCandidates?: number;
  triggerPolicy?: MarketEventTriggerPolicy;
  /** Supplying this adapter opts the scout into real model dispatch. */
  dispatch?: MarketEventTriggerDispatcher;
  errorBackoffMs?: number;
  sourceTimeoutMs?: number;
}

const MAX_FEED_CHARS = 512 * 1024;
const MAX_FEED_ITEMS = 200;
const MAX_TITLE_CHARS = 500;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_CATEGORY_CHARS = 120;
const MAX_URL_CHARS = 2_000;
const MAX_XML_DEPTH = 64;
const DEFAULT_MAX_SEEN_PER_SOURCE = 500;
const DEFAULT_MAX_STORED_DECISIONS = 300;
const DEFAULT_ERROR_BACKOFF_MS = 5 * 60_000;
const DEFAULT_SOURCE_TIMEOUT_MS = 45_000;
const EVENT_MAX_AGE_MS = 72 * 60 * 60_000;
const EVENT_MAX_FUTURE_SKEW_MS = 15 * 60_000;
const DEFAULT_MAX_STORED_TRIGGER_CANDIDATES = 1_000;
const MAX_TRIGGER_DAYS = 31;
const MAX_TRIGGER_COOLDOWNS = 2_000;
const MAX_TRIGGER_DISPATCHES = 2_000;
const MAX_TRIGGER_DISPATCH_ATTEMPTS = 100;
const TRIGGER_MAPPING_VERSION = 1 as const;
const MAX_MODEL_ID_CHARS = 200;

/** Conservative simulation defaults. They do not authorize model dispatch. */
export const DEFAULT_MARKET_EVENT_TRIGGER_POLICY: Readonly<MarketEventTriggerPolicy> = Object.freeze({
  version: 1,
  minPriority: 80,
  ttlMs: 2 * 60 * 60_000,
  targetCooldownMs: 6 * 60 * 60_000,
  dailyCap: 8,
});

export const DEFAULT_MARKET_EVENT_SOURCES: readonly MarketEventSource[] = Object.freeze([
  {
    id: "nasdaq-trade-halts",
    label: "Nasdaq Trade Halts",
    url: "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts",
    family: "halt",
    format: "rss",
    pollIntervalMs: 60_000,
    symbolTags: ["ndaq:IssueSymbol"],
    identityTags: ["ndaq:HaltDate", "ndaq:HaltTime", "ndaq:IssueSymbol", "ndaq:ReasonCode"],
  },
  {
    id: "nasdaq-corporate-actions",
    label: "Nasdaq Corporate Actions",
    url: "https://www.nasdaqtrader.com/rss.aspx?feed=currentheadlines&categorylist=105",
    family: "corporate-action",
    format: "rss",
    pollIntervalMs: 5 * 60_000,
    symbolFromTitle: "trailing-parentheses",
  },
  {
    id: "sec-current-filings",
    label: "SEC Current Filings",
    url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&count=40&output=atom",
    family: "filing",
    format: "atom",
    pollIntervalMs: 5 * 60_000,
  },
  {
    id: "federal-reserve-monetary",
    label: "Federal Reserve Monetary Policy",
    url: "https://www.federalreserve.gov/feeds/press_monetary.xml",
    family: "macro",
    format: "rss",
    pollIntervalMs: 10 * 60_000,
    marketLane: "macro",
  },
  {
    id: "bea-news",
    label: "Bureau of Economic Analysis",
    url: "https://apps.bea.gov/rss/rss.xml",
    family: "macro",
    format: "rss",
    pollIntervalMs: 10 * 60_000,
    marketLane: "macro",
  },
  {
    id: "ftc-press-releases",
    label: "Federal Trade Commission",
    url: "https://www.ftc.gov/feeds/press-release.xml",
    family: "regulatory",
    format: "rss",
    pollIntervalMs: 10 * 60_000,
    marketLane: "story",
  },
  {
    id: "doj-news",
    label: "Department of Justice",
    url: "https://www.justice.gov/feeds/justice-news.xml",
    family: "regulatory",
    format: "rss",
    pollIntervalMs: 10 * 60_000,
    marketLane: "story",
  },
]);

function positiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error("Market scout limit is invalid");
  return value;
}

function boundedText(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#([0-9]{1,7});/g, (_match, decimal: string) => {
      const code = Number.parseInt(decimal, 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface OpenXmlElement {
  name: string;
  localName: string;
  start: number;
}

function xmlLocalName(name: string): string {
  return (name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name).toLowerCase();
}

function findXmlTagEnd(xml: string, start: number): number {
  let quote: "\"" | "'" | undefined;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  throw new Error("incomplete feed document: unterminated XML tag");
}

function findXmlDeclarationEnd(xml: string, start: number): number {
  let quote: "\"" | "'" | undefined;
  let subsetDepth = 0;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "[") {
      subsetDepth += 1;
    } else if (character === "]" && subsetDepth > 0) {
      subsetDepth -= 1;
    } else if (character === ">" && subsetDepth === 0) {
      return index;
    }
  }
  throw new Error("incomplete feed document: unterminated XML declaration");
}

function validateXmlAttributes(raw: string): boolean {
  let index = 0;
  const seen = new Set<string>();
  while (index < raw.length) {
    const whitespaceStart = index;
    while (/\s/.test(raw[index] ?? "")) index += 1;
    if (index === raw.length) return true;
    if (index === whitespaceStart) return false;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/.exec(raw.slice(index));
    if (!nameMatch) return false;
    const name = nameMatch[0];
    if (seen.has(name)) return false;
    seen.add(name);
    index += name.length;
    while (/\s/.test(raw[index] ?? "")) index += 1;
    if (raw[index] !== "=") return false;
    index += 1;
    while (/\s/.test(raw[index] ?? "")) index += 1;
    const quote = raw[index];
    if (quote !== "\"" && quote !== "'") return false;
    index += 1;
    const valueEnd = raw.indexOf(quote, index);
    if (valueEnd < 0 || raw.slice(index, valueEnd).includes("<")) return false;
    index = valueEnd + 1;
  }
  return true;
}

/** Validate the bounded XML structure and return every complete feed entry. */
function parseFeedStructure(xml: string, entryLocalName: string): { rootName: string; blocks: string[] } {
  const stack: OpenXmlElement[] = [];
  const blocks: string[] = [];
  const wantedLocalName = entryLocalName.toLowerCase();
  let rootName: string | undefined;
  let rootClosed = false;
  let cursor = 0;

  while (cursor < xml.length) {
    const tagStart = xml.indexOf("<", cursor);
    if (tagStart < 0) {
      if (stack.length === 0 && xml.slice(cursor).trim()) throw new Error("malformed feed document: text outside the root element");
      cursor = xml.length;
      break;
    }
    if (stack.length === 0 && xml.slice(cursor, tagStart).trim()) {
      throw new Error("malformed feed document: text outside the root element");
    }

    if (xml.startsWith("<!--", tagStart)) {
      const end = xml.indexOf("-->", tagStart + 4);
      if (end < 0) throw new Error("incomplete feed document: unterminated XML comment");
      if (xml.slice(tagStart + 4, end).includes("--")) throw new Error("malformed feed document: invalid XML comment");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", tagStart)) {
      if (stack.length === 0) throw new Error("malformed feed document: CDATA outside the root element");
      const end = xml.indexOf("]]>", tagStart + 9);
      if (end < 0) throw new Error("incomplete feed document: unterminated CDATA section");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", tagStart)) {
      const end = xml.indexOf("?>", tagStart + 2);
      if (end < 0) throw new Error("incomplete feed document: unterminated processing instruction");
      cursor = end + 2;
      continue;
    }
    if (/^<!DOCTYPE\b/i.test(xml.slice(tagStart, tagStart + 16))) {
      if (stack.length > 0 || rootName !== undefined) throw new Error("malformed feed document: misplaced document declaration");
      cursor = findXmlDeclarationEnd(xml, tagStart + 2) + 1;
      continue;
    }
    if (xml.startsWith("<!", tagStart)) throw new Error("malformed feed document: unsupported XML declaration");

    const tagEnd = findXmlTagEnd(xml, tagStart + 1);
    const rawTag = xml.slice(tagStart + 1, tagEnd);
    if (rawTag.startsWith("/")) {
      const closeMatch = /^\/([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)\s*$/.exec(rawTag);
      if (!closeMatch) throw new Error("malformed feed document: invalid closing tag");
      const name = closeMatch[1]!;
      const opened = stack.pop();
      if (!opened || opened.name !== name) throw new Error(`malformed feed document: unexpected closing tag ${name}`);
      if (opened.localName === wantedLocalName) {
        blocks.push(xml.slice(opened.start, tagEnd + 1));
        if (blocks.length > MAX_FEED_ITEMS) throw new Error(`Feed exceeds the ${MAX_FEED_ITEMS}-item safety limit`);
      }
      if (stack.length === 0) rootClosed = true;
      cursor = tagEnd + 1;
      continue;
    }

    const openMatch = /^([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)([\s\S]*)$/.exec(rawTag);
    if (!openMatch) throw new Error("malformed feed document: invalid opening tag");
    const name = openMatch[1]!;
    let attributes = openMatch[2] ?? "";
    const trimmedAttributes = attributes.trimEnd();
    const selfClosing = trimmedAttributes.endsWith("/");
    if (selfClosing) attributes = trimmedAttributes.slice(0, -1);
    if (!validateXmlAttributes(attributes)) throw new Error(`malformed feed document: invalid attributes on ${name}`);
    if (stack.length === 0) {
      if (rootName !== undefined || rootClosed) throw new Error("malformed feed document: multiple root elements");
      rootName = name;
    }
    const localName = xmlLocalName(name);
    if (localName === wantedLocalName && stack.some((element) => element.localName === wantedLocalName)) {
      throw new Error("malformed feed document: nested feed entries");
    }
    if (selfClosing) {
      if (localName === wantedLocalName) {
        blocks.push(xml.slice(tagStart, tagEnd + 1));
        if (blocks.length > MAX_FEED_ITEMS) throw new Error(`Feed exceeds the ${MAX_FEED_ITEMS}-item safety limit`);
      }
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push({ name, localName, start: tagStart });
      if (stack.length > MAX_XML_DEPTH) throw new Error(`Feed exceeds the ${MAX_XML_DEPTH}-level XML nesting safety limit`);
    }
    cursor = tagEnd + 1;
  }

  if (stack.length > 0 || (rootName !== undefined && !rootClosed)) throw new Error("incomplete feed document: unclosed XML element");
  if (!rootName) throw new Error("non-feed document: missing XML root element");
  return { rootName, blocks };
}

function elementValues(xml: string, qualifiedName: string): string[] {
  const name = escapeRegex(qualifiedName);
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, "gi");
  return [...xml.matchAll(pattern)].slice(0, 50).map((match) => boundedText(decodeXmlEntities(match[1] ?? ""), MAX_SUMMARY_CHARS));
}

function firstElementValue(xml: string, localName: string): string {
  const name = escapeRegex(localName);
  const pattern = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>`,
    "i",
  );
  const match = pattern.exec(xml);
  return boundedText(decodeXmlEntities(match?.[1] ?? ""), MAX_SUMMARY_CHARS);
}

function attributeValue(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${escapeRegex(name)}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')`, "i");
  const match = pattern.exec(attributes);
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : boundedText(decodeXmlEntities(value), MAX_URL_CHARS);
}

function atomLink(entry: string): string | undefined {
  const pattern = /<(?:[A-Za-z_][\w.-]*:)?link\b([^>]*)\/?\s*>/gi;
  let fallback: string | undefined;
  for (const match of entry.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    const href = attributeValue(attributes, "href");
    if (!href) continue;
    const rel = attributeValue(attributes, "rel")?.toLowerCase();
    if (!fallback) fallback = href;
    if (!rel || rel === "alternate") return href;
  }
  return fallback;
}

function safePublicUrl(raw: string | undefined, sourceUrl: string): string | undefined {
  if (!raw || raw.length > MAX_URL_CHARS) return undefined;
  try {
    const parsed = new URL(raw, sourceUrl);
    const safe = sanitizePublicUrl(parsed.toString());
    return safe && safe.length <= MAX_URL_CHARS ? safe : undefined;
  } catch {
    return undefined;
  }
}

function parseTimestamp(raw: string): number | undefined {
  if (!raw) return undefined;
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) return undefined;
  const year = new Date(value).getUTCFullYear();
  return year >= 2000 && year <= 2100 ? value : undefined;
}

function normalizeSymbol(raw: string): string | undefined {
  const symbol = raw.trim().toUpperCase().replace(/\//g, ".");
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) ? symbol : undefined;
}

function stableEventId(sourceId: string, ...parts: Array<string | number | undefined>): string {
  const hash = createHash("sha256");
  hash.update("market-event-v1\0").update(sourceId);
  for (const part of parts) hash.update("\0").update(String(part ?? ""));
  return `evt-${hash.digest("hex").slice(0, 32)}`;
}

function parseCategories(block: string): string[] {
  const values = elementValues(block, "category");
  const attributePattern = /<(?:[A-Za-z_][\w.-]*:)?category\b([^>]*)\/?\s*>/gi;
  for (const match of block.matchAll(attributePattern)) {
    const term = attributeValue(match[1] ?? "", "term");
    if (term) values.push(boundedText(term, MAX_CATEGORY_CHARS));
  }
  return [...new Set(values.filter(Boolean).map((value) => value.slice(0, MAX_CATEGORY_CHARS)))].slice(0, 20);
}

/** Parse bounded RSS 2.0 or Atom documents without executing document scripts. */
export function parsePublicFeed(source: MarketEventSource, body: string): PublicFeedItem[] {
  if (body.length > MAX_FEED_CHARS) throw new Error(`${source.label} feed exceeds the document safety limit`);
  const xml = body.replace(/^\uFEFF/, "");
  const entryName = source.format === "atom" ? "entry" : "item";
  const parsed = parseFeedStructure(xml, entryName);
  const rootLocalName = xmlLocalName(parsed.rootName);
  const expectedRoot = source.format === "atom"
    ? rootLocalName === "feed"
    : rootLocalName === "rss" || rootLocalName === "rdf";
  if (!expectedRoot) throw new Error(`${source.label} returned a non-feed document`);
  const blocks = parsed.blocks;
  const items: PublicFeedItem[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const title = boundedText(firstElementValue(block, "title"), MAX_TITLE_CHARS);
    if (!title) throw new Error(`${source.label} feed ${entryName} is missing a title`);
    const rawUrl = source.format === "atom" ? atomLink(block) : firstElementValue(block, "link");
    const url = safePublicUrl(rawUrl, source.url);
    const summary = boundedText(
      firstElementValue(block, "description") || firstElementValue(block, "summary") || firstElementValue(block, "content"),
      MAX_SUMMARY_CHARS,
    );
    const publishedAt = parseTimestamp(
      firstElementValue(block, "pubDate") || firstElementValue(block, "published") || firstElementValue(block, "updated"),
    );
    const suppliedId = boundedText(firstElementValue(block, "guid") || firstElementValue(block, "id"), MAX_URL_CHARS);
    const identityFields = (source.identityTags ?? []).flatMap((tag) => elementValues(block, tag)).filter(Boolean);
    const id = suppliedId
      ? stableEventId(source.id, "supplied-id", suppliedId)
      : url
        ? stableEventId(source.id, "canonical-url", url)
        : stableEventId(source.id, "fallback", title, publishedAt, ...identityFields);
    const dedupeKey = stableEventId(source.id, id, url, title);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const taggedSymbols = (source.symbolTags ?? [])
      .flatMap((tag) => elementValues(block, tag))
      .map(normalizeSymbol)
      .filter((symbol): symbol is string => Boolean(symbol));
    const titleSymbol = source.symbolFromTitle === "trailing-parentheses"
      ? normalizeSymbol(title.match(/\(([A-Z][A-Z0-9.-]{0,9})\)\s*$/)?.[1] ?? "")
      : undefined;
    const structuredSymbols = [...new Set([...taggedSymbols, ...(titleSymbol ? [titleSymbol] : [])])].slice(0, 20);
    items.push({
      id,
      title,
      url,
      summary,
      publishedAt,
      categories: parseCategories(block),
      structuredSymbols,
    });
  }
  return items;
}

function explicitSymbols(text: string): string[] {
  const symbols: string[] = [];
  const patterns = [
    /\$(?<symbol>[A-Z][A-Z0-9.-]{0,9})\b/g,
    /\b(?:NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN|AMEX|OTC|TSX)\s*[:\-]\s*(?<symbol>[A-Z][A-Z0-9.-]{0,9})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const symbol = normalizeSymbol(match.groups?.symbol ?? "");
      if (symbol) symbols.push(symbol);
    }
  }
  return [...new Set(symbols)].slice(0, 20);
}

function classifyEvent(source: MarketEventSource, item: PublicFeedItem): MarketEventClass {
  const text = `${item.title} ${item.summary} ${item.categories.join(" ")}`.toLowerCase();
  if (source.family === "halt") return "halt";
  if (source.family === "corporate-action") return "corporate-action";
  if (source.family === "filing") {
    return /\b(?:8-k|10-k|10-q|6-k|20-f|s-4)\b/i.test(text) ? "filing" : "other";
  }
  if (source.family === "macro") {
    return /\b(?:fomc|monetary policy|federal funds|interest rate|economic projections|gross domestic product|\bgdp\b|personal income|personal consumption|\bpce\b|international trade|trade deficit|balance of payments)\b/i.test(text)
      ? "macro"
      : "other";
  }
  return /\b(?:antitrust|merger|acquisition|charges?|indict(?:ed|ment)?|lawsuit|sues?|settlement|fraud|sanction|export control|recall|competition|consumer protection|data breach|cyber)\b/i.test(text)
    ? "regulatory"
    : "other";
}

function trackedSymbolSet(values: Iterable<string> | undefined): Set<string> {
  const result = new Set<string>();
  if (!values) return result;
  for (const value of values) {
    const symbol = normalizeSymbol(value);
    if (symbol) result.add(symbol);
  }
  return result;
}

export function evaluateMarketEvent(
  source: MarketEventSource,
  item: PublicFeedItem,
  observedAt: number,
  trackedSymbols: Iterable<string> = [],
): MarketEventDecision {
  const tracked = trackedSymbolSet(trackedSymbols);
  const eventClass = classifyEvent(source, item);
  const structuredSymbols = [...new Set(item.structuredSymbols.map(normalizeSymbol)
    .filter((symbol): symbol is string => Boolean(symbol)))].slice(0, 20);
  const extractedSymbols = explicitSymbols(`${item.title} ${item.summary}`);
  // Source/class authority is deliberate: incidental text tickers cannot dilute
  // exchange-structured symbols, and macro releases always stay market-wide.
  const symbols = eventClass === "macro" && source.marketLane === "macro"
    ? []
    : structuredSymbols.length > 0 ? structuredSymbols : extractedSymbols;
  const association: MarketEventAssociation = eventClass === "macro" && source.marketLane === "macro"
    ? "market-wide"
    : structuredSymbols.length > 0
      ? "structured-symbol"
      : symbols.length > 0
        ? "explicit-symbol"
        : source.marketLane
          ? "market-wide"
          : "unresolved";
  const reasonCodes: string[] = [];
  let disposition: MarketEventDisposition = "watch";
  let priority = 50;

  const stale = item.publishedAt !== undefined && observedAt - item.publishedAt > EVENT_MAX_AGE_MS;
  const future = item.publishedAt !== undefined && item.publishedAt - observedAt > EVENT_MAX_FUTURE_SKEW_MS;
  if (eventClass === "other") {
    disposition = "suppress";
    priority = 0;
    reasonCodes.push("unsupported-event-class");
  } else if (stale || future) {
    disposition = "suppress";
    priority = 0;
    reasonCodes.push(stale ? "stale-publication" : "future-publication");
  } else if (eventClass === "macro" && source.marketLane === "macro") {
    disposition = "admit-shadow";
    priority = 90;
    reasonCodes.push("high-impact-macro-source");
  } else if (eventClass === "halt" && structuredSymbols.length === 1) {
    disposition = "admit-shadow";
    priority = 100;
    reasonCodes.push("exchange-structured-halt");
  } else if (eventClass === "halt" && structuredSymbols.length > 1) {
    disposition = "watch";
    priority = 70;
    reasonCodes.push("ambiguous-multi-security-event");
  } else if ((eventClass === "corporate-action" || eventClass === "regulatory") && symbols.length === 1) {
    if (tracked.size === 0 || tracked.has(symbols[0]!)) {
      disposition = "admit-shadow";
      priority = eventClass === "corporate-action" ? 85 : 80;
      reasonCodes.push("single-security-association");
    } else {
      disposition = "watch";
      priority = 55;
      reasonCodes.push("outside-tracked-universe");
    }
  } else if (eventClass === "filing") {
    disposition = "watch";
    priority = symbols.length === 1 ? 65 : 45;
    reasonCodes.push(symbols.length === 1 ? "filing-needs-materiality-check" : "filing-needs-ticker-mapping");
  } else {
    disposition = "watch";
    priority = 50;
    reasonCodes.push(symbols.length > 1 ? "ambiguous-multi-security-event" : "insufficient-security-association");
  }

  const target: MarketEventTarget | undefined = eventClass === "macro" && source.marketLane === "macro"
    ? { kind: "market", lane: "macro" }
    : symbols.length === 1
      ? { kind: "ticker", symbol: symbols[0] }
      : association === "market-wide" && source.marketLane
        ? { kind: "market", lane: source.marketLane }
        : undefined;
  const eventId = /^evt-[a-f0-9]{32}$/.test(item.id)
    ? item.id
    : stableEventId(source.id, "external-item-id", item.id);
  return {
    id: stableEventId(source.id, eventId),
    sourceId: source.id,
    sourceLabel: source.label,
    eventId,
    observedAt,
    publishedAt: item.publishedAt,
    title: item.title,
    url: item.url,
    eventClass,
    association,
    symbols,
    target,
    disposition,
    priority,
    reasonCodes,
  };
}

function cloneTriggerPolicy(policy: MarketEventTriggerPolicy): MarketEventTriggerPolicy {
  return { ...policy };
}

function sameTriggerPolicy(a: MarketEventTriggerPolicy, b: MarketEventTriggerPolicy): boolean {
  return a.version === b.version
    && a.minPriority === b.minPriority
    && a.ttlMs === b.ttlMs
    && a.targetCooldownMs === b.targetCooldownMs
    && a.dailyCap === b.dailyCap;
}

function safeTimestampAdd(value: number, durationMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + durationMs);
}

function triggerCandidateId(decisionId: string): string {
  const hash = createHash("sha256");
  hash.update("market-event-trigger-candidate-v1\0").update(decisionId);
  return `trg-${hash.digest("hex").slice(0, 32)}`;
}

/** Map only validated scout targets; never infer a route from untrusted prose. */
export function proposeMarketEventTriggerRoute(decision: MarketEventDecision): MarketEventTriggerRoute | undefined {
  if (decision.target?.kind === "ticker") {
    const symbol = normalizeSymbol(decision.target.symbol ?? "");
    return symbol ? { kind: "ticker-brief", symbol } : undefined;
  }
  if (decision.target?.kind === "market" && decision.target.lane === "macro") {
    return { kind: "macro-event-brief" };
  }
  if (decision.target?.kind === "market" && decision.target.lane === "story") {
    return { kind: "market-story-brief" };
  }
  return undefined;
}

function triggerTargetKey(route: MarketEventTriggerRoute | undefined): string | undefined {
  if (!route) return undefined;
  if (route.kind === "ticker-brief") return `ticker:${route.symbol}`;
  if (route.kind === "macro-event-brief") return "event:macro";
  return "market-story";
}

export function createMarketEventTriggerAggregate(): MarketEventTriggerAggregate {
  return {
    evaluated: 0,
    mapped: 0,
    wouldTrigger: 0,
    gated: 0,
    missingPublishedAt: 0,
    routes: { tickerBrief: 0, macroEventBrief: 0, marketStoryBrief: 0, unsupported: 0 },
    associations: { structuredSymbol: 0, explicitSymbol: 0, marketWide: 0, unresolved: 0 },
    gates: { notAdmitted: 0, unsupportedRoute: 0, belowPriority: 0, expired: 0, targetCooldown: 0, dailyCap: 0 },
  };
}

function emptyTriggerDryRunState(
  policy: MarketEventTriggerPolicy = DEFAULT_MARKET_EVENT_TRIGGER_POLICY,
): MarketEventTriggerDryRunState {
  return {
    policy: cloneTriggerPolicy(policy),
    candidates: [],
    totals: createMarketEventTriggerAggregate(),
    days: [],
    cooldowns: [],
  };
}

function marketEventTriggerDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Evaluate one immutable dry-run candidate. Stateful inputs are observations,
 * not reservations; this function never touches workers, tokens, or canvases.
 */
export function evaluateMarketEventTriggerCandidate(
  decision: MarketEventDecision,
  options: {
    evaluatedAt: number;
    policy?: MarketEventTriggerPolicy;
    lastWouldTriggerAt?: number;
    wouldTriggerToday?: number;
  },
): MarketEventTriggerCandidate {
  const policy = cloneTriggerPolicy(options.policy ?? DEFAULT_MARKET_EVENT_TRIGGER_POLICY);
  if (!validateDecision(decision) || !validateTriggerPolicy(policy)
    || !validInteger(options.evaluatedAt, decision.observedAt, Number.MAX_SAFE_INTEGER)
    || (options.lastWouldTriggerAt !== undefined
      && !validInteger(options.lastWouldTriggerAt, 1, Number.MAX_SAFE_INTEGER))
    || (options.wouldTriggerToday !== undefined
      && !validInteger(options.wouldTriggerToday, 0, Number.MAX_SAFE_INTEGER))) {
    throw new Error("Market event trigger dry-run input is invalid");
  }
  const route = proposeMarketEventTriggerRoute(decision);
  const targetKey = triggerTargetKey(route);
  const expiresAt = safeTimestampAdd(decision.publishedAt ?? decision.observedAt, policy.ttlMs);
  const gateReasonCodes: MarketEventTriggerGateReason[] = [];

  if (decision.disposition !== "admit-shadow") gateReasonCodes.push("not-admitted");
  if (!route) gateReasonCodes.push("unsupported-route");
  if (decision.priority < policy.minPriority) gateReasonCodes.push("below-priority");
  if (options.evaluatedAt >= expiresAt) gateReasonCodes.push("expired");

  // Stateful pressure is meaningful only after the candidate passes all
  // stateless gates. Gated candidates never consume cooldown or daily volume.
  if (gateReasonCodes.length === 0) {
    if (options.lastWouldTriggerAt !== undefined
      && options.evaluatedAt < safeTimestampAdd(options.lastWouldTriggerAt, policy.targetCooldownMs)) {
      gateReasonCodes.push("target-cooldown");
    }
    if ((options.wouldTriggerToday ?? 0) >= policy.dailyCap) gateReasonCodes.push("daily-cap");
  }

  return {
    id: triggerCandidateId(decision.id),
    mappingVersion: TRIGGER_MAPPING_VERSION,
    decisionId: decision.id,
    sourceId: decision.sourceId,
    observedAt: decision.observedAt,
    publishedAt: decision.publishedAt,
    evaluatedAt: options.evaluatedAt,
    title: decision.title,
    url: decision.url,
    eventClass: decision.eventClass,
    association: decision.association,
    disposition: decision.disposition,
    priority: decision.priority,
    decisionReasonCodes: [...decision.reasonCodes],
    route,
    targetKey,
    expiresAt,
    outcome: gateReasonCodes.length === 0 ? "would-trigger" : "gated",
    gateReasonCodes,
    policy,
  };
}

function incrementTriggerAggregate(
  aggregate: MarketEventTriggerAggregate,
  candidate: MarketEventTriggerCandidate,
): void {
  aggregate.evaluated += 1;
  if (candidate.route) aggregate.mapped += 1;
  if (candidate.outcome === "would-trigger") aggregate.wouldTrigger += 1;
  else aggregate.gated += 1;
  if (candidate.publishedAt === undefined) aggregate.missingPublishedAt += 1;

  if (candidate.route?.kind === "ticker-brief") aggregate.routes.tickerBrief += 1;
  else if (candidate.route?.kind === "macro-event-brief") aggregate.routes.macroEventBrief += 1;
  else if (candidate.route?.kind === "market-story-brief") aggregate.routes.marketStoryBrief += 1;
  else aggregate.routes.unsupported += 1;

  if (candidate.association === "structured-symbol") aggregate.associations.structuredSymbol += 1;
  else if (candidate.association === "explicit-symbol") aggregate.associations.explicitSymbol += 1;
  else if (candidate.association === "market-wide") aggregate.associations.marketWide += 1;
  else aggregate.associations.unresolved += 1;

  for (const reason of candidate.gateReasonCodes) {
    if (reason === "not-admitted") aggregate.gates.notAdmitted += 1;
    else if (reason === "unsupported-route") aggregate.gates.unsupportedRoute += 1;
    else if (reason === "below-priority") aggregate.gates.belowPriority += 1;
    else if (reason === "expired") aggregate.gates.expired += 1;
    else if (reason === "target-cooldown") aggregate.gates.targetCooldown += 1;
    else aggregate.gates.dailyCap += 1;
  }
}

function recordTriggerCandidates(
  state: MarketEventTriggerDryRunState,
  decisions: readonly MarketEventDecision[],
  options: {
    evaluatedAt: number;
    policy: MarketEventTriggerPolicy;
    maxStoredCandidates: number;
  },
): MarketEventTriggerCandidate[] {
  if (state.totals.evaluated > 0 && !sameTriggerPolicy(state.policy, options.policy)) {
    throw new Error("Market event trigger dry-run policy changed without a versioned migration");
  }
  state.policy = cloneTriggerPolicy(options.policy);
  const knownIds = new Set(state.candidates.map((candidate) => candidate.id));
  const cooldowns = new Map(state.cooldowns.map((entry) => [entry.targetKey, entry.lastWouldTriggerAt]));
  const dayKey = marketEventTriggerDay(options.evaluatedAt);
  let day = state.days.find((entry) => entry.day === dayKey);
  if (!day) {
    day = { day: dayKey, aggregate: createMarketEventTriggerAggregate() };
    state.days.push(day);
  }
  const created: MarketEventTriggerCandidate[] = [];

  for (const decision of decisions) {
    const id = triggerCandidateId(decision.id);
    if (knownIds.has(id)) continue;
    const route = proposeMarketEventTriggerRoute(decision);
    const targetKey = triggerTargetKey(route);
    const candidate = evaluateMarketEventTriggerCandidate(decision, {
      evaluatedAt: options.evaluatedAt,
      policy: options.policy,
      lastWouldTriggerAt: targetKey ? cooldowns.get(targetKey) : undefined,
      wouldTriggerToday: day.aggregate.wouldTrigger,
    });
    knownIds.add(candidate.id);
    created.push(candidate);
    incrementTriggerAggregate(state.totals, candidate);
    incrementTriggerAggregate(day.aggregate, candidate);
    if (candidate.outcome === "would-trigger" && candidate.targetKey) {
      cooldowns.set(candidate.targetKey, candidate.evaluatedAt);
    }
  }

  state.candidates = [...created, ...state.candidates]
    .sort((a, b) => b.evaluatedAt - a.evaluatedAt || b.priority - a.priority || a.id.localeCompare(b.id))
    .slice(0, options.maxStoredCandidates);
  state.days = state.days.sort((a, b) => b.day.localeCompare(a.day)).slice(0, MAX_TRIGGER_DAYS);
  state.cooldowns = [...cooldowns.entries()]
    .filter(([, lastWouldTriggerAt]) => options.evaluatedAt < safeTimestampAdd(lastWouldTriggerAt, options.policy.targetCooldownMs))
    .map(([targetKey, lastWouldTriggerAt]) => ({ targetKey, lastWouldTriggerAt }))
    .sort((a, b) => b.lastWouldTriggerAt - a.lastWouldTriggerAt || a.targetKey.localeCompare(b.targetKey))
    .slice(0, MAX_TRIGGER_COOLDOWNS);
  return created;
}

export function marketEventScoutFilePath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MARKET_DATA_DIR?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("MARKET_DATA_DIR must be an absolute path");
    return join(configured, "market-event-scout.json");
  }
  return join(cwd, ".pi", "market-event-scout.json");
}

function emptyState(now: number): MarketEventScoutState {
  return {
    version: 3,
    updatedAt: now,
    sources: [],
    decisions: [],
    triggerDryRun: emptyTriggerDryRunState(),
    triggerDispatches: [],
  };
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function validModelId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 3
    && value.length <= MAX_MODEL_ID_CHARS
    && /^[a-z0-9][a-z0-9._/-]{1,198}(?::[a-z0-9._-]+)?$/.test(value);
}

function validUtcDay(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function dispatchAttemptDays(record: Pick<MarketEventTriggerDispatchRecord, "attempt" | "dispatchDays" | "dispatchDay">): string[] {
  if (Array.isArray(record.dispatchDays)) return record.dispatchDays;
  if (record.dispatchDay !== undefined && record.attempt > 0) {
    // A pre-attempt-history v3 record only retained its most recent day. Count
    // every historical attempt against that day rather than undercounting on
    // migration; this is deliberately conservative and fail-closed.
    return Array.from({ length: record.attempt }, () => record.dispatchDay!);
  }
  return [];
}

function validateSourceState(raw: unknown): raw is MarketEventScoutSourceState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const state = raw as Record<string, unknown>;
  return typeof state.sourceId === "string" && /^[a-z0-9-]{1,80}$/.test(state.sourceId)
    && typeof state.baselineComplete === "boolean"
    && Array.isArray(state.seenEventIds) && state.seenEventIds.length <= 2_000
    && state.seenEventIds.every((id) => typeof id === "string" && /^evt-[a-f0-9]{32}$/.test(id))
    && new Set(state.seenEventIds as string[]).size === state.seenEventIds.length
    && validInteger(state.nextPollAt, 0, Number.MAX_SAFE_INTEGER)
    && (state.lastAttemptAt === undefined || validInteger(state.lastAttemptAt, 1, Number.MAX_SAFE_INTEGER))
    && (state.lastSuccessAt === undefined || validInteger(state.lastSuccessAt, 1, Number.MAX_SAFE_INTEGER))
    && (state.lastStatus === "never" || state.lastStatus === "ok" || state.lastStatus === "error")
    && (state.lastError === undefined || (typeof state.lastError === "string" && state.lastError.length <= 500))
    && validInteger(state.lastItemCount, 0, MAX_FEED_ITEMS)
    && validInteger(state.baselineItems, 0, Number.MAX_SAFE_INTEGER)
    && validInteger(state.newItems, 0, Number.MAX_SAFE_INTEGER)
    && validInteger(state.admitted, 0, Number.MAX_SAFE_INTEGER)
    && validInteger(state.watched, 0, Number.MAX_SAFE_INTEGER)
    && validInteger(state.suppressed, 0, Number.MAX_SAFE_INTEGER);
}

function validateDecision(raw: unknown): raw is MarketEventDecision {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const decision = raw as Record<string, unknown>;
  return typeof decision.id === "string" && /^evt-[a-f0-9]{32}$/.test(decision.id)
    && typeof decision.sourceId === "string" && /^[a-z0-9-]{1,80}$/.test(decision.sourceId)
    && typeof decision.sourceLabel === "string" && decision.sourceLabel.length <= 200
    && boundedText(decision.sourceLabel, 200) === decision.sourceLabel
    && typeof decision.eventId === "string" && /^evt-[a-f0-9]{32}$/.test(decision.eventId)
    && validInteger(decision.observedAt, 1, Number.MAX_SAFE_INTEGER)
    && (decision.publishedAt === undefined || validInteger(decision.publishedAt, 1, Number.MAX_SAFE_INTEGER))
    && typeof decision.title === "string" && decision.title.length >= 1 && decision.title.length <= MAX_TITLE_CHARS
    && boundedText(decision.title, MAX_TITLE_CHARS) === decision.title
    && (decision.url === undefined || (typeof decision.url === "string" && decision.url.length <= MAX_URL_CHARS
      && sanitizePublicUrl(decision.url) === decision.url))
    && (decision.eventClass === "halt" || decision.eventClass === "corporate-action" || decision.eventClass === "filing"
      || decision.eventClass === "macro" || decision.eventClass === "regulatory" || decision.eventClass === "other")
    && (decision.association === "structured-symbol" || decision.association === "explicit-symbol"
      || decision.association === "market-wide" || decision.association === "unresolved")
    && Array.isArray(decision.symbols) && decision.symbols.length <= 20
    && decision.symbols.every((symbol) => typeof symbol === "string" && normalizeSymbol(symbol) === symbol)
    && new Set(decision.symbols as string[]).size === decision.symbols.length
    && (decision.disposition === "admit-shadow" || decision.disposition === "watch" || decision.disposition === "suppress")
    && validInteger(decision.priority, 0, 100)
    && Array.isArray(decision.reasonCodes) && decision.reasonCodes.length <= 10
    && decision.reasonCodes.every((reason) => typeof reason === "string" && /^[a-z0-9-]{1,100}$/.test(reason))
    && (decision.target === undefined || validateTarget(decision.target))
    && validateDecisionSemantics(decision as unknown as MarketEventDecision);
}

function validateTarget(raw: unknown): raw is MarketEventTarget {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const target = raw as Record<string, unknown>;
  if (target.kind === "ticker") {
    return typeof target.symbol === "string" && normalizeSymbol(target.symbol) === target.symbol && target.lane === undefined;
  }
  return target.kind === "market" && target.symbol === undefined && (target.lane === "macro" || target.lane === "story");
}

function validateDecisionSemantics(decision: MarketEventDecision): boolean {
  if (decision.target?.kind === "ticker") {
    if (decision.symbols.length !== 1 || decision.symbols[0] !== decision.target.symbol) return false;
    if (decision.association !== "structured-symbol" && decision.association !== "explicit-symbol") return false;
  }
  if (decision.target?.kind === "market") {
    if (decision.symbols.length !== 0 || decision.association !== "market-wide") return false;
  }
  if (decision.disposition !== "admit-shadow") return true;
  if (!decision.target) return false;
  if (decision.eventClass === "macro") {
    return decision.target.kind === "market" && decision.target.lane === "macro";
  }
  return decision.target.kind === "ticker" && decision.symbols.length === 1;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function validateTriggerPolicy(raw: unknown): raw is MarketEventTriggerPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const policy = raw as Record<string, unknown>;
  return hasExactKeys(policy, ["version", "minPriority", "ttlMs", "targetCooldownMs", "dailyCap"])
    && policy.version === 1
    && validInteger(policy.minPriority, 0, 100)
    && validInteger(policy.ttlMs, 60_000, 72 * 60 * 60_000)
    && validInteger(policy.targetCooldownMs, 60_000, 30 * 24 * 60 * 60_000)
    && validInteger(policy.dailyCap, 1, 1_000);
}

function validateTriggerRoute(raw: unknown): raw is MarketEventTriggerRoute {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const route = raw as Record<string, unknown>;
  if (route.kind === "ticker-brief") {
    return hasExactKeys(route, ["kind", "symbol"])
      && typeof route.symbol === "string" && normalizeSymbol(route.symbol) === route.symbol;
  }
  return hasExactKeys(route, ["kind"])
    && (route.kind === "macro-event-brief" || route.kind === "market-story-brief");
}

const TRIGGER_GATE_REASONS = new Set<MarketEventTriggerGateReason>([
  "not-admitted",
  "unsupported-route",
  "below-priority",
  "expired",
  "target-cooldown",
  "daily-cap",
]);

function validTriggerTargetKey(value: unknown): value is string {
  if (value === "event:macro" || value === "market-story") return true;
  if (typeof value !== "string" || !value.startsWith("ticker:")) return false;
  const symbol = value.slice("ticker:".length);
  return normalizeSymbol(symbol) === symbol;
}

function validateTriggerCandidate(raw: unknown): raw is MarketEventTriggerCandidate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const candidate = raw as Record<string, unknown>;
  if (!(typeof candidate.id === "string" && /^trg-[a-f0-9]{32}$/.test(candidate.id))
    || candidate.mappingVersion !== TRIGGER_MAPPING_VERSION
    || typeof candidate.decisionId !== "string" || !/^evt-[a-f0-9]{32}$/.test(candidate.decisionId)
    || candidate.id !== triggerCandidateId(candidate.decisionId)
    || typeof candidate.sourceId !== "string" || !/^[a-z0-9-]{1,80}$/.test(candidate.sourceId)
    || !validInteger(candidate.observedAt, 1, Number.MAX_SAFE_INTEGER)
    || (candidate.publishedAt !== undefined && !validInteger(candidate.publishedAt, 1, Number.MAX_SAFE_INTEGER))
    || !validInteger(candidate.evaluatedAt, candidate.observedAt, Number.MAX_SAFE_INTEGER)
    || typeof candidate.title !== "string" || candidate.title.length < 1 || candidate.title.length > MAX_TITLE_CHARS
    || boundedText(candidate.title, MAX_TITLE_CHARS) !== candidate.title
    || (candidate.url !== undefined && !(typeof candidate.url === "string" && candidate.url.length <= MAX_URL_CHARS
      && sanitizePublicUrl(candidate.url) === candidate.url))
    || !(candidate.eventClass === "halt" || candidate.eventClass === "corporate-action" || candidate.eventClass === "filing"
      || candidate.eventClass === "macro" || candidate.eventClass === "regulatory" || candidate.eventClass === "other")
    || !(candidate.association === "structured-symbol" || candidate.association === "explicit-symbol"
      || candidate.association === "market-wide" || candidate.association === "unresolved")
    || !(candidate.disposition === "admit-shadow" || candidate.disposition === "watch" || candidate.disposition === "suppress")
    || !validInteger(candidate.priority, 0, 100)
    || !Array.isArray(candidate.decisionReasonCodes) || candidate.decisionReasonCodes.length > 10
    || !candidate.decisionReasonCodes.every((reason) => typeof reason === "string" && /^[a-z0-9-]{1,100}$/.test(reason))
    || new Set(candidate.decisionReasonCodes as string[]).size !== candidate.decisionReasonCodes.length
    || !validateTriggerPolicy(candidate.policy)
    || !validInteger(candidate.expiresAt, 1, Number.MAX_SAFE_INTEGER)
    || !(candidate.outcome === "would-trigger" || candidate.outcome === "gated")
    || !Array.isArray(candidate.gateReasonCodes) || candidate.gateReasonCodes.length > TRIGGER_GATE_REASONS.size
    || !candidate.gateReasonCodes.every((reason) => typeof reason === "string"
      && TRIGGER_GATE_REASONS.has(reason as MarketEventTriggerGateReason))
    || new Set(candidate.gateReasonCodes as string[]).size !== candidate.gateReasonCodes.length) {
    return false;
  }

  const policy = candidate.policy as MarketEventTriggerPolicy;
  const route = candidate.route === undefined ? undefined : validateTriggerRoute(candidate.route)
    ? candidate.route as MarketEventTriggerRoute : undefined;
  if (candidate.route !== undefined && !route) return false;
  const expectedTargetKey = triggerTargetKey(route);
  if (expectedTargetKey === undefined) {
    if (candidate.targetKey !== undefined) return false;
  } else if (!validTriggerTargetKey(candidate.targetKey) || candidate.targetKey !== expectedTargetKey) {
    return false;
  }
  if (route?.kind === "ticker-brief"
    && candidate.association !== "structured-symbol" && candidate.association !== "explicit-symbol") return false;
  if (route && route.kind !== "ticker-brief" && candidate.association !== "market-wide") return false;

  const expectedExpiresAt = safeTimestampAdd(
    (candidate.publishedAt ?? candidate.observedAt) as number,
    policy.ttlMs,
  );
  if (candidate.expiresAt !== expectedExpiresAt) return false;
  const gates = new Set(candidate.gateReasonCodes as MarketEventTriggerGateReason[]);
  const notAdmitted = candidate.disposition !== "admit-shadow";
  const unsupportedRoute = route === undefined;
  const belowPriority = (candidate.priority as number) < policy.minPriority;
  const expired = (candidate.evaluatedAt as number) >= expectedExpiresAt;
  if (gates.has("not-admitted") !== notAdmitted
    || gates.has("unsupported-route") !== unsupportedRoute
    || gates.has("below-priority") !== belowPriority
    || gates.has("expired") !== expired) return false;
  const hasStatelessGate = notAdmitted || unsupportedRoute || belowPriority || expired;
  if (hasStatelessGate && (gates.has("target-cooldown") || gates.has("daily-cap"))) return false;
  if (candidate.outcome === "would-trigger") return gates.size === 0;
  return gates.size > 0 && (hasStatelessGate || gates.has("target-cooldown") || gates.has("daily-cap"));
}

function validateCounterGroup(raw: unknown, keys: readonly string[]): raw is Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const group = raw as Record<string, unknown>;
  return hasExactKeys(group, keys)
    && keys.every((key) => validInteger(group[key], 0, Number.MAX_SAFE_INTEGER));
}

function validateTriggerAggregate(raw: unknown): raw is MarketEventTriggerAggregate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const aggregate = raw as Record<string, unknown>;
  if (!hasExactKeys(aggregate, ["evaluated", "mapped", "wouldTrigger", "gated", "missingPublishedAt", "routes", "associations", "gates"])
    || !validInteger(aggregate.evaluated, 0, Number.MAX_SAFE_INTEGER)
    || !validInteger(aggregate.mapped, 0, Number.MAX_SAFE_INTEGER)
    || !validInteger(aggregate.wouldTrigger, 0, Number.MAX_SAFE_INTEGER)
    || !validInteger(aggregate.gated, 0, Number.MAX_SAFE_INTEGER)
    || !validInteger(aggregate.missingPublishedAt, 0, Number.MAX_SAFE_INTEGER)
    || !validateCounterGroup(aggregate.routes, ["tickerBrief", "macroEventBrief", "marketStoryBrief", "unsupported"])
    || !validateCounterGroup(aggregate.associations, ["structuredSymbol", "explicitSymbol", "marketWide", "unresolved"])
    || !validateCounterGroup(aggregate.gates, ["notAdmitted", "unsupportedRoute", "belowPriority", "expired", "targetCooldown", "dailyCap"])) {
    return false;
  }
  const routes = aggregate.routes as Record<string, number>;
  const associations = aggregate.associations as Record<string, number>;
  const gates = aggregate.gates as Record<string, number>;
  const evaluated = aggregate.evaluated as number;
  const gated = aggregate.gated as number;
  return aggregate.mapped === routes.tickerBrief + routes.macroEventBrief + routes.marketStoryBrief
    && evaluated === aggregate.mapped + routes.unsupported
    && evaluated === (aggregate.wouldTrigger as number) + gated
    && aggregate.missingPublishedAt <= evaluated
    && evaluated === associations.structuredSymbol + associations.explicitSymbol + associations.marketWide + associations.unresolved
    && Object.values(gates).every((count) => count <= gated);
}

function validateTriggerDryRunState(raw: unknown): raw is MarketEventTriggerDryRunState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const state = raw as Record<string, unknown>;
  if (!hasExactKeys(state, ["policy", "candidates", "totals", "days", "cooldowns"])
    || !validateTriggerPolicy(state.policy)
    || !Array.isArray(state.candidates) || state.candidates.length > 2_000 || !state.candidates.every(validateTriggerCandidate)
    || !validateTriggerAggregate(state.totals)
    || !Array.isArray(state.days) || state.days.length > MAX_TRIGGER_DAYS
    || !Array.isArray(state.cooldowns) || state.cooldowns.length > MAX_TRIGGER_COOLDOWNS) return false;

  const candidates = state.candidates as MarketEventTriggerCandidate[];
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
    || new Set(candidates.map((candidate) => candidate.decisionId)).size !== candidates.length
    || candidates.some((candidate) => !sameTriggerPolicy(candidate.policy, state.policy as MarketEventTriggerPolicy))) return false;
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1]!;
    const current = candidates[index]!;
    if (previous.evaluatedAt < current.evaluatedAt
      || (previous.evaluatedAt === current.evaluatedAt && previous.priority < current.priority)
      || (previous.evaluatedAt === current.evaluatedAt && previous.priority === current.priority && previous.id > current.id)) return false;
  }

  const days = state.days as unknown[];
  const dayKeys: string[] = [];
  for (const rawDay of days) {
    if (!rawDay || typeof rawDay !== "object" || Array.isArray(rawDay)) return false;
    const day = rawDay as Record<string, unknown>;
    if (!hasExactKeys(day, ["day", "aggregate"])
      || typeof day.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.day)
      || new Date(`${day.day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day.day
      || !validateTriggerAggregate(day.aggregate)) return false;
    dayKeys.push(day.day);
  }
  if (new Set(dayKeys).size !== dayKeys.length || dayKeys.some((day, index) => index > 0 && day > dayKeys[index - 1]!)) return false;

  const cooldowns = state.cooldowns as unknown[];
  const cooldownKeys: string[] = [];
  let previousCooldownAt = Number.MAX_SAFE_INTEGER;
  for (const rawCooldown of cooldowns) {
    if (!rawCooldown || typeof rawCooldown !== "object" || Array.isArray(rawCooldown)) return false;
    const cooldown = rawCooldown as Record<string, unknown>;
    if (!hasExactKeys(cooldown, ["targetKey", "lastWouldTriggerAt"])
      || !validTriggerTargetKey(cooldown.targetKey)
      || !validInteger(cooldown.lastWouldTriggerAt, 1, Number.MAX_SAFE_INTEGER)
      || cooldown.lastWouldTriggerAt > previousCooldownAt) return false;
    cooldownKeys.push(cooldown.targetKey);
    previousCooldownAt = cooldown.lastWouldTriggerAt;
  }
  return new Set(cooldownKeys).size === cooldownKeys.length;
}

function validateTriggerDispatchRecord(raw: unknown): raw is MarketEventTriggerDispatchRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const allowedKeys = ["candidateId", "status", "attempt", "createdAt", "updatedAt", "modelId", "dispatchDays", "dispatchDay", "jobId", "error"];
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) return false;
  if (typeof record.candidateId !== "string" || !/^trg-[a-f0-9]{32}$/.test(record.candidateId)
    || !validModelId(record.modelId) || record.modelId !== MARKET_SCOUT_MODEL_ID
    || !(record.status === "pending" || record.status === "reserved" || record.status === "enqueued"
      || record.status === "settled" || record.status === "failed")
    || !validInteger(record.attempt, 0, MAX_TRIGGER_DISPATCH_ATTEMPTS)
    || !validInteger(record.createdAt, 1, Number.MAX_SAFE_INTEGER)
    || !validInteger(record.updatedAt, record.createdAt as number, Number.MAX_SAFE_INTEGER)
    || (record.dispatchDay !== undefined && !validUtcDay(record.dispatchDay))
    || (record.jobId !== undefined && (typeof record.jobId !== "string" || record.jobId.length < 1 || record.jobId.length > 256))
    || (record.error !== undefined && (typeof record.error !== "string" || record.error.length < 1 || record.error.length > 500))) {
    return false;
  }
  if (record.dispatchDays !== undefined && (
    !Array.isArray(record.dispatchDays)
    || record.dispatchDays.length !== record.attempt
    || record.dispatchDays.length > MAX_TRIGGER_DISPATCH_ATTEMPTS
    || !record.dispatchDays.every(validUtcDay)
  )) return false;
  if (record.dispatchDays === undefined && record.attempt > 0 && record.dispatchDay === undefined) return false;
  if (record.status === "pending" || record.status === "reserved") {
    if (record.jobId !== undefined) return false;
  } else if (record.status === "enqueued" && typeof record.jobId !== "string") {
    return false;
  }
  if (record.status !== "pending" && dispatchAttemptDays(record as Pick<MarketEventTriggerDispatchRecord, "attempt" | "dispatchDays" | "dispatchDay">).length === 0) return false;
  if (record.status === "failed" && typeof record.error !== "string") return false;
  return true;
}

function normalizeTriggerDispatchRecord(raw: MarketEventTriggerDispatchRecord): MarketEventTriggerDispatchRecord {
  const days = dispatchAttemptDays(raw);
  return {
    ...raw,
    ...(raw.dispatchDays === undefined ? { dispatchDays: days } : { dispatchDays: [...raw.dispatchDays] }),
  };
}

function isLiveTriggerDispatch(record: MarketEventTriggerDispatchRecord): boolean {
  return record.status === "pending" || record.status === "reserved" || record.status === "enqueued";
}

function retainTriggerDispatches(records: MarketEventTriggerDispatchRecord[]): MarketEventTriggerDispatchRecord[] {
  const live = records.filter(isLiveTriggerDispatch);
  const terminal = records.filter((record) => !isLiveTriggerDispatch(record));
  // Never evict an unsettled dispatch to make room for newer terminal history.
  // Admission stops once the live portion reaches the bound, so truncation is
  // only needed for settled/failed telemetry.
  return live.length >= MAX_TRIGGER_DISPATCHES
    ? live.slice(0, MAX_TRIGGER_DISPATCHES)
    : [...live, ...terminal.slice(0, MAX_TRIGGER_DISPATCHES - live.length)];
}

export async function readMarketEventScoutState(path: string, now: number = Date.now()): Promise<MarketEventScoutState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return emptyState(now);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Malformed market event scout state: invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Malformed market event scout state: not an object");
  }
  const state = parsed as Record<string, unknown>;
  if ((state.version !== 1 && state.version !== 2 && state.version !== 3)
    || !Array.isArray(state.sources) || !Array.isArray(state.decisions)
    || (state.version >= 2 && state.triggerDryRun === undefined)
    || (state.version >= 3 && state.triggerDispatches === undefined)) {
    throw new Error("Malformed market event scout state: unsupported schema");
  }
  if (state.sources.length > 100 || !state.sources.every(validateSourceState)
    || state.decisions.length > 2_000 || !state.decisions.every(validateDecision)
    || (state.version >= 2 && !validateTriggerDryRunState(state.triggerDryRun))
    || (state.version >= 3 && (!Array.isArray(state.triggerDispatches)
      || state.triggerDispatches.length > MAX_TRIGGER_DISPATCHES
      || !state.triggerDispatches.every(validateTriggerDispatchRecord)))) {
    throw new Error("Malformed market event scout state: invalid record");
  }
  const sources = state.sources as MarketEventScoutSourceState[];
  if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) {
    throw new Error("Malformed market event scout state: duplicate source");
  }
  const decisions = state.decisions as MarketEventDecision[];
  if (new Set(decisions.map((decision) => decision.id)).size !== decisions.length) {
    throw new Error("Malformed market event scout state: duplicate decision");
  }
  if (!validInteger(state.updatedAt, 1, Number.MAX_SAFE_INTEGER)) {
    throw new Error("Malformed market event scout state: invalid updatedAt");
  }
  const triggerDispatches = state.version === 3
    ? (state.triggerDispatches as MarketEventTriggerDispatchRecord[]).map(normalizeTriggerDispatchRecord)
    : [];
  if (new Set(triggerDispatches.map((record) => record.candidateId)).size !== triggerDispatches.length) {
    throw new Error("Malformed market event scout state: duplicate trigger dispatch");
  }
  return {
    version: 3,
    updatedAt: state.updatedAt,
    sources,
    decisions,
    // v1 migration is deliberately empty: retained historical decisions are
    // not replayed as newly observed trigger evidence.
    triggerDryRun: state.version >= 2
      ? state.triggerDryRun as MarketEventTriggerDryRunState
      : emptyTriggerDryRunState(),
    triggerDispatches,
  };
}

export async function writeMarketEventScoutState(path: string, state: MarketEventScoutState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const updated = { ...state, updatedAt: Date.now() };
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(updated)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function initialSourceState(sourceId: string): MarketEventScoutSourceState {
  return {
    sourceId,
    baselineComplete: false,
    seenEventIds: [],
    nextPollAt: 0,
    lastStatus: "never",
    lastItemCount: 0,
    baselineItems: 0,
    newItems: 0,
    admitted: 0,
    watched: 0,
    suppressed: 0,
  };
}

function safeSourceError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Source retrieval failed";
  return boundedText(message, 500) || "Source retrieval failed";
}

/** In-process path serialization supplements the deployment's one-parent-writer invariant. */
const statePathQueues = new Map<string, Promise<void>>();

function withStatePathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = statePathQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  statePathQueues.set(path, gate);
  const result = previous.catch(() => undefined).then(operation).finally(release);
  void gate.finally(() => {
    if (statePathQueues.get(path) === gate) statePathQueues.delete(path);
  });
  return result;
}

async function withSourceDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let rejectGuard!: (reason: unknown) => void;
  const guard = new Promise<never>((_resolve, reject) => { rejectGuard = reject; });
  const forwardAbort = () => {
    const reason = parentSignal?.reason ?? new Error("Market event scout aborted");
    controller.abort(reason);
    rejectGuard(reason);
  };
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    const reason = new Error("Source retrieval timed out");
    controller.abort(reason);
    rejectGuard(reason);
  }, timeoutMs);
  try {
    const result = await Promise.race([operation(controller.signal), guard]);
    if (timedOut) throw new Error("Source retrieval timed out");
    return result;
  } catch (error) {
    if (parentSignal?.aborted) throw parentSignal.reason ?? new Error("Market event scout aborted");
    if (timedOut) throw new Error("Source retrieval timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", forwardAbort);
  }
}

export class MarketEventScout {
  private readonly client: MarketEventDocumentClient;
  private readonly statePath: string;
  private readonly sources: readonly MarketEventSource[];
  private readonly getTrackedSymbols: () => Iterable<string>;
  private readonly now: () => number;
  private readonly maxSeenPerSource: number;
  private readonly maxStoredDecisions: number;
  private readonly maxStoredTriggerCandidates: number;
  private readonly triggerPolicy: MarketEventTriggerPolicy;
  private readonly dispatch?: MarketEventTriggerDispatcher;
  private readonly dispatchPolicy: MarketEventTriggerDispatchPolicy;
  private dispatchRecoveryComplete = false;
  private readonly errorBackoffMs: number;
  private readonly sourceTimeoutMs: number;
  private running?: Promise<MarketEventScoutRunResult>;

  constructor(options: MarketEventScoutOptions) {
    if (!isAbsolute(options.statePath)) throw new Error("Market event scout state path must be absolute");
    this.client = options.client;
    this.statePath = options.statePath;
    this.sources = options.sources ?? DEFAULT_MARKET_EVENT_SOURCES;
    this.getTrackedSymbols = options.getTrackedSymbols ?? (() => []);
    this.now = options.now ?? Date.now;
    this.maxSeenPerSource = positiveInteger(options.maxSeenPerSource, DEFAULT_MAX_SEEN_PER_SOURCE, 2_000);
    this.maxStoredDecisions = positiveInteger(options.maxStoredDecisions, DEFAULT_MAX_STORED_DECISIONS, 2_000);
    this.maxStoredTriggerCandidates = positiveInteger(
      options.maxStoredTriggerCandidates,
      DEFAULT_MAX_STORED_TRIGGER_CANDIDATES,
      2_000,
    );
    if (!validateTriggerPolicy(options.triggerPolicy ?? DEFAULT_MARKET_EVENT_TRIGGER_POLICY)) {
      throw new Error("Market event trigger dry-run policy is invalid");
    }
    this.triggerPolicy = cloneTriggerPolicy(options.triggerPolicy ?? DEFAULT_MARKET_EVENT_TRIGGER_POLICY);
    this.dispatch = options.dispatch;
    this.dispatchPolicy = {
      ...DEFAULT_MARKET_EVENT_TRIGGER_DISPATCH_POLICY,
      ...(options.dispatch?.policy ?? {}),
    };
    if (this.dispatch && this.dispatch.modelId !== MARKET_SCOUT_MODEL_ID) {
      throw new Error(`Market event trigger dispatch model must be ${MARKET_SCOUT_MODEL_ID}`);
    }
    if (this.dispatch && (
      this.dispatchPolicy.perRunCap !== DEFAULT_MARKET_EVENT_TRIGGER_DISPATCH_POLICY.perRunCap
      || this.dispatchPolicy.dailyCap !== DEFAULT_MARKET_EVENT_TRIGGER_DISPATCH_POLICY.dailyCap
    )) {
      throw new Error("Market event trigger dispatch policy is pinned to 1 per poll and 4 attempts per UTC day");
    }
    this.errorBackoffMs = positiveInteger(options.errorBackoffMs, DEFAULT_ERROR_BACKOFF_MS, 24 * 60 * 60_000);
    this.sourceTimeoutMs = positiveInteger(options.sourceTimeoutMs, DEFAULT_SOURCE_TIMEOUT_MS, 2 * 60_000);
    if (this.sources.length < 1 || this.sources.length > 100) throw new Error("Market event scout source count is invalid");
    const ids = this.sources.map((source) => source.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => !/^[a-z0-9-]{1,80}$/.test(id))) {
      throw new Error("Market event scout source IDs must be unique kebab-case values");
    }
    for (const source of this.sources) {
      if (sanitizePublicUrl(source.url) !== source.url) {
        throw new Error(`Market event scout source URL is invalid: ${source.id}`);
      }
      if (!source.label || boundedText(source.label, 200) !== source.label) throw new Error(`Market event scout source label is invalid: ${source.id}`);
      if (!Number.isInteger(source.pollIntervalMs) || source.pollIntervalMs < 60_000 || source.pollIntervalMs > 24 * 60 * 60_000) {
        throw new Error(`Market event scout poll interval is invalid: ${source.id}`);
      }
    }
  }

  async getState(): Promise<MarketEventScoutState> {
    return readMarketEventScoutState(this.statePath, this.now());
  }

  async nextDueAt(): Promise<number> {
    const state = await this.getState();
    const now = this.now();
    return Math.min(...this.sources.map((source) =>
      state.sources.find((candidate) => candidate.sourceId === source.id)?.nextPollAt ?? now));
  }

  run(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<MarketEventScoutRunResult> {
    if (this.running) return this.running;
    const operation = withStatePathLock(this.statePath, () => this.runOnce(options)).finally(() => {
      if (this.running === operation) this.running = undefined;
    });
    this.running = operation;
    return operation;
  }

  /**
   * Settle a dispatched candidate after the research worker publishes or
   * rejects its result. This is deliberately separate from the scout poll so
   * worker completion can update the durable outbox without another feed fetch.
   */
  async settleDispatch(
    candidateId: string,
    outcome: "complete" | "failed" | "cancelled",
    error?: string,
  ): Promise<void> {
    await withStatePathLock(this.statePath, async () => {
      const state = await readMarketEventScoutState(this.statePath, this.now());
      const record = state.triggerDispatches.find((entry) => entry.candidateId === candidateId);
      if (!record || record.status === "settled" || record.status === "failed") return;
      record.status = outcome === "complete" ? "settled" : "failed";
      record.updatedAt = this.now();
      record.error = outcome === "complete" ? undefined : boundedText(error || `Research ${outcome}`, 500);
      await writeMarketEventScoutState(this.statePath, state);
    });
  }

  private async drainDispatches(state: MarketEventScoutState): Promise<{
    enqueued: number;
    failed: number;
    pending: number;
  }> {
    if (!this.dispatch) return { enqueued: 0, failed: 0, pending: 0 };

    // A reserved/enqueued record can only be in flight when the parent process
    // was interrupted. The parent owns the worker lifecycle, so recovering it
    // to pending is safe on the first drain of a fresh scout instance. Keeping
    // this one-shot prevents duplicate dispatches during ordinary polling.
    if (!this.dispatchRecoveryComplete) {
      for (const record of state.triggerDispatches) {
        if (record.status === "reserved" || record.status === "enqueued") {
          record.status = "pending";
          record.jobId = undefined;
          record.error = undefined;
          record.updatedAt = this.now();
        }
      }
      await writeMarketEventScoutState(this.statePath, state);
      this.dispatchRecoveryComplete = true;
    }

    const candidates = new Map(state.triggerDryRun.candidates.map((candidate) => [candidate.id, candidate]));
    const today = marketEventTriggerDay(this.now());
    let attemptsToday = state.triggerDispatches.reduce(
      (count, record) => count + dispatchAttemptDays(record).filter((day) => day === today).length,
      0,
    );
    let acceptedThisRun = 0;
    let failedThisRun = 0;

    for (const record of [...state.triggerDispatches].sort((a, b) => a.createdAt - b.createdAt)) {
      if (record.status !== "pending") continue;
      if (acceptedThisRun >= this.dispatchPolicy.perRunCap || attemptsToday >= this.dispatchPolicy.dailyCap) break;
      if (record.attempt >= MAX_TRIGGER_DISPATCH_ATTEMPTS) {
        record.status = "failed";
        record.error = "Trigger dispatch retry limit reached";
        record.updatedAt = this.now();
        failedThisRun += 1;
        await writeMarketEventScoutState(this.statePath, state);
        continue;
      }

      const candidate = candidates.get(record.candidateId);
      if (!candidate || candidate.outcome !== "would-trigger") {
        record.status = "failed";
        record.error = "Trigger candidate is no longer retained";
        record.updatedAt = this.now();
        failedThisRun += 1;
        await writeMarketEventScoutState(this.statePath, state);
        continue;
      }

      record.status = "reserved";
      record.attempt += 1;
      record.dispatchDays = [...dispatchAttemptDays(record), today];
      record.updatedAt = this.now();
      record.error = undefined;
      record.jobId = undefined;
      attemptsToday += 1;
      await writeMarketEventScoutState(this.statePath, state);

      let result: Awaited<ReturnType<MarketEventTriggerDispatcher["dispatch"]>>;
      try {
        result = await this.dispatch.dispatch(candidate);
      } catch (error) {
        result = { accepted: false, error: error instanceof Error ? error.message : String(error) };
      }
      const safeError = boundedText(result.error || "Dispatch adapter rejected the candidate", 500);
      if (result.accepted && typeof result.jobId === "string" && result.jobId.length > 0 && result.jobId.length <= 256) {
        record.status = "enqueued";
        record.jobId = result.jobId;
        record.error = undefined;
        acceptedThisRun += 1;
      } else if (!result.accepted && result.retryable) {
        record.status = "pending";
        record.error = safeError;
      } else {
        record.status = "failed";
        record.error = safeError;
        failedThisRun += 1;
      }
      record.updatedAt = this.now();
      await writeMarketEventScoutState(this.statePath, state);
    }

    return {
      enqueued: acceptedThisRun,
      failed: failedThisRun,
      pending: state.triggerDispatches.filter((record) => record.status === "pending").length,
    };
  }

  private async runOnce(options: { force?: boolean; signal?: AbortSignal }): Promise<MarketEventScoutRunResult> {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Market event scout aborted");
    const startedAt = this.now();
    const state = await readMarketEventScoutState(this.statePath, startedAt);
    const trackedSymbols = [...this.getTrackedSymbols()];
    const runDecisions: MarketEventDecision[] = [];
    let successfulSources = 0;
    let failedSources = 0;
    let baselineItems = 0;
    let newItems = 0;
    let admitted = 0;
    let watched = 0;
    let suppressed = 0;
    let polledSources = 0;

    for (const source of this.sources) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Market event scout aborted");
      let sourceState = state.sources.find((candidate) => candidate.sourceId === source.id);
      if (!sourceState) {
        sourceState = initialSourceState(source.id);
        state.sources.push(sourceState);
      }
      const attemptAt = this.now();
      if (!options.force && sourceState.nextPollAt > attemptAt) continue;
      polledSources += 1;
      sourceState.lastAttemptAt = attemptAt;

      try {
        const document = await withSourceDeadline(
          (sourceSignal) => this.client.readDocument(source.url, sourceSignal),
          this.sourceTimeoutMs,
          options.signal,
        );
        if (document.retrievalStatus !== "fetched") {
          throw new Error(`Source retrieval ${document.retrievalStatus}`);
        }
        if (document.truncated) throw new Error("Source document exceeded the retrieval safety limit");
        const items = parsePublicFeed(source, document.body);
        const observedAt = this.now();
        sourceState.lastStatus = "ok";
        sourceState.lastError = undefined;
        sourceState.lastSuccessAt = observedAt;
        sourceState.lastItemCount = items.length;
        sourceState.nextPollAt = observedAt + source.pollIntervalMs;
        successfulSources += 1;

        const currentIds = items.map((item) => item.id);
        if (!sourceState.baselineComplete) {
          sourceState.baselineComplete = true;
          sourceState.baselineItems += items.length;
          baselineItems += items.length;
        } else {
          const seen = new Set(sourceState.seenEventIds);
          const unseen = items.filter((item) => !seen.has(item.id));
          sourceState.newItems += unseen.length;
          newItems += unseen.length;
          for (const item of unseen) {
            const decision = evaluateMarketEvent(source, item, observedAt, trackedSymbols);
            if (decision.disposition === "admit-shadow") {
              admitted += 1;
              sourceState.admitted += 1;
            } else if (decision.disposition === "watch") {
              watched += 1;
              sourceState.watched += 1;
            } else {
              suppressed += 1;
              sourceState.suppressed += 1;
            }
            if (decision.disposition !== "suppress") runDecisions.push(decision);
          }
        }
        sourceState.seenEventIds = [...new Set([...currentIds, ...sourceState.seenEventIds])]
          .slice(0, this.maxSeenPerSource);
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("Market event scout aborted");
        sourceState.lastStatus = "error";
        sourceState.lastError = safeSourceError(error);
        sourceState.nextPollAt = this.now() + Math.max(source.pollIntervalMs, this.errorBackoffMs);
        failedSources += 1;
      }
    }

    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Market event scout aborted");
    runDecisions.sort((a, b) => b.priority - a.priority || b.observedAt - a.observedAt || a.id.localeCompare(b.id));
    const triggerCandidates = recordTriggerCandidates(state.triggerDryRun, runDecisions, {
      evaluatedAt: this.now(),
      policy: this.triggerPolicy,
      maxStoredCandidates: this.maxStoredTriggerCandidates,
    });
    if (this.dispatch) {
      const knownDispatches = new Set(state.triggerDispatches.map((record) => record.candidateId));
      for (const candidate of triggerCandidates) {
        if (candidate.outcome !== "would-trigger" || knownDispatches.has(candidate.id)
          || state.triggerDispatches.filter(isLiveTriggerDispatch).length >= MAX_TRIGGER_DISPATCHES) continue;
        state.triggerDispatches.unshift({
          candidateId: candidate.id,
          status: "pending",
          attempt: 0,
          createdAt: this.now(),
          updatedAt: this.now(),
          modelId: this.dispatch.modelId,
          dispatchDays: [],
        });
        knownDispatches.add(candidate.id);
      }
      state.triggerDispatches = retainTriggerDispatches(state.triggerDispatches);
    }
    if (runDecisions.length > 0) {
      const byId = new Map<string, MarketEventDecision>();
      for (const decision of [...runDecisions, ...state.decisions]) {
        if (!byId.has(decision.id)) byId.set(decision.id, decision);
      }
      state.decisions = [...byId.values()]
        .sort((a, b) => b.observedAt - a.observedAt || b.priority - a.priority)
        .slice(0, this.maxStoredDecisions);
    }
    state.sources = state.sources.filter((source) => this.sources.some((configured) => configured.id === source.sourceId));
    state.updatedAt = this.now();
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Market event scout aborted");
    await writeMarketEventScoutState(this.statePath, state);
    const dispatch = await this.drainDispatches(state);

    return {
      startedAt,
      completedAt: this.now(),
      polledSources,
      successfulSources,
      failedSources,
      baselineItems,
      newItems,
      admitted,
      watched,
      suppressed,
      decisions: runDecisions,
      triggerCandidates,
      candidateEvaluated: triggerCandidates.length,
      wouldTrigger: triggerCandidates.filter((candidate) => candidate.outcome === "would-trigger").length,
      gated: triggerCandidates.filter((candidate) => candidate.outcome === "gated").length,
      dispatchEnqueued: dispatch.enqueued,
      dispatchFailed: dispatch.failed,
      dispatchPending: dispatch.pending,
    };
  }
}
