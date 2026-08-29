/**
 * Conformance trace replay validator — Stage 0 of the browser-session
 * migration.
 *
 * Loads the captured fixture (tests/fixtures/pi-trace-v1.jsonl by default),
 * validates every event against `parseConformanceTrace`, and asserts the
 * behavioral invariants a browser adapter must reproduce:
 *
 *   - meta event present (scenario + model + env)
 *   - panel opened and closed around the scenario
 *   - input events include j/k/c/q (research brief, why, cancel, close)
 *   - state snapshots show one complete BRIEF job, one complete WHY job,
 *     and one cancelled job (research / researchQueue / recentResearch)
 *   - usage accounting recorded at least once
 *   - archive event recorded at least once
 *
 * Exit 0 on pass; non-zero with a clear message on failure.
 *
 * Usage:  npx tsx scripts/replay-pi-trace.ts [path-to-fixture]
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseConformanceTrace,
  type ConformanceTraceEvent,
} from "../shared/conformance-trace.js";

const DEFAULT_FIXTURE = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "pi-trace-v1.jsonl"),
);

type ResearchJob = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect research jobs from a state payload (research / researchQueue / recentResearch). */
function jobsFromState(payload: Record<string, unknown>): ResearchJob[] {
  const out: ResearchJob[] = [];
  const collect = (value: unknown) => {
    if (isRecord(value)) out.push(value);
    if (Array.isArray(value)) for (const item of value) if (isRecord(item)) out.push(item);
  };
  collect(payload.research);
  collect(payload.researchQueue);
  collect(payload.recentResearch);
  return out;
}

function jobOutcomes(events: ConformanceTraceEvent[]): Map<string, Set<string>> {
  const byLabel = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== "state") continue;
    for (const job of jobsFromState(event.payload)) {
      const label = String(job.contextLabel ?? job.id ?? "?");
      const outcome = String(job.outcome ?? "?");
      if (!byLabel.has(label)) byLabel.set(label, new Set());
      byLabel.get(label)!.add(outcome);
    }
  }
  return byLabel;
}

function fail(message: string, extra?: string): never {
  console.error(`[replay] FAIL: ${message}`);
  if (extra) console.error(extra);
  process.exit(1);
}

async function main(): Promise<void> {
  const fixtureArg = process.argv[2]?.trim();
  const fixturePath = fixtureArg ? path.resolve(fixtureArg) : DEFAULT_FIXTURE;

  let text: string;
  try {
    text = await readFile(fixturePath, "utf8");
  } catch (error) {
    fail(`cannot read fixture at ${fixturePath}`, error instanceof Error ? error.message : String(error));
  }

  const { events, error } = parseConformanceTrace(text);
  if (error) fail(`invalid trace: ${error}`, `file: ${fixturePath}`);
  if (events.length === 0) fail("trace contains no events");

  const kinds = new Map<string, number>();
  for (const event of events) kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);

  const inputs = events.filter((event) => event.kind === "input").map((event) => String(event.payload.data ?? ""));
  const outcomes = jobOutcomes(events);

  // ── Invariants ────────────────────────────────────────────────────────────

  const meta = events.find((event) => event.kind === "meta");
  if (!meta) fail("missing meta event");
  if (!meta.payload.scenario || !meta.payload.model) fail("meta event missing scenario/model");
  if (meta.payload.captureVersion === undefined) fail("meta event missing captureVersion");

  const panelOpened = events.some((event) => event.kind === "panel" && event.payload.opened === true);
  if (!panelOpened) fail("no panel-open event recorded");

  const requiredInputs = ["j", "k", "c", "q"];
  const missingInputs = requiredInputs.filter((key) => !inputs.includes(key));
  if (missingInputs.length > 0) fail(`input events missing keys: ${missingInputs.join(", ")}`);

  const briefComplete = outcomes.get("AAPL BRIEF")?.has("complete") ?? false;
  const whyComplete = outcomes.get("AAPL WHY")?.has("complete") ?? false;
  const cancelled = [...outcomes.values()].some((set) => set.has("cancelled"));
  if (!briefComplete) fail("no complete BRIEF job found in state snapshots (expected contextLabel \"AAPL BRIEF\" with outcome complete)");
  if (!whyComplete) fail("no complete WHY job found in state snapshots (expected contextLabel \"AAPL WHY\" with outcome complete)");
  if (!cancelled) fail("no cancelled job found in state snapshots (expected outcome cancelled)");

  if (!events.some((event) => event.kind === "usage")) fail("no usage event recorded");
  if (!events.some((event) => event.kind === "archive")) fail("no archive event recorded");
  if (!events.some((event) => event.kind === "settle")) fail("no settle event recorded");

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`[replay] fixture: ${fixturePath}`);
  console.log(`[replay] events: ${events.length}`);
  console.log("[replay] kinds:", [...kinds.entries()].map(([kind, count]) => `${kind}=${count}`).join(" "));
  console.log(`[replay] inputs: ${inputs.join(" ")}`);
  for (const [label, set] of outcomes) {
    console.log(`[replay] job ${label}: ${[...set].sort().join(",")}`);
  }
  console.log("[replay] PASS");
  process.exit(0);
}

main().catch((error) => {
  console.error("[replay] FAILED:", error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
