/**
 * Authenticated browser-terminal backend.
 *
 * This entrypoint deliberately has no Pi imports. The browser owns the
 * terminal/research state; this service only authenticates the principal
 * supplied by the reverse proxy, brokers fixed upstreams, and persists the
 * small durable records the browser kernel needs.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import express, { type Request, type Response as ExpressResponse } from "express";
import {
  CHART_SCOPE_CONFIGS,
  normalizeChartScope,
  parseChartPayloadToQuote,
  type ChartScope,
  type Quote,
} from "../shared/kernel/quotes.js";
import {
  fetchCryptoPulse,
  isCryptoPulseUsable,
  resolveYahooPair,
  type CryptoPulseSnapshot,
  type FetchLike,
} from "../shared/crypto-pulse.js";
import { isMarketResearchToolName, MARKET_RESEARCH_TOOL_NAMES } from "../shared/research-tool-policy.js";
import { isUnbrowserMcpToolName } from "../shared/unbrowser-mcp.js";
import { normalizeWatchlistSymbol, WATCHLIST_MAX_SYMBOLS } from "../shared/watchlist-symbols.js";
import { matchesProxyToken, normalizePrincipal, singleHeader } from "./proxy-auth.js";
import {
  extractWatchlistFromScreenshot,
  WATCHLIST_SCREENSHOT_MAX_BYTES,
  WatchlistScreenshotImportError,
  WatchlistScreenshotImportLimiter,
  validateWatchlistScreenshotImport,
} from "./watchlist-screenshot-import.js";
import {
  createPersistentProviderBudget,
  estimateChatProviderCost,
  providerBudgetConfigFromEnv,
  type ProviderBudgetConfig,
} from "./provider-budget.js";

const USER_HEADER = "x-fin-terminal-user";
const PROXY_TOKEN_HEADER = "x-fin-terminal-proxy-token";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash-0731";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_CHAT_BODY_BYTES = 512 * 1024;
const MAX_CHAT_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MCP_BODY_BYTES = 128 * 1024;
const MAX_MCP_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_QUOTE_RESPONSE_BYTES = 512 * 1024;
const MAX_STORAGE_BODY_BYTES = 2 * 1024 * 1024;
const CRYPTO_CACHE_TTL_MS = 60_000;
const BROKER_RATE_WINDOW_MS = 60_000;
const MAX_GLOBAL_CONCURRENCY = 16;
const MAX_PRINCIPAL_CONCURRENCY = 4;
const MAX_CHAT_CONCURRENCY = 2;
// Keep these in lockstep with the dedicated unbrowser_mcp_router overlay:
// inactive workers expire after 120s and no worker lives longer than 900s.
const MCP_SESSION_IDLE_TTL_MS = 120 * 1_000;
const MCP_SESSION_MAX_LIFETIME_MS = 900 * 1_000;
const UPSTREAM_CHAT_TIMEOUT_MS = 75_000;
const UPSTREAM_MCP_TIMEOUT_MS = 35_000;
const UPSTREAM_QUOTE_TIMEOUT_MS = 15_000;
const UPSTREAM_MCP_CLOSE_TIMEOUT_MS = 5_000;
// Whole-universe batch quote fetch. One batch request replaces ~130 per-symbol
// requests, so the overall deadline must fit inside the browser's own 12s
// refresh deadline and the per-symbol upstream timeout stays the single-quote
// bound.
const QUOTE_BATCH_MAX_SYMBOLS = 200;
const QUOTE_BATCH_CACHE_TTL_MS = 20_000;
const QUOTE_BATCH_DEADLINE_MS = 10_000;
const QUOTE_BATCH_UPSTREAM_CONCURRENCY = 6;
const QUOTE_BATCH_CACHE_MAX_ENTRIES = 8;
const MCP_READINESS_TIMEOUT_MS = 10_000;
const MCP_READINESS_CACHE_MS = 10_000;
const MCP_PROTOCOL_VERSION = "2025-03-26";
const MCP_METHODS = new Set(["initialize", "notifications/initialized", "tools/call"]);
const STORAGE_NAMES = new Set(["market-research-archive.json", "market-watchlist.json"]);
const MAX_MCP_SESSIONS = 8;
const MAX_MCP_SESSIONS_PER_PRINCIPAL = 4;
const MCP_INITIALIZE_RATE_WINDOW_MS = 60_000;
// A single research run opens one upstream session per unbrowser client call
// (initialize + notifications + tools/call + DELETE). A healthy J run makes
// ~6-7 sessions and a J+K session more, so the cap must sit comfortably above
// that or discovery 429s mid-run.
const MCP_INITIALIZE_RATE_LIMIT = 30;

// Quote refreshes are intentionally high-volume. They must not consume the
// same per-minute budget as crypto, interactive research, or control traffic;
// otherwise a 58-symbol refresh can make J/K source discovery unavailable for
// the rest of the minute and can starve the crypto pulse endpoint.
const QUOTE_RATE_LIMIT = 60;
const CRYPTO_RATE_LIMIT = 30;
// The research lane carries BOTH the model's chat turns and the worker's MCP
// traffic (chat ~8 + MCP ~26 per run). 24/min made every working research run
// exhaust its own budget: the model's next chat call got 429 and the run died
// as "Research model request failed" right after the extractions succeeded.
const RESEARCH_RATE_LIMIT = 90;
const CONTROL_RATE_LIMIT = 60;

type BrokerLane = "quote" | "crypto" | "research" | "control";

const BROKER_LANE_LIMITS: Record<BrokerLane, { rateLimit: number; globalRateLimit: number; concurrency: number }> = {
  quote: { rateLimit: QUOTE_RATE_LIMIT, globalRateLimit: QUOTE_RATE_LIMIT, concurrency: MAX_PRINCIPAL_CONCURRENCY },
  crypto: { rateLimit: CRYPTO_RATE_LIMIT, globalRateLimit: CRYPTO_RATE_LIMIT, concurrency: 2 },
  research: { rateLimit: RESEARCH_RATE_LIMIT, globalRateLimit: RESEARCH_RATE_LIMIT, concurrency: MAX_PRINCIPAL_CONCURRENCY },
  control: { rateLimit: CONTROL_RATE_LIMIT, globalRateLimit: CONTROL_RATE_LIMIT, concurrency: MAX_PRINCIPAL_CONCURRENCY },
};

type FetchImpl = typeof fetch;
type JsonRecord = Record<string, unknown>;

export interface BrowserTerminalAppOptions {
  fetchImpl?: FetchImpl;
  openRouterApiKey?: string;
  openRouterModel?: string;
  mcpEndpoint?: string;
  storageRoot?: string;
  webDist?: string;
  now?: () => number;
  proxyToken?: string;
  watchlistImportApiKey?: string;
  watchlistImportModel?: string;
  watchlistImportUrl?: string;
  providerBudget?: Partial<ProviderBudgetConfig>;
}

type PrincipalRequestState = {
  windowStartedAt: number;
  requestCount: number;
  concurrent: number;
};

type McpSession = {
  principal: string;
  upstreamSessionId: string;
  createdAt: number;
  lastUsedAt: number;
  activeRequests: number;
  requestTail: Promise<void>;
  closing: boolean;
};

type CryptoCacheEntry = {
  result: { snapshot: unknown; errors: string[] };
  cachedAt: number;
};

type QuoteBatchEntry = {
  chartScope: ChartScope;
  requested: number;
  quotes: Quote[];
  cachedAt: number;
};

type McpReadiness = {
  checkedAt: number;
  ok: boolean;
};

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function principalFor(req: Request, proxyToken: string): string | undefined {
  return normalizePrincipal(singleHeader(req, USER_HEADER), Boolean(proxyToken));
}

function sameOriginRequest(req: Request): boolean {
  const fetchSite = req.header("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") return false;
  const origin = req.header("origin");
  if (!origin) return true;
  if (origin === "null") return false;
  try {
    const parsed = new URL(origin);
    const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
    const host = forwardedHost || req.header("host");
    const forwardedProtocol = req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    const protocol = forwardedProtocol || req.protocol;
    return Boolean(
      host
      && protocol
      && parsed.host.toLowerCase() === host.toLowerCase()
      && parsed.protocol === `${protocol}:`,
    );
  } catch {
    return false;
  }
}

function quoteSymbol(value: string): string | undefined {
  const symbol = value.trim();
  return /^[A-Za-z0-9^._=\-$]{1,96}$/.test(symbol) ? symbol : undefined;
}

function validScope(value: unknown): ChartScope | undefined {
  if (typeof value !== "string") return undefined;
  const scope = normalizeChartScope(value);
  return value === scope ? scope : undefined;
}

/** Parse the batch quote symbol list: comma-separated, validated, deduped, order-preserving. */
function parseQuoteBatchSymbols(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const symbol = quoteSymbol(raw.trim());
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols;
}

