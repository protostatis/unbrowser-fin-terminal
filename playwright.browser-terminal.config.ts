import { defineConfig, devices } from "@playwright/test";

/** Authenticated browser-terminal startup and lifecycle coverage. */
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
		command: "PUBLIC_BASE_PATH=/ VITE_TERMINAL_BUILD_MODE=browser VITE_BROWSER_TERMINAL_TEST_HARNESS=1 npm run build:browser-terminal && npx tsx tests/e2e/browser-terminal-server.ts",
		url: "http://127.0.0.1:45174/",
		timeout: 120_000,
		reuseExistingServer: false,
	},
});
