import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ModelRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
  CONFORMANCE_MODEL_ID,
  CONFORMANCE_PROVIDER_ID,
  createConformanceProvider,
} from "./conformance-mock-model.js";
import { MARKET_RESEARCH_TOOL_NAMES } from "../shared/research-tool-policy.js";
import { MARKET_SCOUT_MODEL_ID } from "../shared/market-event-scout.js";

export const MARKET_AGENT_TOOLS = MARKET_RESEARCH_TOOL_NAMES;

export const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-v4-flash-0731";
export const MARKET_SCOUT_OPENROUTER_MODEL = MARKET_SCOUT_MODEL_ID;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_OPENROUTER_MODEL_TEMPLATE = "deepseek/deepseek-v4-flash";

function resolveConfiguredModel(
  modelRuntime: ModelRuntime,
  provider: string,
  modelId: string,
): Model<any> | undefined {
  const catalogModel = modelRuntime.getModel(provider, modelId);
  if (catalogModel) return catalogModel;
  if (provider !== "openrouter" || (modelId !== DEFAULT_OPENROUTER_MODEL && modelId !== MARKET_SCOUT_OPENROUTER_MODEL)) return undefined;

  // Pi 0.83.0's bundled catalog predates the July 31 model release. Reuse the
  // existing OpenRouter transport compatibility while supplying the published
  // identity, context, and pricing until the next Pi catalog ships it.
  const template = modelRuntime.getModel("openrouter", DEFAULT_OPENROUTER_MODEL_TEMPLATE);
  if (!template) return undefined;
  if (modelId === MARKET_SCOUT_OPENROUTER_MODEL) {
    return {
      ...template,
      id: modelId,
      name: "NVIDIA: Nemotron 3.5 Lightning",
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    };
  }

  return {
    ...template,
    id: DEFAULT_OPENROUTER_MODEL,
    name: "DeepSeek: DeepSeek V4 Flash 0731",
    cost: {
      input: 0.09,
      output: 0.18,
      cacheRead: 0.018,
      cacheWrite: 0,
    },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  };
}

