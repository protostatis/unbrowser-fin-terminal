/**
 * UTC-day pre-cache budget ledger for market-research paired pre-warming.
 *
 * The ledger lives under MARKET_DATA_DIR (or cwd/.pi) as
 * `market-precache-ledger.json`. Updated atomically (write-tmp + rename)
 * under the one-parent-writer invariant.
 *
 * Design:
 * - Per-day attempt entries carry a stable pair identity. A settled pair may
 *   be attempted again after freshness/cooldown planning admits it; at most
 *   one reservation for that pair may remain unresolved.
 * - Reserve + atomically persist BEFORE dispatch; stranded entries survive restarts.
 * - No refund within the day; actual usage is telemetry.
 * - Callers serialize fresh read-modify-write operations through one queue so
 *   concurrent reservations and settlements never clobber.
 * - Malformed ledgers fail closed. Public workers stay cold.
 */

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * Bounded, structured failure telemetry attached to a settled pre-cache entry.
 * The code is a stable machine classification; the message is a redacted,
 * bounded copy of the worker error so operators can diagnose without the
 * in-memory job map or worker stdout (which is discarded in production).
 */
export interface PrecacheFailureTelemetry {
  /** Machine classification of the settlement failure. */
  code: string;
  /** Final scheduler phase when the run settled (queued/dispatched/running/...). */
  phase?: string;
  /** Last tool attempted before the failure, when known. */
  lastTool?: string;
  /** True when the per-run token guard aborted the run. */
  tokenGuard?: boolean;
  /** Redacted, bounded worker error message. */
  message?: string;
}

export interface PrecacheDayEntry {
  /** Stable key derived from the exact research identity (pair or single). */
  pairKey: string;
  /** Monotonic attempt number for this pair within the UTC day. */
  attempt: number;
  /** Conservative per-run reservation (always the perRunLimit). */
  reservation: number;
  /** When the reservation was placed (epoch ms). */
  reservedAt: number;
  /** Actual total tokens from the worker, when reported. */
  actualTokens?: number;
  /** Total cost from the worker (if reported). */
  actualCost?: number;
  outcome?: "complete" | "failed" | "cancelled";
  /** Structured failure telemetry for non-complete settlements. */
  failure?: PrecacheFailureTelemetry;
}

export interface PrecacheLedgerDay {
  date: string;
  budget: number;
  perRunLimit: number;
  entries: PrecacheDayEntry[];
}

export interface PrecacheLedgerFile {
  version: 1;
  updatedAt: number;
  days: PrecacheLedgerDay[];
}

// ── Config ────────────────────────────────────────────────────────────────

const DEFAULT_DAILY_BUDGET = 2_000_000;
const DEFAULT_PER_RUN_LIMIT = 100_000;

export function readPrecacheBudgetConfig(env: NodeJS.ProcessEnv = process.env): { budget: number; perRunLimit: number } {
  const budgetRaw = env.MARKET_PRECACHE_BUDGET?.trim();
  const budget = budgetRaw ? Number(budgetRaw) : DEFAULT_DAILY_BUDGET;
  if (!Number.isInteger(budget) || budget < 10_000 || budget > 10_000_000) {
    throw new Error("MARKET_PRECACHE_BUDGET must be an integer from 10 000 to 10 000 000");
  }
  const limitRaw = env.MARKET_PRECACHE_RUN_LIMIT?.trim();
  const perRunLimit = limitRaw ? Number(limitRaw) : DEFAULT_PER_RUN_LIMIT;
  if (!Number.isInteger(perRunLimit) || perRunLimit < 5_000 || perRunLimit > 500_000) {
    throw new Error("MARKET_PRECACHE_RUN_LIMIT must be an integer from 5 000 to 500 000");
  }
  if (perRunLimit > budget) {
    throw new Error("MARKET_PRECACHE_RUN_LIMIT cannot exceed MARKET_PRECACHE_BUDGET");
  }
  return { budget, perRunLimit };
}

// ── Pair key derivation ───────────────────────────────────────────────────

