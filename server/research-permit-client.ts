/**
 * Worker→gateway private authenticated research-permit client.
 *
 * The public gateway owns the global research-permit state (max two concurrent
 * one-shot research child processes). Worker processes — and the coordinator
 * that forks them — must acquire a permit from the gateway immediately before
 * forking and release it only after the child exits. This client is the only
 * path a worker uses to reach that private state; it never talks to Redis and
 * never touches the public listener.
 *
 * Feature-gated: `TERMINAL_RUNTIME_FEATURE_ENABLED=1` plus a
 * `TERMINAL_RUNTIME_MANAGEMENT_TOKEN` (>= 32 chars). Without the flag the
 * coordinator keeps its previous no-permit behavior.
 */

import type {
  ResearchPermitGate,
  ResearchPermitIdentity,
} from "./research-worker-coordinator.js";

export interface ResearchPermitClientConfig {
  /** Private management API base URL of the gateway (e.g. http://public-gateway:8789). */
  baseUrl: string;
  /** X-Management-Token value shared with the gateway's private listener. */
  token: string;
  /** HTTP timeout for each management call (ms). */
  timeoutMs?: number;
  /** Injectable fetch for deterministic tests. */
  fetch?: typeof globalThis.fetch;
}

export type ResearchPermitStatus =
  | "acquired"
  | "queued"
  | "released"
  | "cancelled"
  | "expired"
  | "not-found";

const PERMIT_ACQUIRE_PATH = "/api/management/research-permits/acquire";
const PERMIT_STATUS_PATH = "/api/management/research-permits/status";
const PERMIT_HEARTBEAT_PATH = "/api/management/research-permits/heartbeat";
const PERMIT_RELEASE_PATH = "/api/management/research-permits/release";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class ResearchPermitClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: ResearchPermitClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async acquire(identity: ResearchPermitIdentity): Promise<{
    accepted: boolean;
    status: "acquired" | "queued" | "rejected";
    requestId?: string;
    reason?: string;
    queuePosition?: number;
  }> {
    const result = await this.post<Record<string, unknown>>(PERMIT_ACQUIRE_PATH, {
      sessionId: identity.sessionId,
      workerGeneration: identity.workerGeneration,
    });
    const accepted = result.body?.accepted === true;
    const status = result.body?.status;
    const requestId = typeof result.body?.requestId === "string"
      ? result.body.requestId
      : undefined;
    const reason = typeof result.body?.reason === "string"
      ? result.body.reason
      : undefined;
    const queuePosition = typeof result.body?.queuePosition === "number"
      ? result.body.queuePosition
      : undefined;
    if (!accepted) {
      return { accepted: false, status: "rejected", reason };
    }
    if (status === "acquired") {
      return { accepted: true, status: "acquired", requestId };
    }
    return { accepted: true, status: "queued", requestId, queuePosition };
  }

  async status(requestId: string): Promise<{ requestId: string; status: ResearchPermitStatus }> {
    const result = await this.post<Record<string, unknown>>(PERMIT_STATUS_PATH, { requestId });
    const status = result.body?.status;
    if (
      typeof status !== "string"
      || !["acquired", "queued", "released", "cancelled", "expired", "not-found"].includes(status)
    ) {
      return { requestId, status: "not-found" };
    }
    return { requestId, status: status as ResearchPermitStatus };
  }

  /** Heartbeat a queued permit so the owning session stays alive and the wait remains valid. */
  async heartbeat(requestId: string, sessionId?: string): Promise<void> {
    await this.post<Record<string, unknown>>(PERMIT_HEARTBEAT_PATH, {
      requestId,
      ...(sessionId ? { sessionId } : {}),
    });
  }

  async release(requestId: string): Promise<void> {
    await this.post<Record<string, unknown>>(PERMIT_RELEASE_PATH, { requestId });
  }

  private async post<T extends Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; body: T | undefined }> {
    let response: globalThis.Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-management-token": this.token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error(`research-permit client could not reach gateway at ${this.baseUrl}${path}`);
    }
    let parsed: T | undefined;
    try {
      const json: unknown = await response.json();
      if (isRecord(json)) parsed = json as T;
    } catch {
      // non-JSON error body
    }
    if (!response.ok) {
      throw new Error(`research-permit client received ${response.status} from ${path}`);
    }
    return { ok: true, status: response.status, body: parsed };
  }
}

/**
 * Build a coordinator-compatible `ResearchPermitGate` from the worker's
 * environment, or return `undefined` when the feature is disabled.
 *
 * Returns undefined when:
 *  - TERMINAL_RUNTIME_FEATURE_ENABLED is not exactly "1", or
 *  - TERMINAL_RUNTIME_MANAGEMENT_TOKEN is missing/too short, or
 *  - TERMINAL_RUNTIME_MANAGEMENT_URL is unset/invalid.
 */
export function createResearchPermitGateFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { permitGate: ResearchPermitGate; permitIdentity: () => ResearchPermitIdentity } | undefined {
  if (env.TERMINAL_RUNTIME_FEATURE_ENABLED?.trim() !== "1") return undefined;
  const token = env.TERMINAL_RUNTIME_MANAGEMENT_TOKEN?.trim();
  if (!token || token.length < 32) return undefined;
  const rawUrl = env.TERMINAL_RUNTIME_MANAGEMENT_URL?.trim();
  if (!rawUrl) return undefined;
  let baseUrl: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    baseUrl = parsed.origin;
  } catch {
    return undefined;
  }

  const client = new ResearchPermitClient({ baseUrl, token });
  const permitIdentity = (): ResearchPermitIdentity => ({
    sessionId: env.TERMINAL_RUNTIME_SESSION_ID?.trim() || "public-worker",
    workerGeneration: env.TERMINAL_RUNTIME_WORKER_GENERATION?.trim() || "unknown",
  });

  const gate: ResearchPermitGate = {
    acquire: (identity) => client.acquire(identity),
    status: (requestId) => client.status(requestId),
    heartbeat: (requestId) => client.heartbeat(requestId),
    release: (requestId) => client.release(requestId),
  };
  return { permitGate: gate, permitIdentity };
}
