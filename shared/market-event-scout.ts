/**
 * Deterministic, shadow-only market event scout.
 *
 * Public RSS/Atom feeds are acquired through Unbrowser, parsed with bounded
 * helpers, associated to a tracked security or market lane, and persisted for
 * inspection. This module never dispatches model research or reserves tokens.
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
  version: 1;
  updatedAt: number;
  sources: MarketEventScoutSourceState[];
  /** Recent actionable observations only; suppressed events remain counters. */
  decisions: MarketEventDecision[];
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

export function marketEventScoutFilePath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MARKET_DATA_DIR?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("MARKET_DATA_DIR must be an absolute path");
    return join(configured, "market-event-scout.json");
  }
  return join(cwd, ".pi", "market-event-scout.json");
}

function emptyState(now: number): MarketEventScoutState {
  return { version: 1, updatedAt: now, sources: [], decisions: [] };
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
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
  if (state.version !== 1 || !Array.isArray(state.sources) || !Array.isArray(state.decisions)) {
    throw new Error("Malformed market event scout state: unsupported schema");
  }
  if (state.sources.length > 100 || !state.sources.every(validateSourceState)
    || state.decisions.length > 2_000 || !state.decisions.every(validateDecision)) {
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
  return {
    version: 1,
    updatedAt: state.updatedAt,
    sources,
    decisions,
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
    };
  }
}
