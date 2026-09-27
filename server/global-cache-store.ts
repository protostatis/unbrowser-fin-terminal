/**
 * Fenced SQLite store for the global research cache.
 *
 * Server-only. Never imported by the browser bundle: the browser terminal
 * stays Pi-free and only reads published entries through an authenticated
 * exact-identity endpoint.
 *
 * Guarantees:
 * - single active writer via lease row with fencing token + expiry
 *   (renewable via renewLease; observable via checkLease);
 * - stale leaders cannot publish (every mutation checks token + expiry);
 * - idempotent publication per cache key (same candidate + generation);
 * - newer entries are never overwritten by older ones; equal-timestamp
 *   conflicts resolve deterministically by last writer.
 */

import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  isGlobalCacheEntryEligible,
  validateGlobalCacheEntry,
  type GlobalCacheEntry,
  type GlobalCacheIdentity,
} from "../shared/global-research-cache.js";

export interface GlobalCacheStoreOptions {
  filePath: string;
  now?: () => number;
  leaseTtlMs?: number;
}

export interface GlobalLease {
  owner: string;
  token: string;
  expiresAt: number;
}

type SqliteStatement = {
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
  run: (...params: unknown[]) => void;
};

type SqliteDatabase = {
  exec: (source: string) => void;
  prepare: (source: string) => SqliteStatement;
  close: () => void;
};

type SqliteModule = {
  DatabaseSync: new (location: string) => SqliteDatabase;
};

let sqliteModulePromise: Promise<SqliteModule> | undefined;

async function loadSqlite(): Promise<SqliteModule> {
  if (!sqliteModulePromise) {
    // Pinned runtime provides node:sqlite; project types stay on Node 20 compat.
    // @ts-expect-error node:sqlite is provided by the pinned Node runtime.
    sqliteModulePromise = import("node:sqlite") as unknown as Promise<SqliteModule>;
  }
  return sqliteModulePromise;
}

const DEFAULT_LEASE_TTL_MS = 60_000;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

function validOwner(owner: string): boolean {
  return typeof owner === "string" && owner.length >= 1 && owner.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(owner);
}

async function openDatabase(filePath: string): Promise<SqliteDatabase> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const { DatabaseSync } = await loadSqlite();
  const database = new DatabaseSync(filePath);
  database.exec("PRAGMA busy_timeout = 15000;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec(
    "CREATE TABLE IF NOT EXISTS global_cache_lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL);",
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS global_cache_entries (cache_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fencing_token TEXT NOT NULL, candidate_id TEXT NOT NULL, generated_at INTEGER NOT NULL);",
  );
  database.exec("CREATE INDEX IF NOT EXISTS idx_global_cache_expires ON global_cache_entries (expires_at);");
  return database;
}

function readLeaseRow(database: SqliteDatabase): GlobalLease | undefined {
  const row = database.prepare("SELECT owner, token, expires_at AS expiresAt FROM global_cache_lease WHERE id = 1;").get();
  if (!row || typeof row.owner !== "string" || typeof row.token !== "string" || typeof row.expiresAt !== "number") {
    return undefined;
  }
  return { owner: row.owner, token: row.token, expiresAt: row.expiresAt };
}

