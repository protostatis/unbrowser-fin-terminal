import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  assertMarketAgentTools,
  createAgentModelRuntime,
  DEFAULT_OPENROUTER_MODEL,
  MARKET_SCOUT_OPENROUTER_MODEL,
  MARKET_AGENT_TOOLS,
  readAgentModelConfig,
  validateUnbrowserRuntime,
} from "../server/agent-config.js";

test("OpenRouter configuration selects the latest DeepSeek Flash default", () => {
  const config = readAgentModelConfig({ OPENROUTER_API_KEY: "test-only" });
  assert.equal(config.provider, "openrouter");
  assert.equal(config.modelId, "deepseek/deepseek-v4-flash-0731");
  assert.equal(config.modelId, DEFAULT_OPENROUTER_MODEL);
  assert.equal(config.maxOutputTokens, 4_096);
});

test("model policy stays on local Pi configuration when OpenRouter is not configured", () => {
  const config = readAgentModelConfig({});
  assert.equal(config.provider, undefined);
  assert.equal(config.modelId, undefined);
});

test("Pi resolves the July 31 DeepSeek Flash release before its catalog entry ships", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "fin-terminal-model-test-"));
  try {
    const { model } = await createAgentModelRuntime(agentDir, { OPENROUTER_API_KEY: "test-only" });
    assert.equal(model?.provider, "openrouter");
    assert.equal(model?.id, "deepseek/deepseek-v4-flash-0731");
    assert.equal(model?.name, "DeepSeek: DeepSeek V4 Flash 0731");
    assert.equal(model?.contextWindow, 1_048_576);
    assert.equal(model?.cost.input, 0.09);
    assert.equal(model?.cost.output, 0.18);
    assert.equal(model?.maxTokens, 4_096);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Pi resolves the scout-only free Nemotron model before its catalog entry ships", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "fin-terminal-scout-model-test-"));
  try {
    const { model } = await createAgentModelRuntime(agentDir, {
      OPENROUTER_API_KEY: "test-only",
      OPENROUTER_MODEL: MARKET_SCOUT_OPENROUTER_MODEL,
    });
    assert.equal(model?.provider, "openrouter");
    assert.equal(model?.id, MARKET_SCOUT_OPENROUTER_MODEL);
    assert.equal(model?.cost.input, 0);
    assert.equal(model?.cost.output, 0);
    assert.equal(model?.maxTokens, 4_096);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Pi loads an OpenRouter key from an absolute secret file without provider refresh", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "fin-terminal-secret-test-"));
  const keyPath = path.join(agentDir, "openrouter-key");
  try {
    await writeFile(keyPath, "test-only\n", { mode: 0o600 });
    const { model } = await createAgentModelRuntime(agentDir, { OPENROUTER_API_KEY_FILE: keyPath });
    assert.equal(model?.provider, "openrouter");
    assert.equal(model?.id, "deepseek/deepseek-v4-flash-0731");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("model configuration rejects ambiguous credentials and incomplete policy", () => {
  assert.throws(
    () => readAgentModelConfig({ OPENROUTER_API_KEY: "one", OPENROUTER_API_KEY_FILE: "/secret/two" }),
    /only one/,
  );
  assert.throws(
    () => readAgentModelConfig({ MARKET_MODEL_PROVIDER: "openrouter" }),
    /must be set together/,
  );
  assert.throws(
    () => readAgentModelConfig({ OPENROUTER_API_KEY_FILE: "relative/key" }),
    /must be an absolute path/,
  );
  assert.throws(
    () => readAgentModelConfig({
      MARKET_MODEL_PROVIDER: "openrouter",
      MARKET_MODEL_ID: "deepseek/deepseek-v4-flash-0731",
      OPENROUTER_MODEL: "another/model",
    }),
    /must match/,
  );
  assert.throws(
    () => readAgentModelConfig({ MARKET_MAX_OUTPUT_TOKENS: "100000" }),
    /must be an integer/,
  );
});

test("production requires an isolated unbrowser MCP endpoint", () => {
  assert.throws(() => validateUnbrowserRuntime({ NODE_ENV: "production" }), /UNBROWSER_MCP_URL is required/);
  assert.doesNotThrow(() => validateUnbrowserRuntime({
    NODE_ENV: "production",
    UNBROWSER_MCP_URL: "http://unbrowser-mcp:8767/mcp",
  }));
  assert.throws(
    () => validateUnbrowserRuntime({ UNBROWSER_MCP_URL: "file:///tmp/socket" }),
    /must be an HTTP\(S\) URL/,
  );
});

test("Pi exposes only the production market tool allowlist", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "fin-terminal-agent-test-"));
  const cwd = path.resolve(import.meta.dirname, "..");
  try {
    const loader = new DefaultResourceLoader({ cwd, agentDir });
    await loader.reload();
    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
      tools: [...MARKET_AGENT_TOOLS],
    });
    try {
      assert.deepEqual(extensionsResult.errors, []);
      assertMarketAgentTools(session);
      assert.deepEqual(new Set(session.getActiveToolNames()), new Set(MARKET_AGENT_TOOLS));
      assert.deepEqual(new Set(session.getAllTools().map((tool) => tool.name)), new Set(MARKET_AGENT_TOOLS));
    } finally {
      session.dispose();
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
