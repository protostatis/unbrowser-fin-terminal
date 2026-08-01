/**
 * Static replay fixture for the replay-only public demo.
 *
 * The demo build renders this pre-built screen in the same terminal/status/
 * modal visual language as the live build, but it is fully self-contained:
 * no WebSocket, fetch, auth, identity, persistence, redirect, model, or
 * third-party-source request ever runs. Every line is generic, synthetic
 * fixture text with explicit non-financial / no-live / no-third-party-source
 * language.
 *
 * The fixture is validated at module load (validateReplayArtifact below), so a
 * malformed fixture fails fast at import time instead of shipping a broken
 * kiosk. Key evidence invariant: "unavailable" evidence has exactly 0 packets
 * and "claimed" evidence has at least 1.
 */

export type ReplayEvidenceStatus = "unavailable" | "claimed";

export type ReplayRetrievalStatus = "fetched" | "limited" | "failed";

export interface ReplayPacket {
  id: string;
  title: string;
  domain: string;
  retrieval: ReplayRetrievalStatus;
  excerpt: string;
}

export interface ReplayDossier {
  intent: string;
  stage: string;
  evidenceStatus: ReplayEvidenceStatus;
  packets: ReplayPacket[];
}

export interface ReplayDialogCopy {
  title: string;
  lines: string[];
}

export interface ReplayScreen {
  /** Terminal-frame rows, pre-rendered with the tc-* palette classes. */
  rows: string[];
  /** Status-line label shown in the replay chrome. */
  statusLabel: string;
  dossier: ReplayDossier;
  pilot: ReplayDialogCopy;
  sourceLocker: ReplayDialogCopy;
}

/** Human-readable (terminal uppercase) evidence status label. */
export const REPLAY_EVIDENCE_STATUS_LABEL: Record<ReplayEvidenceStatus, string> = {
  unavailable: "UNAVAILABLE",
  claimed: "CLAIMED",
};

/** Human-readable (terminal uppercase) retrieval status label. */
export const REPLAY_RETRIEVAL_STATUS_LABEL: Record<ReplayRetrievalStatus, string> = {
  fetched: "FETCHED",
  limited: "LIMITED",
  failed: "FAILED",
};

/** Explicit disclaimer phrases baked into the fixture rows and dialogs. */
export const REPLAY_DISCLAIMERS = {
  nonFinancial: "Not financial or investment advice.",
  noLive: "Not live data — this screen is frozen.",
  noThirdParty: "No third-party or external sources.",
  noAccount: "No account, workspace, save, or follow is created.",
  noActivation: "This pilot creates no activation.",
} as const;

/* ── HTML-safe row builder (same palette as the live theme) ─────────────── */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap one text run in a `tc tc-*` palette span (all content escaped). */
function tc(cls: string, text: string): string {
  return `<span class="tc ${cls}">${escapeHtml(text)}</span>`;
}

const SCREEN_WIDTH = 92;

function rule(): string {
  return tc("tc-borderMuted", "─".repeat(SCREEN_WIDTH));
}

/** Right-align an optional trailing segment against a fixed screen width. */
function row(left: string, right = ""): string {
  const visible = (html: string) => html.replace(/<[^>]*>/g, "");
  const gap = Math.max(
    0,
    SCREEN_WIDTH - visible(left).length - visible(right).length,
  );
  return `${left}${" ".repeat(gap)}${right}`;
}

/* ── The shipped fixture ──────────────────────────────────────────────────── */

