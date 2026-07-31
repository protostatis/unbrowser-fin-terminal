import { randomUUID } from "node:crypto";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_MAX_EXTRACT_CHARS = 8_000;

type FetchLike = typeof fetch;

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type McpToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

export type UnbrowserExtractionMode = "text_main" | "table_to_json" | "extract_cards";

export type UnbrowserNavigation = {
  url?: string;
  status?: number;
  challenge?: unknown;
  blockmap?: { density?: { likely_js_filled?: boolean; thin_shell?: boolean } };
  [key: string]: unknown;
};

export type UnbrowserExtraction = {
  mode: UnbrowserExtractionMode;
  requestedUrl: string;
  finalUrl: string;
  httpStatus?: number;
  retrievalStatus: "fetched" | "challenged" | "limited";
  challenge?: unknown;
  content: string;
  truncated: boolean;
};

export type UnbrowserMcpClientOptions = {
  fetch?: FetchLike;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxExtractChars?: number;
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function normalizeUnbrowserMcpUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("UNBROWSER_MCP_URL must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("UNBROWSER_MCP_URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("UNBROWSER_MCP_URL must not contain credentials or a fragment");
  }
  return parsed.href;
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("unbrowser MCP request timed out")), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`unbrowser MCP response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response too large");
        throw new Error(`unbrowser MCP response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function parseEnvelope(text: string, status: number): JsonRpcEnvelope | undefined {
  if (!text.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`unbrowser MCP returned malformed JSON (HTTP ${status})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("unbrowser MCP returned an invalid JSON-RPC envelope");
  }
  return parsed as JsonRpcEnvelope;
}

function toolResultText(value: unknown, toolName: string): string {
  if (!value || typeof value !== "object") {
    throw new Error(`unbrowser MCP ${toolName} returned no result`);
  }
  const result = value as McpToolResult;
  const text = Array.isArray(result.content)
    ? result.content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n")
    : "";
  if (result.isError) {
    throw new Error(`unbrowser ${toolName} failed: ${text.slice(0, 300) || "unknown error"}`);
  }
  if (!text) throw new Error(`unbrowser MCP ${toolName} returned no text content`);
  return text;
}

function parseToolJson(text: string, toolName: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`unbrowser MCP ${toolName} returned malformed tool JSON`);
  }
}

class McpSession {
  private sessionId: string | undefined;
  private requestId = 0;

  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: FetchLike,
    private readonly requestTimeoutMs: number,
    private readonly maxResponseBytes: number,
  ) {}

  async initialize(signal?: AbortSignal): Promise<void> {
    const response = await this.post({
      jsonrpc: "2.0",
      id: ++this.requestId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "unbrowser-fin-terminal", version: "0.1.0" },
      },
    }, signal, false);
    if (!this.sessionId) throw new Error("unbrowser MCP did not return a session ID");
    if (!response?.result) throw new Error("unbrowser MCP initialization returned no result");
    await this.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }, signal, true);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (!this.sessionId) throw new Error("unbrowser MCP session is not initialized");
    const response = await this.post({
      jsonrpc: "2.0",
      id: ++this.requestId,
      method: "tools/call",
      params: { name, arguments: args },
    }, signal, false);
    return toolResultText(response?.result, name);
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    const timed = timeoutSignal(undefined, Math.min(this.requestTimeoutMs, 5_000));
    try {
      await this.fetchImpl(this.endpoint, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId },
        signal: timed.signal,
      });
    } catch {
      // Session cleanup is best-effort; mcp-proxy also expires abandoned sessions.
    } finally {
      timed.cleanup();
    }
  }

  private async post(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
    allowEmpty: boolean,
  ): Promise<JsonRpcEnvelope | undefined> {
    const timed = timeoutSignal(signal, this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body: JSON.stringify(payload),
        signal: timed.signal,
      });
      const responseSession = response.headers.get("mcp-session-id");
      if (responseSession) this.sessionId = responseSession;
      const text = await readBoundedText(response, this.maxResponseBytes);
      if (!response.ok) {
        throw new Error(`unbrowser MCP returned HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      const envelope = parseEnvelope(text, response.status);
      if (!envelope && !allowEmpty) throw new Error("unbrowser MCP returned an empty response");
      if (envelope?.error) {
        throw new Error(`unbrowser MCP error: ${envelope.error.message || "unknown JSON-RPC error"}`);
      }
      return envelope;
    } finally {
      timed.cleanup();
    }
  }
}

export class UnbrowserMcpClient {
  readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxExtractChars: number;

  constructor(endpoint: string, options: UnbrowserMcpClientOptions = {}) {
    this.endpoint = normalizeUnbrowserMcpUrl(endpoint);
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    this.maxExtractChars = positiveInteger(options.maxExtractChars, DEFAULT_MAX_EXTRACT_CHARS);
  }