/**
 * Derive a stable, bounded key from the complete pair cache identity. Symbol
 * and chart scope are required because ticker BRIEF/WHY research keys are
 * shared across symbols.
 */
export function pairedPairKey(
  symbol: string,
  chartScope: string,
  briefKey: string,
  whyKey: string,
): string {
  const sorted = [briefKey, whyKey].sort();
  const digest = createHash("sha256")
    .update("precache-pair-v1\0")
    .update(symbol.trim().toUpperCase())
    .update("\0")
    .update(chartScope.trim().toLowerCase())
    .update("\0")
    .update(sorted[0]!)
    .update("\0")
    .update(sorted[1]!)
    .digest("hex")
    .slice(0, 32);
  return `pair-${digest}`;
}

/**
 * Stable key for a single (non-paired) pre-cache identity, used by the
 * `single` pre-cache strategy where BRIEF and WHY run as independent jobs.
 * Reuses the same `pair-` prefix and format so the ledger schema is unchanged.
 */
export function singlePrecacheKey(
  symbol: string,
  chartScope: string,
  researchKey: string,
): string {
  const digest = createHash("sha256")
    .update("precache-single-v1\0")
    .update(symbol.trim().toUpperCase())
    .update("\0")
    .update(chartScope.trim().toLowerCase())
    .update("\0")
    .update(researchKey.trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
  return `pair-${digest}`;
}

// ── UTC day key ───────────────────────────────────────────────────────────

export function utcDayKey(now: number = Date.now()): string {
  if (!Number.isFinite(now)) throw new Error("UTC day timestamp must be finite");
  const date = new Date(now);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

// ── Path resolution ──────────────────────────────────────────────────────

export function precacheLedgerFilePath(cwd: string): string {
  const configured = process.env.MARKET_DATA_DIR?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("MARKET_DATA_DIR must be an absolute path");
    return join(configured, "market-precache-ledger.json");
  }
  return join(cwd, ".pi", "market-precache-ledger.json");
}

// ── Validation ────────────────────────────────────────────────────────────

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateFailureTelemetry(raw: unknown): raw is PrecacheFailureTelemetry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const f = raw as Record<string, unknown>;
  if (typeof f.code !== "string" || !/^[a-z0-9-]{1,80}$/.test(f.code)) return false;
  if (f.phase !== undefined && (typeof f.phase !== "string" || f.phase.length > 40)) return false;
  if (f.lastTool !== undefined && (typeof f.lastTool !== "string" || f.lastTool.length > 160)) return false;
  if (f.tokenGuard !== undefined && typeof f.tokenGuard !== "boolean") return false;
  if (f.message !== undefined && (typeof f.message !== "string" || f.message.length > 400)) return false;
  return true;
}

function validateEntry(raw: unknown): raw is PrecacheDayEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.pairKey === "string" && /^pair-[a-f0-9]{32}$/.test(e.pairKey) &&
    isFiniteInteger(e.attempt) && e.attempt >= 1 && e.attempt <= 2_000 &&
    isFiniteInteger(e.reservation) && e.reservation >= 5_000 && e.reservation <= 500_000 &&
    isFiniteInteger(e.reservedAt) && e.reservedAt > 0 && e.reservedAt <= 9_000_000_000_000_000 &&
    (e.actualTokens === undefined || (isFiniteInteger(e.actualTokens) && e.actualTokens >= 0 && e.actualTokens <= 1_000_000_000)) &&
    (e.actualCost === undefined || (isFiniteNumber(e.actualCost) && e.actualCost >= 0 && e.actualCost <= 1_000_000)) &&
    (e.outcome === undefined || e.outcome === "complete" || e.outcome === "failed" || e.outcome === "cancelled") &&
    (e.failure === undefined || validateFailureTelemetry(e.failure))
  );
}

