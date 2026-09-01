import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createBrowserTerminalApp } from "../server/browser-terminal.js";

const PROXY_TOKEN = "test-proxy-token";

function headers(principal = "account:alice"): HeadersInit {
	return {
		"content-type": "application/json",
		"x-fin-terminal-proxy-token": PROXY_TOKEN,
		"x-fin-terminal-user": principal,
	};
}

async function withServer<T>(
	fetchImpl: typeof fetch,
	fn: (base: string, calls: Array<{ url: string; init?: RequestInit }>) => Promise<T>,
	now: () => number = Date.now,
): Promise<T> {
	const root = await mkdtemp(path.join(os.tmpdir(), "browser-terminal-test-"));
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const app = createBrowserTerminalApp({
		fetchImpl: async (input, init) => {
			calls.push({ url: String(input), init });
			return fetchImpl(input, init);
		},
		openRouterApiKey: "server-secret",
		openRouterModel: "server/model",
		watchlistImportModel: "vision/model",
		mcpEndpoint: "https://mcp.test/mcp",
		storageRoot: root,
		webDist: "",
		proxyToken: PROXY_TOKEN,
		now,
	});
	const server = app.listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address() as AddressInfo;
		return await fn(`http://127.0.0.1:${address.port}`, calls);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	}
}

test("authenticated browser broker overrides model and never forwards browser auth", async () => {
	let openRouterBody: Record<string, unknown> | undefined;
	const fakeFetch: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url === "https://openrouter.ai/api/v1/chat/completions") {
			openRouterBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error(`unexpected upstream ${url}`);
	};

	await withServer(fakeFetch, async (base, calls) => {
		const session = await fetch(`${base}/api/browser/v1/session`, { headers: headers() });
		assert.equal(session.status, 200);
		assert.deepEqual(await session.json(), {
			version: 1,
			model: "server/model",
			features: { broker: true, mcp: true, quotes: true, cryptoPulse: true, persistence: true },
		});

		const chat = await fetch(`${base}/api/browser/v1/chat/completions`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				model: "attacker/model",
				messages: [{ role: "system", content: "system" }, { role: "user", content: "hello" }],
				tools: [{ type: "function", function: { name: "market_discover", description: "discover", parameters: {} } }],
			}),
		});
		assert.equal(chat.status, 200);
		assert.equal(openRouterBody?.model, "server/model");
		assert.equal(openRouterBody?.max_tokens, 4096);
		assert.deepEqual((openRouterBody?.messages as unknown[]).length, 2);
		const upstreamCall = calls.find((call) => call.url === "https://openrouter.ai/api/v1/chat/completions");
		assert.ok(upstreamCall);
		assert.equal((upstreamCall.init?.headers as Record<string, string>).authorization, "Bearer server-secret");
		assert.equal((upstreamCall.init?.headers as Record<string, string>)["x-fin-terminal-user"], undefined);

		const crossOrigin = await fetch(`${base}/api/browser/v1/session`, { headers: { ...headers(), origin: "https://evil.example" } });
		assert.equal(crossOrigin.status, 403);
  });
});

test("authenticated browser broker serves screenshot watchlist import", async () => {
  let visionBody: Record<string, unknown> | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    if (String(input) !== "https://openrouter.ai/api/v1/chat/completions") throw new Error(`unexpected upstream ${String(input)}`);
    visionBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ instruments: [
        { symbol: "AAPL", name: "Apple", assetType: "stock", confidence: 0.99 },
        { symbol: "BTC", name: "Bitcoin", assetType: "crypto", confidence: 0.96 },
      ] }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/api/watchlist/import`, {
      method: "POST",
      headers: { ...headers(), "content-type": "image/png" },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).candidates.map((candidate: { symbol: string }) => candidate.symbol), ["AAPL", "BTC-USD"]);
    assert.equal(visionBody?.model, "vision/model");
  });
});

test("authenticated broker requires the forwarded origin scheme to match", async () => {
  const fakeFetch: typeof fetch = async () => {
    throw new Error("unexpected upstream");
  };
  await withServer(fakeFetch, async (base) => {
    const host = new URL(base).host;
    const wrongScheme = await fetch(`${base}/api/browser/v1/session`, {
      headers: { ...headers(), origin: `https://${host}`, "x-forwarded-host": host, "x-forwarded-proto": "http" },
    });
    assert.equal(wrongScheme.status, 403);

    const forwardedHttps = await fetch(`${base}/api/browser/v1/session`, {
      headers: { ...headers(), origin: `https://${host}`, "x-forwarded-host": host, "x-forwarded-proto": "https" },
    });
    assert.equal(forwardedHttps.status, 200);
  });
});

