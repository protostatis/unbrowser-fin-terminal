import assert from "node:assert/strict";
import test from "node:test";
import { fetchQuotes } from "../.pi/extensions/market-terminal.js";

test("a stalled quote universe shares one refresh deadline", async () => {
  const originalFetch = globalThis.fetch;
  const requestSignals: AbortSignal[] = [];
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("quote request did not receive an abort signal"));
      return;
    }
    requestSignals.push(signal);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) as typeof fetch;

  try {
    const startedAt = performance.now();
    const quotes = await fetchQuotes(
      Array.from({ length: 24 }, (_unused, index) => `SYM${index}`),
      undefined,
      undefined,
      150,
    );
    const elapsedMs = performance.now() - startedAt;

    assert.deepEqual(quotes, []);
    assert.equal(requestSignals.length, 8, "only the concurrent first wave should begin");
    assert.ok(elapsedMs < 350, `refresh exceeded its shared deadline: ${elapsedMs.toFixed(1)}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
