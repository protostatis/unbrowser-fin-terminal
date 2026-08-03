import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { startPublicLiveGateway, type PublicLiveGateway } from "../server/public-live-gateway.js";
import { PublicSessionPersistence } from "../server/public-session-persistence.js";

const PUBLIC_ORIGIN = "https://public-terminal.test";
const GENERATION_A = "generation-a-0001";
const GENERATION_B = "generation-b-0002";
const GENERATION_C = "generation-c-0003";
const WORKER_PROXY_TOKEN = "integration-worker-token";

async function listen(server: Server, port = 0): Promise<number> {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startFakeWorker() {
  let healthGeneration = GENERATION_A;
  let socketGeneration = GENERATION_A;
  let principal: string | undefined;
  let healthCheckCount = 0;
  let holdNextHealth = false;
  let heldHealth: { response: ServerResponse; generation: string } | undefined;
  let heldHealthStarted: (() => void) | undefined;
  const clients = new Set<WebSocket>();
  const server = createServer((request, response) => {
    if (request.url === "/api/ready") {
      healthCheckCount += 1;
      const generation = healthGeneration;
      if (holdNextHealth) {
        holdNextHealth = false;
        heldHealth = { response, generation };
        heldHealthStarted?.();
        heldHealthStarted = undefined;
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ready", instanceId: generation }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: ({ req }, done) => {
      const proxyToken = req.headers["x-fin-terminal-proxy-token"];
      const nextPrincipal = req.headers["x-fin-terminal-user"];
      if (
        proxyToken !== WORKER_PROXY_TOKEN
        || typeof nextPrincipal !== "string"
        || (principal !== undefined && principal !== nextPrincipal)
      ) {
        done(false, 403, "Forbidden");
        return;
      }
      principal = nextPrincipal;
      done(true);
    },
  });
  wss.on("headers", (headers) => {
    headers.push(`X-Fin-Terminal-Worker-Generation: ${socketGeneration}`);
  });
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.send(JSON.stringify({
      type: "frame",
      rows: ["PUBLIC WORKER READY"],
      width: 120,
      rows_count: 1,
      state: { mode: "market" },
    }));
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    setHealthGeneration(value: string) {
      healthGeneration = value;
    },
    setSocketGeneration(value: string) {
      socketGeneration = value;
    },
    get healthCheckCount() {
      return healthCheckCount;
    },
    holdNextHealthCheck(): Promise<void> {
      holdNextHealth = true;
      return new Promise((resolve) => {
        heldHealthStarted = resolve;
      });
    },
    releaseHeldHealthCheck() {
      if (!heldHealth) throw new Error("no held worker health check");
      heldHealth.response.setHeader("content-type", "application/json");
      heldHealth.response.end(JSON.stringify({ status: "ready", instanceId: heldHealth.generation }));
      heldHealth = undefined;
    },
    get connectionCount() {
      return clients.size;
    },
    sendOversizedMessage() {
      for (const client of clients) client.send("x".repeat(512 * 1_024 + 1));
    },
    async close() {
      if (heldHealth) {
        heldHealth.response.statusCode = 503;
        heldHealth.response.end();
        heldHealth = undefined;
      }
      for (const client of clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

function setGatewayEnvironment(port: number, workerUrl: string): () => void {
  const values: Record<string, string> = {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    MARKET_ROOT: process.cwd(),
    PUBLIC_ALLOWED_ORIGIN: PUBLIC_ORIGIN,
    PUBLIC_REDIS_URL: `memory://gateway-integration-${process.pid}-${port}`,
    PUBLIC_SESSION_SIGNING_KEY: "integration-signing-key-0000000000",
    PUBLIC_EDGE_PROXY_TOKEN: "integration-edge-token-000000000000",
    PUBLIC_WORKER_PROXY_TOKEN: WORKER_PROXY_TOKEN,
    PUBLIC_TURNSTILE_BYPASS: "1",
    PUBLIC_MAX_SESSIONS: "1",
    PUBLIC_MAX_QUEUE: "5",
    PUBLIC_TICKET_TTL_SECONDS: "30",
    PUBLIC_RECONNECT_GRACE_SECONDS: "5",
    PUBLIC_IDLE_TIMEOUT_SECONDS: "60",
    PUBLIC_SESSION_MAX_SECONDS: "120",
    PUBLIC_ADMISSION_ATTEMPTS: "10",
    PUBLIC_ADMISSION_WINDOW_SECONDS: "60",
    PUBLIC_WORKER_ENDPOINTS: `seat-01=${workerUrl}`,
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function startHarness() {
  const worker = await startFakeWorker();
  const gatewayPort = await unusedPort();
  const restoreEnvironment = setGatewayEnvironment(gatewayPort, worker.url);
  let gateway: PublicLiveGateway | undefined;
  try {
    gateway = await startPublicLiveGateway();
  } catch (error) {
    restoreEnvironment();
    await worker.close();
    throw error;
  }
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  return {
    worker,
    baseUrl,
    async close() {
      await gateway?.close();
      restoreEnvironment();
      await worker.close();
    },
  };
}

async function admit(baseUrl: string, expectedStatus = "admitted") {
  const configResponse = await fetch(`${baseUrl}/api/public/config`);
  assert.equal(configResponse.status, 200);
  assert.match(configResponse.headers.get("cache-control") ?? "", /no-store/);
  const config = await configResponse.json() as { visitorToken: string };
  const admissionResponse = await fetch(`${baseUrl}/api/public/admission`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: PUBLIC_ORIGIN,
      "x-public-visitor-token": config.visitorToken,
    },
    body: JSON.stringify({ turnstileToken: "" }),
  });
  assert.equal(admissionResponse.status, 200);
  const admission = await admissionResponse.json() as { ticketToken: string; status: string };
  assert.equal(admission.status, expectedStatus);
  assert.equal("researchRunsRemaining" in admission, false);
  return {
    visitorToken: config.visitorToken,
    ticketToken: admission.ticketToken,
    status: admission.status,
  };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 6_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("condition was not met before timeout");
}

async function rawRequest(baseUrl: string, request: string): Promise<string> {
  const url = new URL(baseUrl);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  await once(socket, "connect");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  socket.end(request);
  await once(socket, "close");
  return Buffer.concat(chunks).toString("utf8");
}

function openBrowser(baseUrl: string, ticketToken: string): {
  socket: WebSocket;
  opened: Promise<void>;
  message: Promise<string>;
} {
  const socket = new WebSocket(
    baseUrl.replace(/^http/, "ws") + "/ws",
    `fin-terminal-session.${ticketToken}`,
    { origin: PUBLIC_ORIGIN },
  );
  const opened = once(socket, "open").then(() => undefined);
  const message = once(socket, "message").then(([data]) => data.toString());
  return { socket, opened, message };
}

async function status(baseUrl: string, visitorToken: string, ticketToken: string) {
  const response = await fetch(`${baseUrl}/api/public/admission/status`, {
    headers: {
      "x-public-visitor-token": visitorToken,
      "x-public-ticket-token": ticketToken,
    },
  });
  return {
    response,
    body: await response.json() as { status?: string; reason?: string; readyWorkers?: number },
  };
}

async function readyWorkers(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl}/api/ready`);
  const body = await response.json() as { readyWorkers: number };
  return body.readyWorkers;
}

test("a stale browser close cannot expire its live replacement", { timeout: 20_000 }, async () => {
  const harness = await startHarness();
  const sockets: WebSocket[] = [];
  try {
    const ticket = await admit(harness.baseUrl);
    const first = openBrowser(harness.baseUrl, ticket.ticketToken);
    sockets.push(first.socket);
    await first.opened;
    assert.match(await first.message, /PUBLIC WORKER READY/);

    const firstClosed = once(first.socket, "close");
    const replacement = openBrowser(harness.baseUrl, ticket.ticketToken);
    sockets.push(replacement.socket);
    await replacement.opened;
    assert.match(await replacement.message, /PUBLIC WORKER READY/);
    const [closeCode] = await firstClosed;
    assert.equal(closeCode, 4001);

    const healthBaseline = harness.worker.healthCheckCount;
    const replacementStartedAt = Date.now();
    await waitUntil(() => (
      harness.worker.healthCheckCount >= healthBaseline + 3
      && Date.now() - replacementStartedAt >= 5_500
    ), 8_000);
    const current = await status(harness.baseUrl, ticket.visitorToken, ticket.ticketToken);
    assert.equal(current.response.status, 200);
    assert.equal(current.body.status, "active");
    assert.equal(replacement.socket.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) socket.terminate();
    await harness.close();
  }
});

test("a worker generation changed after admission is fenced end to end", { timeout: 15_000 }, async () => {
  const harness = await startHarness();
  let browser: WebSocket | undefined;
  try {
    const heldHealthStarted = harness.worker.holdNextHealthCheck();
    await heldHealthStarted;
    const ticket = await admit(harness.baseUrl);
    harness.worker.setSocketGeneration(GENERATION_B);
    const connection = openBrowser(harness.baseUrl, ticket.ticketToken);
    browser = connection.socket;
    const closed = once(browser, "close");
    await connection.opened;
    const [closeCode] = await closed;
    assert.ok(closeCode === 4408 || closeCode === 4410);

    const ended = await status(harness.baseUrl, ticket.visitorToken, ticket.ticketToken);
    assert.equal(ended.body.status, "ended");
    assert.equal(ended.body.reason, "worker-unavailable");

    const nextTicket = await admit(harness.baseUrl, "queued");
    harness.worker.setHealthGeneration(GENERATION_B);
    const heldHealthCount = harness.worker.healthCheckCount;
    harness.worker.releaseHeldHealthCheck();
    await waitUntil(() => harness.worker.healthCheckCount >= heldHealthCount + 1);
    assert.equal(await readyWorkers(harness.baseUrl), 0);
    const stillQueued = await status(
      harness.baseUrl,
      nextTicket.visitorToken,
      nextTicket.ticketToken,
    );
    assert.equal(stillQueued.body.status, "queued");

    harness.worker.setHealthGeneration(GENERATION_C);
    await waitUntil(async () => {
      const next = await status(
        harness.baseUrl,
        nextTicket.visitorToken,
        nextTicket.ticketToken,
      );
      return next.body.status === "admitted";
    });
  } finally {
    browser?.terminate();
    await harness.close();
  }
});

test("malformed Host on a raw upgrade cannot crash the gateway", { timeout: 10_000 }, async () => {
  const harness = await startHarness();
  try {
    const response = await rawRequest(
      harness.baseUrl,
      "GET /ws HTTP/1.1\r\n" +
        "Host: [\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n" +
        `Origin: ${PUBLIC_ORIGIN}\r\n` +
        "Sec-WebSocket-Protocol: fin-terminal-session.invalid\r\n\r\n",
    );
    assert.match(response, /^HTTP\/1\.1 (?:400|401|403)/);
    const health = await fetch(`${harness.baseUrl}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    await harness.close();
  }
});

test("a failed raw upgrade leaves a pristine admitted seat", { timeout: 10_000 }, async () => {
  const harness = await startHarness();
  try {
    const ticket = await admit(harness.baseUrl);
    const response = await rawRequest(
      harness.baseUrl,
      "GET /ws HTTP/1.1\r\n" +
        "Host: terminal.test\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: invalid\r\n" +
        `Origin: ${PUBLIC_ORIGIN}\r\n` +
        `Sec-WebSocket-Protocol: fin-terminal-session.${ticket.ticketToken}\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 400/);
    await waitUntil(async () => {
      const current = await status(harness.baseUrl, ticket.visitorToken, ticket.ticketToken);
      return current.body.status === "admitted";
    });
    assert.equal(harness.worker.connectionCount, 0);
  } finally {
    await harness.close();
  }
});

test("browser message limits persist across replacement reconnects", { timeout: 10_000 }, async () => {
  const harness = await startHarness();
  const sockets: WebSocket[] = [];
  try {
    const ticket = await admit(harness.baseUrl);
    const first = openBrowser(harness.baseUrl, ticket.ticketToken);
    sockets.push(first.socket);
    await first.opened;
    await first.message;
    for (let index = 0; index < 55; index += 1) {
      first.socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const replacement = openBrowser(harness.baseUrl, ticket.ticketToken);
    sockets.push(replacement.socket);
    await replacement.opened;
    await replacement.message;
    const closed = once(replacement.socket, "close");
    for (let index = 0; index < 15; index += 1) {
      replacement.socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    }
    const [closeCode] = await closed;
    assert.equal(closeCode, 4408);
    const ended = await status(harness.baseUrl, ticket.visitorToken, ticket.ticketToken);
    assert.equal(ended.body.reason, "rate-limited");
  } finally {
    for (const socket of sockets) socket.terminate();
    await harness.close();
  }
});

test("oversized worker output is rejected before reaching the browser", { timeout: 10_000 }, async () => {
  const harness = await startHarness();
  let browser: WebSocket | undefined;
  try {
    const ticket = await admit(harness.baseUrl);
    const connection = openBrowser(harness.baseUrl, ticket.ticketToken);
    browser = connection.socket;
    await connection.opened;
    assert.match(await connection.message, /PUBLIC WORKER READY/);

    const closed = once(browser, "close");
    harness.worker.sendOversizedMessage();
    const [closeCode] = await closed;
    assert.equal(closeCode, 4410);
    const ended = await status(harness.baseUrl, ticket.visitorToken, ticket.ticketToken);
    assert.equal(ended.body.status, "ended");
    assert.equal(ended.body.reason, "worker-unavailable");
  } finally {
    browser?.terminate();
    await harness.close();
  }
});

test("startup releases its Redis lease when persisted state is invalid", { timeout: 10_000 }, async () => {
  const gatewayPort = await unusedPort();
  const redisUrl = `memory://invalid-startup-${process.pid}-${gatewayPort}`;
  const seed = new PublicSessionPersistence(redisUrl, "seed-owner");
  await seed.connect();
  await seed.save({
    version: 99,
    dailyBudgetDay: "invalid",
    dailyReservedMicroUsd: 0,
    queue: [],
    sessions: [],
    workers: [{ id: "seat-01" }],
  } as never);
  await seed.close();

  const restoreEnvironment = setGatewayEnvironment(gatewayPort, "http://127.0.0.1:9");
  process.env.PUBLIC_REDIS_URL = redisUrl;
  try {
    await assert.rejects(() => startPublicLiveGateway(), /unsupported public session state version/);
    const nextOwner = new PublicSessionPersistence(redisUrl, "next-owner");
    await nextOwner.connect();
    await nextOwner.close();
  } finally {
    restoreEnvironment();
  }
});
