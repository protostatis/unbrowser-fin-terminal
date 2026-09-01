import { chmod, mkdir } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ProviderBudgetLane = "research" | "import";

export interface ProviderBudgetConfig {
  principalDailyResearchRequests: number;
  principalDailyImportRequests: number;
  globalDailyBudgetUsd: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  importEstimateUsd: number;
}

export interface ProviderBudgetOptions {
  filePath: string;
  now?: () => number;
  config?: Partial<ProviderBudgetConfig>;
}

export interface ProviderBudgetDecision {
  allowed: boolean;
  reason?: "principal-quota" | "global-budget";
  retryAfterSeconds: number;
}

type PrincipalUsage = {
  researchRequests: number;
  importRequests: number;
};

type ProviderBudgetState = {
  version: 1;
  day: string;
  global: {
    estimatedUsd: number;
    researchRequests: number;
    importRequests: number;
  };
  principals: Record<string, PrincipalUsage>;
};

const DEFAULT_CONFIG: ProviderBudgetConfig = {
  // These are conservative request ceilings for the browser-owned canary. A
  // single research run normally consumes several model turns, so this still
  // permits normal use while bounding an account's daily spend.
  principalDailyResearchRequests: 40,
  principalDailyImportRequests: 5,
  globalDailyBudgetUsd: 25,
  // Deliberately overestimate the default model's rates when the deployment
  // does not provide a more precise price card. The ledger is an attempt
  // reservation before the upstream call, so it fails closed rather than
  // overspending; provider failures still consume the conservative reservation.
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 4,
  importEstimateUsd: 0.05,
};

const MAX_PRINCIPALS = 100_000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 15_000;

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function resolveProviderBudgetConfig(overrides: Partial<ProviderBudgetConfig> = {}): ProviderBudgetConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  return {
    principalDailyResearchRequests: positiveInteger(config.principalDailyResearchRequests, "principalDailyResearchRequests"),
    principalDailyImportRequests: positiveInteger(config.principalDailyImportRequests, "principalDailyImportRequests"),
    globalDailyBudgetUsd: positiveFinite(config.globalDailyBudgetUsd, "globalDailyBudgetUsd"),
    inputUsdPerMillionTokens: positiveFinite(config.inputUsdPerMillionTokens, "inputUsdPerMillionTokens"),
    outputUsdPerMillionTokens: positiveFinite(config.outputUsdPerMillionTokens, "outputUsdPerMillionTokens"),
    importEstimateUsd: positiveFinite(config.importEstimateUsd, "importEstimateUsd"),
  };
}

function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

export function providerBudgetConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderBudgetConfig {
  const overrides: Partial<ProviderBudgetConfig> = {};
  const values: Array<[keyof ProviderBudgetConfig, string]> = [
    ["principalDailyResearchRequests", "MARKET_BROWSER_DAILY_RESEARCH_REQUESTS"],
    ["principalDailyImportRequests", "MARKET_BROWSER_DAILY_IMPORTS"],
    ["globalDailyBudgetUsd", "MARKET_BROWSER_PROVIDER_BUDGET_USD"],
    ["inputUsdPerMillionTokens", "MARKET_BROWSER_INPUT_USD_PER_MILLION_TOKENS"],
    ["outputUsdPerMillionTokens", "MARKET_BROWSER_OUTPUT_USD_PER_MILLION_TOKENS"],
    ["importEstimateUsd", "MARKET_BROWSER_IMPORT_ESTIMATE_USD"],
  ];
  for (const [key, envName] of values) {
    const value = envNumber(env, envName);
    if (value !== undefined) overrides[key] = value;
  }
  return resolveProviderBudgetConfig(overrides);
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function retryAfterSeconds(timestamp: number): number {
  const nextDay = new Date(timestamp);
  nextDay.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((nextDay.getTime() - timestamp) / 1_000));
}

function emptyState(day: string): ProviderBudgetState {
  return {
    version: 1,
    day,
    global: { estimatedUsd: 0, researchRequests: 0, importRequests: 0 },
    principals: {},
  };
}

function parseState(text: string, day: string): ProviderBudgetState {
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) throw new Error("provider budget state is too large");
  const value = JSON.parse(text) as Partial<ProviderBudgetState>;
  if (value.version !== 1 || typeof value.day !== "string") throw new Error("provider budget state is invalid");
  if (value.day !== day) return emptyState(day);
  const global = value.global;
  if (!global || !Number.isFinite(global.estimatedUsd) || global.estimatedUsd < 0
    || !Number.isInteger(global.researchRequests) || global.researchRequests < 0
    || !Number.isInteger(global.importRequests) || global.importRequests < 0) {
    throw new Error("provider budget global state is invalid");
  }
  if (!value.principals || typeof value.principals !== "object" || Array.isArray(value.principals)) {
    throw new Error("provider budget principals are invalid");
  }
  const principals: Record<string, PrincipalUsage> = {};
  for (const [principal, usage] of Object.entries(value.principals)) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(principal) || !usage || !Number.isInteger(usage.researchRequests)
      || usage.researchRequests < 0 || !Number.isInteger(usage.importRequests) || usage.importRequests < 0) {
      throw new Error("provider budget principal state is invalid");
    }
    if (Object.keys(principals).length >= MAX_PRINCIPALS) throw new Error("provider budget has too many principals");
    principals[principal] = usage;
  }
  return { version: 1, day, global, principals };
}

