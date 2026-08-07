/**
 * Benchmark the research-agent prompt variants (legacy vs compact).
 *
 * Deterministic, offline: measures the job-instruction context the extension
 * actually owns — character/token size, redundancy, and hard-contract
 * coverage. The Pi system prompt + tool schemas are constant across variants
 * and are reported as the fixed baseline per the advisor's estimate.
 *
 * Token estimate: chars / 4 (English proxy; no tokenizer dependency).
 * Run: npx tsx scripts/benchmark-prompts.ts
 */
import { buildResearchPromptCompact, buildResearchPromptLegacy } from "../.pi/extensions/market-terminal.js";

type JobInput = {
  symbol: string;
  contextLabel: string;
  id: string;
  chartScope: "day" | "week" | "month" | "year" | "max";
  question: string;
  intent: "brief" | "why";
  researchKey: string;
};

const TICKER_BRIEF_QUESTION =
  "Build a source-verified factual brief of the latest company developments and catalysts: what happened, when, key reported numbers, upcoming verified dates, and explicit unknowns.";
const MARKET_STORY_QUESTION =
  "Build a source-verified factual market brief: current leadership, cross-asset moves, consequential developments, verified upcoming catalysts, and explicit unknowns.";

const JOBS: Record<string, JobInput> = {
  "AAPL ticker BRIEF": {
    symbol: "AAPL", contextLabel: "AAPL BRIEF", id: "market-bench-1", chartScope: "day",
    question: TICKER_BRIEF_QUESTION, intent: "brief", researchKey: "v1/ticker/brief",
  },
  "MARKET story BRIEF": {
    symbol: "MARKET", contextLabel: "MARKET STORY BRIEF", id: "market-bench-2", chartScope: "day",
    question: MARKET_STORY_QUESTION, intent: "brief", researchKey: "v1/market/story/brief",
  },
};

function stats(text: string): { chars: number; tokens: number; lines: number } {
  return { chars: text.length, tokens: Math.ceil(text.length / 4), lines: text.split("\n").length };
}

function countOccurrences(text: string, phrase: string): number {
  let count = 0;
  let index = 0;
  const lower = text.toLowerCase();
  const needle = phrase.toLowerCase();
  while ((index = lower.indexOf(needle, index)) !== -1) { count += 1; index += needle.length; }
  return count;
}

const PHRASES = [
  "UNTRUSTED_SOURCE_CONTENT",
  "research_id",
  "never invent",
  "sourceIds",
  "dossierHint",
  "stage=partial",
  "candidates",
  "ta-*",
];

const COMPACT_CONTRACT_CHECKLIST = [
  ["HARD OUTPUT CONTRACT", "hard contract table present"],
  ["scenarios", "scenarios rule present"],
  ["at most 5 non-TA", "block budget"],
  ["exactly 1, first", "read count/order rule"],
  ["freeform content  omit", "freeform banned"],
  ["FAILURE:", "degraded-failure protocol"],
  ["every claim item", "item-level support rule"],
  ["no evidence, no scenarios", "degraded publish constraint"],
] as const;

function coverage(text: string): { met: string[]; missed: string[] } {
  const met: string[] = [];
  const missed: string[] = [];
  for (const [needle, label] of COMPACT_CONTRACT_CHECKLIST) {
    (text.includes(needle) ? met : missed).push(label);
  }
  return { met, missed };
}

const CONSTANT_BASELINE_TOKENS = 4300; // Pi system prompt (~300) + 4 tool guidelines (~700) + 4 schemas (~3300), advisor estimate

console.log("=== Research prompt variants: context benchmark (job-instruction scope) ===\n");

const rows: Array<{ job: string; variant: string; chars: number; tokens: number; lines: number }> = [];
for (const [jobName, job] of Object.entries(JOBS)) {
  for (const [variant, build] of [["legacy", buildResearchPromptLegacy], ["compact", buildResearchPromptCompact]] as const) {
    const text = build(job);
    const s = stats(text);
    rows.push({ job: jobName, variant, ...s });
    console.log(`[${jobName} · ${variant}] ${s.chars} chars · ~${s.tokens} tokens · ${s.lines} lines`);
  }
  const legacy = stats(buildResearchPromptLegacy(job));
  const compact = stats(buildResearchPromptCompact(job));
  const pct = ((legacy.tokens - compact.tokens) / legacy.tokens * 100).toFixed(1);
  console.log(`  → compact saves ${legacy.tokens - compact.tokens} tokens (~${pct}%) on the job instruction`);
  console.log(`  → full worker context (constant baseline ~${CONSTANT_BASELINE_TOKENS} + job): legacy ≈ ${CONSTANT_BASELINE_TOKENS + legacy.tokens}, compact ≈ ${CONSTANT_BASELINE_TOKENS + compact.tokens}\n`);
}

console.log("=== Redundancy (repeat occurrences of key rules within one job instruction) ===\n");
const job = JOBS["AAPL ticker BRIEF"]!;
const legacyText = buildResearchPromptLegacy(job);
const compactText = buildResearchPromptCompact(job);
console.log("phrase                          legacy   compact");
for (const phrase of PHRASES) {
  console.log(`${phrase.padEnd(30)} ${countOccurrences(legacyText, phrase).toString().padEnd(7)} ${countOccurrences(compactText, phrase)}`);
}

console.log("\n=== Hard-contract coverage (compact variant) ===\n");
const c = coverage(compactText);
console.log("met:", c.met.join(", ") || "(none)");
console.log("missed:", c.missed.join(", ") || "(none)");

console.log("\n=== compact-strict delta ===\n");
console.log("Adds a machine-readable first line to market_extract results (not the job prompt):");
console.log('  RESULT status=failed failureCode=EXTRACTOR_UNAVAILABLE retryable=true nextAction=EXTRACT_ALTERNATIVE');
console.log('  RESULT status=fetched failureCode=FETCHED retryable=false nextAction=CONTINUE');
console.log("→ +1 short line per extraction result, enabling a state-machine failure protocol.\n");
