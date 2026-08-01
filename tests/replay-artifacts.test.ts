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
      '<span class="tc tc-accent">SIGNAL</span> <span class="tc tc-text">demo</span>',
      '<span class="tc tc-warning">&gt;</span> <span class="tc tc-text">Not financial or investment advice. Not live data. No third-party or external sources.</span>',
    ],
    statusLabel: "STATIC REPLAY · NO NETWORK",
    dossier: {
      intent: "preview",
      stage: "sample",
      evidenceStatus: "unavailable",
      packets: [],
    },
    pilot: {
      title: "STATIC PILOT",
      lines: [
        "This pilot is informational only. It creates no activation, no account, and no workspace.",
        "Nothing is saved, followed, or shared.",
      ],
    },
    sourceLocker: {
      title: "SOURCE LOCKER",
      lines: [
        "This demo holds no third-party or external sources; it is a synthetic fixture.",
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
  // The fixture is an honest demo: unavailable evidence with zero packets.
  assert.equal(REPLAY_SCREEN.dossier.evidenceStatus, "unavailable");
  assert.equal(REPLAY_SCREEN.dossier.packets.length, 0);
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

test("claimed evidence must have at least one packet", () => {
  const screen = baseScreen({
    dossier: { ...baseScreen().dossier, evidenceStatus: "claimed", packets: [] },
  });
  assert.throws(() => validateReplayArtifact(screen), /claimed evidence must have at least 1 packet/);
});

test("claimed evidence accepts a valid packet list", () => {
  const screen = baseScreen({
    dossier: {
      ...baseScreen().dossier,
      evidenceStatus: "claimed",
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
      evidenceStatus: "claimed",
      packets: [packet, { ...packet }],
    },
  });
  assert.throws(() => validateReplayArtifact(duplicate), /duplicate packet id/);

  const unsafeId = baseScreen({
    dossier: {
      ...baseScreen().dossier,
      evidenceStatus: "claimed",
      packets: [{ ...packet, id: "has space & quote" }],
    },
  });
  assert.throws(() => validateReplayArtifact(unsafeId), /id must be 1-64 URL-safe chars/);

  const emptyId = baseScreen({
    dossier: {
      ...baseScreen().dossier,
      evidenceStatus: "claimed",
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

test("fixture screen text explicitly states non-financial, no-live, no-third-party language", () => {
  const screen = validateReplayArtifact(REPLAY_SCREEN);
  const text = screen.rows.join(" ").toLowerCase();
  for (const marker of ["advice", "live", "third-party"]) {
    assert.equal(text.includes(marker), true, `missing marker "${marker}"`);
  }
});

test("pilot copy states clearly that nothing is created, saved, or followed", () => {
  const screen = validateReplayArtifact(REPLAY_SCREEN);
  const text = screen.pilot.lines.join(" ").toLowerCase();
  for (const marker of ["activation", "account", "workspace", "save", "follow"]) {
    assert.equal(text.includes(marker), true, `missing marker "${marker}"`);
  }
});

test("source locker copy keeps the synthetic no-third-party language", () => {
  const screen = validateReplayArtifact(REPLAY_SCREEN);
  const text = screen.sourceLocker.lines.join(" ").toLowerCase();
  for (const marker of ["third-party", "synthetic"]) {
    assert.equal(text.includes(marker), true, `missing marker "${marker}"`);
  }
});

test("disclaimer phrases are explicit and cover the required promises", () => {
  assert.match(REPLAY_DISCLAIMERS.nonFinancial, /not financial/i);
  assert.match(REPLAY_DISCLAIMERS.noLive, /not live/i);
  assert.match(REPLAY_DISCLAIMERS.noThirdParty, /no third-party/i);
  assert.match(REPLAY_DISCLAIMERS.noAccount, /no account/i);
  assert.match(REPLAY_DISCLAIMERS.noActivation, /no activation/i);
});

test("evidence status labels cover both replay statuses", () => {
  assert.deepEqual(Object.keys(REPLAY_EVIDENCE_STATUS_LABEL).sort(), [
    "claimed",
    "unavailable",
  ]);
  for (const status of ["unavailable", "claimed"] as ReplayEvidenceStatus[]) {
    assert.equal(typeof REPLAY_EVIDENCE_STATUS_LABEL[status], "string");
  }
});