function validateDay(raw: unknown): raw is PrecacheLedgerDay {
  if (!raw || typeof raw !== "object") return false;
  const d = raw as Record<string, unknown>;
  return (
    typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date) &&
    isFiniteInteger(d.budget) && d.budget >= 10_000 && d.budget <= 10_000_000 &&
    isFiniteInteger(d.perRunLimit) && d.perRunLimit >= 5_000 && d.perRunLimit <= 500_000 && d.perRunLimit <= d.budget &&
    Array.isArray(d.entries) && d.entries.length <= 2_000 && d.entries.every(validateEntry) &&
    new Set((d.entries as PrecacheDayEntry[]).map((entry) => `${entry.pairKey}:${entry.attempt}`)).size === d.entries.length &&
    new Set((d.entries as PrecacheDayEntry[]).filter((entry) => entry.outcome === undefined).map((entry) => entry.pairKey)).size
      === (d.entries as PrecacheDayEntry[]).filter((entry) => entry.outcome === undefined).length &&
    (d.entries as PrecacheDayEntry[]).every((entry) => entry.reservation === d.perRunLimit) &&
    (d.entries as PrecacheDayEntry[]).reduce((sum, entry) => sum + entry.reservation, 0) <= d.budget
  );
}

// ── Ledger read / write ───────────────────────────────────────────────────

export async function readPrecacheLedger(path: string): Promise<PrecacheLedgerFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { version: 1, updatedAt: Date.now(), days: [] };
    }
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    throw new Error("Malformed market precache ledger: invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Malformed market precache ledger: not an object");
  const p = parsed as Record<string, unknown>;
  if (p.version !== 1) throw new Error("Malformed market precache ledger: unsupported version");
  if (!Array.isArray(p.days)) throw new Error("Malformed market precache ledger: missing days array");
  if (p.days.length > 14) throw new Error("Malformed market precache ledger: too many day entries");
  for (const day of p.days) {
    if (!validateDay(day)) throw new Error("Malformed market precache ledger: invalid day entry");
  }
  const dates = (p.days as PrecacheLedgerDay[]).map((day) => day.date);
  if (new Set(dates).size !== dates.length) throw new Error("Malformed market precache ledger: duplicate day entry");
  return {
    version: 1,
    updatedAt: typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt) ? p.updatedAt : Date.now(),
    days: p.days as PrecacheLedgerDay[],
  };
}