test("dependency readiness performs an MCP handshake and cleans up the probe session", async () => {
  const methods: string[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    methods.push(init?.method || "GET");
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "readiness", result: {} }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "readiness-session" },
      });
    }
    return new Response(null, { status: 204 });
  };
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/api/ready?dependencies=1`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready",
      browserTerminal: true,
      dependencies: { mcp: true },
    });
  });
  assert.deepEqual(methods, ["POST", "DELETE"]);
});

test("dependency readiness reports MCP outages without hiding ordinary health", async () => {
  const fakeFetch: typeof fetch = async () => { throw new Error("sidecar unavailable"); };
  await withServer(fakeFetch, async (base) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);

    const response = await fetch(`${base}/api/ready?dependencies=1`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "starting",
      browserTerminal: true,
      dependencies: { mcp: false },
    });
  });
});

test("MCP proxy maps upstream sessions and binds them to the authenticated principal", async () => {
	const mcpCalls: Array<{ headers?: HeadersInit; body?: string }> = [];
	const fakeFetch: typeof fetch = async (input, init) => {
		if (String(input) !== "https://mcp.test/mcp") throw new Error(`unexpected upstream ${String(input)}`);
		mcpCalls.push({ headers: init?.headers, body: String(init?.body ?? "") });
		const body = JSON.parse(String(init?.body)) as { method?: string };
		if (body.method === "initialize") {
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
				status: 200,
				headers: { "content-type": "application/json", "mcp-session-id": "upstream-session" },
			});
		}
		return new Response(body.method === "notifications/initialized" ? "" : JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } }), {
			status: body.method === "notifications/initialized" ? 202 : 200,
			headers: { "content-type": "application/json" },
		});
	};

	await withServer(fakeFetch, async (base) => {
		const initialize = await fetch(`${base}/api/browser/v1/mcp`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		assert.equal(initialize.status, 200);
		const browserSession = initialize.headers.get("mcp-session-id");
		assert.ok(browserSession);
		assert.notEqual(browserSession, "upstream-session");

		const call = await fetch(`${base}/api/browser/v1/mcp`, {
			method: "POST",
			headers: { ...headers(), "mcp-session-id": browserSession! },
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "market_discover", arguments: {} } }),
		});
		assert.equal(call.status, 200);
		assert.equal(await call.text(), JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } }));
		assert.equal((mcpCalls[1]?.headers as Record<string, string>)["mcp-session-id"], "upstream-session");

		const otherPrincipal = await fetch(`${base}/api/browser/v1/mcp`, {
			method: "POST",
			headers: { ...headers("account:bob"), "mcp-session-id": browserSession! },
			body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "market_discover", arguments: {} } }),
		});
		assert.equal(otherPrincipal.status, 404);

		// The browser research worker calls the raw unbrowser tools through this
		// proxy (market_discover → navigate; market_extract → text_main/…).
		// Blocking them broke production discovery with the generic
		// "Source retrieval is temporarily unavailable" mapping.
		const navigate = await fetch(`${base}/api/browser/v1/mcp`, {
			method: "POST",
			headers: { ...headers(), "mcp-session-id": browserSession! },
			body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "navigate", arguments: { url: "https://lite.duckduckgo.com/lite/?q=test" } } }),
		});
		assert.equal(navigate.status, 200);
		const textMain = await fetch(`${base}/api/browser/v1/mcp`, {
			method: "POST",
			headers: { ...headers(), "mcp-session-id": browserSession! },
			body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "text_main", arguments: {} } }),
		});
		assert.equal(textMain.status, 200);

		const arbitraryTool = await fetch(`${base}/api/browser/v1/mcp`, {
			method: "POST",
			headers: { ...headers(), "mcp-session-id": browserSession! },
			body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "shell_exec", arguments: { command: "rm -rf /" } } }),
		});
		assert.equal(arbitraryTool.status, 400);
  });
});

test("MCP proxy caps sessions per authenticated principal", async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
    status: 200,
    headers: { "content-type": "application/json", "mcp-session-id": `upstream-${Math.random()}` },
  });
	  await withServer(fakeFetch, async (base) => {
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${base}/api/browser/v1/mcp`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id: index, method: "initialize", params: {} }),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses.slice(0, 4), Array.from({ length: 4 }, () => 200));
    assert.equal(statuses[4], 429);
  });
});