function validMcpSessionId(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{20,160}$/.test(value) ? value : undefined;
}

function readMaxOutputTokens(): number {
  const raw = process.env.MARKET_MAX_OUTPUT_TOKENS?.trim();
  if (!raw) return 4_096;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 256 && value <= 16_384 ? value : 4_096;
}

function readHeader(req: Request, name: string): string | undefined {
  return singleHeader(req, name);
}

function etagFor(text: string): string {
  return `"${createHash("sha256").update(text).digest("hex")}"`;
}

function principalDirectory(root: string, principal: string): string {
  const key = createHash("sha256").update(principal).digest("hex");
  return path.join(root, key);
}

async function writeAtomic(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function validateStoredDocument(name: string, value: unknown): boolean {
  const record = asRecord(value);
  if (!record || serializedBytes(value) > MAX_STORAGE_BODY_BYTES) return false;
  if (name === "market-watchlist.json") {
    if (!Array.isArray(record.symbols) || record.symbols.length > WATCHLIST_MAX_SYMBOLS) return false;
    return record.symbols.every((symbol) => typeof symbol === "string" && Boolean(normalizeWatchlistSymbol(symbol)));
  }
  return record.version === 1
    && Array.isArray(record.entries)
    && record.entries.length <= 500;
}

function validateChatRequest(value: unknown): {
  messages: JsonRecord[];
  toolChoice: "auto" | "none";
  tools: JsonRecord[];
  parallelToolCalls: boolean;
} | undefined {
  const body = asRecord(value);
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 80) return undefined;
  if (serializedBytes(body.messages) > MAX_CHAT_BODY_BYTES) return undefined;
  const messages: JsonRecord[] = [];
  for (const raw of body.messages) {
    const message = asRecord(raw);
    if (!message || !["system", "user", "assistant", "tool"].includes(String(message.role))) return undefined;
    if (message.content !== undefined && serializedBytes(message.content) > 80_000) return undefined;
    if (message.role === "tool" && (!boundedString(message.tool_call_id, 160) || !boundedString(message.content, 80_000))) return undefined;
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 8) return undefined;
      for (const rawCall of message.tool_calls) {
        const call = asRecord(rawCall);
        const fn = asRecord(call?.function);
        if (!call || call.type !== "function" || !boundedString(call.id, 160) || !fn || !boundedString(fn.name, 80) || !MARKET_RESEARCH_TOOL_NAMES.includes(fn.name as never) || !boundedString(fn.arguments, 32_000)) return undefined;
      }
    }
    messages.push(message);
  }

  const rawTools = body.tools === undefined ? [] : body.tools;
  if (!Array.isArray(rawTools) || rawTools.length > MARKET_RESEARCH_TOOL_NAMES.length) return undefined;
  const tools: JsonRecord[] = [];
  for (const rawTool of rawTools) {
    const tool = asRecord(rawTool);
    const fn = asRecord(tool?.function);
    if (!tool || tool.type !== "function" || !fn || !boundedString(fn.name, 80) || !MARKET_RESEARCH_TOOL_NAMES.includes(fn.name as never)) return undefined;
    if (fn.description !== undefined && !boundedString(fn.description, 4_000)) return undefined;
    if (fn.parameters !== undefined && serializedBytes(fn.parameters) > 32_000) return undefined;
    tools.push(tool);
  }
  const toolChoice = body.tool_choice === "none" ? "none" : body.tool_choice === "auto" || body.tool_choice === undefined ? "auto" : undefined;
  if (!toolChoice) return undefined;
  return {
    messages,
    toolChoice,
    tools,
    parallelToolCalls: body.parallel_tool_calls === true,
  };
}