function writeState(filePath: string, state: ProviderBudgetState): void {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, filePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * SQLite supplies a kernel-backed inter-process transaction lock. The JSON file
 * remains the human-readable ledger; the sidecar database is only the mutex so
 * a crash rolls back the lock without leaving a stale directory behind.
 */
type SqliteDatabase = {
  exec(source: string): void;
  close(): void;
};

type SqliteModule = {
  DatabaseSync: new (location: string) => SqliteDatabase;
};

let sqliteModulePromise: Promise<SqliteModule> | undefined;

async function openBudgetTransaction(filePath: string): Promise<{
  commit: () => void;
  close: () => void;
}> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (!sqliteModulePromise) {
    // Node 22.23.2 (the local and container runtime) provides node:sqlite;
    // @types/node remains on the project-wide Node 20 compatibility types.
    // @ts-expect-error node:sqlite is provided by the pinned Node 22 runtime.
    sqliteModulePromise = import("node:sqlite") as unknown as Promise<SqliteModule>;
  }
  const { DatabaseSync } = await sqliteModulePromise;
  const databasePath = `${filePath}.lock.sqlite`;
  const setup = new DatabaseSync(databasePath);
  try {
    await chmod(databasePath, 0o600);
    // Schema setup is deliberately completed and closed before the transaction
    // connection is opened. Otherwise a same-process second DatabaseSync can
    // synchronously wait on DDL while the first transaction awaits file I/O.
    setup.exec("PRAGMA busy_timeout = 15000; CREATE TABLE IF NOT EXISTS provider_budget_mutex (id INTEGER PRIMARY KEY CHECK (id = 1));");
  } finally {
    setup.close();
  }
  const database = new DatabaseSync(databasePath);
  const startedAt = Date.now();
  try {
    await chmod(databasePath, 0o600);
    database.exec("PRAGMA busy_timeout = 15000;");
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    database.close();
    if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) throw new Error("provider budget lock timeout", { cause: error });
    throw error;
  }
  let committed = false;
  return {
    commit: () => {
      database.exec("COMMIT");
      committed = true;
    },
    close: () => {
      try {
        if (!committed) database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    },
  };
}

export function estimateChatProviderCost(
  requestBody: unknown,
  maxOutputTokens: number,
  config: ProviderBudgetConfig,
): number {
  const serialized = JSON.stringify(requestBody) ?? "";
  const inputTokens = Math.ceil(Buffer.byteLength(serialized, "utf8") / 4);
  return (inputTokens * config.inputUsdPerMillionTokens + maxOutputTokens * config.outputUsdPerMillionTokens) / 1_000_000;
}

export function createPersistentProviderBudget(options: ProviderBudgetOptions) {
  const config = resolveProviderBudgetConfig(options.config);
  const now = options.now ?? Date.now;
  let tail = Promise.resolve();

  async function consume(principal: string, lane: ProviderBudgetLane, estimatedUsd: number): Promise<ProviderBudgetDecision> {
    const previous = tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    tail = current;
    await previous;
    let transaction: Awaited<ReturnType<typeof openBudgetTransaction>> | undefined;
    try {
      transaction = await openBudgetTransaction(options.filePath);
      const timestamp = now();
      const day = utcDay(timestamp);
      let state: ProviderBudgetState;
      try {
        state = parseState(readFileSync(options.filePath, "utf8"), day);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
        state = emptyState(day);
      }
      const usage = state.principals[principal] ?? { researchRequests: 0, importRequests: 0 };
      const principalLimit = lane === "research" ? config.principalDailyResearchRequests : config.principalDailyImportRequests;
      const principalRequests = lane === "research" ? usage.researchRequests : usage.importRequests;
      if (principalRequests >= principalLimit) {
        return { allowed: false, reason: "principal-quota", retryAfterSeconds: retryAfterSeconds(timestamp) };
      }
      if (!Number.isFinite(estimatedUsd) || estimatedUsd <= 0 || state.global.estimatedUsd + estimatedUsd > config.globalDailyBudgetUsd) {
        return { allowed: false, reason: "global-budget", retryAfterSeconds: retryAfterSeconds(timestamp) };
      }
      if (lane === "research") {
        usage.researchRequests += 1;
        state.global.researchRequests += 1;
      } else {
        usage.importRequests += 1;
        state.global.importRequests += 1;
      }
      state.global.estimatedUsd = Number((state.global.estimatedUsd + estimatedUsd).toFixed(6));
      state.principals[principal] = usage;
      writeState(options.filePath, state);
      transaction.commit();
      return { allowed: true, retryAfterSeconds: retryAfterSeconds(timestamp) };
    } finally {
      try {
        transaction?.close();
      } finally {
        release();
      }
    }
  }

  return { config, consume };
}