  async navigate(url: string, signal?: AbortSignal): Promise<UnbrowserNavigation> {
    return this.withSession(async (session) => {
      const text = await session.callTool("navigate", { url, exec_scripts: false, include_ascii: false }, signal);
      const result = parseToolJson(text, "navigate");
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("unbrowser navigate returned an invalid result");
      }
      return result as UnbrowserNavigation;
    }, signal);
  }

  async extract(
    url: string,
    mode: UnbrowserExtractionMode,
    signal?: AbortSignal,
  ): Promise<UnbrowserExtraction> {
    return this.withSession(async (session) => {
      const navigationText = await session.callTool(
        "navigate",
        { url, exec_scripts: false, include_ascii: false },
        signal,
      );
      const rawNavigation = parseToolJson(navigationText, "navigate");
      if (!rawNavigation || typeof rawNavigation !== "object" || Array.isArray(rawNavigation)) {
        throw new Error("unbrowser navigate returned an invalid result");
      }
      const navigation = rawNavigation as UnbrowserNavigation;
      const finalUrl = typeof navigation.url === "string" ? navigation.url : url;
      const likelyJsFilled = navigation.blockmap?.density?.likely_js_filled === true
        || navigation.blockmap?.density?.thin_shell === true;
      if (navigation.challenge) {
        return {
          mode,
          requestedUrl: url,
          finalUrl,
          httpStatus: typeof navigation.status === "number" ? navigation.status : undefined,
          retrievalStatus: "challenged",
          challenge: navigation.challenge,
          content: "",
          truncated: false,
        };
      }
      if (likelyJsFilled) {
        return {
          mode,
          requestedUrl: url,
          finalUrl,
          httpStatus: typeof navigation.status === "number" ? navigation.status : undefined,
          retrievalStatus: "limited",
          content: "Page requires a higher-fidelity browser; scripts were not executed.",
          truncated: false,
        };
      }

      const args = mode === "extract_cards" ? { limit: 12 } : {};
      const extractionText = await session.callTool(mode, args, signal);
      let normalized = extractionText;
      try {
        const parsed = JSON.parse(extractionText);
        normalized = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
      } catch {
        // Some MCP tools return plain text rather than JSON-encoded content.
      }
      const truncated = normalized.length > this.maxExtractChars;
      return {
        mode,
        requestedUrl: url,
        finalUrl,
        httpStatus: typeof navigation.status === "number" ? navigation.status : undefined,
        retrievalStatus: "fetched",
        content: normalized.slice(0, this.maxExtractChars),
        truncated,
      };
    }, signal);
  }

  private async withSession<T>(
    operation: (session: McpSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const session = new McpSession(
      this.endpoint,
      this.fetchImpl,
      this.requestTimeoutMs,
      this.maxResponseBytes,
    );
    try {
      await session.initialize(signal);
      return await operation(session);
    } finally {
      await session.close();
    }
  }
}

export type ResearchCandidate = {
  sourceId: string;
  title: string;
  url: string;
  source: string;
};

export type GrantedResearchCandidate = ResearchCandidate & { candidateId: string };

type CandidateGrant = {
  expiresAt: number;
  extractionCount: number;
  candidates: Map<string, GrantedResearchCandidate & { used: boolean }>;
};

export type ResearchCandidateRegistryOptions = {
  ttlMs?: number;
  maxExtractions?: number;
  now?: () => number;
  createId?: () => string;
};

export class ResearchCandidateRegistry {
  private readonly grants = new Map<string, CandidateGrant>();
  private readonly ttlMs: number;
  private readonly maxExtractions: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: ResearchCandidateRegistryOptions = {}) {
    this.ttlMs = positiveInteger(options.ttlMs, 15 * 60_000);
    this.maxExtractions = positiveInteger(options.maxExtractions, 4);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  register(researchId: string, candidates: ResearchCandidate[]): GrantedResearchCandidate[] {
    const id = researchId.trim();
    if (!id) throw new Error("research_id is required to grant extraction candidates");
    const previous = this.grants.get(id);
    const grant: CandidateGrant = {
      expiresAt: this.now() + this.ttlMs,
      // Rediscovery may replace candidates, but it must never reset the
      // per-research extraction-attempt budget.
      extractionCount: previous?.extractionCount ?? 0,
      candidates: new Map(),
    };
    const usedIds = new Set<string>();
    const granted = candidates.slice(0, 8).map((candidate) => {
      let candidateId = this.createId();
      while (!candidateId || usedIds.has(candidateId)) candidateId = this.createId();
      usedIds.add(candidateId);
      const value: GrantedResearchCandidate & { used: boolean } = {
        ...candidate,
        candidateId,
        used: false,
      };
      grant.candidates.set(candidateId, value);
      return { ...candidate, candidateId };
    });
    this.grants.set(id, grant);
    return granted;
  }

  consume(researchId: string, candidateId: string): GrantedResearchCandidate {
    const grant = this.grants.get(researchId);
    if (!grant) throw new Error("No extraction candidates are registered for this research job");
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(researchId);
      throw new Error("Extraction candidates expired; run market_discover again");
    }
    if (grant.extractionCount >= this.maxExtractions) {
      throw new Error(`Research job reached its ${this.maxExtractions}-source extraction limit`);
    }
    const candidate = grant.candidates.get(candidateId);
    if (!candidate) throw new Error("Unknown candidate_id for this research job");
    if (candidate.used) throw new Error("candidate_id was already used");
    // Consume before network I/O. Failed or cancelled fetches still count as
    // attempts so a model cannot bypass the cap by forcing retries.
    candidate.used = true;
    grant.extractionCount += 1;
    return {
      sourceId: candidate.sourceId,
      title: candidate.title,
      url: candidate.url,
      source: candidate.source,
      candidateId: candidate.candidateId,
    };
  }

  clear(researchId: string): void {
    this.grants.delete(researchId);
  }

  reset(): void {
    this.grants.clear();
  }
}
