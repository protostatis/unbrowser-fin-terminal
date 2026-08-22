/**
 * Pi session usage bridge shared across native ESM and Pi's jiti extension
 * loader. Both loaders have separate module caches, so the collector lives on
 * globalThis inside the one-shot research worker process.
 */

export interface ResearchWorkerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost?: number;
}

export type ResearchWorkerUsageCollector = () => ResearchWorkerUsage | undefined;

type WorkerUsageGlobal = typeof globalThis & {
  __unbrowserFinTerminalWorkerUsageCollector?: ResearchWorkerUsageCollector;
};

const workerUsageGlobal = globalThis as WorkerUsageGlobal;

export function setResearchWorkerUsageCollector(collector: ResearchWorkerUsageCollector | undefined): void {
  workerUsageGlobal.__unbrowserFinTerminalWorkerUsageCollector = collector;
}

export function collectResearchWorkerUsage(): ResearchWorkerUsage | undefined {
  return workerUsageGlobal.__unbrowserFinTerminalWorkerUsageCollector?.();
}

// ── Token-guard bridge ─────────────────────────────────────────────────────
//
// The per-run token guard lives in the worker process (installTokenGuard in
// server/research-worker.ts). It aborts the session on the pre-turn projection
// check, which otherwise surfaces as a generic "no canvas published" failure.
// Expose the trigger through the same globalThis bridge so the settled event
// can carry explicit `tokenGuard: true` telemetry for ledger diagnosis.

export type TokenGuardTriggeredCollector = () => boolean;

type TokenGuardGlobal = typeof globalThis & {
  __unbrowserFinTerminalTokenGuardTriggered?: boolean;
};

const tokenGuardGlobal = globalThis as TokenGuardGlobal;

export function setTokenGuardTriggered(triggered: boolean): void {
  tokenGuardGlobal.__unbrowserFinTerminalTokenGuardTriggered = triggered;
}

export function isTokenGuardTriggered(): boolean {
  return tokenGuardGlobal.__unbrowserFinTerminalTokenGuardTriggered === true;
}
