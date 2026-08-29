import { defineConfig, devices } from "@playwright/test";

/**
 * Production-build smoke coverage for the personal browser session.
 *
 * The browser session has a real dedicated Worker and IndexedDB boundary, so
 * this intentionally runs against `vite preview` rather than the dev server.
 * The model and MCP requests are intercepted by the spec; no credentials or
 * external network are used.
 */
export default defineConfig({
	testDir: "./tests/e2e",
	testMatch: "**/*.spec.ts",
	timeout: 90_000,
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: "http://127.0.0.1:45173",
		trace: "retain-on-failure",
		headless: true,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "VITE_SESSION_MODE=browser VITE_OPENROUTER_MODEL=conformance VITE_UNBROWSER_MCP_URL=http://browser-e2e.invalid/mcp npm run build && npx vite preview --config vite.config.ts --host 127.0.0.1 --port 45173 --strictPort",
		url: "http://127.0.0.1:45173",
		timeout: 120_000,
		reuseExistingServer: false,
	},
});
