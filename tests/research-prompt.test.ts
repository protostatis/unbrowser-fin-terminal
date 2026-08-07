import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResearchPrompt,
  buildResearchPromptCompact,
  buildResearchPromptLegacy,
  readResearchPromptVariant,
  type ResearchPromptJob,
} from "../.pi/extensions/market-terminal.js";

const JOB: ResearchPromptJob = {
  symbol: "AAPL",
  contextLabel: "AAPL BRIEF",
  id: "market-test-1",
  chartScope: "day",
  question: "Build a source-verified factual brief of the latest company developments and catalysts.",
  intent: "brief",
  researchKey: "v1/ticker/brief",
};

test("legacy prompt preserves the historical prose contract", () => {
  const prompt = buildResearchPromptLegacy(JOB);
  assert.match(prompt, /Research AAPL for the open market terminal\. Mode: BRIEF/);
  assert.match(prompt, /Include research_id=market-test-1 in every market_discover and market_canvas call/);
  assert.match(prompt, /at most five total non-technical blocks/);
  assert.match(prompt, /UNTRUSTED_SOURCE_CONTENT/);
  assert.match(prompt, /dossierHint/);
  assert.doesNotMatch(prompt, /HARD OUTPUT CONTRACT/);
});

test("compact prompt leads with a hard output contract", () => {
  const prompt = buildResearchPromptCompact(JOB);
  const lines = prompt.split("\n");
  assert.equal(lines[0]!.startsWith("ROLE:"), true);
  const contractIndex = lines.findIndex((line) => line.startsWith("HARD OUTPUT CONTRACT"));
  assert.ok(contractIndex >= 0, "contract present");
  assert.ok(contractIndex < 10, "contract is near the top");
  assert.match(prompt, /scenarios\s+FORBIDDEN in BRIEF/);
  assert.match(prompt, /at most 5 non-TA blocks/);
  assert.match(prompt, /dossierHint=read/);
  assert.match(prompt, /FAILURE:/);
  assert.match(prompt, /No evidence, no scenarios, no citations/);
  assert.doesNotMatch(prompt, /dossierHint.*the terminal shows the answer first/);
});

test("compact prompt is substantially smaller than legacy on the same job", () => {
  const legacy = buildResearchPromptLegacy(JOB);
  const compact = buildResearchPromptCompact(JOB);
  assert.ok(compact.length < legacy.length * 0.65, `compact should be <65% of legacy (${compact.length}/${legacy.length})`);
});

test("research prompt variants are env-selected", () => {
  const previous = process.env.MARKET_RESEARCH_PROMPT;
  try {
    delete process.env.MARKET_RESEARCH_PROMPT;
    assert.equal(readResearchPromptVariant(), "legacy");
    process.env.MARKET_RESEARCH_PROMPT = "compact";
    assert.equal(readResearchPromptVariant(), "compact");
    assert.equal(buildResearchPrompt(JOB), buildResearchPromptCompact(JOB));
    process.env.MARKET_RESEARCH_PROMPT = "compact-strict";
    assert.equal(readResearchPromptVariant(), "compact-strict");
    assert.equal(buildResearchPrompt(JOB), buildResearchPromptCompact(JOB));
    process.env.MARKET_RESEARCH_PROMPT = "legacy";
    assert.equal(buildResearchPrompt(JOB), buildResearchPromptLegacy(JOB));
    process.env.MARKET_RESEARCH_PROMPT = "banana";
    assert.throws(() => readResearchPromptVariant(), /MARKET_RESEARCH_PROMPT/);
  } finally {
    if (previous === undefined) delete process.env.MARKET_RESEARCH_PROMPT;
    else process.env.MARKET_RESEARCH_PROMPT = previous;
  }
});
