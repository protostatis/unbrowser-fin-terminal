/** Strict, fail-closed configuration for the public live-terminal gateway. */

export interface PublicWorkerEndpoint {
  id: string;
  url: string;
}

export interface PublicLiveGatewayConfig {
  host: string;
  port: number;
  publicBasePath: string;
  publicOrigin: string;
  redisUrl: string;
  signingKey: string;
  workerProxyToken: string;
  turnstileSiteKey: string;
  turnstileSecret: string;
  turnstileRequired: boolean;
  turnstileExpectedHostname?: string;
  workerEndpoints: readonly PublicWorkerEndpoint[];
  maxQueue: number;
  ticketTtlMs: number;
  reconnectGraceMs: number;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  maxResearchRuns: number;
  dailyBudgetMicroUsd: number;
  researchRunReservationMicroUsd: number;
  admissionAttemptsPerWindow: number;
  admissionWindowMs: number;
}

export interface PublicSessionWorkerConfig {
  enabled: boolean;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  reconnectGraceMs: number;
  maxResearchRuns: number;
}

function optional(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = optional(env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = optional(env[name]);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function millisecondsFromSeconds(
  env: NodeJS.ProcessEnv,
  name: string,
  fallbackSeconds: number,
  minimumSeconds: number,
  maximumSeconds: number,
): number {
  return integer(env, name, fallbackSeconds, minimumSeconds, maximumSeconds) * 1_000;
}

function canonicalOrigin(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value) {
    throw new Error(`${name} must be a canonical HTTP(S) origin`);
  }
  return parsed.origin;
}

function redisUrl(value: string, isProduction: boolean): string {
  if (value.startsWith("memory://")) {
    if (isProduction) throw new Error("PUBLIC_REDIS_URL cannot use memory:// in production");
    return value;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PUBLIC_REDIS_URL must be an absolute redis:// or rediss:// URL");
  }
  if ((parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") || !parsed.hostname) {
    throw new Error("PUBLIC_REDIS_URL must be an absolute redis:// or rediss:// URL");
  }
  return value;
}

function publicBasePath(value: string | undefined): string {
  const path = optional(value) ?? "/fin-terminal-demo/";
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(path)) {
    throw new Error("PUBLIC_BASE_PATH must start and end with / and contain URL-safe path segments");
  }
  return path;
}

function parseWorkerEndpoints(raw: string, maxSeats: number): PublicWorkerEndpoint[] {
  const endpoints = raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error("PUBLIC_WORKER_ENDPOINTS entries must be id=http://host:port");
    }
    const id = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error("PUBLIC_WORKER_ENDPOINTS worker ids must be URL-safe");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`PUBLIC_WORKER_ENDPOINTS has an invalid URL for ${id}`);
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(`PUBLIC_WORKER_ENDPOINTS URL for ${id} must be a bare HTTP(S) origin`);
    }
    return { id, url: url.origin };
  });
  if (endpoints.length !== maxSeats) {
    throw new Error("PUBLIC_WORKER_ENDPOINTS must contain exactly PUBLIC_MAX_SESSIONS workers");
  }
  if (new Set(endpoints.map(({ id }) => id)).size !== endpoints.length) {
    throw new Error("PUBLIC_WORKER_ENDPOINTS worker ids must be unique");
  }
  return endpoints;
}

/**
 * Reads the public gateway's production contract. No public live process starts
 * without its CAPTCHA verifier, signed-token key, internal worker token, and
 * explicitly enumerated isolated worker seats.
 */
