/**
 * Deterministic conformance model provider (server-side only).
 *
 * Registered into ModelRuntime via `registerNativeProvider` when
 * `MARKET_MODEL_PROVIDER=conformance` is set. Plays a fixed 5-turn research
 * script per user message:
 *
 *   1. market_technicals ({scope:"ticker", symbol, research_id})
 *   2. market_discover  ({scope:"ticker", symbol, research_id})
 *   3. market_extract   ×2 ({research_id, candidate_id, mode:"text_main"})
 *   4. market_canvas    ({symbol, title, research_id, stage:"complete",
 *                         blocks, citations})
 *   5. final text, stopReason "stop"
 *
 * The job id and target symbol are parsed from the research prompt user
 * message (the prompt embeds `research_id=${job.id}`); candidate ids are
 * parsed from the previous market_discover tool result. Canvas source ids are
 * the REAL extension ids (`S-<sha256(url).slice(0,12)>`) computed for the
 * fixed fixture URLs served by scripts/conformance/mock-mcp-server.ts, and the
 * citation quotes the exact fixture sentence served there, so the extension's
 * citation/evidence validation passes end to end.
 *
 * Deterministic: same prompt → same tool call sequence, no network, no key.
 * Used by BOTH the parent session and forked research workers (env inherited).
 */

import { createHash } from "node:crypto";
import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";

type MockEventStream = ReturnType<typeof createAssistantMessageEventStream>;

export const CONFORMANCE_PROVIDER_ID = "conformance";
export const CONFORMANCE_MODEL_ID = "conformance-model-v1";

/**
 * Fixture URLs the mock MCP serves (distinct domains, because the extension's
 * dedupeCandidates drops same-domain candidates). Shared with the MCP server.
 */
export const CONFORMANCE_FIXTURE_URLS = [
  "https://fixture.example/news/apple-q2-2026",
  "https://fixture-news.example/apple-analysis",
  "https://fixture-press.example/apple-press-release",
] as const;

/** Exact sentence served as article content by the mock MCP; citations quote it. */
export const CONFORMANCE_FIXTURE_SENTENCE =
  "Apple Inc. is an American multinational corporation and technology company headquartered in Cupertino, California.";