test("MCP initialization reserves global worker capacity before upstream responses return", async () => {
  const fakeFetch: typeof fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": `upstream-${Math.random()}` },
    });
  };
  await withServer(fakeFetch, async (base) => {
    const responses = await Promise.all(Array.from({ length: 9 }, (_, index) => fetch(`${base}/api/browser/v1/mcp`, {
      method: "POST",
      headers: headers(`account:user-${index}`),
      body: JSON.stringify({ jsonrpc: "2.0", id: index, method: "initialize", params: {} }),
    })));
    assert.equal(responses.filter((response) => response.status === 200).length, 8);
    assert.equal(responses.filter((response) => response.status === 429).length, 1);
  });
});

test("MCP session requests are serialized and expired sessions are closed", async () => {
  let clock = 0;
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  let closeCalls = 0;
  const fakeFetch: typeof fetch = async (_input, init) => {
    const method = (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method;
    if (init?.method === "DELETE") {
      closeCalls += 1;
      return new Response(null, { status: 204 });
    }
    if (method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "upstream-session" },
      });
    }
    activeCalls += 1;
    maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
    await new Promise((resolve) => setTimeout(resolve, 10));
    activeCalls -= 1;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await withServer(fakeFetch, async (base) => {
    const initialize = await fetch(`${base}/api/browser/v1/mcp`, {
      method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const browserSession = initialize.headers.get("mcp-session-id");
    assert.ok(browserSession);
    const calls = await Promise.all([1, 2].map((id) => fetch(`${base}/api/browser/v1/mcp`, {
      method: "POST",
      headers: { ...headers(), "mcp-session-id": browserSession! },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "market_discover", arguments: {} } }),
    })));
    assert.deepEqual(calls.map((response) => response.status), [200, 200]);
    assert.equal(maximumActiveCalls, 1);

    clock = 121_000;
    const expired = await fetch(`${base}/api/browser/v1/mcp`, {
      method: "POST",
      headers: { ...headers(), "mcp-session-id": browserSession! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "market_discover", arguments: {} } }),
    });
    assert.equal(expired.status, 404);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCalls, 1);
  }, () => clock);
});