export function readPublicLiveGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): PublicLiveGatewayConfig {
  const isProduction = env.NODE_ENV === "production";
  const turnstileBypass = optional(env.PUBLIC_TURNSTILE_BYPASS);
  if (turnstileBypass && turnstileBypass !== "1") {
    throw new Error("PUBLIC_TURNSTILE_BYPASS must be 1 when set");
  }
  if (turnstileBypass === "1" && isProduction) {
    throw new Error("PUBLIC_TURNSTILE_BYPASS is forbidden in production");
  }
  const turnstileRequired = turnstileBypass !== "1";
  const maxResearchRuns = integer(env, "PUBLIC_MAX_RESEARCH_RUNS", 5, 1, 10);
  const dailyBudgetMicroUsd = integer(
    env,
    "PUBLIC_DAILY_RESEARCH_BUDGET_MICRO_USD",
    10_000_000,
    100_000,
    1_000_000_000,
  );
  const researchRunReservationMicroUsd = integer(
    env,
    "PUBLIC_RESEARCH_RUN_RESERVATION_MICRO_USD",
    200_000,
    1_000,
    10_000_000,
  );
  if (maxResearchRuns * researchRunReservationMicroUsd > dailyBudgetMicroUsd) {
    throw new Error("PUBLIC_MAX_RESEARCH_RUNS reservation cannot exceed the daily public research budget");
  }
  const maxSessions = integer(env, "PUBLIC_MAX_SESSIONS", 10, 1, 10);
  const signingKey = required(env, "PUBLIC_SESSION_SIGNING_KEY");
  if (signingKey.length < 32) throw new Error("PUBLIC_SESSION_SIGNING_KEY must be at least 32 characters");

  return {
    host: optional(env.HOST) ?? "127.0.0.1",
    port: integer(env, "PORT", 8788, 1, 65_535),
    publicBasePath: publicBasePath(env.PUBLIC_BASE_PATH),
    publicOrigin: canonicalOrigin(required(env, "PUBLIC_ALLOWED_ORIGIN"), "PUBLIC_ALLOWED_ORIGIN"),
    redisUrl: redisUrl(required(env, "PUBLIC_REDIS_URL"), isProduction),
    signingKey,
    workerProxyToken: required(env, "PUBLIC_WORKER_PROXY_TOKEN"),
    turnstileSiteKey: turnstileRequired ? required(env, "PUBLIC_TURNSTILE_SITE_KEY") : "",
    turnstileSecret: turnstileRequired ? required(env, "PUBLIC_TURNSTILE_SECRET") : "",
    turnstileRequired,
    ...(optional(env.PUBLIC_TURNSTILE_EXPECTED_HOSTNAME)
      ? { turnstileExpectedHostname: optional(env.PUBLIC_TURNSTILE_EXPECTED_HOSTNAME) }
      : {}),
    workerEndpoints: parseWorkerEndpoints(required(env, "PUBLIC_WORKER_ENDPOINTS"), maxSessions),
    maxQueue: integer(env, "PUBLIC_MAX_QUEUE", 50, 1, 500),
    ticketTtlMs: millisecondsFromSeconds(env, "PUBLIC_TICKET_TTL_SECONDS", 600, 30, 3_600),
    reconnectGraceMs: millisecondsFromSeconds(env, "PUBLIC_RECONNECT_GRACE_SECONDS", 30, 5, 300),
    idleTimeoutMs: millisecondsFromSeconds(env, "PUBLIC_IDLE_TIMEOUT_SECONDS", 300, 60, 900),
    absoluteTimeoutMs: millisecondsFromSeconds(env, "PUBLIC_SESSION_MAX_SECONDS", 900, 120, 1_800),
    maxResearchRuns,
    dailyBudgetMicroUsd,
    researchRunReservationMicroUsd,
    admissionAttemptsPerWindow: integer(env, "PUBLIC_ADMISSION_ATTEMPTS", 5, 1, 30),
    admissionWindowMs: millisecondsFromSeconds(env, "PUBLIC_ADMISSION_WINDOW_SECONDS", 600, 60, 3_600),
  };
}

/** Public worker settings are intentionally independent from guest-controlled input. */
export function readPublicSessionWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): PublicSessionWorkerConfig {
  const enabled = optional(env.PUBLIC_SESSION_WORKER) === "1";
  if (!enabled) {
    return {
      enabled: false,
      idleTimeoutMs: 0,
      absoluteTimeoutMs: 0,
      reconnectGraceMs: 0,
      maxResearchRuns: 0,
    };
  }
  return {
    enabled: true,
    idleTimeoutMs: millisecondsFromSeconds(env, "PUBLIC_IDLE_TIMEOUT_SECONDS", 300, 60, 900),
    absoluteTimeoutMs: millisecondsFromSeconds(env, "PUBLIC_SESSION_MAX_SECONDS", 900, 120, 1_800),
    reconnectGraceMs: millisecondsFromSeconds(env, "PUBLIC_RECONNECT_GRACE_SECONDS", 30, 5, 300),
    maxResearchRuns: integer(env, "PUBLIC_MAX_RESEARCH_RUNS", 5, 1, 10),
  };
}
