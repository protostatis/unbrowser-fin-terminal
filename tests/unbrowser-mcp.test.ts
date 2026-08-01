import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeUnbrowserMcpUrl,
  ResearchCandidateRegistry,
  UnbrowserMcpClient,
  userFacingUnbrowserError,
} from "../shared/unbrowser-mcp.js";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("candidate grants are research-bound, single-use, capped, and expiring", () => {
  let now = 1_000;
  let sequence = 0;
  const registry = new ResearchCandidateRegistry({
    ttlMs: 100,
    maxExtractions: 2,
    now: () => now,
    createId: () => `candidate-${++sequence}`,
  });
  const candidates = registry.register("job-1", [
    { sourceId: "S1", title: "One", url: "https://one.example/", source: "one.example" },
    { sourceId: "S2", title: "Two", url: "https://two.example/", source: "two.example" },
    { sourceId: "S3", title: "Three", url: "https://three.example/", source: "three.example" },
  ]);

  assert.equal(candidates[0]?.candidateId, "candidate-1");
  assert.throws(() => registry.consume("job-2", "candidate-1"), /No extraction candidates/);
  assert.equal(registry.consume("job-1", "candidate-1").sourceId, "S1");
  assert.throws(() => registry.consume("job-1", "candidate-1"), /already used/);
  assert.equal(registry.consume("job-1", "candidate-2").sourceId, "S2");
  assert.throws(() => registry.consume("job-1", "candidate-3"), /2-source extraction limit/);
  const rediscovered = registry.register("job-1", [
    { sourceId: "S4", title: "Four", url: "https://four.example/", source: "four.example" },
  ]);
  assert.throws(
    () => registry.consume("job-1", rediscovered[0]!.candidateId),
    /2-source extraction limit/,
  );

  const expiring = registry.register("job-2", [
    { sourceId: "S1", title: "One", url: "https://one.example/", source: "one.example" },
  ]);
  now += 101;
  assert.throws(() => registry.consume("job-2", expiring[0]!.candidateId), /expired/);
});

test("MCP endpoint validation rejects credential-bearing and non-HTTP URLs", () => {
  assert.equal(normalizeUnbrowserMcpUrl("http://unbrowser-mcp:8767/mcp"), "http://unbrowser-mcp:8767/mcp");
  assert.throws(() => normalizeUnbrowserMcpUrl("file:///tmp/unbrowser"), /HTTP or HTTPS/);
  assert.throws(() => normalizeUnbrowserMcpUrl("https://user:pass@example.com/mcp"), /must not contain credentials/);
});

test("MCP hides non-actionable upstream 400 and 500 details", async () => {
  assert.equal(
    userFacingUnbrowserError("unbrowser MCP returned HTTP 500: upstream trace details"),
    "Source retrieval is temporarily unavailable. Try refreshing later.",
  );
  assert.equal(
    userFacingUnbrowserError("unbrowser MCP returned HTTP 400: malformed upstream response"),
    "Source retrieval is temporarily unavailable. Try refreshing later.",
  );

  const client = new UnbrowserMcpClient("http://unbrowser-mcp:8767/mcp", {
    fetch: async () => new Response("upstream trace details", { status: 500 }),
  });
  await assert.rejects(
    client.navigate("https://example.com/article"),
    (error: unknown) => error instanceof Error
      && error.message === "Source retrieval is temporarily unavailable. Try refreshing later.",
  );
});

test("MCP extraction initializes a session, uses fixed tools, truncates output, and closes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses: Response[] = [
    jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-03-26", serverInfo: { name: "unbrowser", version: "test" } },
    }, { headers: { "mcp-session-id": "session-1" } }),
    new Response(null, { status: 202 }),
    jsonResponse({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: JSON.stringify({
          url: "https://example.com/article",
          status: 200,
          challenge: null,
          blockmap: { density: { likely_js_filled: false, thin_shell: false } },
        }) }],
        isError: false,
      },
    }),
    jsonResponse({
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: JSON.stringify("0123456789") }], isError: false },
    }),
    new Response(null, { status: 200 }),
  ];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  };

  const client = new UnbrowserMcpClient("http://unbrowser-mcp:8767/mcp", {
    fetch: fakeFetch,
    maxExtractChars: 6,
  });
  const result = await client.extract("https://example.com/article", "text_main");

  assert.equal(result.retrievalStatus, "fetched");
  assert.equal(result.content, "012345");
  assert.equal(result.truncated, true);
  assert.equal(calls.length, 5);
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[4]?.init?.method, "DELETE");

  const toolCalls = calls
    .map((call) => typeof call.init?.body === "string" ? JSON.parse(call.init.body) : undefined)
    .filter((payload) => payload?.method === "tools/call");
  assert.deepEqual(toolCalls.map((payload) => payload.params.name), ["navigate", "text_main"]);
  assert.deepEqual(toolCalls[0]?.params.arguments, {
    url: "https://example.com/article",
    exec_scripts: false,
    include_ascii: false,
  });
});

test("MCP extraction stops after navigation reports a challenge", async () => {
  const calls: RequestInit[] = [];
  const responses: Response[] = [
    jsonResponse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }, {
      headers: { "mcp-session-id": "session-2" },
    }),
    new Response(null, { status: 202 }),
    jsonResponse({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: JSON.stringify({
          url: "https://example.com/challenge",
          status: 403,
          challenge: { provider: "bot-wall" },
        }) }],
        isError: false,
      },
    }),
    new Response(null, { status: 200 }),
  ];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push(init ?? {});
    return responses.shift()!;
  };

  const client = new UnbrowserMcpClient("http://unbrowser-mcp:8767/mcp", { fetch: fakeFetch });
  const result = await client.extract("https://example.com/challenge", "text_main");
  assert.equal(result.retrievalStatus, "challenged");
  assert.equal(result.content, "");

  const toolCalls = calls
    .map((call) => typeof call.body === "string" ? JSON.parse(call.body) : undefined)
    .filter((payload) => payload?.method === "tools/call");
  assert.deepEqual(toolCalls.map((payload) => payload.params.name), ["navigate"]);
});
