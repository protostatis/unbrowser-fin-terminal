/**
 * Deterministic Unbrowser MCP endpoint for conformance capture.
 *
 * Speaks the same JSON-RPC-over-HTTP protocol as `UnbrowserMcpClient`
 * (shared/unbrowser-mcp.ts): POST initialize → mcp-session-id header,
 * notifications/initialized, tools/call navigate|text_main|table_to_json|
 * extract_cards|body, DELETE to close.
 *
 * Behavior (fully deterministic, no network):
 *  - navigate on html.duckduckgo.com → blockmap.interactives.link_samples for
 *    the CONFORMANCE_FIXTURE_URLS (drives market_discover candidates).
 *  - navigate on any fixture URL → plain article page (density normal, no
 *    challenge, no link samples).
 *  - text_main → JSON string of fixed article content containing
 *    CONFORMANCE_FIXTURE_SENTENCE (drives market_extract + canvas citations).
 *  - table_to_json / extract_cards → small fixed structures.
 *  - body → raw article text (readDocument path, scout disabled in capture).
 */

import http from "node:http";
import {
  CONFORMANCE_FIXTURE_SENTENCE,
  CONFORMANCE_FIXTURE_URLS,
} from "../../server/conformance-mock-model.js";

const MOCK_SESSION_ID = "conformance-session-1";
const DUCKDUCKGO_PREFIX = "https://html.duckduckgo.com/html/";

const ARTICLE_CONTENT = [
  "# Apple Q2 2026 reporting",
  "",
  CONFORMANCE_FIXTURE_SENTENCE,
  "The company reported quarterly results and reaffirmed its capital allocation program.",
  "Analysts cited supply-chain normalization as a tailwind for the quarter.",
].join("\n");

const TABLE_JSON = JSON.stringify({
  rows: [
    { period: "Q2 2026", revenue: "$95B", note: "reported" },
    { period: "Q1 2026", revenue: "$89B", note: "reported" },
  ],
});

const CARDS_JSON = JSON.stringify([
  { headline: "Apple reports Q2 results", url: CONFORMANCE_FIXTURE_URLS[0] },
  { headline: "Analysts react to Apple quarter", url: CONFORMANCE_FIXTURE_URLS[1] },
]);

function navigatePayload(url: string): Record<string, unknown> {
  if (url.startsWith(DUCKDUCKGO_PREFIX)) {
    return {
      url,
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      blockmap: {
        density: { likely_js_filled: false, thin_shell: false },
        interactives: {
          link_samples: CONFORMANCE_FIXTURE_URLS.map((fixtureUrl) => ({
            text: `Result for ${fixtureUrl}`,
            href: fixtureUrl,
          })),
        },
      },
    };
  }
  if (CONFORMANCE_FIXTURE_URLS.includes(url as (typeof CONFORMANCE_FIXTURE_URLS)[number])) {
    return {
      url,
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      blockmap: {
        density: { likely_js_filled: false, thin_shell: false },
        interactives: { link_samples: [] },
      },
    };
  }
  return {
    url,
    status: 404,
    headers: { "content-type": "text/plain" },
    blockmap: { density: { likely_js_filled: false, thin_shell: false } },
  };
}

function toolResultText(toolName: string, args: Record<string, unknown>): string {
  const url = String(args.url ?? "");
  switch (toolName) {
    case "navigate":
      return JSON.stringify(navigatePayload(url));
    case "text_main":
      return JSON.stringify(ARTICLE_CONTENT);
    case "table_to_json":
      return TABLE_JSON;
    case "extract_cards":
      return CARDS_JSON;
    case "body":
      return JSON.stringify(ARTICLE_CONTENT);
    default:
      return JSON.stringify({ error: `unknown tool ${toolName}` });
  }
}

function handleToolCall(name: string, args: unknown): { content: Array<{ type: string; text: string }> } {
  return {
    content: [{ type: "text", text: toolResultText(name, (args ?? {}) as Record<string, unknown>) }],
  };
}

export interface MockMcpServerHandle {
  endpoint: string;
  close(): Promise<void>;
}

export function startMockMcpServer(port = 0): Promise<MockMcpServerHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");

        const reply = (status: number, payload?: string) => {
          res.setHeader("mcp-session-id", MOCK_SESSION_ID);
          res.statusCode = status;
          res.end(payload ?? "");
        };

        if (req.method === "DELETE") {
          reply(204);
          return;
        }

        let envelope: unknown;
        try {
          envelope = body ? JSON.parse(body) : undefined;
        } catch {
          reply(400, JSON.stringify({ jsonrpc: "2.0", id: null, error: { message: "invalid JSON" } }));
          return;
        }
        if (!envelope || typeof envelope !== "object") {
          reply(400, JSON.stringify({ jsonrpc: "2.0", id: null, error: { message: "empty body" } }));
          return;
        }
        const rpc = envelope as { method?: string; id?: string | number; params?: Record<string, unknown> };

        if (rpc.method === "initialize") {
          reply(200, JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "conformance-mock-mcp", version: "1" },
            },
          }));
          return;
        }
        if (rpc.method === "notifications/initialized") {
          reply(202);
          return;
        }
        if (rpc.method === "tools/call") {
          const name = String((rpc.params as { name?: unknown } | undefined)?.name ?? "");
          const args = (rpc.params as { arguments?: unknown } | undefined)?.arguments;
          reply(200, JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: handleToolCall(name, args),
          }));
          return;
        }
        reply(400, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { message: `unhandled method ${rpc.method}` } }));
      });
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        endpoint: `http://127.0.0.1:${actualPort}/mcp`,
        close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}