/** Real extension source id scheme: S-<sha256(url) first 12 hex>. */
export function conformanceSourceId(url: string): string {
  return `S-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
}

const MOCK_COST = {
  input: 0.1,
  output: 0.2,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0.3,
};

function mockUsage(turn: number) {
  const input = 2_000 + turn * 500;
  const output = 600 + turn * 100;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { ...MOCK_COST, total: 0.3 },
  };
}

/** Extract `research_id=<id>` from the research prompt. */
function researchIdFromPrompt(prompt: string): string | undefined {
  const match = /research_id=([A-Za-z0-9_-]{1,160})/.exec(prompt);
  return match?.[1];
}

/** Extract the target symbol from legacy and structured research prompts. */
function symbolFromPrompt(prompt: string): string | undefined {
  const target = /(?:target|symbol)=([A-Za-z0-9.^$-]{1,20})/i.exec(prompt)?.[1]
    ?? /\bResearch ([A-Za-z0-9.^$-]{1,20})\s+/i.exec(prompt)?.[1];
  return target && target !== "MARKET" ? target : "AAPL";
}

/** Extract `candidate_id=<id>` lines out of the discover tool result text. */
function candidateIdsFromResult(content: unknown): string[] {
  // ToolResultMessage.content is an array of {type:"text",text} parts (or a
  // plain string from legacy transforms); flatten before scanning.
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter((part): part is { type?: string; text?: string } =>
          typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
      : "";
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/candidate_id=([A-Za-z0-9_-]{8,160})/g)) {
    const id = match[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
    if (ids.length >= 2) break;
  }
  return ids;
}

type TurnPlan =
  | { kind: "technicals"; symbol: string; researchId: string }
  | { kind: "discover"; symbol: string; researchId: string }
  | { kind: "extract"; researchId: string; candidateIds: string[] }
  | { kind: "canvas"; symbol: string; researchId: string; sourceIds: string[] }
  | { kind: "final" };

function planForContext(context: Context): TurnPlan {
  const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
  const prompt = String(
    typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? ""),
  );
  const researchId = researchIdFromPrompt(prompt) ?? "job-unknown";
  const symbol = symbolFromPrompt(prompt) ?? "AAPL";

  const executedToolNames = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "assistant") continue;
    const content = (message as { content?: Array<{ type?: string; name?: string }> }).content;
    for (const part of content ?? []) {
      if (part.type === "toolCall" && typeof part.name === "string") executedToolNames.add(part.name);
    }
  }

  if (executedToolNames.has("market_canvas")) return { kind: "final" };

  // The last tool result tells us which step ran last.
  const lastToolResult = [...context.messages].reverse().find((m) => m.role === "toolResult");
  const lastToolContent = (lastToolResult as { content?: unknown } | undefined)?.content;

  if (executedToolNames.has("market_extract")) {
    // Extract succeeded → publish the complete canvas with the real source ids
    // of the fixture URLs (two extracted candidates).
    const sourceIds = CONFORMANCE_FIXTURE_URLS.slice(0, 2).map(conformanceSourceId);
    return { kind: "canvas", symbol, researchId, sourceIds };
  }
  if (executedToolNames.has("market_discover")) {
    const candidateIds = candidateIdsFromResult(lastToolContent);
    return candidateIds.length > 0
      ? { kind: "extract", researchId, candidateIds }
      : { kind: "final" };
  }
  if (executedToolNames.has("market_technicals")) {
    // Technicals already ran → advance to discovery (never repeat a step).
    return { kind: "discover", symbol, researchId };
  }
  return { kind: "technicals", symbol, researchId };
}

function toolCallMessage(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  turn: number,
): AssistantMessageEvent[] {
  const events: AssistantMessageEvent[] = [];
  const content = toolCalls.map((toolCall, index) => ({
    type: "toolCall" as const,
    id: `call_${turn}_${index}`,
    name: toolCall.name,
    arguments: toolCall.args,
  }));
  const partial = {
    role: "assistant" as const,
    content,
    api: CONFORMANCE_PROVIDER_ID,
    provider: CONFORMANCE_PROVIDER_ID,
    model: CONFORMANCE_MODEL_ID,
    usage: mockUsage(turn),
    stopReason: "toolUse" as const,
    timestamp: Date.now(),
  };
  events.push({ type: "start", partial });
  toolCalls.forEach((toolCall, index) => {
    events.push({ type: "toolcall_start", contentIndex: index, partial });
    events.push({
      type: "toolcall_delta",
      contentIndex: index,
      delta: JSON.stringify(toolCall.args),
      partial,
    });
    events.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: {
        type: "toolCall",
        id: `call_${turn}_${index}`,
        name: toolCall.name,
        arguments: toolCall.args,
      },
      partial,
    });
  });
  events.push({ type: "done", reason: "toolUse", message: partial });
  return events;
}

/** Build the mock model's response for one provider turn. */
export function conformancePlan(
  context: Context,
): { toolCalls: Array<{ name: string; args: Record<string, unknown> }> } | { finalText: string } {
  const plan = planForContext(context);
  switch (plan.kind) {
    case "technicals":
      return {
        toolCalls: [{
          name: "market_technicals",
          args: { scope: "ticker", symbol: plan.symbol, research_id: plan.researchId },
        }],
      };
    case "discover":
      return {
        toolCalls: [{
          name: "market_discover",
          args: { scope: "ticker", symbol: plan.symbol, research_id: plan.researchId },
        }],
      };
    case "extract":
      return {
        toolCalls: plan.candidateIds.map((candidateId) => ({
          name: "market_extract",
          args: { research_id: plan.researchId, candidate_id: candidateId, mode: "text_main" },
        })),
      };
    case "canvas":
      return {
        toolCalls: [{
          name: "market_canvas",
          args: {
            symbol: plan.symbol,
            title: `${plan.symbol} conformance brief`,
            research_id: plan.researchId,
            stage: "complete",
            content: "",
            blocks: [
              {
                id: "read",
                kind: "text",
                title: "Summary",
                text: `${plan.symbol} traded on verified public reporting reviewed from fetched sources.`,
                sourceIds: plan.sourceIds,
                dossierHint: "read",
              },
              {
                id: "unknowns",
                kind: "bullets",
                title: "Unknowns",
                items: [{ text: "No additional confirmed catalysts beyond the fetched reporting." }],
                dossierHint: "unknowns",
              },
            ],
            citations: plan.sourceIds.length > 0
              ? [{ source_id: plan.sourceIds[0]!, quote: CONFORMANCE_FIXTURE_SENTENCE.slice(0, 80) }]
              : [],
          },
        }],
      };
    case "final":
      return { finalText: "Conformance research complete." };
  }
}

/** Build the scripted assistant event stream for one provider turn. */
function mockStreamEvents(context: Context): MockEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const plan = conformancePlan(context);
    const turn = context.messages.filter((m) => m.role === "assistant").length + 1;
    if ("toolCalls" in plan) {
      for (const event of toolCallMessage(plan.toolCalls, turn)) stream.push(event);
    } else {
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: plan.finalText }],
        api: CONFORMANCE_PROVIDER_ID,
        provider: CONFORMANCE_PROVIDER_ID,
        model: CONFORMANCE_MODEL_ID,
        usage: mockUsage(turn),
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: plan.finalText, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: plan.finalText, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    }
    stream.end();
  });
  return stream;
}

/** Deterministic provider for the conformance capture. */
export function createConformanceProvider(): Provider {
  return createProvider({
    id: CONFORMANCE_PROVIDER_ID,
    name: "Conformance Mock",
    auth: {
      apiKey: {
        name: "Conformance key (keyless local mock)",
        resolve: () => Promise.resolve({ auth: { apiKey: "conformance-key" } }),
      },
    },
    models: [{
      id: CONFORMANCE_MODEL_ID,
      name: "Conformance Model V1",
      api: CONFORMANCE_PROVIDER_ID,
      provider: CONFORMANCE_PROVIDER_ID,
      baseUrl: "http://127.0.0.1:0/mock",
      reasoning: false,
      input: ["text"],
      cost: MOCK_COST,
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    }] as unknown as Array<Model<string>>,
    api: {
      // The SDK drives turns through ModelRuntime.streamSimple.
      streamSimple(model, context) {
        return mockStreamEvents(context);
      },
      stream(model, context) {
        return mockStreamEvents(context);
      },
    },
  });
}