export function createGlobalCacheStore(options: GlobalCacheStoreOptions) {
  const filePath = options.filePath;
  if (!filePath || typeof filePath !== "string") throw new Error("global cache store filePath is required");
  const now = options.now ?? Date.now;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 5_000 || leaseTtlMs > 10 * 60_000) {
    throw new Error("global cache lease TTL must be an integer from 5000 to 600000");
  }
  let tail = Promise.resolve();

  async function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    tail = current;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function acquireLease(owner: string): Promise<{ acquired: boolean; lease?: GlobalLease }> {
    if (!validOwner(owner)) throw new Error("global cache lease owner is invalid");
    return serialized(async () => {
      const database = await openDatabase(filePath);
      try {
        database.exec("BEGIN IMMEDIATE;");
        try {
          const timestamp = now();
          const current = readLeaseRow(database);
          if (current && current.expiresAt > timestamp && current.owner !== owner) {
            database.exec("ROLLBACK;");
            return { acquired: false };
          }
          const lease: GlobalLease = { owner, token: randomUUID().replace(/-/g, ""), expiresAt: timestamp + leaseTtlMs };
          database.prepare(
            "INSERT INTO global_cache_lease (id, owner, token, expires_at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, token = excluded.token, expires_at = excluded.expires_at;",
          ).run(lease.owner, lease.token, lease.expiresAt);
          database.exec("COMMIT;");
          return { acquired: true, lease };
        } catch (error) {
          try {
            database.exec("ROLLBACK;");
          } catch {
            // Ignore rollback failures; close below surfaces the original error.
          }
          throw error;
        }
      } finally {
        database.close();
      }
    });
  }

  async function releaseLease(owner: string, token: string): Promise<boolean> {
    if (!validOwner(owner) || typeof token !== "string" || token.length === 0) return false;
    return serialized(async () => {
      const database = await openDatabase(filePath);
      try {
        database.exec("BEGIN IMMEDIATE;");
        try {
          const current = readLeaseRow(database);
          if (!current || current.owner !== owner || current.token !== token) {
            database.exec("ROLLBACK;");
            return false;
          }
          database.prepare("DELETE FROM global_cache_lease WHERE id = 1;").run();
          database.exec("COMMIT;");
          return true;
        } catch (error) {
          try {
            database.exec("ROLLBACK;");
          } catch {
            // Ignore rollback failures.
          }
          throw error;
        }
      } finally {
        database.close();
      }
    });
  }

  function checkLeader(database: SqliteDatabase, token: string): boolean {
    const current = readLeaseRow(database);
    if (!current || current.token !== token) return false;
    if (current.expiresAt <= now()) return false;
    return true;
  }

  /** Renew our own lease without stealing another owner's live lease. */
  async function renewLease(owner: string, token: string): Promise<{ renewed: boolean; lease?: GlobalLease }> {
    if (!validOwner(owner) || typeof token !== "string" || token.length === 0) return { renewed: false };
    return serialized(async () => {
      const database = await openDatabase(filePath);
      try {
        database.exec("BEGIN IMMEDIATE;");
        try {
          const current = readLeaseRow(database);
          if (!current || current.owner !== owner || current.token !== token) {
            database.exec("ROLLBACK;");
            return { renewed: false };
          }
          const lease: GlobalLease = { owner, token, expiresAt: now() + leaseTtlMs };
          database.prepare("UPDATE global_cache_lease SET expires_at = ? WHERE id = 1;").run(lease.expiresAt);
          database.exec("COMMIT;");
          return { renewed: true, lease };
        } catch (error) {
          try {
            database.exec("ROLLBACK;");
          } catch {
            // Ignore rollback failures.
          }
          throw error;
        }
      } finally {
        database.close();
      }
    });
  }

  /** Non-mutating fencing check for long operations (polling) to abort when fenced out. */
  async function checkLease(token: string): Promise<boolean> {
    const database = await openDatabase(filePath);
    try {
      const current = readLeaseRow(database);
      if (!current || current.token !== token) return false;
      return current.expiresAt > now();
    } finally {
      database.close();
    }
  }

  async function putEntry(token: string, entry: GlobalCacheEntry): Promise<{ ok: boolean; reason?: string; deduplicated?: boolean }> {
    if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing-lease-token" };
    if (!validateGlobalCacheEntry(entry)) return { ok: false, reason: "invalid-entry" };
    if (Buffer.byteLength(JSON.stringify(entry), "utf8") > MAX_ENTRY_BYTES) return { ok: false, reason: "entry-too-large" };
    return serialized(async () => {
      const database = await openDatabase(filePath);
      try {
        database.exec("BEGIN IMMEDIATE;");
        try {
          if (!checkLeader(database, token)) {
            database.exec("ROLLBACK;");
            return { ok: false, reason: "stale-leader" };
          }
          const existing = database
            .prepare("SELECT entry_json AS entryJson, generated_at AS generatedAt, candidate_id AS candidateId FROM global_cache_entries WHERE cache_key = ?;")
            .get(entry.cacheKey) as { entryJson?: unknown; generatedAt?: unknown; candidateId?: unknown } | undefined;
          if (existing && typeof existing.generatedAt === "number") {
            if (existing.generatedAt > entry.generatedAt) {
              database.exec("ROLLBACK;");
              return { ok: false, reason: "stale-entry" };
            }
            if (existing.generatedAt === entry.generatedAt && existing.candidateId === entry.provenance.candidateId) {
              database.exec("ROLLBACK;");
              return { ok: true, deduplicated: true };
            }
          }
          database.prepare(
            "INSERT INTO global_cache_entries (cache_key, entry_json, updated_at, expires_at, fencing_token, candidate_id, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (cache_key) DO UPDATE SET entry_json = excluded.entry_json, updated_at = excluded.updated_at, expires_at = excluded.expires_at, fencing_token = excluded.fencing_token, candidate_id = excluded.candidate_id, generated_at = excluded.generated_at;",
          ).run(
            entry.cacheKey,
            JSON.stringify(entry),
            now(),
            entry.expiresAt,
            token,
            entry.provenance.candidateId,
            entry.generatedAt,
          );
          database.exec("COMMIT;");
          return { ok: true };
        } catch (error) {
          try {
            database.exec("ROLLBACK;");
          } catch {
            // Ignore rollback failures.
          }
          throw error;
        }
      } finally {
        database.close();
      }
    });
  }

  async function getEntry(cacheKey: string): Promise<GlobalCacheEntry | undefined> {
    if (typeof cacheKey !== "string" || cacheKey.length === 0 || cacheKey.length > 512) return undefined;
    const database = await openDatabase(filePath);
    try {
      const row = database
        .prepare("SELECT entry_json AS entryJson FROM global_cache_entries WHERE cache_key = ?;")
        .get(cacheKey) as { entryJson?: unknown } | undefined;
      if (!row || typeof row.entryJson !== "string") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.entryJson);
      } catch {
        return undefined;
      }
      if (!validateGlobalCacheEntry(parsed)) return undefined;
      const entry = parsed as GlobalCacheEntry;
      if (!isGlobalCacheEntryEligible(entry, now())) return undefined;
      return entry;
    } finally {
      database.close();
    }
  }

  async function getEntryByIdentity(identity: GlobalCacheIdentity): Promise<GlobalCacheEntry | undefined> {
    const { globalCacheKey } = await import("../shared/global-research-cache.js");
    return getEntry(globalCacheKey(identity));
  }

  return { acquireLease, releaseLease, renewLease, checkLease, putEntry, getEntry, getEntryByIdentity };
}

export type GlobalCacheStore = ReturnType<typeof createGlobalCacheStore>;