const rows: string[] = [
  row(
    tc("tc-accent", "SIGNAL") + tc("tc-text", " // MARKET TERMINAL"),
    tc("tc-muted", "STATIC DEMO"),
  ),
  tc("tc-success", "● ") +
    tc("tc-muted", "STATIC BUILD · NO LIVE FEED · NO LOGIN · NO SAVE"),
  rule(),
  row(tc("tc-accent", "SAMPLE WATCHLIST"), tc("tc-dim", "/ PILOT PREVIEW")),
  "",
  row(
    tc("tc-text", "AAA ") + tc("tc-muted", "Sample Holding"),
    tc("tc-muted", "--.-- ") + tc("tc-dim", "---- (--.--%)"),
  ),
  row(
    tc("tc-text", "BBB ") + tc("tc-muted", "Sample Materials"),
    tc("tc-muted", "--.-- ") + tc("tc-dim", "---- (--.--%)"),
  ),
  row(
    tc("tc-text", "CCC ") + tc("tc-muted", "Sample Consumer"),
    tc("tc-muted", "--.-- ") + tc("tc-dim", "---- (--.--%)"),
  ),
  row(
    tc("tc-text", "DDD ") + tc("tc-muted", "Sample Technology"),
    tc("tc-muted", "--.-- ") + tc("tc-dim", "---- (--.--%)"),
  ),
  row(
    tc("tc-text", "EEE ") + tc("tc-muted", "Sample Energy"),
    tc("tc-muted", "--.-- ") + tc("tc-dim", "---- (--.--%)"),
  ),
  "",
  rule(),
  row(tc("tc-accent", "SIGNALS"), tc("tc-dim", "See all")),
  tc("tc-muted", "STATIC   ") +
    tc("tc-text", "Sample signal one: frozen fixture text, not a real headline."),
  tc("tc-muted", "FROZEN   ") +
    tc("tc-text", "Sample signal two: this line ships inside the demo build."),
  tc("tc-muted", "DEMO     ") +
    tc("tc-text", "Sample signal three: nothing here was retrieved live."),
  "",
  rule(),
  tc("tc-accent", "ABOUT"),
  tc("tc-text", "This is a static, self-contained demo screen. It renders a"),
  tc("tc-text", "frozen sample layout to preview the terminal experience,"),
  tc("tc-text", "with no backend, no session, and no live data."),
  tc("tc-warning", "> ") + tc("tc-text", REPLAY_DISCLAIMERS.nonFinancial),
  tc("tc-warning", "> ") + tc("tc-text", REPLAY_DISCLAIMERS.noLive),
  tc("tc-warning", "> ") + tc("tc-text", REPLAY_DISCLAIMERS.noThirdParty),
  rule(),
  tc("tc-dim", "[ STATIC DEMO ]") +
    tc("tc-muted", "   no input is sent · ESC closes dialogs"),
];

const dossier: ReplayDossier = {
  intent: "preview",
  stage: "sample",
  // Unavailable evidence — the fixture honestly holds zero packets because the
  // replay build never retrieves or holds any third-party material.
  evidenceStatus: "unavailable",
  packets: [],
};

const pilot: ReplayDialogCopy = {
  title: "STATIC PILOT",
  lines: [
    "This pilot is informational only and renders a frozen sample screen.",
    "It creates no activation, no account, and no workspace.",
    "Nothing is saved, followed, or shared, and no data leaves this page.",
  ],
};

const sourceLocker: ReplayDialogCopy = {
  title: "SOURCE LOCKER",
  lines: [
    "This demo holds no live or third-party sources.",
    "Every line on screen is part of a static, synthetic fixture.",
    "No retrieval, fetch, or external request ever runs.",
  ],
};

/* ── Module-load validation ───────────────────────────────────────────────── */

const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const FORBIDDEN_TAG_RE =
  /<\/?\s*(?:a|script|iframe|img|object|embed|link|meta|style|form|input|button|svg|video|audio|source|base)\b/i;
const FORBIDDEN_ATTR_RE = /\s(?:on\w+|href|src)\s*=/i;
const JAVASCRIPT_URL_RE = /javascript\s*:/i;

const MAX_ROW_LENGTH = 240;
const MAX_ROWS = 64;

/** Markers the fixture's visible screen text must mention explicitly. */
const ROW_REQUIRED_MARKERS = ["advice", "live", "third-party"] as const;
/** The pilot dialog must state exactly what it does not create. */
const PILOT_REQUIRED_MARKERS = [
  "activation",
  "account",
  "workspace",
  "save",
  "follow",
] as const;
/** The source locker dialog must keep the no-third-party / synthetic language. */
const SOURCE_REQUIRED_MARKERS = ["third-party", "synthetic"] as const;

function fail(reason: string): never {
  throw new Error(`Replay artifact validation failed: ${reason}`);
}

/** Strip tags and decode the few entities the fixture uses, for text checks. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function assertBalanced(html: string, reason: string): void {
  const opens = (html.match(/<span\b/g) ?? []).length;
  const closes = (html.match(/<\/span>/g) ?? []).length;
  if (opens !== closes) fail(`${reason}: unbalanced <span>`);
  const strongOpens = (html.match(/<strong\b/g) ?? []).length;
  const strongCloses = (html.match(/<\/strong>/g) ?? []).length;
  if (strongOpens !== strongCloses) fail(`${reason}: unbalanced <strong>`);
}

/**
 * Validate a replay screen, throwing on any structural or content violation.
 *
 * Enforced rules include: rows are non-empty HTML-safe terminal text; packet
 * ids are non-empty, unique, and URL-safe; disclaimer language is explicit;
 * and the evidence invariant holds — `unavailable` evidence has exactly 0
 * packets while `claimed` evidence has at least 1.
 */