export type AgentModelConfig = {
  provider?: string;
  modelId?: string;
  maxOutputTokens: number;
  openRouterKeyFile?: string;
};

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`MARKET_MAX_OUTPUT_TOKENS must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function readAgentModelConfig(env: NodeJS.ProcessEnv = process.env): AgentModelConfig {
  const explicitProvider = optionalValue(env.MARKET_MODEL_PROVIDER);
  const explicitModel = optionalValue(env.MARKET_MODEL_ID);
  const openRouterModel = optionalValue(env.OPENROUTER_MODEL);
  const openRouterKeyFile = optionalValue(env.OPENROUTER_API_KEY_FILE);
  const openRouterConfigured = Boolean(
    openRouterModel
    || openRouterKeyFile
    || optionalValue(env.OPENROUTER_API_KEY),
  );

  if (Boolean(explicitProvider) !== Boolean(explicitModel)) {
    throw new Error("MARKET_MODEL_PROVIDER and MARKET_MODEL_ID must be set together");
  }
  if (explicitProvider && openRouterModel && explicitProvider !== "openrouter") {
    throw new Error("OPENROUTER_MODEL cannot be combined with a non-OpenRouter MARKET_MODEL_PROVIDER");
  }
  if (
    explicitProvider
    && explicitProvider !== "openrouter"
    && explicitProvider !== CONFORMANCE_PROVIDER_ID
    && (openRouterKeyFile || optionalValue(env.OPENROUTER_API_KEY))
  ) {
    throw new Error("OpenRouter credentials cannot be combined with a non-OpenRouter MARKET_MODEL_PROVIDER");
  }
  if (explicitModel && openRouterModel && explicitModel !== openRouterModel) {
    throw new Error("MARKET_MODEL_ID and OPENROUTER_MODEL must match when both are set");
  }
  if (openRouterKeyFile && optionalValue(env.OPENROUTER_API_KEY)) {
    throw new Error("Set only one of OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE");
  }
  if (openRouterKeyFile && !path.isAbsolute(openRouterKeyFile)) {
    throw new Error("OPENROUTER_API_KEY_FILE must be an absolute path");
  }

  const provider = explicitProvider ?? (openRouterConfigured ? "openrouter" : undefined);
  const modelId = explicitModel
    ?? (provider === "openrouter" ? openRouterModel ?? DEFAULT_OPENROUTER_MODEL : undefined);

  return {
    provider,
    modelId,
    maxOutputTokens: boundedInteger(
      env.MARKET_MAX_OUTPUT_TOKENS,
      DEFAULT_MAX_OUTPUT_TOKENS,
      256,
      16_384,
    ),
    openRouterKeyFile,
  };
}

async function readSecretFile(filePath: string): Promise<string> {
  const secret = (await readFile(filePath, "utf8")).trim();
  if (!secret) throw new Error(`${filePath} is empty`);
  if (secret.includes("\0") || secret.includes("\n") || secret.includes("\r")) {
    throw new Error(`${filePath} must contain exactly one secret value`);
  }
  return secret;
}

export async function createAgentModelRuntime(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ modelRuntime: ModelRuntime; model?: Model<any>; config: AgentModelConfig }> {
  const config = readAgentModelConfig(env);
  const injectedOpenRouterKey = config.openRouterKeyFile
    ? await readSecretFile(config.openRouterKeyFile)
    : env !== process.env ? optionalValue(env.OPENROUTER_API_KEY) : undefined;
  const credentials = injectedOpenRouterKey ? new InMemoryCredentialStore() : undefined;
  if (credentials && injectedOpenRouterKey) {
    await credentials.modify("openrouter", async () => ({ type: "api_key", key: injectedOpenRouterKey }));
  }
  const modelRuntime = await ModelRuntime.create({
    ...(credentials ? { credentials } : {}),
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });

  if (!config.provider || !config.modelId) return { modelRuntime, config };

  // Conformance capture mode: register the deterministic mock provider before
  // resolving the model so both the parent session and forked research workers
  // (which inherit env) execute the same scripted research flow with no key.
  if (config.provider === CONFORMANCE_PROVIDER_ID) {
    if (config.modelId !== CONFORMANCE_MODEL_ID) {
      throw new Error(`Unknown conformance model: ${config.modelId}`);
    }
    modelRuntime.registerNativeProvider(createConformanceProvider());
  }

  const selected = resolveConfiguredModel(modelRuntime, config.provider, config.modelId);
  if (!selected) {
    throw new Error(`Unknown configured market model: ${config.provider}/${config.modelId}`);
  }
  if (config.provider !== CONFORMANCE_PROVIDER_ID && !modelRuntime.hasConfiguredAuth(config.provider)) {
    // The conformance provider is a keyless deterministic mock; the runtime's
    // provider-auth snapshot is built before registerNativeProvider runs, so
    // hasConfiguredAuth cannot see it. Real providers still fail closed.
    throw new Error(`No credentials configured for market model provider: ${config.provider}`);
  }

  const maxTokens = selected.maxTokens > 0
    ? Math.min(selected.maxTokens, config.maxOutputTokens)
    : config.maxOutputTokens;
  const model: Model<any> = { ...selected, maxTokens };
  return { modelRuntime, model, config };
}

export function assertMarketAgentTools(session: AgentSession): void {
  const expected = new Set<string>(MARKET_AGENT_TOOLS);
  const active = session.getActiveToolNames();
  const registered = session.getAllTools().map((tool) => tool.name);
  const exact = (names: string[]) => names.length === expected.size && names.every((name) => expected.has(name));
  if (!exact(active) || !exact(registered)) {
    throw new Error(
      `Unsafe market agent tool registry; expected only ${MARKET_AGENT_TOOLS.join(", ")}; `
      + `active=${active.join(",") || "(none)"}; registered=${registered.join(",") || "(none)"}`,
    );
  }
}

export function validateUnbrowserRuntime(env: NodeJS.ProcessEnv = process.env): void {
  const endpoint = optionalValue(env.UNBROWSER_MCP_URL);
  if (endpoint) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error("UNBROWSER_MCP_URL must be an absolute HTTP(S) URL");
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.hash
    ) {
      throw new Error("UNBROWSER_MCP_URL must be an HTTP(S) URL without credentials or a fragment");
    }
    return;
  }
  if (env.NODE_ENV === "production" || env.UNBROWSER_MCP_REQUIRED === "1") {
    throw new Error("UNBROWSER_MCP_URL is required for isolated production research");
  }
}