async function responseBuffer(response: globalThis.Response, maxBytes: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("upstream response exceeded the broker limit");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response too large");
        throw new Error("upstream response exceeded the broker limit");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

function sendUpstreamResponse(res: ExpressResponse, response: globalThis.Response, body: Buffer, sessionId?: string): void {
  const contentType = response.headers.get("content-type");
  if (contentType) res.setHeader("content-type", contentType);
  if (sessionId) res.setHeader("mcp-session-id", sessionId);
  res.status(response.status).send(body.length > 0 ? body : undefined);
}

function safeUpstreamFailure(res: ExpressResponse, status = 502): void {
  res.status(status).json({ error: "Upstream service is temporarily unavailable" });
}

export function createBrowserTerminalApp(options: BrowserTerminalAppOptions = {}): express.Express {
  const request = options.fetchImpl ?? fetch;
  const proxyToken = options.proxyToken ?? process.env.MARKET_PROXY_TOKEN?.trim() ?? "";
  const openRouterApiKey = options.openRouterApiKey ?? process.env.OPENROUTER_API_KEY?.trim() ?? "";
  const openRouterModel = options.openRouterModel?.trim()
    || process.env.OPENROUTER_MODEL?.trim()
    || process.env.MARKET_MODEL_ID?.trim()
    || DEFAULT_MODEL;
  const watchlistImportApiKey = options.watchlistImportApiKey?.trim() || process.env.WATCHLIST_IMPORT_API_KEY?.trim() || "";
  const watchlistImportModel = options.watchlistImportModel?.trim() || process.env.WATCHLIST_IMPORT_MODEL?.trim() || "";
  const watchlistImportUrl = options.watchlistImportUrl?.trim() || process.env.WATCHLIST_IMPORT_URL?.trim() || "";
  const mcpEndpoint = options.mcpEndpoint ?? process.env.UNBROWSER_MCP_URL?.trim();
  const storageRoot = options.storageRoot ?? path.resolve(process.env.MARKET_DATA_DIR?.trim() || "/data", "browser-sessions");
  const webDist = options.webDist ?? path.resolve(process.env.MARKET_ROOT?.trim() || process.cwd(), "dist-web");
  const now = options.now ?? Date.now;
  const brokerRequestState = new Map<string, PrincipalRequestState>();
  const globalBrokerRequestState = new Map<BrokerLane, PrincipalRequestState>();
  let globalConcurrent = 0;
  const mcpSessions = new Map<string, McpSession>();
  const mcpInitializeState = new Map<string, PrincipalRequestState>();
  let mcpInitializationInFlight = 0;
  const storageLocks = new Map<string, Promise<void>>();
  const cryptoCache = new Map<boolean, CryptoCacheEntry>();
  const cryptoInFlight = new Map<boolean, Promise<CryptoCacheEntry["result"]>>();
  const quoteBatchCache = new Map<string, QuoteBatchEntry>();
  const quoteBatchInFlight = new Map<string, Promise<QuoteBatchEntry>>();
  const screenshotImportLimiter = new WatchlistScreenshotImportLimiter();
  const providerBudget = createPersistentProviderBudget({
    filePath: path.join(storageRoot, "provider-budget.json"),
    now,
    config: options.providerBudget ?? providerBudgetConfigFromEnv(),
  });
  let mcpReadiness: McpReadiness | undefined;
  let mcpReadinessInFlight: Promise<boolean> | undefined;

  function acquireBrokerRequest(
    principal: string,
    lane: BrokerLane,
    principalConcurrency = BROKER_LANE_LIMITS[lane].concurrency,
  ): (() => void) | undefined {
    const timestamp = now();
    const laneLimits = BROKER_LANE_LIMITS[lane];
    const stateKey = `${lane}\0${principal}`;
    const state = brokerRequestState.get(stateKey) ?? { windowStartedAt: timestamp, requestCount: 0, concurrent: 0 };
    const globalState = globalBrokerRequestState.get(lane) ?? { windowStartedAt: timestamp, requestCount: 0, concurrent: 0 };
    if (timestamp - state.windowStartedAt >= BROKER_RATE_WINDOW_MS) {
      state.windowStartedAt = timestamp;
      state.requestCount = 0;
    }
    if (timestamp - globalState.windowStartedAt >= BROKER_RATE_WINDOW_MS) {
      globalState.windowStartedAt = timestamp;
      globalState.requestCount = 0;
    }
    if (
      state.requestCount >= laneLimits.rateLimit
      || globalState.requestCount >= laneLimits.globalRateLimit
      || state.concurrent >= principalConcurrency
      || globalConcurrent >= MAX_GLOBAL_CONCURRENCY
    ) {
      return undefined;
    }
    state.requestCount += 1;
    globalState.requestCount += 1;
    state.concurrent += 1;
    globalConcurrent += 1;
    brokerRequestState.set(stateKey, state);
    globalBrokerRequestState.set(lane, globalState);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.concurrent = Math.max(0, state.concurrent - 1);
      globalConcurrent = Math.max(0, globalConcurrent - 1);
    };
  }

  async function checkMcpReadiness(): Promise<boolean> {
    if (!mcpEndpoint) return true;
    const timestamp = now();
    if (mcpReadiness && timestamp - mcpReadiness.checkedAt < MCP_READINESS_CACHE_MS) {
      return mcpReadiness.ok;
    }
    if (mcpReadinessInFlight) return mcpReadinessInFlight;

    const probe = (async () => {
      let sessionId: string | undefined;
      try {
        const initialize = await request(mcpEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "readiness",
            method: "initialize",
            params: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "unbrowser-fin-terminal-readiness", version: "0.1.0" },
            },
          }),
          signal: AbortSignal.timeout(MCP_READINESS_TIMEOUT_MS),
        });
        await responseBuffer(initialize, 64 * 1024);
        sessionId = initialize.headers.get("mcp-session-id") || undefined;
        return initialize.ok && Boolean(sessionId);
      } catch {
        return false;
      } finally {
        if (sessionId) {
          try {
            await request(mcpEndpoint, {
              method: "DELETE",
              headers: { "mcp-session-id": sessionId },
              signal: AbortSignal.timeout(UPSTREAM_MCP_CLOSE_TIMEOUT_MS),
            });
          } catch {
            // The sidecar has its own bounded worker lifetime.
          }
        }
      }
    })();
    mcpReadinessInFlight = probe;
    try {
      const ok = await probe;
      mcpReadiness = { checkedAt: now(), ok };
      return ok;
    } finally {
      if (mcpReadinessInFlight === probe) mcpReadinessInFlight = undefined;
    }
  }

  function logMcpFailure(method: string, tool: string | undefined, startedAt: number, error: unknown): void {
    if (process.env.NODE_ENV === "test") return;
    const detail = error instanceof Error ? error : new Error(String(error));
    const cause = detail.cause && typeof detail.cause === "object"
      ? detail.cause as { code?: unknown; name?: unknown }
      : undefined;
    let endpointHost = "unknown";
    try {
      endpointHost = new URL(mcpEndpoint || "").host || endpointHost;
    } catch {
      // Keep diagnostics safe when a bad endpoint is supplied.
    }
    console.warn("browser-terminal MCP upstream failure", {
      method,
      tool: tool || undefined,
      endpointHost,
      elapsedMs: Math.max(0, now() - startedAt),
      errorName: detail.name,
      errorMessage: detail.message.slice(0, 240),
      causeName: typeof cause?.name === "string" ? cause.name : undefined,
      causeCode: typeof cause?.code === "string" ? cause.code : undefined,
    });
  }

  function respondBusy(res: ExpressResponse): void {
    res.setHeader("retry-after", "1");
    res.status(429).json({ error: "Browser terminal is temporarily busy" });
  }

  async function closeMcpSession(session: McpSession): Promise<void> {
    if (!mcpEndpoint) return;
    try {
      const response = await request(mcpEndpoint, {
        method: "DELETE",
        headers: { "mcp-session-id": session.upstreamSessionId },
        signal: AbortSignal.timeout(UPSTREAM_MCP_CLOSE_TIMEOUT_MS),
      });
      await responseBuffer(response, 64 * 1024);
    } catch {
      // Expiry cleanup is best-effort; the upstream worker has its own maximum
      // lifetime and will still be reaped if this close request fails.
    }
  }

  async function withMcpSessionLock<T>(session: McpSession, operation: () => Promise<T>): Promise<T> {
    session.activeRequests += 1;
    const previous = session.requestTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    session.requestTail = current;
    await previous;
    try {
      return await operation();
    } finally {
      session.activeRequests = Math.max(0, session.activeRequests - 1);
      session.lastUsedAt = now();
      release();
    }
  }

  async function withStorageLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = storageLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    storageLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (storageLocks.get(key) === current) storageLocks.delete(key);
    }
  }

  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'");
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));
  app.get("/api/ready", async (req, res) => {
    if (req.query.dependencies === "1" && !(await checkMcpReadiness())) {
      res.status(503).json({ status: "starting", browserTerminal: true, dependencies: { mcp: false } });
      return;
    }
    res.json({
      status: "ready",
      browserTerminal: true,
      ...(req.query.dependencies === "1" ? { dependencies: { mcp: true } } : {}),
    });
  });

  app.use((req, res, next) => {
    if (req.path === "/api/ready") {
      next();
      return;
    }
    if (!matchesProxyToken(proxyToken, readHeader(req, PROXY_TOKEN_HEADER))) {
      res.status(403).type("text").send("Forbidden");
      return;
    }
    if (!sameOriginRequest(req)) {
      res.status(403).type("text").send("Forbidden");
      return;
    }
    const principal = principalFor(req, proxyToken);
    if (!principal) {
      res.status(403).type("text").send("Forbidden");
      return;
    }
    res.setHeader("cache-control", "no-store");
    (req as Request & { browserPrincipal?: string }).browserPrincipal = principal;
    next();
  });

  const getPrincipal = (req: Request): string => (req as Request & { browserPrincipal?: string }).browserPrincipal ?? "local";

  const screenshotImportEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // The browser entrypoint already holds the server-side OpenRouter key. It
    // is safe to expose it to the importer only through the module's default
    // OpenRouter endpoint; custom endpoints still require their own key.
    ...(openRouterApiKey ? { OPENROUTER_API_KEY: openRouterApiKey } : {}),
    ...(watchlistImportApiKey ? { WATCHLIST_IMPORT_API_KEY: watchlistImportApiKey } : {}),
    ...(watchlistImportModel ? { WATCHLIST_IMPORT_MODEL: watchlistImportModel } : {}),
    ...(watchlistImportUrl ? { WATCHLIST_IMPORT_URL: watchlistImportUrl } : {}),
  };

  app.get("/api/browser/v1/session", (_req, res) => {
    res.json({
      version: 1,
      model: openRouterModel,
      features: { broker: true, mcp: Boolean(mcpEndpoint), quotes: true, cryptoPulse: true, persistence: true },
    });
  });

  // Screenshot import is an authenticated browser-terminal capability. Keep
  // it on this entrypoint as well as the legacy live server: the canary does
  // not run server/index.ts, so omitting this route turns the UI into a 404.
  app.post(
    "/api/watchlist/import",
    express.raw({ type: "*/*", limit: WATCHLIST_SCREENSHOT_MAX_BYTES }),
    async (req, res) => {
      const rate = screenshotImportLimiter.consume(getPrincipal(req));
      if (!rate.allowed) {
        res.status(429).json({
          error: "Screenshot import is temporarily rate limited. Try again shortly.",
          retryAfterSeconds: Math.ceil((rate.retryAfterMs ?? 0) / 1_000),
        });
        return;
      }
      const image = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        await validateWatchlistScreenshotImport(image, screenshotImportEnv);
      } catch (error) {
        const failure = error instanceof WatchlistScreenshotImportError
          ? error
          : new WatchlistScreenshotImportError("Screenshot import is not configured.", 503);
        res.status(failure.status).json({ error: failure.message });
        return;
      }
      let budget;
      try {
        budget = await providerBudget.consume(getPrincipal(req), "import", providerBudget.config.importEstimateUsd);
      } catch {
        safeUpstreamFailure(res, 503);
        return;
      }
      if (!budget.allowed) {
        res.setHeader("retry-after", String(budget.retryAfterSeconds));
        res.status(429).json({ error: budget.reason === "principal-quota" ? "Daily watchlist import limit reached" : "Daily provider budget reached" });
        return;
      }
      try {
        const result = await extractWatchlistFromScreenshot(image, screenshotImportEnv, request);
        res.status(200).json(result);
      } catch (error) {
        const failure = error instanceof WatchlistScreenshotImportError
          ? error
          : new WatchlistScreenshotImportError("Screenshot import failed.", 500);
        res.status(failure.status).json({ error: failure.message });
      }
    },
  );

  // Whole-universe market-map fetch. The canonical extension refreshes ~130
  // symbols per sync; doing that through the per-symbol endpoint below would
  // blow through the quote lane's 60/min budget and silently truncate every
  // map to the first 60 symbols. The broker fans out upstream itself, so one
  // batch request costs one lane slot and the universe arrives whole. This
  // literal route must stay registered before "/:symbol" or Express would
  // match "batch" as a ticker symbol.
  app.get("/api/browser/v1/quotes/batch", async (req, res) => {
    const scope = validScope(req.query.scope);
    if (!scope) {
      res.status(400).json({ error: "Invalid quote scope" });
      return;
    }
    const symbols = parseQuoteBatchSymbols(req.query.symbols);
    if (!symbols || symbols.length === 0) {
      res.status(400).json({ error: "Invalid quote symbols" });
      return;
    }
    if (symbols.length > QUOTE_BATCH_MAX_SYMBOLS) {
      res.status(400).json({ error: "Too many quote symbols" });
      return;
    }
    const batchKey = `${scope}\0${symbols.join(",")}`;

    const respondWith = (entry: QuoteBatchEntry): void => {
      res.json({ version: 1, chartScope: entry.chartScope, requested: entry.requested, quotes: entry.quotes });
    };

    const cached = quoteBatchCache.get(batchKey);
    // A fresh batch serves every principal without touching the lane budget.
    if (cached && now() - cached.cachedAt < QUOTE_BATCH_CACHE_TTL_MS) {
      respondWith(cached);
      return;
    }
    // Concurrent identical requests share one upstream fan-out.
    const pending = quoteBatchInFlight.get(batchKey);
    if (pending) {
      try {
        respondWith(await pending);
      } catch {
        safeUpstreamFailure(res);
      }
      return;
    }

    const release = acquireBrokerRequest(getPrincipal(req), "quote");
    if (!release) {
      respondBusy(res);
      return;
    }
    try {
      // Re-check after acquiring: an identical fan-out may have started while
      // this request waited for a lane slot.
      const racedPending = quoteBatchInFlight.get(batchKey);
      if (racedPending) {
        respondWith(await racedPending);
        return;
      }
      const racedFresh = quoteBatchCache.get(batchKey);
      if (racedFresh && now() - racedFresh.cachedAt < QUOTE_BATCH_CACHE_TTL_MS) {
        respondWith(racedFresh);
        return;
      }
      respondWith(await runQuoteBatch(batchKey, scope, symbols));
    } catch {
      safeUpstreamFailure(res);
    } finally {
      release();
    }
  });

  async function runQuoteBatch(batchKey: string, scope: ChartScope, symbols: readonly string[]): Promise<QuoteBatchEntry> {
    const run = (async (): Promise<QuoteBatchEntry> => {
      const cfg = CHART_SCOPE_CONFIGS[scope];
      const deadline = AbortSignal.timeout(QUOTE_BATCH_DEADLINE_MS);
      const quotes: Quote[] = [];
      let cursor = 0;
      const workerCount = Math.min(QUOTE_BATCH_UPSTREAM_CONCURRENCY, symbols.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (cursor < symbols.length && !deadline.aborted) {
          const symbol = symbols[cursor++]!;
          try {
            const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
            url.searchParams.set("range", cfg.yahooRange);
            url.searchParams.set("interval", cfg.yahooInterval);
            url.searchParams.set("includePrePost", String(cfg.includePrePost));
            const response = await request(url, { headers: { accept: "application/json", "user-agent": "market-terminal/0.1" }, signal: deadline });
            if (!response.ok) continue;
            const payload = JSON.parse((await responseBuffer(response, MAX_QUOTE_RESPONSE_BYTES)).toString("utf8"));
            quotes.push(parseChartPayloadToQuote(symbol, payload, { ...cfg, chartScope: scope }));
          } catch {
            // A partial universe is still useful; failed symbols are omitted
            // and the caller's partial-universe guard decides usability.
            continue;
          }
        }
      }));
      const entry: QuoteBatchEntry = { chartScope: scope, requested: symbols.length, quotes, cachedAt: now() };
      // Only a usable majority is worth serving to the next caller; a degraded
      // fan-out should not poison the cache for the TTL window.
      if (entry.quotes.length * 2 >= entry.requested) {
        while (quoteBatchCache.size >= QUOTE_BATCH_CACHE_MAX_ENTRIES) {
          const oldest = [...quoteBatchCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
          if (!oldest) break;
          quoteBatchCache.delete(oldest[0]);
        }
        quoteBatchCache.set(batchKey, entry);
      }
      return entry;
    })();
    quoteBatchInFlight.set(batchKey, run);
    try {
      return await run;
    } finally {
      if (quoteBatchInFlight.get(batchKey) === run) quoteBatchInFlight.delete(batchKey);
    }
  }

  app.get("/api/browser/v1/quotes/:symbol", async (req, res) => {
    const symbol = quoteSymbol(req.params.symbol);
    const scope = validScope(req.query.scope);
    if (!symbol || !scope) {
      res.status(400).json({ error: "Invalid quote symbol or scope" });
      return;
    }
    const release = acquireBrokerRequest(getPrincipal(req), "quote");
    if (!release) {
      respondBusy(res);
      return;
    }
    const cfg = CHART_SCOPE_CONFIGS[scope];
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set("range", cfg.yahooRange);
    url.searchParams.set("interval", cfg.yahooInterval);
    url.searchParams.set("includePrePost", String(cfg.includePrePost));
    try {
      const response = await request(url, { headers: { accept: "application/json", "user-agent": "market-terminal/0.1" }, signal: AbortSignal.timeout(UPSTREAM_QUOTE_TIMEOUT_MS) });
      if (!response.ok) {
        safeUpstreamFailure(res, response.status === 429 ? 429 : 502);
        return;
      }
      const payload = JSON.parse((await responseBuffer(response, MAX_QUOTE_RESPONSE_BYTES)).toString("utf8"));
      const quote = parseChartPayloadToQuote(symbol, payload, { ...cfg, chartScope: scope });
      res.json(quote);
    } catch {
      safeUpstreamFailure(res);
    } finally {
      release();
    }
  });

  app.get("/api/browser/v1/crypto/pair/:symbol", async (req, res) => {
    const symbol = quoteSymbol(req.params.symbol);
    if (!symbol) {
      res.status(400).json({ error: "Invalid crypto symbol" });
      return;
    }
    const release = acquireBrokerRequest(getPrincipal(req), "crypto");
    if (!release) {
      respondBusy(res);
      return;
    }
    try {
      const yahooSymbol = await resolveYahooPair(symbol, request as FetchLike);
      res.json({ version: 1, yahooSymbol });
    } catch {
      safeUpstreamFailure(res);
    } finally {
      release();
    }
  });

  app.get("/api/browser/v1/crypto/pulse", async (req, res) => {
    const panicRadarEnabled = req.query.panicRadar !== "0";
    const cached = cryptoCache.get(panicRadarEnabled);
    if (cached && now() - cached.cachedAt < CRYPTO_CACHE_TTL_MS) {
      res.json({ version: 1, ...cached.result });
      return;
    }
    const release = acquireBrokerRequest(getPrincipal(req), "crypto");
    if (!release) {
      respondBusy(res);
      return;
    }
    let inFlight = cryptoInFlight.get(panicRadarEnabled);
    if (!inFlight) {
      inFlight = fetchCryptoPulse({ fetchImpl: request as FetchLike, panicRadarEnabled })
        .then((result) => {
          const previous = cryptoCache.get(panicRadarEnabled);
          const usable = isCryptoPulseUsable(result.snapshot);
          const next = usable || !previous
            ? result
            : { snapshot: previous.result.snapshot, errors: result.errors };
          cryptoCache.set(panicRadarEnabled, { result: next, cachedAt: now() });
          return next;
        })
        .finally(() => cryptoInFlight.delete(panicRadarEnabled));
      cryptoInFlight.set(panicRadarEnabled, inFlight);
    }
    try {
      res.json({ version: 1, ...(await inFlight) });
    } catch {
      const stale = cryptoCache.get(panicRadarEnabled);
      if (stale) res.json({ version: 1, ...stale.result });
      else safeUpstreamFailure(res);
    } finally {
      release();
    }
  });

  app.post("/api/browser/v1/chat/completions", express.json({ limit: MAX_CHAT_BODY_BYTES }), async (req, res) => {
    const principal = getPrincipal(req);
    const validated = validateChatRequest(req.body);
    if (!validated || serializedBytes(req.body) > MAX_CHAT_BODY_BYTES) {
      res.status(400).json({ error: "Invalid browser research request" });
      return;
    }
    const release = acquireBrokerRequest(principal, "research", MAX_CHAT_CONCURRENCY);
    if (!release) {
      respondBusy(res);
      return;
    }
    try {
      if (!openRouterApiKey) {
        res.status(503).json({ error: "Research broker is not configured" });
        return;
      }
      let budget;
      try {
        budget = await providerBudget.consume(
          principal,
          "research",
          estimateChatProviderCost(req.body, readMaxOutputTokens(), providerBudget.config),
        );
      } catch {
        safeUpstreamFailure(res, 503);
        return;
      }
      if (!budget.allowed) {
        res.setHeader("retry-after", String(budget.retryAfterSeconds));
        res.status(429).json({ error: budget.reason === "principal-quota" ? "Daily research limit reached" : "Daily provider budget reached" });
        return;
      }
      const body: JsonRecord = {
        model: openRouterModel,
        messages: validated.messages,
        temperature: 0,
        max_tokens: readMaxOutputTokens(),
        tool_choice: validated.toolChoice,
        ...(validated.tools.length > 0 ? { tools: validated.tools } : {}),
        ...(validated.parallelToolCalls ? { parallel_tool_calls: true } : {}),
      };
      const upstream = await request(OPENROUTER_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${openRouterApiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_CHAT_TIMEOUT_MS),
      });
      const response = await responseBuffer(upstream, MAX_CHAT_RESPONSE_BYTES);
      res.status(upstream.status);
      res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
      res.send(response);
    } catch {
      safeUpstreamFailure(res);
    } finally {
      release();
    }
  });

  app.post("/api/browser/v1/mcp", express.json({ limit: MAX_MCP_BODY_BYTES }), async (req, res) => {
    const principal = getPrincipal(req);
    const timestamp = now();
    const mcpStartedAt = timestamp;
    const expiredAt = timestamp - MCP_SESSION_IDLE_TTL_MS;
    const expiredLifetime = timestamp - MCP_SESSION_MAX_LIFETIME_MS;
    const expiredSessions: McpSession[] = [];
    for (const [sessionId, session] of mcpSessions) {
      if (session.activeRequests === 0 && (session.lastUsedAt < expiredAt || session.createdAt < expiredLifetime)) {
        session.closing = true;
        mcpSessions.delete(sessionId);
        expiredSessions.push(session);
      }
    }
    for (const [sessionPrincipal, state] of mcpInitializeState) {
      if (state.concurrent === 0 && timestamp - state.windowStartedAt >= MCP_INITIALIZE_RATE_WINDOW_MS) {
        mcpInitializeState.delete(sessionPrincipal);
      }
    }
    for (const session of expiredSessions) {
      void closeMcpSession(session);
    }
    if (!mcpEndpoint) {
      res.status(503).json({ error: "Research source broker is not configured" });
      return;
    }
    const body = asRecord(req.body);
    const method = body?.method;
    if (!body || typeof method !== "string" || !MCP_METHODS.has(method)) {
      res.status(400).json({ error: "MCP method is not allowed" });
      return;
    }
    if (method === "tools/call") {
      const params = asRecord(body.params);
      const name = params?.name;
      // The browser research worker rides this endpoint for BOTH surfaces: the
      // raw unbrowser tools (navigate/text_main/… for market_discover and
      // market_extract) and the market research tools (public-gateway path).
      // An allowlist that omits either breaks research with the generic
      // "Source retrieval is temporarily unavailable" mapping.
      const toolAllowed = typeof name === "string"
        && (isMarketResearchToolName(name) || isUnbrowserMcpToolName(name));
      if (!params || !toolAllowed || (params.arguments !== undefined && !asRecord(params.arguments))) {
         res.status(400).json({ error: "MCP tool is not allowed" });
         return;
      }
    }
    const release = acquireBrokerRequest(principal, "research");
    if (!release) {
      respondBusy(res);
      return;
    }
    const browserSessionId = validMcpSessionId(readHeader(req, "mcp-session-id"));
    if (method === "initialize" && browserSessionId) {
      res.status(400).json({ error: "MCP initialize must not include a session" });
      release();
      return;
    }
    let countedInitialization = false;
    if (method === "initialize") {
      const state = mcpInitializeState.get(principal) ?? { windowStartedAt: timestamp, requestCount: 0, concurrent: 0 };
      if (timestamp - state.windowStartedAt >= MCP_INITIALIZE_RATE_WINDOW_MS) {
        state.windowStartedAt = timestamp;
        state.requestCount = 0;
      }
      const principalSessionCount = [...mcpSessions.values()].filter((session) => session.principal === principal).length;
      if (state.requestCount >= MCP_INITIALIZE_RATE_LIMIT) {
        res.status(429).json({ error: "Research source broker is temporarily busy" });
        release();
        return;
      }
      if (
        principalSessionCount + state.concurrent >= MAX_MCP_SESSIONS_PER_PRINCIPAL
        || mcpSessions.size + mcpInitializationInFlight >= MAX_MCP_SESSIONS
      ) {
        res.status(429).json({ error: "Research source session limit reached" });
        release();
        return;
      }
      state.requestCount += 1;
      state.concurrent += 1;
      mcpInitializationInFlight += 1;
      mcpInitializeState.set(principal, state);
      countedInitialization = true;
    }
    const existing = browserSessionId ? mcpSessions.get(browserSessionId) : undefined;
    if (method !== "initialize" && (!existing || existing.principal !== principal)) {
      res.status(404).json({ error: "MCP session not found" });
      release();
      return;
    }
    const upstreamHeaders: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (existing) upstreamHeaders["mcp-session-id"] = existing.upstreamSessionId;
    try {
      const forward = async (): Promise<void> => {
        const upstream = await request(mcpEndpoint, {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(UPSTREAM_MCP_TIMEOUT_MS),
        });
        const response = await responseBuffer(upstream, MAX_MCP_RESPONSE_BYTES);
        if (existing && (upstream.status === 404 || upstream.status === 410)) {
          existing.closing = true;
          if (mcpSessions.get(browserSessionId!) === existing) mcpSessions.delete(browserSessionId!);
          sendUpstreamResponse(res, upstream, response);
          return;
        }
        const upstreamSessionId = upstream.headers.get("mcp-session-id") || existing?.upstreamSessionId;
        if (method === "initialize" && (!upstream.ok || !upstreamSessionId)) {
          sendUpstreamResponse(res, upstream, response);
          return;
        }
        const responseBrowserSessionId = browserSessionId || randomUUID().replace(/-/g, "");
        if (method === "initialize" && upstreamSessionId) {
          const sessionTimestamp = now();
          mcpSessions.set(responseBrowserSessionId, {
            principal,
            upstreamSessionId,
            createdAt: sessionTimestamp,
            lastUsedAt: sessionTimestamp,
            activeRequests: 0,
            requestTail: Promise.resolve(),
            closing: false,
          });
        }
        sendUpstreamResponse(res, upstream, response, responseBrowserSessionId);
      };
      if (existing) await withMcpSessionLock(existing, forward);
      else await forward();
    } catch (error) {
      if (existing) {
        existing.closing = true;
        if (mcpSessions.get(browserSessionId!) === existing) mcpSessions.delete(browserSessionId!);
      }
      const params = asRecord(body.params);
      logMcpFailure(method, typeof params?.name === "string" ? params.name : undefined, mcpStartedAt, error);
      safeUpstreamFailure(res);
    } finally {
      if (countedInitialization) {
        const state = mcpInitializeState.get(principal);
        if (state) {
          state.concurrent = Math.max(0, state.concurrent - 1);
          if (state.concurrent === 0 && timestamp - state.windowStartedAt >= MCP_INITIALIZE_RATE_WINDOW_MS) {
            mcpInitializeState.delete(principal);
          }
        }
        mcpInitializationInFlight = Math.max(0, mcpInitializationInFlight - 1);
      }
      release();
    }
  });

  app.delete("/api/browser/v1/mcp", async (req, res) => {
    const principal = getPrincipal(req);
    const browserSessionId = validMcpSessionId(readHeader(req, "mcp-session-id"));
    const existing = browserSessionId ? mcpSessions.get(browserSessionId) : undefined;
    if (!existing || existing.principal !== principal || !mcpEndpoint) {
      res.status(404).end();
      return;
    }
    const release = acquireBrokerRequest(principal, "research");
    if (!release) {
      respondBusy(res);
      return;
    }
    mcpSessions.delete(browserSessionId!);
    existing.closing = true;
    try {
      await withMcpSessionLock(existing, async () => {
        const upstream = await request(mcpEndpoint, { method: "DELETE", headers: { "mcp-session-id": existing.upstreamSessionId }, signal: AbortSignal.timeout(UPSTREAM_MCP_CLOSE_TIMEOUT_MS) });
        const response = await responseBuffer(upstream, 64 * 1024);
        sendUpstreamResponse(res, upstream, response);
      });
    } catch {
      res.status(204).end();
    } finally {
      release();
    }
  });

  app.get("/api/browser/v1/storage/:name", async (req, res) => {
    const name = req.params.name;
    if (!STORAGE_NAMES.has(name)) {
      res.status(404).end();
      return;
    }
    const release = acquireBrokerRequest(getPrincipal(req), "control");
    if (!release) {
      respondBusy(res);
      return;
    }
    const filePath = path.join(principalDirectory(storageRoot, getPrincipal(req)), name);
    try {
      const text = await readFile(filePath, "utf8");
      res.setHeader("etag", etagFor(text));
      res.type("json").send(text);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") res.status(404).end();
      else safeUpstreamFailure(res, 500);
    } finally {
      release();
    }
  });

  app.put("/api/browser/v1/storage/:name", express.json({ limit: MAX_STORAGE_BODY_BYTES }), async (req, res) => {
    const name = req.params.name;
    if (!STORAGE_NAMES.has(name) || !validateStoredDocument(name, req.body)) {
      res.status(400).json({ error: "Invalid browser storage document" });
      return;
    }
    const release = acquireBrokerRequest(getPrincipal(req), "control");
    if (!release) {
      respondBusy(res);
      return;
    }
    const filePath = path.join(principalDirectory(storageRoot, getPrincipal(req)), name);
    try {
      const result = await withStorageLock(`${getPrincipal(req)}\0${name}`, async () => {
        let currentText: string | undefined;
        try {
          currentText = await readFile(filePath, "utf8");
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
        }
        const expected = req.header("if-match");
        const createOnly = req.header("if-none-match") === "*";
        if ((expected && createOnly) || expected === "*") {
          return { invalidPrecondition: true as const };
        }
        if (!expected && !createOnly) {
          return { preconditionRequired: true as const };
        }
        if (expected && expected !== "*" && (!currentText || expected !== etagFor(currentText))) {
          return { conflict: true as const };
        }
        if (createOnly && currentText) {
          return { exists: true as const };
        }
        const text = `${JSON.stringify(req.body, null, 2)}\n`;
        await writeAtomic(filePath, text);
        return { etag: etagFor(text) };
      });
      if ("conflict" in result) {
        res.status(409).json({ error: "Storage version is stale" });
        return;
      }
      if ("exists" in result) {
        res.status(412).json({ error: "Storage document already exists" });
        return;
      }
      if ("preconditionRequired" in result) {
        res.status(428).json({ error: "Storage writes require If-Match or If-None-Match" });
        return;
      }
      if ("invalidPrecondition" in result) {
        res.status(400).json({ error: "Storage write precondition is invalid" });
        return;
      }
      res.setHeader("etag", result.etag);
      res.json({ ok: true });
    } catch {
      safeUpstreamFailure(res, 500);
    } finally {
      release();
    }
  });

  if (webDist) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use((error: unknown, _req: Request, res: ExpressResponse, _next: unknown) => {
    const status = (error as { status?: number }).status === 413 ? 413 : 400;
    res.status(status).json({ error: status === 413 ? "Request body is too large" : "Malformed request" });
  });
  return app;
}
