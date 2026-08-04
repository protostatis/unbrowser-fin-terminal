import assert from "node:assert/strict";
import test from "node:test";
import {
  extractSearchCandidates,
  grantAllowedExtractionCandidates,
  type DiscoveryCandidate,
} from "../.pi/extensions/market-terminal.js";
import {
  filterKnownBotWallSources,
  knownBotWallDomainForUrl,
  KNOWN_BOT_WALL_DOMAINS,
} from "../shared/research-source-policy.js";
import { ResearchCandidateRegistry } from "../shared/unbrowser-mcp.js";

test("known bot-wall policy matches exact hosts and subdomains only", () => {
  assert.deepEqual(KNOWN_BOT_WALL_DOMAINS, [
    "reuters.com",
    "seekingalpha.com",
    "spglobal.com",
    "wsj.com",
  ]);
  assert.equal(knownBotWallDomainForUrl("https://www.reuters.com/markets/us/"), "reuters.com");
  assert.equal(knownBotWallDomainForUrl("https://quotes.wsj.com/market-data"), "wsj.com");
  assert.equal(knownBotWallDomainForUrl("https://notreuters.com/article"), undefined);
  assert.equal(knownBotWallDomainForUrl("https://reuters.com.example.test/article"), undefined);
  assert.equal(knownBotWallDomainForUrl("ftp://www.reuters.com/article"), undefined);
  assert.equal(knownBotWallDomainForUrl("not a URL"), undefined);
});

test("known bot-wall filter preserves alternatives and reports excluded coverage", () => {
  const result = filterKnownBotWallSources([
    { title: "Reuters", url: "https://www.reuters.com/markets/us/" },
    { title: "SEC filing", url: "https://www.sec.gov/Archives/example" },
    { title: "S&P Global", url: "https://www.spglobal.com/spdji/en/" },
    { title: "Company IR", url: "https://ir.example.com/news" },
    { title: "Reuters duplicate", url: "https://reuters.com/world/" },
    // These had successful extractions and must not be over-blocked.
    { title: "Yahoo", url: "https://finance.yahoo.com/quote/AMZN/" },
    { title: "Investing", url: "https://www.investing.com/earnings-calendar" },
  ]);

  assert.deepEqual(result.allowed.map((source) => source.title), [
    "SEC filing",
    "Company IR",
    "Yahoo",
    "Investing",
  ]);
  assert.deepEqual(result.blockedDomains, ["reuters.com", "spglobal.com"]);
  assert.equal(result.blockedCount, 3);
});

test("search discovery scans past blocked top results to fill the candidate set", () => {
  const blocked = Array.from({ length: 8 }, (_, index) => ({
    text: `Blocked ${index}`,
    href: `https://www.reuters.com/markets/article-${index}`,
  }));
  const alternatives = Array.from({ length: 8 }, (_, index) => ({
    text: `Alternative ${index}`,
    href: `https://source-${index}.example/report`,
  }));

  const result = extractSearchCandidates([...blocked, ...alternatives], 8);

  assert.equal(result.blockedSourceCount, 8);
  assert.deepEqual(result.blockedDomains, ["reuters.com"]);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.text),
    alternatives.map((candidate) => candidate.text),
  );
});

test("capability issuance excludes blocked sources without spending extraction budget", () => {
  let sequence = 0;
  const registry = new ResearchCandidateRegistry({
    maxExtractions: 4,
    createId: () => `candidate-${++sequence}`,
  });
  const candidates: DiscoveryCandidate[] = [
    {
      id: "blocked",
      title: "Reuters",
      url: "https://www.reuters.com/markets/us/",
      source: "reuters.com",
      status: "search-only",
    },
    ...Array.from({ length: 4 }, (_, index): DiscoveryCandidate => ({
      id: `allowed-${index}`,
      title: `Alternative ${index}`,
      url: `https://source-${index}.example/report`,
      source: `source-${index}.example`,
      status: "search-only",
    })),
  ];

  const granted = grantAllowedExtractionCandidates(registry, "job-1", candidates);

  assert.deepEqual(granted.map((candidate) => candidate.id), [
    "allowed-0",
    "allowed-1",
    "allowed-2",
    "allowed-3",
  ]);
  assert.deepEqual(granted.map((candidate) => candidate.candidateId), [
    "candidate-1",
    "candidate-2",
    "candidate-3",
    "candidate-4",
  ]);
  assert.throws(() => registry.consume("job-1", "blocked"), /Unknown candidate_id/);
  for (const candidate of granted) {
    assert.equal(registry.consume("job-1", candidate.candidateId!).sourceId, candidate.id);
  }
});
