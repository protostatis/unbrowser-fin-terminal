import { readFile } from "node:fs/promises";
import path from "node:path";
import { createBrowserTerminalApp } from "./browser-terminal.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const WEB_DIST = path.resolve(process.env.MARKET_ROOT?.trim() || process.cwd(), "dist-web");
const PUBLIC_BASE_PATH = process.env.PUBLIC_BASE_PATH?.trim() || "/fin-terminal-browser/";

function validateBasePath(value: string): string {
	if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(value)) {
		throw new Error("PUBLIC_BASE_PATH must start and end with / and contain URL-safe path segments");
	}
	return value;
}

function requiredSecret(value: string | undefined, name: string): string {
	const secret = value?.trim() || "";
	if (!secret) throw new Error(`${name} is required for the authenticated browser terminal`);
	if (secret.includes("\0") || /[\r\n]/.test(secret)) throw new Error(`${name} must contain one secret value`);
	return secret;
}

async function readOpenRouterKey(): Promise<string> {
	const direct = process.env.OPENROUTER_API_KEY?.trim();
	const file = process.env.OPENROUTER_API_KEY_FILE?.trim();
	if (direct && file) throw new Error("Set only one of OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE");
	if (file) {
		if (!path.isAbsolute(file)) throw new Error("OPENROUTER_API_KEY_FILE must be an absolute path");
		return requiredSecret(await readFile(file, "utf8"), "OPENROUTER_API_KEY_FILE");
	}
	if (!direct && process.env.NODE_ENV !== "production") return "";
	return requiredSecret(direct, "OPENROUTER_API_KEY");
}

function validateMcpEndpoint(raw: string | undefined): string {
	if (!raw?.trim() && process.env.NODE_ENV !== "production") return "";
	const value = requiredSecret(raw, "UNBROWSER_MCP_URL");
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("UNBROWSER_MCP_URL must be an absolute HTTP(S) URL");
	}
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.hash) {
		throw new Error("UNBROWSER_MCP_URL must be an HTTP(S) URL without credentials or a fragment");
	}
	return parsed.href;
}

function validateOutputTokenConfig(): void {
	const raw = process.env.MARKET_MAX_OUTPUT_TOKENS?.trim();
	if (!raw) return;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 256 || value > 16_384) {
		throw new Error("MARKET_MAX_OUTPUT_TOKENS must be an integer from 256 to 16384");
	}
}

async function verifyBrowserBuild(webDist: string, expectedBasePath: string): Promise<void> {
	const indexPath = path.join(webDist, "index.html");
	const html = await readFile(indexPath, "utf8");
	if (!/<meta\s+name="x-build-mode"\s+content="browser"/i.test(html)) {
		throw new Error("Built frontend is not the authenticated browser terminal build");
	}
	const escapedBasePath = expectedBasePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (!new RegExp(`<meta\\s+name="x-build-base-path"\\s+content="${escapedBasePath}"`, "i").test(html)) {
		throw new Error("Built frontend PUBLIC_BASE_PATH does not match the authenticated browser terminal runtime");
	}
}

async function main(): Promise<void> {
	if (process.env.NODE_ENV === "production") {
		validateBasePath(PUBLIC_BASE_PATH);
		if (process.env.TERMINAL_RUNTIME_MODE?.trim() !== "browser") {
			throw new Error("TERMINAL_RUNTIME_MODE=browser is required for the authenticated browser terminal");
		}
		if (!process.env.MARKET_PROXY_TOKEN?.trim()) throw new Error("MARKET_PROXY_TOKEN is required in production");
		validateOutputTokenConfig();
		await verifyBrowserBuild(WEB_DIST, PUBLIC_BASE_PATH);
	}
	const app = createBrowserTerminalApp({
		openRouterApiKey: await readOpenRouterKey(),
		mcpEndpoint: validateMcpEndpoint(process.env.UNBROWSER_MCP_URL),
		webDist: WEB_DIST,
	});
	app.listen(PORT, HOST, () => console.log(`[browser-terminal] Listening on http://${HOST}:${PORT}`));
}

void main().catch((error: unknown) => {
	console.error("[browser-terminal] failed to start:", error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