test("MCP session map keeps one lock object across staggered requests", async () => {
  let toolCalls = 0;
  let activeTools = 0;
  let maximumActiveTools = 0;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const fakeFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "upstream-session" },
      });
    }
    toolCalls += 1;
    activeTools += 1;
    maximumActiveTools = Math.max(maximumActiveTools, activeTools);
    if (toolCalls === 1) await firstGate;
    if (toolCalls === 2) await secondGate;
    activeTools -= 1;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: toolCalls, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await withServer(fakeFetch, async (base) => {
    const initialize = await fetch(`${base}/api/browser/v1/mcp`, {
      method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const browserSession = initialize.headers.get("mcp-session-id");
    assert.ok(browserSession);
    const requestBody = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "market_discover", arguments: {} } });
    const first = fetch(`${base}/api/browser/v1/mcp`, { method: "POST", headers: { ...headers(), "mcp-session-id": browserSession! }, body: requestBody(2) });
    while (toolCalls < 1) await new Promise((resolve) => setImmediate(resolve));
    const second = fetch(`${base}/api/browser/v1/mcp`, { method: "POST", headers: { ...headers(), "mcp-session-id": browserSession! }, body: requestBody(3) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(toolCalls, 1);
    releaseFirst();
    while (toolCalls < 2) await new Promise((resolve) => setImmediate(resolve));
    const third = fetch(`${base}/api/browser/v1/mcp`, { method: "POST", headers: { ...headers(), "mcp-session-id": browserSession! }, body: requestBody(4) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(toolCalls, 2);
    assert.equal(maximumActiveTools, 1);
    releaseSecond();
    assert.deepEqual((await Promise.all([first, second, third])).map((response) => response.status), [200, 200, 200]);
  });
});

test("MCP intermediate requests cannot extend the absolute session lifetime", async () => {
  let clock = 0;
  const fakeFetch: typeof fetch = async (_input, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "upstream-session" },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await withServer(fakeFetch, async (base) => {
    const initialize = await fetch(`${base}/api/browser/v1/mcp`, {
      method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const browserSession = initialize.headers.get("mcp-session-id");
    assert.ok(browserSession);
    for (const [index, timestamp] of [100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000, 899_000].entries()) {
      clock = timestamp;
      const intermediate = await fetch(`${base}/api/browser/v1/mcp`, {
        method: "POST", headers: { ...headers(), "mcp-session-id": browserSession! }, body: JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: "market_discover", arguments: {} } }),
      });
      assert.equal(intermediate.status, 200);
    }
    clock = 901_000;
    const expired = await fetch(`${base}/api/browser/v1/mcp`, {
      method: "POST", headers: { ...headers(), "mcp-session-id": browserSession! }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "market_discover", arguments: {} } }),
    });
    assert.equal(expired.status, 404);
  }, () => clock);
});

test("global broker rate limiting applies across principals", async () => {
  const fakeFetch: typeof fetch = async () => { throw new Error("unexpected upstream"); };
  await withServer(fakeFetch, async (base) => {
    const responses = [];
    for (let index = 0; index < 61; index += 1) {
      responses.push(await fetch(`${base}/api/browser/v1/storage/market-watchlist.json`, {
        headers: headers(`account:rate-${index}`),
      }));
    }
    assert.equal(responses.filter((response) => response.status === 404).length, 60);
    assert.equal(responses.filter((response) => response.status === 429).length, 1);
  });
});

