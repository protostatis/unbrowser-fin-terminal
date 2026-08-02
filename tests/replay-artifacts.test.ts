import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLAY_DISCLAIMERS,
  REPLAY_EVIDENCE_STATUS_LABEL,
  REPLAY_SCREEN,
  validateReplayArtifact,
  type ReplayEvidenceStatus,
  type ReplayScreen,
} from "../web/src/replay-artifacts.js";

/** Build a minimal valid screen so each test mutates exactly one rule. */
function baseScreen(overrides: Partial<ReplayScreen> = {}): ReplayScreen {
  return {
    rows: [
      '<span class="tc tc-accent">MARKET ARCADE</span> <span class="tc tc-text">demo</span>',
      '<span class="tc tc-warning">&gt;</span> <span class="tc tc-text">T BRIEF · EVIDENCE PARTIAL</span>',
    ],
    statusLabel: "STATIC REPLAY · NO NETWORK",
    dossier: {
      intent: "preview",
      stage: "sample",
      evidenceStatus: "unavailable",
      sourceCount: 10,
      packets: [],
    },
    pilot: {
      title: "CAPTURED PRODUCT REPLAY",
      lines: [
        "This captured replay opens the signed-in terminal for current work.",
        "It is not live data.",
      ],
    },
    sourceLocker: {
      title: "SOURCE LOCKER · CAPTURED BRIEF",
      lines: [
        "Captured evidence is replayed locally; no source request runs in this demo.",
      ],
    },
    ...overrides,
  };
}

test("the shipped fixture passes module-load validation", () => {
  // Importing REPLAY_SCREEN already ran validateReplayArtifact at module load;
  // run it again explicitly so the shipped rows and metadata are checked.
  assert.doesNotThrow(() => validateReplayArtifact(REPLAY_SCREEN));
  assert.equal(REPLAY_SCREEN.rows.length > 0, true);
  assert.equal(REPLAY_SCREEN.dossier.evidenceStatus, "partial");
  assert.equal(REPLAY_SCREEN.dossier.packets.length, 4);
  assert.equal(REPLAY_SCREEN.dossier.sourceCount, 6);
});

test("unavailable evidence must have exactly zero packets", () => {
  const screen = baseScreen({
    dossier: {
      ...baseScreen().dossier,
      evidenceStatus: "unavailable",
      packets: [
        {
          id: "sample-source-01",
          title: "Sample synthetic source",
          domain: "synthetic.example",
          retrieval: "fetched",
          excerpt: "Synthetic fixture excerpt with no real content.",
        },
      ],
    },
  });
  assert.throws(() => validateReplayArtifact(screen), /unavailable evidence must have exactly 0 packets/);
});

test("partial evidence must have at least one packet", () => {
  const screen = baseScreen({
    dossier: { ...baseScreen().dossier, evidenceStatus: "partial", packets: [] },
  });
  assert.throws(() => validateReplayArtifact(screen), /partial evidence must have at least 1 packet/);
});

test("partial evidence accepts a valid packet list", () => {
  const screen = baseScreen({
    dossier: {
      ...baseScreen().dossier,
      evidenceStatus: "partial",
      packets: [
        {
          id: "sample-source-01",
          title: "Sample synthetic source",
          domain: "synthetic.example",
          retrieval: "fetched",
          excerpt: "Synthetic fixture excerpt with no real content.",
        },
      ],
    },
  });
  assert.doesNotThrow(() => validateReplayArtifact(screen));
});

test("packet ids must be non-empty, unique, and URL-safe", () => {
  const packet = {
    id: "sample-source-01",
    title: "Sample synthetic source",
    domain: "synthetic.example",
    retrieval: "fetched",
    excerpt: "Synthetic fixture excerpt with no real content.",
  } as const;

  const duplicate = baseScreen({
    dossier: {
      ...baseScreen().dossier,
      evidenceStatus: "partial",
      packets: [packet, { ...packet }],
    },
  });
  assert.throws(() => validateReplayArtifact(duplicate), /duplicate packet id/);

  const unsafeId = baseScreen({
    dossier: {
      ...baseScreen().dossier,
      evidenceStatus: "partial",
      packets: [{ ...packet, id: "has space & quote" }],
    },
  });
  assert.throws(() => validateReplayArtifact(unsafeId), /id must be 1-64 URL-safe chars/);

  const emptyId = baseScreen({
    dossier: {
      ...baseScreen().dossier,
      evidenceStatus: "partial",
      packets: [{ ...packet, id: "" }],
    },
  });
  assert.throws(() => validateReplayArtifact(emptyId), /id must be 1-64 URL-safe chars/);
});

test("rows must be non-empty HTML-safe terminal text", () => {
  const scriptRow = baseScreen({
    rows: [
      '<script>alert("x")</script>',
      '<span class="tc tc-text">safe</span>',
    ],
  });
  assert.throws(() => validateReplayArtifact(scriptRow), /forbidden tag/);

  const linkRow = baseScreen({
    rows: [
      '<span class="tc tc-text">text</span> <a href="https://evil.example">x</a>',
      '<span class="tc tc-text">safe</span>',
    ],
  });
  assert.throws(() => validateReplayArtifact(linkRow), /forbidden tag/);

  const emptyRows = baseScreen({ rows: [] });
  assert.throws(() => validateReplayArtifact(emptyRows), /rows must be a non-empty array/);

  const noVisibleText = baseScreen({ rows: ["<span class=\"tc tc-text\">   </span>"] });
  assert.throws(() => validateReplayArtifact(noVisibleText), /no visible text/);

  const unbalanced = baseScreen({
    rows: ['<span class="tc tc-text">open', '<span class="tc tc-text">safe</span>'],
  });
  assert.throws(() => validateReplayArtifact(unbalanced), /unbalanced <span>/);
});

test("fixture screen retains the captured terminal and evidence identifiers", () => {
  const screen = validateReplayArtifact(REPLAY_SCREEN);
  const text = screen.rows.join(" ").toLowerCase();
  for (const marker of ["market arcade", "evidence partial", "t brief"]) {
    assert.equal(text.includes(marker), true, `missing marker "${marker}"`);
  }
});

test("pilot copy states that the product frame is captured and not live", () => {
  const screen = validateReplayArtifact(REPLAY_SCREEN);
  const text = screen.pilot.lines.join(" ").toLowerCase();
  for (const marker of ["captured", "signed-in", "not live"]) {
    assert.equal(text.includes(marker), true, `missing marker "${marker}"`);
  }
});

test("source locker copy explains that evidence is replayed locally", () => {
  const screen = validateReplayArtifact(REPLAY_SCREEN);
  const text = screen.sourceLocker.lines.join(" ").toLowerCase();
  for (const marker of ["captured", "replayed", "no source request"]) {
    assert.equal(text.includes(marker), true, `missing marker "${marker}"`);
  }
});

test("disclaimer phrases identify the frozen replay boundary", () => {
  assert.match(REPLAY_DISCLAIMERS.nonFinancial, /not financial/i);
  assert.match(REPLAY_DISCLAIMERS.noLive, /not live/i);
  assert.match(REPLAY_DISCLAIMERS.captured, /replayed locally/i);
});

test("evidence status labels cover replay completeness states", () => {
  assert.deepEqual(Object.keys(REPLAY_EVIDENCE_STATUS_LABEL).sort(), [
    "complete",
    "partial",
    "unavailable",
  ]);
  for (const status of ["unavailable", "partial", "complete"] as ReplayEvidenceStatus[]) {
    assert.equal(typeof REPLAY_EVIDENCE_STATUS_LABEL[status], "string");
  }
});
