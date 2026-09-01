import { test, expect, type Page } from "@playwright/test";

const SESSION_PATH = "/api/browser/v1/session";

async function expectConnected(page: Page): Promise<void> {
	await expect(page.locator(".browser-alpha-shell")).toBeVisible();
	await expect(page.locator(".browser-alpha-connect")).toHaveCount(0);
}

async function browserTerminalControl(page: Page, action: "unmount" | "remount"): Promise<void> {
	await page.evaluate((requestedAction) => {
		type TestWindow = Window & {
			__browserTerminalTest?: { unmount: () => void; remount: () => void };
		};
		const controls = (window as TestWindow).__browserTerminalTest;
		if (!controls) throw new Error("browser terminal test controls are unavailable");
		controls[requestedAction]();
	}, action);
}

test("authenticated mode auto-starts once through the real broker and removes session controls", async ({ page }) => {
	let sessionRequests = 0;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === SESSION_PATH) sessionRequests += 1;
	});

	await page.goto("");

	await expectConnected(page);
	await expect.poll(() => sessionRequests).toBe(1);
	await expect(page.getByRole("button", { name: "Disconnect session" })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Connect your OpenRouter key" })).toHaveCount(0);
});

test("authenticated startup exposes a retry after a broker failure", async ({ page }) => {
	let first = true;
	await page.route(`**${SESSION_PATH}`, async (route) => {
		if (first) {
			first = false;
			await route.fulfill({
				status: 503,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ error: "starting" }),
			});
			return;
		}
		await route.continue();
	});

	await page.goto("");
	await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
	await page.getByRole("button", { name: "Retry" }).click();
	await expectConnected(page);
});

test("same-document unmount/remount releases startup and StrictMode does not duplicate it", async ({ page }) => {
	let sessionRequests = 0;
	let releaseFirstSession: (() => void) | undefined;
	let first = true;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === SESSION_PATH) sessionRequests += 1;
	});
	await page.route(`**${SESSION_PATH}`, async (route) => {
		if (first) {
			first = false;
			await new Promise<void>((resolve) => { releaseFirstSession = resolve; });
			try {
				await route.continue();
			} catch {
				// The component should abort this request when it is unmounted.
			}
			return;
		}
		await route.continue();
	});

	await page.goto("");
	await expect.poll(() => sessionRequests).toBe(1);
	await browserTerminalControl(page, "unmount");
	await expect(page.locator(".browser-alpha-shell")).toHaveCount(0);
	await browserTerminalControl(page, "remount");
	releaseFirstSession?.();
	await expectConnected(page);
	await expect.poll(() => sessionRequests).toBe(2);
});
