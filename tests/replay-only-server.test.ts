/**
 * Integration tests for the replay-only server.
 *
 * These tests use isolated temporary MARKET_ROOT directories so they do not
 * depend on or inherit any runtime-critical environment variables from the
 * actual working tree. Each test case starts and stops a real HTTP server
 * on an ephemeral port.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { randomInt } from "node:crypto";
import { createConnection } from "node:net";
import test from "node:test";

const PROXY_TOKEN_HEADER = "x-fin-terminal-proxy-token";
const PROXY_TOKEN = "replay-test-token";

// =========================================================================
// Helpers
// =========================================================================

function uniquePort(): number {
  // Random port in the unprivileged range (1024–65535).
  return randomInt(1024, 65536);
}

// The first forked tsx process can cold-start the full server dependency graph
// on constrained CI runners; keep the readiness deadline above that startup
// cost without changing the server's own behavior.
function waitForServer(port: number, host: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tryConnect() {
      const sock = createConnection({ port, host });
      sock.on("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server did not start on ${host}:${port} within ${timeoutMs}ms`));
        } else {
          setTimeout(tryConnect, 50);
        }
      });
    }
    tryConnect();
  });
}

async function fetchJson(url: string): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const text = await resp.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: resp.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(
  url: string,
  withProxyToken = false,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: withProxyToken ? { [PROXY_TOKEN_HEADER]: PROXY_TOKEN } : undefined,
    });
    return { status: resp.status, body: await resp.text() };
  } finally {
    clearTimeout(timeout);
  }
}

function upgradeStatus(port: number, withProxyToken = false): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for replay WebSocket-upgrade response"));
    }, 5_000);
    let response = "";

    socket.on("connect", () => {
      socket.write(
        "GET /ws HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          (withProxyToken ? `${PROXY_TOKEN_HEADER}: ${PROXY_TOKEN}\r\n` : "") +
          "\r\n",
      );
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString();
      const match = /^HTTP\/1\.1\s+(\d{3})/i.exec(response);
      if (!match) return;
      clearTimeout(timeout);
      socket.destroy();
      resolve(Number(match[1]));
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

// =========================================================================
// Tests
// =========================================================================

test("replay server starts and serves /api/health", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "replay-test-"));
  const distWeb = path.join(root, "dist-web");
  mkdirSync(distWeb, { recursive: true });
  writeFileSync(path.join(distWeb, "index.html"), `<!doctype html>
<html><head><meta name="x-build-mode" content="replay"></head><body>replay test</body></html>`);

  const port = uniquePort();
  const { fork } = await import("node:child_process");
  const serverEntry = path.resolve(import.meta.dirname!, "..", "server", "index.ts");

  const child = fork(serverEntry, [], {
    env: {
      ...process.env,
      PUBLIC_DEMO: "1",
      PORT: String(port),
      HOST: "127.0.0.1",
      MARKET_ROOT: root,
      NODE_ENV: "development",
      // Clear any live-mode env vars that could cause side effects
      OPENROUTER_API_KEY: "",
      OPENROUTER_API_KEY_FILE: "",
      UNBROWSER_MCP_URL: "",
      MARKET_PROXY_TOKEN: "replay-test-token",
      ALLOWED_ORIGINS: "",
      MARKET_MODEL_PROVIDER: "",
      MARKET_MODEL_ID: "",
      OPENROUTER_MODEL: "",
    },
    execArgv: ["--import", "tsx"],
    stdio: "pipe",
    silent: true,
  });

  try {
    await waitForServer(port, "127.0.0.1");

    // Health endpoint
    const health = await fetchJson(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");
    assert.ok(typeof health.body.uptime === "number");

    // Ready endpoint
    const ready = await fetchJson(`http://127.0.0.1:${port}/api/ready`);
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, "ready");
    assert.equal(ready.body.replay, true);

    // Index page
    const index = await fetchText(`http://127.0.0.1:${port}/`, true);
    assert.equal(index.status, 200);
    assert.ok(index.body.includes("replay test"));
  } finally {
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay server rejects /ws upgrade with 403", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "replay-test-"));
  const distWeb = path.join(root, "dist-web");
  mkdirSync(distWeb, { recursive: true });
  writeFileSync(path.join(distWeb, "index.html"), `<!doctype html>
<html><head><meta name="x-build-mode" content="replay"></head><body>test</body></html>`);

  const port = uniquePort();
  const { fork } = await import("node:child_process");

  const child = fork(
    path.resolve(import.meta.dirname!, "..", "server", "index.ts"),
    [],
    {
      env: {
        ...process.env,
        PUBLIC_DEMO: "1",
        PORT: String(port),
        HOST: "127.0.0.1",
        MARKET_ROOT: root,
        NODE_ENV: "development",
        OPENROUTER_API_KEY: "",
        OPENROUTER_API_KEY_FILE: "",
        UNBROWSER_MCP_URL: "",
        MARKET_PROXY_TOKEN: "replay-test-token",
        ALLOWED_ORIGINS: "",
        MARKET_MODEL_PROVIDER: "",
        MARKET_MODEL_ID: "",
        OPENROUTER_MODEL: "",
      },
      execArgv: ["--import", "tsx"],
      stdio: "pipe",
      silent: true,
    },
  );

  try {
    await waitForServer(port, "127.0.0.1");

    // Normal HTTP requests to the route get the same deterministic refusal.
    const wsResp = await fetchText(`http://127.0.0.1:${port}/ws`, true);
    assert.equal(wsResp.status, 403);
    assert.ok(wsResp.body.includes("WebSocket not available in replay mode"));

    // A real HTTP Upgrade bypasses Express routing; it must also be refused
    // and must never produce the successful WebSocket 101 response.
    assert.equal(await upgradeStatus(port, true), 403);
  } finally {
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay production fails if dist-web/index.html is missing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "replay-test-"));
  // Intentionally do NOT create dist-web

  const port = uniquePort();
  const { fork } = await import("node:child_process");

  const child = fork(
    path.resolve(import.meta.dirname!, "..", "server", "index.ts"),
    [],
    {
      env: {
        ...process.env,
        PUBLIC_DEMO: "1",
        PORT: String(port),
        HOST: "127.0.0.1",
        MARKET_ROOT: root,
        NODE_ENV: "production",
        OPENROUTER_API_KEY: "",
        OPENROUTER_API_KEY_FILE: "",
        UNBROWSER_MCP_URL: "",
        MARKET_PROXY_TOKEN: "replay-test-token",
        ALLOWED_ORIGINS: "",
        MARKET_MODEL_PROVIDER: "",
        MARKET_MODEL_ID: "",
        OPENROUTER_MODEL: "",
      },
      execArgv: ["--import", "tsx"],
      stdio: "pipe",
      silent: true,
    },
  );

  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));

  await new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      assert.notEqual(code, 0, "Expected non-zero exit code");
      const stderr = stderrChunks.join("");
      assert.ok(
        stderr.includes("dist-web/index.html") || stderr.includes("replay"),
        `Expected error about dist-web/index.html, got stderr: ${stderr}`,
      );
      resolve();
    });
  });

  rmSync(root, { recursive: true, force: true });
});

test("replay production fails if manifest mode mismatches", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "replay-test-"));
  const distWeb = path.join(root, "dist-web");
  mkdirSync(distWeb, { recursive: true });
  writeFileSync(path.join(distWeb, "index.html"), `<!doctype html>
<html><head><meta name="x-build-mode" content="live"></head><body>wrong mode</body></html>`);

  const port = uniquePort();
  const { fork } = await import("node:child_process");

  const child = fork(
    path.resolve(import.meta.dirname!, "..", "server", "index.ts"),
    [],
    {
      env: {
        ...process.env,
        PUBLIC_DEMO: "1",
        PORT: String(port),
        HOST: "127.0.0.1",
        MARKET_ROOT: root,
        NODE_ENV: "production",
        OPENROUTER_API_KEY: "",
        OPENROUTER_API_KEY_FILE: "",
        UNBROWSER_MCP_URL: "",
        MARKET_PROXY_TOKEN: "replay-test-token",
        ALLOWED_ORIGINS: "",
        MARKET_MODEL_PROVIDER: "",
        MARKET_MODEL_ID: "",
        OPENROUTER_MODEL: "",
      },
      execArgv: ["--import", "tsx"],
      stdio: "pipe",
      silent: true,
    },
  );

  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));

  await new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      assert.notEqual(code, 0, "Expected non-zero exit code");
      const stderr = stderrChunks.join("");
      assert.ok(
        stderr.includes("Build mode mismatch") || stderr.includes("mismatch"),
        `Expected mismatch error, got stderr: ${stderr}`,
      );
      resolve();
    });
  });

  rmSync(root, { recursive: true, force: true });
});

test("replay production fails if manifest meta tag is missing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "replay-test-"));
  const distWeb = path.join(root, "dist-web");
  mkdirSync(distWeb, { recursive: true });
  writeFileSync(path.join(distWeb, "index.html"), `<!doctype html>
<html><head></head><body>no meta tag</body></html>`);

  const port = uniquePort();
  const { fork } = await import("node:child_process");

  const child = fork(
    path.resolve(import.meta.dirname!, "..", "server", "index.ts"),
    [],
    {
      env: {
        ...process.env,
        PUBLIC_DEMO: "1",
        PORT: String(port),
        HOST: "127.0.0.1",
        MARKET_ROOT: root,
        NODE_ENV: "production",
        OPENROUTER_API_KEY: "",
        OPENROUTER_API_KEY_FILE: "",
        UNBROWSER_MCP_URL: "",
        MARKET_PROXY_TOKEN: "replay-test-token",
        ALLOWED_ORIGINS: "",
        MARKET_MODEL_PROVIDER: "",
        MARKET_MODEL_ID: "",
        OPENROUTER_MODEL: "",
      },
      execArgv: ["--import", "tsx"],
      stdio: "pipe",
      silent: true,
    },
  );

  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));

  await new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      assert.notEqual(code, 0, "Expected non-zero exit code");
      const stderr = stderrChunks.join("");
      assert.ok(
        stderr.includes("missing") || stderr.includes("x-build-mode"),
        `Expected missing meta tag error, got stderr: ${stderr}`,
      );
      resolve();
    });
  });

  rmSync(root, { recursive: true, force: true });
});

test("replay production with matching manifest starts successfully without agent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "replay-test-"));
  const distWeb = path.join(root, "dist-web");
  mkdirSync(distWeb, { recursive: true });
  writeFileSync(path.join(distWeb, "index.html"), `<!doctype html>
<html><head><meta name="x-build-mode" content="replay"></head><body>replay prod test</body></html>`);

  const port = uniquePort();
  const { fork } = await import("node:child_process");

  const child = fork(
    path.resolve(import.meta.dirname!, "..", "server", "index.ts"),
    [],
    {
      env: {
        ...process.env,
        PUBLIC_DEMO: "1",
        PORT: String(port),
        HOST: "127.0.0.1",
        MARKET_ROOT: root,
        NODE_ENV: "production",
        OPENROUTER_API_KEY: "",
        OPENROUTER_API_KEY_FILE: "",
        UNBROWSER_MCP_URL: "",
        MARKET_PROXY_TOKEN: "replay-test-token",
        ALLOWED_ORIGINS: "",
        MARKET_MODEL_PROVIDER: "",
        MARKET_MODEL_ID: "",
        OPENROUTER_MODEL: "",
      },
      execArgv: ["--import", "tsx"],
      stdio: "pipe",
      silent: true,
    },
  );

  try {
    await waitForServer(port, "127.0.0.1");

    // Verify the server is running and serving the ready endpoint
    const ready = await fetchJson(`http://127.0.0.1:${port}/api/ready`);
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, "ready");
    assert.equal(ready.body.replay, true);

    // Verify static files are served
    const index = await fetchText(`http://127.0.0.1:${port}/`, true);
    assert.equal(index.status, 200);
    assert.ok(index.body.includes("replay prod test"));
  } finally {
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});