test("quote refresh budget does not consume crypto or interactive research budgets", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/v8/finance/chart/")) {
      return new Response(JSON.stringify({ chart: { result: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://openrouter.ai/api/v1/chat/completions") {
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected upstream ${url}`);
  };
  await withServer(fakeFetch, async (base) => {
    const quotes = [];
    for (let index = 0; index < 60; index += 1) {
      quotes.push(await fetch(`${base}/api/browser/v1/quotes/AAPL?scope=day`, { headers: headers() }));
    }
    assert.equal(quotes.every((response) => response.status === 502), true);

    const crypto = await fetch(`${base}/api/browser/v1/crypto/pulse`, { headers: headers() });
    assert.equal(crypto.status, 200);

    const research = await fetch(`${base}/api/browser/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(research.status, 200);

    const rejectedQuote = await fetch(`${base}/api/browser/v1/quotes/AAPL?scope=day`, { headers: headers() });
    assert.equal(rejectedQuote.status, 429);
  });
});

test("storage is principal-scoped and rejects stale writes", async () => {
	const fakeFetch: typeof fetch = async () => { throw new Error("unexpected upstream"); };
	await withServer(fakeFetch, async (base) => {
		const document = { version: 1, symbols: ["AAPL"] };
	const first = await fetch(`${base}/api/browser/v1/storage/market-watchlist.json`, {
			method: "PUT", headers: { ...headers(), "if-none-match": "*" }, body: JSON.stringify(document),
		});
		assert.equal(first.status, 200);
		const etag = first.headers.get("etag");
		assert.ok(etag);
		const read = await fetch(`${base}/api/browser/v1/storage/market-watchlist.json`, { headers: headers() });
		assert.deepEqual(await read.json(), document);
		const stale = await fetch(`${base}/api/browser/v1/storage/market-watchlist.json`, {
			method: "PUT", headers: { ...headers(), "if-match": '"stale"' }, body: JSON.stringify({ version: 1, symbols: ["MSFT"] }),
		});
		assert.equal(stale.status, 409);
		const other = await fetch(`${base}/api/browser/v1/storage/market-watchlist.json`, { headers: headers("account:bob") });
		assert.equal(other.status, 404);
  });
});

test("storage compare-and-swap is serialized for concurrent writes", async () => {
  const fakeFetch: typeof fetch = async () => { throw new Error("unexpected upstream"); };
  await withServer(fakeFetch, async (base) => {
		const first = await fetch(`${base}/api/browser/v1/storage/market-watchlist.json`, {
			method: "PUT", headers: { ...headers(), "if-none-match": "*" }, body: JSON.stringify({ version: 1, symbols: ["AAPL"] }),
    });
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const writes = await Promise.all(["MSFT", "NVDA"].map((symbol) => fetch(`${base}/api/browser/v1/storage/market-watchlist.json`, {
      method: "PUT",
      headers: { ...headers(), "if-match": etag! },
      body: JSON.stringify({ version: 1, symbols: [symbol] }),
    })));
    assert.deepEqual(writes.map((response) => response.status).sort(), [200, 409]);
  });
});

test("storage rejects an unconditional write so first-create races cannot lose data", async () => {
  const fakeFetch: typeof fetch = async () => { throw new Error("unexpected upstream"); };
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/api/browser/v1/storage/market-watchlist.json`, {
      method: "PUT", headers: headers(), body: JSON.stringify({ version: 1, symbols: ["AAPL"] }),
    });
    assert.equal(response.status, 428);
  });
});

test("broker bounds chunked upstream responses before buffering them", async () => {
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "too-large" } });
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/api/browser/v1/mcp`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(response.status, 502);
  });
});

test("broker bounds chunked quote responses before parsing them", async () => {
  const fakeFetch: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(512 * 1024 + 1));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/api/browser/v1/quotes/AAPL?scope=day`, { headers: headers() });
    assert.equal(response.status, 502);
  });
});

test("broker rejects excess concurrent quote work", async () => {
  let started = 0;
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const fakeFetch: typeof fetch = async (input) => {
    if (!String(input).includes("/v8/finance/chart/")) throw new Error("unexpected upstream");
    started += 1;
    await gate;
    return new Response(JSON.stringify({ chart: { result: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await withServer(fakeFetch, async (base) => {
    const responsesPromise = Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/api/browser/v1/quotes/AAPL?scope=day`, { headers: headers() })));
    while (started < 4) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
    unblock();
    const responses = await responsesPromise;
    assert.equal(started, 4);
    assert.deepEqual(responses.map((response) => response.status).sort(), [429, 502, 502, 502, 502]);
  });
});

