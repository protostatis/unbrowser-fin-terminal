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