export async function writeLedger(path: string, file: PrecacheLedgerFile): Promise<void> {
  const updated = { ...file, updatedAt: Date.now() };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(updated)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

// ── Day record access ─────────────────────────────────────────────────────

export function getOrCreateDay(file: PrecacheLedgerFile, day: string): PrecacheLedgerDay {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Pre-cache ledger day must use YYYY-MM-DD");
  const { budget, perRunLimit } = readPrecacheBudgetConfig();
  let dayRecord = file.days.find((record) => record.date === day);
  if (dayRecord && (dayRecord.budget !== budget || dayRecord.perRunLimit !== perRunLimit)) {
    throw new Error("Pre-cache budget configuration cannot change within an existing UTC ledger day");
  }
  if (!dayRecord) {
    dayRecord = { date: day, budget, perRunLimit, entries: [] };
    file.days.push(dayRecord);
    if (file.days.length > 14) file.days = file.days.slice(-14);
  }
  return dayRecord;
}

// ── Budget helpers ────────────────────────────────────────────────────────

export function dayRemainingBudget(day: PrecacheLedgerDay): number {
  const reserved = day.entries.reduce((sum, e) => sum + e.reservation, 0);
  return Math.max(0, day.budget - reserved);
}

export function dayTotalReserved(day: PrecacheLedgerDay): number {
  return day.entries.reduce((sum, e) => sum + e.reservation, 0);
}

export function dayTotalActualTokens(day: PrecacheLedgerDay): number {
  return day.entries.reduce((sum, e) => sum + (e.actualTokens ?? 0), 0);
}

// ── Reservation ───────────────────────────────────────────────────────────

export interface ReserveResult {
  /** Newly created reservations, in input priority order. */
  reservedEntries: PrecacheDayEntry[];
  /** Newly reserved pair keys, in input priority order. */
  reservedPairKeys: string[];
  /** Keys with an unresolved reservation; callers must not dispatch them. */
  existingPairKeys: string[];
  remaining: number;
}

/**
 * In-memory reservation. Returns the updated day in the file.
 * Caller must persist with `writeLedger` after this returns.
 */
export function reservePrecacheEntries(
  day: PrecacheLedgerDay,
  pairKeys: readonly string[],
  now: number = Date.now(),
): ReserveResult {
  if (!Number.isInteger(now) || now <= 0) throw new Error("Pre-cache reservation timestamp must be a positive integer");
  const unresolved = new Set(day.entries.filter((entry) => entry.outcome === undefined).map((entry) => entry.pairKey));
  const reservedEntries: PrecacheDayEntry[] = [];
  const reservedPairKeys: string[] = [];
  const existingPairKeys: string[] = [];
  for (const pairKey of pairKeys) {
    if (!/^pair-[a-f0-9]{32}$/.test(pairKey)) throw new Error(`Invalid pre-cache pair key: ${pairKey}`);
    if (unresolved.has(pairKey)) {
      existingPairKeys.push(pairKey);
      continue;
    }
    if (dayRemainingBudget(day) < day.perRunLimit) break;
    const attempt = day.entries.filter((entry) => entry.pairKey === pairKey).reduce((max, entry) => Math.max(max, entry.attempt), 0) + 1;
    const entry: PrecacheDayEntry = { pairKey, attempt, reservation: day.perRunLimit, reservedAt: now };
    day.entries.push(entry);
    unresolved.add(pairKey);
    reservedEntries.push(entry);
    reservedPairKeys.push(pairKey);
  }
  return { reservedEntries, reservedPairKeys, existingPairKeys, remaining: dayRemainingBudget(day) };
}

/**
 * Record actual usage for a completed/cancelled/failed paired run.
 * Idempotent: an already-settled entry is not overwritten.
 * Returns true if the update was applied.
 */
export function settlePrecacheEntry(
  day: PrecacheLedgerDay,
  pairKey: string,
  attempt: number,
  outcome: "complete" | "failed" | "cancelled",
  actualTokens?: number,
  actualCost?: number,
  failure?: PrecacheFailureTelemetry,
): boolean {
  const entry = day.entries.find((e) => e.pairKey === pairKey && e.attempt === attempt);
  if (!entry) return false;
  if (entry.outcome !== undefined) return false;
  if (actualTokens !== undefined) {
    if (!Number.isInteger(actualTokens) || actualTokens < 0 || actualTokens > 1_000_000_000) {
      throw new Error("Pre-cache actual token usage is invalid");
    }
  }
  if (actualCost !== undefined) {
    if (!Number.isFinite(actualCost) || actualCost < 0 || actualCost > 1_000_000) {
      throw new Error("Pre-cache actual cost is invalid");
    }
  }
  if (failure !== undefined && !validateFailureTelemetry(failure)) {
    throw new Error("Pre-cache failure telemetry is invalid");
  }
  entry.outcome = outcome;
  if (actualTokens !== undefined) entry.actualTokens = actualTokens;
  if (actualCost !== undefined) {
    entry.actualCost = actualCost;
  }
  if (failure !== undefined) entry.failure = failure;
  return true;
}

// ── Token guard for research-worker ───────────────────────────────────────

export interface TokenGuardInput {
  /** Total tokens used so far in this run (from session stats). */
  usedTotal: number;
  /** Estimated context tokens for the current turn. */
  contextEstimate: number;
  /** Model max output tokens. */
  modelMaxTokens: number;
  /** Per-run token limit (from ledger/request). */
  tokenLimit: number;
}

/**
 * Pure predicate: returns true when a new provider turn would exceed the
 * token limit. e.g. the pre-turn `turn_start` handler should abort if this
 * returns true.
 */
export function wouldExceedTokenLimit(input: TokenGuardInput): boolean {
  const values = [input.usedTotal, input.contextEstimate, input.modelMaxTokens, input.tokenLimit];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || !Number.isInteger(value))) return true;
  if (input.modelMaxTokens === 0 || input.tokenLimit === 0) return true;
  const projected = input.usedTotal + input.contextEstimate + input.modelMaxTokens;
  return projected > input.tokenLimit;
}