test("quote and crypto providers are server-side browser transports", async () => {
	const providerCalls: string[] = [];
	const timestamp = Math.floor(Date.now() / 1_000);
	const fakeFetch: typeof fetch = async (input) => {
		const url = String(input);
		providerCalls.push(url);
		if (url.includes("/v8/finance/chart/")) {
			return new Response(JSON.stringify({ chart: { result: [{
				meta: {
					symbol: "AAPL", currency: "USD", shortName: "Apple Inc.",
					fullExchangeName: "NasdaqGS", exchangeTimezoneName: "America/New_York",
					dataGranularity: "1d", regularMarketPrice: 101, regularMarketVolume: 1_000,
					regularMarketTime: timestamp, chartPreviousClose: 100,
				},
				timestamp: [timestamp - 86_400, timestamp],
				indicators: { quote: [{ close: [100, 101], volume: [900, 1_000] }] },
			}] } }), { status: 200, headers: { "content-type": "application/json" } });
		}
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	};

	await withServer(fakeFetch, async (base) => {
		const quote = await fetch(`${base}/api/browser/v1/quotes/AAPL?scope=day`, { headers: headers() });
		assert.equal(quote.status, 200);
		assert.equal((await quote.json()).symbol, "AAPL");
		const pulse = await fetch(`${base}/api/browser/v1/crypto/pulse`, { headers: headers() });
		assert.equal(pulse.status, 200);
		const pulseBody = await pulse.json() as { version: number; snapshot: unknown; errors: string[] };
		assert.equal(pulseBody.version, 1);
		assert.ok(pulseBody.snapshot);
		assert.ok(Array.isArray(pulseBody.errors));
		assert.ok(providerCalls.some((url) => url.includes("coinmarketcap.com")));
	});
});

function yahooChartFixture(symbol: string): unknown {
	const timestamp = Math.floor(Date.now() / 1_000);
	return { chart: { result: [{
		meta: {
			symbol, currency: "USD", shortName: `${symbol} Inc.`,
			fullExchangeName: "NasdaqGS", exchangeTimezoneName: "America/New_York",
			dataGranularity: "5m", regularMarketPrice: 101, regularMarketVolume: 1_000,
			regularMarketTime: timestamp, chartPreviousClose: 100,
		},
		timestamp: [timestamp - 86_400, timestamp],
		indicators: { quote: [{ close: [100, 101], volume: [900, 1_000] }] },
	}] } };
}

