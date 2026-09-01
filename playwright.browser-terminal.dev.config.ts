import { defineConfig, devices } from "@playwright/test";

/** Development-mode StrictMode replay and same-document lifecycle coverage. */
export default defineConfig({
	testDir: "./tests/e2e",
	testMatch: "**/browser-terminal.authenticated.spec.ts",
	timeout: 30_000,
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL: "http://127.0.0.1:45174/",
		headless: true,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "NODE_ENV=test npx tsx tests/e2e/browser-terminal-server.ts --vite",
		url: "http://127.0.0.1:45174/",
		timeout: 120_000,
		reuseExistingServer: false,
	},
});
