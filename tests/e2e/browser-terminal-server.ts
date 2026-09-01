import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { createBrowserTerminalApp } from "../../server/browser-terminal.js";

const PROXY_PORT = Number(process.env.BROWSER_TERMINAL_E2E_PORT ?? 45174);
const BACKEND_PORT = Number(process.env.BROWSER_TERMINAL_E2E_BACKEND_PORT ?? 45175);
const VITE_PORT = Number(process.env.BROWSER_TERMINAL_E2E_VITE_PORT ?? 45176);
const PROXY_TOKEN = "browser-terminal-e2e-proxy-token";
const PRINCIPAL = "account:e2e-approved";
const USE_VITE = process.argv.includes("--vite");

function listen(server: http.Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function upstreamRequest(
	req: IncomingMessage,
	res: ServerResponse,
	port: number,
	injectPrincipal: boolean,
): void {
	const headers = { ...req.headers };
	delete headers["x-fin-terminal-user"];
	delete headers["x-fin-terminal-proxy-token"];
	delete headers["x-forwarded-host"];
	delete headers["x-forwarded-proto"];
	if (injectPrincipal) {
		headers.host = `127.0.0.1:${PROXY_PORT}`;
		headers["x-fin-terminal-user"] = PRINCIPAL;
		headers["x-fin-terminal-proxy-token"] = PROXY_TOKEN;
		headers["x-forwarded-host"] = `127.0.0.1:${PROXY_PORT}`;
		headers["x-forwarded-proto"] = "http";
	}
	const upstream = http.request({
		host: "127.0.0.1",
		port,
		method: req.method,
		path: req.url,
		headers,
	}, (response) => {
		res.writeHead(response.statusCode ?? 502, response.headers);
		response.pipe(res);
	});
	upstream.on("error", () => {
		if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
		res.end("upstream unavailable");
	});
	req.on("aborted", () => upstream.destroy());
	req.pipe(upstream);
}

async function main(): Promise<void> {
	const storageRoot = await mkdtemp(path.join(os.tmpdir(), "browser-terminal-e2e-"));
	const webDist = path.resolve("dist-web");
	const upstreamFetch: typeof fetch = async (input, init) => {
		const url = String(input);
		// Keep the browser lifecycle test deterministic while still exercising the
		// real broker routes and its upstream response handling.
		if (url.startsWith("https://query1.finance.yahoo.com/")) {
			return new Response(JSON.stringify({ chart: { result: [] } }), { status: 200 });
		}
		if (url.startsWith("https://pro-api.coinmarketcap.com/") || url.startsWith("https://panicradar.ai/")) {
			return new Response("{}", { status: 200 });
		}
		if (url === "https://openrouter.ai/api/v1/chat/completions") {
			return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error(`unexpected E2E upstream ${url} ${init?.method ?? "GET"}`);
	};
	const app = createBrowserTerminalApp({
		fetchImpl: upstreamFetch,
		openRouterApiKey: "browser-terminal-e2e-key",
		openRouterModel: "browser-terminal/e2e",
		storageRoot,
		webDist,
		proxyToken: PROXY_TOKEN,
		providerBudget: {
			principalDailyResearchRequests: 10,
			principalDailyImportRequests: 2,
			globalDailyBudgetUsd: 5,
		},
	});
	const backend = app.listen(BACKEND_PORT, "127.0.0.1");
	await new Promise<void>((resolve, reject) => {
		backend.once("listening", resolve);
		backend.once("error", reject);
	});

	let vite: { close: () => Promise<void> } | undefined;
	if (USE_VITE) {
		process.env.PUBLIC_BASE_PATH = "/";
		process.env.VITE_TERMINAL_BUILD_MODE = "browser";
		process.env.VITE_BROWSER_TERMINAL_TEST_HARNESS = "1";
		const { createServer } = await import("vite");
		const devServer = await createServer({
			configFile: path.resolve("vite.config.ts"),
			server: { host: "127.0.0.1", port: VITE_PORT, strictPort: true },
		});
		await devServer.listen();
		vite = devServer;
	}

	const proxy = http.createServer((req, res) => {
		const isApi = req.url?.startsWith("/api/") || false;
		if (USE_VITE && !isApi) {
			upstreamRequest(req, res, VITE_PORT, false);
		} else {
			upstreamRequest(req, res, BACKEND_PORT, true);
		}
	});
	await listen(proxy, PROXY_PORT);

	const shutdown = async () => {
		proxy.close();
		await vite?.close();
		await new Promise<void>((resolve) => backend.close(() => resolve()));
		await rm(storageRoot, { recursive: true, force: true });
	};
	process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
	process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