test("quote batch serves the whole universe for one lane slot", async () => {
	const fetchedSymbols: string[] = [];
	const fakeFetch: typeof fetch = async (input) => {
		const url = String(input);
		const match = /\/v8\/finance\/chart\/([^?]+)/.exec(url);
		if (match) {
			fetchedSymbols.push(decodeURIComponent(match[1]!));
			return new Response(JSON.stringify(yahooChartFixture(decodeURIComponent(match[1]!))), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error(`unexpected upstream ${url}`);
	};

	await withServer(fakeFetch, async (base) => {
		const batch = await fetch(`${base}/api/browser/v1/quotes/batch?scope=day&symbols=AAPL,MSFT,NVDA`, { headers: headers() });
		assert.equal(batch.status, 200);
		const body = await batch.json() as { version: number; chartScope: string; requested: number; quotes: Array<{ symbol: string }> };
		assert.equal(body.version, 1);
		assert.equal(body.chartScope, "day");
		assert.equal(body.requested, 3);
		assert.deepEqual(body.quotes.map((quote) => quote.symbol).sort(), ["AAPL", "MSFT", "NVDA"]);
		assert.deepEqual([...fetchedSymbols].sort(), ["AAPL", "MSFT", "NVDA"]);

		// The whole universe cost a single lane request, so 59 per-symbol
		// refreshes still fit the same minute window and the 60th is rejected.
		for (let index = 0; index < 59; index += 1) {
			const single = await fetch(`${base}/api/browser/v1/quotes/AAPL?scope=day`, { headers: headers() });
			assert.equal(single.status, 200);
		}
		const overflow = await fetch(`${base}/api/browser/v1/quotes/AAPL?scope=day`, { headers: headers() });
		assert.equal(overflow.status, 429);
	});
});

test("quote batch coalesces identical concurrent requests and caches within the TTL", async () => {
	let clock = 1_000_000;
	let yahooCalls = 0;
	const fakeFetch: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes("/v8/finance/chart/")) {
			yahooCalls += 1;
			return new Response(JSON.stringify(yahooChartFixture("AAPL")), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error(`unexpected upstream ${url}`);
	};

	await withServer(fakeFetch, async (base) => {
		const first = fetch(`${base}/api/browser/v1/quotes/batch?scope=week&symbols=AAPL,MSFT`, { headers: headers() });
		const second = fetch(`${base}/api/browser/v1/quotes/batch?scope=week&symbols=AAPL,MSFT`, { headers: headers() });
		const [firstBody, secondBody] = await Promise.all([first, second]);
		assert.equal(firstBody.status, 200);
		assert.equal(secondBody.status, 200);
		assert.equal(yahooCalls, 2, "two symbols fetched once each, not once per concurrent request");

		clock += 5_000;
		const cacheHit = await fetch(`${base}/api/browser/v1/quotes/batch?scope=week&symbols=AAPL,MSFT`, { headers: headers() });
		assert.equal(cacheHit.status, 200);
		assert.equal(yahooCalls, 2, "a fresh cache entry serves without upstream calls");

		clock += 25_000;
		const afterTtl = await fetch(`${base}/api/browser/v1/quotes/batch?scope=week&symbols=AAPL,MSFT`, { headers: headers() });
		assert.equal(afterTtl.status, 200);
		assert.ok(yahooCalls > 2, "an expired cache entry refetches the universe");
	}, () => clock);
});

test("quote batch validates scope, symbols, and universe size", async () => {
	const fakeFetch: typeof fetch = async () => { throw new Error("unexpected upstream"); };
	await withServer(fakeFetch, async (base) => {
		const badScope = await fetch(`${base}/api/browser/v1/quotes/batch?scope=decade&symbols=AAPL`, { headers: headers() });
		assert.equal(badScope.status, 400);
		const noSymbols = await fetch(`${base}/api/browser/v1/quotes/batch?scope=day`, { headers: headers() });
		assert.equal(noSymbols.status, 400);
		const garbage = await fetch(`${base}/api/browser/v1/quotes/batch?scope=day&symbols=,,`, { headers: headers() });
		assert.equal(garbage.status, 400);
		const tooMany = await fetch(`${base}/api/browser/v1/quotes/batch?scope=day&symbols=${Array.from({ length: 201 }, (_unused, index) => `S${index}`).join(",")}`, { headers: headers() });
		assert.equal(tooMany.status, 400);
	});
});

test("a degraded quote batch is returned but not cached", async () => {
	let clock = 2_000_000;
	let yahooCalls = 0;
	const fakeFetch: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes("/v8/finance/chart/AAPL")) {
			yahooCalls += 1;
			return new Response(JSON.stringify(yahooChartFixture("AAPL")), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (url.includes("/v8/finance/chart/")) {
			yahooCalls += 1;
			return new Response(JSON.stringify({ chart: { result: [] } }), { status: 200, headers: { "content-type": "application/json" } });
		}
		throw new Error(`unexpected upstream ${url}`);
	};

	await withServer(fakeFetch, async (base) => {
		const degraded = await fetch(`${base}/api/browser/v1/quotes/batch?scope=day&symbols=AAPL,MSFT,NVDA`, { headers: headers() });
		assert.equal(degraded.status, 200);
		const body = await degraded.json() as { requested: number; quotes: unknown[] };
		assert.equal(body.requested, 3);
		assert.equal(body.quotes.length, 1, "failed symbols are omitted, not failed wholesale");

		clock += 25_000;
		await fetch(`${base}/api/browser/v1/quotes/batch?scope=day&symbols=AAPL,MSFT,NVDA`, { headers: headers() });
		assert.equal(yahooCalls, 6, "a below-half universe is not cached; the next window refetches everything");
	}, () => clock);
});
