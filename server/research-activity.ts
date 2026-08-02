/** Trusted research-progress detection shared by a worker and its gateway. */

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function activeJob(value: unknown): boolean {
  const job = record(value);
  if (!job) return false;
  if (job.active === true) return true;
  return job.phase === "queued" || job.phase === "dispatched"
    || job.phase === "running" || job.phase === "cancelling";
}

export function hasActiveResearchState(value: unknown): boolean {
  const state = record(value);
  if (!state) return false;
  if (activeJob(state.research)) return true;
  return Array.isArray(state.researchQueue) && state.researchQueue.some(activeJob);
}

export function isActiveResearchFramePayload(text: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return false;
  }
  const frame = record(message);
  return frame?.type === "frame" && hasActiveResearchState(frame.state);
}
