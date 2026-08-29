import assert from "node:assert/strict";
import test from "node:test";
import {
  extractWatchlistFromScreenshot,
  WatchlistScreenshotImportError,
  WatchlistScreenshotImportLimiter,
  WATCHLIST_SCREENSHOT_MAX_CANDIDATES,
  parseWatchlistScreenshotResponse,
  screenshotImageMimeType,
} from "../server/watchlist-screenshot-import.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("screenshot responses map crypto base tickers to Yahoo USD pairs", () => {
  const result = parseWatchlistScreenshotResponse(JSON.stringify({
    instruments: [
      { symbol: "BTC", name: "Bitcoin", assetType: "crypto", confidence: 0.99 },
      { symbol: "ETH", yahooSymbol: "ETH-USD", name: "Ethereum", assetType: "cryptocurrency" },
      { symbol: "AAPL", name: "Apple", assetType: "stock" },
    ],
  }));

  assert.deepEqual(result.candidates, [
    {
      symbol: "BTC-USD",
      rawSymbol: "BTC",
      name: "Bitcoin",
      assetType: "crypto",
      confidence: 0.99,
    },
    {
      symbol: "ETH-USD",
      rawSymbol: "ETH",
      name: "Ethereum",
      assetType: "crypto",
    },
    {
      symbol: "AAPL",
      rawSymbol: "AAPL",
      name: "Apple",
      assetType: "stock",
    },
  ]);
});

test("screenshot responses exclude malformed and duplicate symbols", () => {
  const result = parseWatchlistScreenshotResponse(JSON.stringify({
    instruments: [
      { symbol: "BTC", assetType: "crypto" },
      { symbol: "BTC-USD", assetType: "crypto" },
      { symbol: "not a symbol", assetType: "stock" },
      { name: "missing ticker", assetType: "stock" },
    ],
  }));

  assert.deepEqual(result.candidates.map((candidate) => candidate.symbol), ["BTC-USD"]);
  assert.equal(result.rejected, 3);
});

test("screenshot output is capped to the interactive watchlist capacity", () => {
  const result = parseWatchlistScreenshotResponse(JSON.stringify({
    instruments: Array.from(
      { length: WATCHLIST_SCREENSHOT_MAX_CANDIDATES + 1 },
      (_unused, index) => ({ symbol: `SYM${index}`, assetType: "stock" }),
    ),
  }));

  assert.equal(result.candidates.length, WATCHLIST_SCREENSHOT_MAX_CANDIDATES);
});

test("the vision request caps generation before parsing an oversized provider result", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const content = JSON.stringify({
      instruments: Array.from(
        { length: WATCHLIST_SCREENSHOT_MAX_CANDIDATES + 1 },
        (_unused, index) => ({ symbol: `SYM${index}`, assetType: "stock" }),
      ),
    });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await extractWatchlistFromScreenshot(PNG_BYTES, {
      WATCHLIST_IMPORT_MODEL: "test-model",
      WATCHLIST_IMPORT_API_KEY: "test-key",
    });
    const messages = requestBody?.messages as Array<{ role?: unknown; content?: unknown }> | undefined;
    const systemPrompt = messages?.find((message) => message.role === "system")?.content;

    assert.equal(result.candidates.length, WATCHLIST_SCREENSHOT_MAX_CANDIDATES);
    assert.equal(requestBody?.max_tokens, 4_096);
    assert.match(String(systemPrompt), new RegExp(`no more than ${WATCHLIST_SCREENSHOT_MAX_CANDIDATES} instruments`, "i"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image type detection uses bytes rather than an untrusted request header", () => {
  assert.equal(screenshotImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(screenshotImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(screenshotImageMimeType(Buffer.from("RIFFxxxxWEBP", "ascii")), "image/webp");
  assert.equal(screenshotImageMimeType(Buffer.from("not an image")), undefined);
});

test("the vision request limiter resets after its fixed window", () => {
  const limiter = new WatchlistScreenshotImportLimiter(2, 1_000);
  assert.deepEqual(limiter.consume("account:a", 100), { allowed: true });
  assert.deepEqual(limiter.consume("account:a", 200), { allowed: true });
  assert.deepEqual(limiter.consume("account:a", 300), { allowed: false, retryAfterMs: 800 });
  assert.deepEqual(limiter.consume("account:a", 1_100), { allowed: true });
});

test("custom vision endpoints must use HTTPS", async () => {
  await assert.rejects(
    extractWatchlistFromScreenshot(PNG_BYTES, {
      WATCHLIST_IMPORT_MODEL: "test-model",
      WATCHLIST_IMPORT_API_KEY: "test-key",
      WATCHLIST_IMPORT_URL: "http://vision.example.test/v1/chat/completions",
    }),
    (error: unknown) => error instanceof WatchlistScreenshotImportError
      && error.status === 503
      && /HTTPS/.test(error.message),
  );
});

test("a custom vision endpoint cannot receive the shared OpenRouter key", async () => {
  await assert.rejects(
    extractWatchlistFromScreenshot(PNG_BYTES, {
      WATCHLIST_IMPORT_MODEL: "test-model",
      OPENROUTER_API_KEY: "shared-openrouter-key",
      WATCHLIST_IMPORT_URL: "https://vision.example.test/v1/chat/completions",
    }),
    (error: unknown) => error instanceof WatchlistScreenshotImportError
      && error.status === 503
      && /requires WATCHLIST_IMPORT_API_KEY/.test(error.message),
  );
});