export function validateReplayArtifact(screen: ReplayScreen): ReplayScreen {
  /* ── Rows ─────────────────────────────────────────────────────────────── */
  if (
    !Array.isArray(screen.rows) ||
    screen.rows.length === 0 ||
    screen.rows.length > MAX_ROWS
  ) {
    fail(`rows must be a non-empty array of at most ${MAX_ROWS} entries`);
  }
  const screenText: string[] = [];
  screen.rows.forEach((html, index) => {
    if (typeof html !== "string") fail(`row ${index} must be a string`);
    if (html.length > MAX_ROW_LENGTH) {
      fail(`row ${index} exceeds ${MAX_ROW_LENGTH} chars`);
    }
    if (FORBIDDEN_TAG_RE.test(html)) fail(`row ${index} contains a forbidden tag`);
    if (FORBIDDEN_ATTR_RE.test(html)) fail(`row ${index} contains a forbidden attribute`);
    if (JAVASCRIPT_URL_RE.test(html)) fail(`row ${index} contains a javascript: scheme`);
    assertBalanced(html, `row ${index}`);
    if (html.length > 0) {
      const text = visibleText(html).trim();
      if (text.length === 0) fail(`row ${index} has no visible text`);
      screenText.push(text);
    }
  });

  const joinedScreenText = screenText.join(" ").toLowerCase();
  for (const marker of ROW_REQUIRED_MARKERS) {
    if (!joinedScreenText.includes(marker)) {
      fail(`fixture screen text must mention "${marker}"`);
    }
  }

  /* ── Dossier / evidence metadata ──────────────────────────────────────── */
  const dossier = screen.dossier;
  if (!dossier || typeof dossier !== "object") fail("dossier is required");
  if (
    dossier.evidenceStatus !== "unavailable" &&
    dossier.evidenceStatus !== "claimed"
  ) {
    fail(`invalid evidenceStatus "${String(dossier.evidenceStatus)}"`);
  }
  if (typeof dossier.intent !== "string" || dossier.intent.trim() === "") {
    fail("dossier intent is required");
  }
  if (typeof dossier.stage !== "string" || dossier.stage.trim() === "") {
    fail("dossier stage is required");
  }
  if (!Array.isArray(dossier.packets)) fail("dossier packets must be an array");

  if (dossier.evidenceStatus === "unavailable") {
    if (dossier.packets.length !== 0) {
      fail("unavailable evidence must have exactly 0 packets");
    }
  } else if (dossier.packets.length < 1) {
    fail("claimed evidence must have at least 1 packet");
  }

  const ids = new Set<string>();
  dossier.packets.forEach((packet, index) => {
    if (!packet || typeof packet !== "object") {
      fail(`packet ${index} must be an object`);
    }
    if (typeof packet.id !== "string" || !ID_RE.test(packet.id)) {
      fail(`packet ${index} id must be 1-64 URL-safe chars`);
    }
    if (ids.has(packet.id)) fail(`duplicate packet id "${packet.id}"`);
    ids.add(packet.id);
    if (
      typeof packet.title !== "string" ||
      packet.title.trim() === "" ||
      packet.title.length > 120
    ) {
      fail(`packet ${index} needs a non-empty title (≤120 chars)`);
    }
    if (typeof packet.domain !== "string" || !DOMAIN_RE.test(packet.domain)) {
      fail(`packet ${index} domain must be a lowercase dotted domain`);
    }
    if (!REPLAY_RETRIEVAL_STATUS_LABEL[packet.retrieval]) {
      fail(`packet ${index} has an invalid retrieval status`);
    }
    if (
      typeof packet.excerpt !== "string" ||
      packet.excerpt.trim() === "" ||
      packet.excerpt.length > 300
    ) {
      fail(`packet ${index} needs a non-empty excerpt (≤300 chars)`);
    }
  });

  /* ── Dialog copy ──────────────────────────────────────────────────────── */
  const dialogCopies: Array<[string, ReplayDialogCopy, readonly string[]]> = [
    ["pilot", screen.pilot, PILOT_REQUIRED_MARKERS],
    ["sourceLocker", screen.sourceLocker, SOURCE_REQUIRED_MARKERS],
  ];
  for (const [key, copy, markers] of dialogCopies) {
    if (!copy || typeof copy !== "object") fail(`${key} dialog copy is required`);
    if (typeof copy.title !== "string" || copy.title.trim() === "") {
      fail(`${key} dialog needs a title`);
    }
    if (!Array.isArray(copy.lines) || copy.lines.length === 0) {
      fail(`${key} dialog needs body lines`);
    }
    const copyText = copy.lines.join(" ").toLowerCase();
    for (const marker of markers) {
      if (!copyText.includes(marker)) {
        fail(`${key} dialog copy must mention "${marker}"`);
      }
    }
  }

  if (typeof screen.statusLabel !== "string" || screen.statusLabel.trim() === "") {
    fail("statusLabel is required");
  }

  return screen;
}

/* ── Exported fixture (validated at module load) ──────────────────────────── */

export const REPLAY_SCREEN: ReplayScreen = {
  rows,
  statusLabel: "STATIC REPLAY · NO NETWORK",
  dossier,
  pilot,
  sourceLocker,
};

validateReplayArtifact(REPLAY_SCREEN);
