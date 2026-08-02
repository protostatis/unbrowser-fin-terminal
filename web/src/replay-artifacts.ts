/**
 * Static replay fixture for the replay-only public demo.
 *
 * The demo build renders this pre-built screen in the same terminal/status/
 * modal visual language as the live build, but it is fully self-contained:
 * no WebSocket, fetch, auth, identity, persistence, redirect, model, or
 * third-party-source request ever runs. The shipped frame below was captured
 * from the signed-in terminal's existing Yahoo/Unbrowser-backed data flow and
 * approved as an immutable public replay.
 *
 * The fixture is validated at module load (validateReplayArtifact below), so a
 * malformed fixture fails fast at import time instead of shipping a broken
 * kiosk. Key evidence invariant: "unavailable" evidence has exactly 0 packets;
 * partial and complete evidence retain their captured packets.
 */

export type ReplayEvidenceStatus = "unavailable" | "partial" | "complete";

export type ReplayRetrievalStatus = "fetched" | "limited" | "failed" | "challenged";

export interface ReplayPacket {
  id: string;
  title: string;
  domain: string;
  retrieval: ReplayRetrievalStatus;
  excerpt: string;
  capturedAt?: string;
  note?: string;
  mode?: string;
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
  partial: "PARTIAL",
  complete: "COMPLETE",
};

/** Human-readable (terminal uppercase) retrieval status label. */
export const REPLAY_RETRIEVAL_STATUS_LABEL: Record<ReplayRetrievalStatus, string> = {
  fetched: "FETCHED",
  limited: "LIMITED",
  failed: "FAILED",
  challenged: "CHALLENGED",
};

/** Explicit disclaimer phrases baked into the fixture rows and dialogs. */
export const REPLAY_DISCLAIMERS = {
  nonFinancial: "Not financial or investment advice.",
  noLive: "Not live data — this screen is frozen.",
  captured: "Captured evidence is replayed locally; no source request runs in this demo.",
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

// Captured 2026-08-02 from the authenticated terminal at 202 columns. Keep
// the terminal-produced HTML rather than reformatting it into a mock screen.
const rows = String.raw`<span style="color:rgb(88,166,255);font-weight:700"> SIGNAL </span> <span style="color:rgb(201,209,217);font-weight:700">MARKET ARCADE</span> <span style="color:rgb(110,118,129)">PLAYER 1 · public/delayed MVP</span> <span style="color:rgb(110,118,129)">● UNKNOWN</span> <span style="color:rgb(110,118,129)">DELAYED 1d</span>
<span style="color:rgb(48,54,61)">──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────</span>
<span style="color:rgb(110,118,129)"> QUOTE </span> <span style="color:rgb(88,166,255);background-color:rgb(31,111,235);font-weight:700"> RESEARCH </span>
<span style="color:rgb(110,118,129)"> 1:DAY  2:WEEK </span><span style="color:rgb(88,166,255);background-color:rgb(31,111,235);font-weight:700"> 3:MONTH </span><span style="color:rgb(110,118,129)"> 4:YEAR  5:TOTAL   MONTH QUOTE</span>
&nbsp;
<span style="color:rgb(88,166,255);font-weight:700">DISCOVERY CANVAS · T · BRIEF · MONTH</span>
<span style="color:rgb(201,209,217);font-weight:700">AT&amp;T (T) - BRIEF: Latest Developments &amp; Catalysts</span>
<span style="color:rgb(110,118,129)">COMPLETE · 11 BLOCKS · 6 SOURCES · Updated 8/1/2026, 11:06:41 PM · EVIDENCE PARTIAL</span>
<span style="color:rgb(48,54,61)">──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────</span>
<span style="color:rgb(110,118,129)"> GAAP EPS $0.66                                                   │ Below $31.80B consensus                                          │ Updated Jul 22, 2026; consensus ~$2.31</span>
<span style="color:rgb(201,209,217)"> Q1 2026 EPS  $0.57 vs $0.554 cons                                │ Q4 2025 EPS  $0.52 vs $0.46 cons                                 │ Trailing EPS / P/E  $3.02 / 7.70x</span>
<span style="color:rgb(110,118,129)"> Apr 22, 2026; GAAP $0.54                                         │ Jan 28, 2026; GAAP $0.53                                         │ Forward P/E 9.94</span>
<span style="color:rgb(201,209,217)"> Next earnings (Q3 2026)  approx Oct 2026 (unverified)</span>
<span style="color:rgb(110,118,129)"> Consensus EPS est ~$0.60</span>
&nbsp;
<span style="color:rgb(88,166,255)"> ◆ </span><span style="color:rgb(88,166,255);font-weight:700">EXPLICIT UNKNOWNS &amp; RETRIEVAL GAPS</span>
<span style="color:rgb(201,209,217)"> │ investors.com guidance coverage was BLOCKED (PerimeterX 403) — not bypassed; 2028 guidance detail unverified. No verified fiber/mobility subscriber adds, dividend amount/date, or net-debt figures were retrieved in this brief.</span>
&nbsp;
<span style="color:rgb(88,166,255)"> ∿</span> <span style="color:rgb(201,209,217);font-weight:700">PRICE ACTION · MONTH CHART · 1H BARS</span><span style="color:rgb(110,118,129)"> · T · 1H · Jul 31, 04:00 PM EDT [TA1]</span>
<span style="color:rgb(110,118,129)">      1H close-based  1h bars</span>
<span style="color:rgb(110,118,129)">  $24.67</span> <span style="color:rgb(63,185,80)">                                                  •••••••</span>
<span style="color:rgb(110,118,129)">        </span> <span style="color:rgb(63,185,80)">                                         ••  ••           ••••••</span>
<span style="color:rgb(110,118,129)">        </span> <span style="color:rgb(63,185,80)">             •       ••••••••••  ••••••</span>
<span style="color:rgb(110,118,129)">  $20.14</span> <span style="color:rgb(63,185,80)">     •</span>
<span style="color:rgb(110,118,129)">     EDT Jul 1, 09:30             Jul 16, 14:30             Jul 31, 16:00</span>
<span style="color:rgb(88,166,255)">  ◆ 48-bar close low: $22.84</span>
<span style="color:rgb(88,166,255)">  ◆ 48-bar close high: $25.24</span>
&nbsp;
<span style="color:rgb(88,166,255)"> ▦ </span><span style="color:rgb(88,166,255);font-weight:700">TA HEURISTIC · MONTH · BEARISH · -3/3</span>
<span style="color:rgb(201,209,217)"> Last aligned close  $23.25 [TA1]                                 │ SMA 20 bars  $23.48 [TA1]                                        │ EMA 12 bars  $23.33 [TA1]</span>
<span style="color:rgb(201,209,217)"> EMA 26 bars  $23.54 [TA1]                                        │ RSI 14 bars (Wilder)  38.23 [TA1]                                │ MACD 12/26 bars  -0.208 [TA1]</span>
<span style="color:rgb(201,209,217)"> MACD signal 9 bars  -0.192 [TA1]                                 │ MACD histogram  -0.016 [TA1]                                     │ 1h return  -0.06% [TA1]</span>
&nbsp;
<span style="color:rgb(88,166,255)"> ∿</span> <span style="color:rgb(201,209,217);font-weight:700">TREND DISTANCE · CLOSE VS SMA 20 · MONTH</span><span style="color:rgb(110,118,129)"> · T · 1H · Jul 31, 04:00 PM EDT [TA1]</span>
<span style="color:rgb(110,118,129)">    5.2%</span> <span style="color:rgb(248,81,73)">                          ╱           ╱──    ╱─────</span>
<span style="color:rgb(110,118,129)">    0.0%</span> <span style="color:rgb(110,118,129)">●────────╲─────────╲──────────╲───────────────────────╲─────────</span>
<span style="color:rgb(110,118,129)">   -5.2%</span> <span style="color:rgb(248,81,73)">                                                         ╲─</span>
<span style="color:rgb(110,118,129)">CANVAS 9–46 / 94  [W/S] scroll  [PgUp/PgDn] page</span>
<span style="color:rgb(48,54,61)">──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────</span>
<span style="color:rgb(110,118,129)">T BRIEF COMPLETE · MONTH · 11 BLOCKS</span>
<span style="color:rgb(110,118,129)">D-PAD  [A/D] TAB  [W/S] SCROLL  [TAB] ONE PANE</span>
<span style="color:rgb(110,118,129)">[B] BACK  [Q] QUIT  [J] BRIEF  [K] WHY  [E] WATCH  [R] SYNC</span>`
  .split("\n")
  .map((line) => (line === "&nbsp;" ? "" : line));

const dossier: ReplayDossier = {
  intent: "brief",
  stage: "complete",
  evidenceStatus: "partial",
  packets: [
    { id: "S-e655bc91f423", retrieval: "challenged", domain: "investors.com", capturedAt: "06:05 PM", title: "AT&T Rises On Q4 Earnings Beat, Guidance Through 2028", excerpt: "", note: "Source presented an access challenge", mode: "text_main" },
    { id: "S-30d980f137ae", retrieval: "fetched", domain: "stockanalysis.com", capturedAt: "06:05 PM", title: "AT&T earnings and estimates", excerpt: "Captured terminal excerpt: AT&T (T) closing price $23.27 on 07/31/2026; extended trading data was displayed in the original packet.", mode: "text_main" },
    { id: "S-d9f5bae8a8f5", retrieval: "fetched", domain: "about.att.com", capturedAt: "06:05 PM", title: "AT&T Reports Strong First-Quarter 2026 Financial Results", excerpt: "Captured terminal packet; the original session identified this candidate as non-distinct from the MarketBeat packet.", mode: "text_main" },
    { id: "S-b84bf7ed92af", retrieval: "fetched", domain: "marketbeat.com", capturedAt: "06:05 PM", title: "AT&T (T) Earnings Date and Reports 2026", excerpt: "Captured terminal packet with an extraction-card response. The replay preserves the packet’s presence and retrieval mode without re-fetching it.", mode: "extract_cards" },
  ],
};

const pilot: ReplayDialogCopy = {
  title: "CAPTURED PRODUCT REPLAY",
  lines: [
    "This is a captured terminal brief, replayed locally in the public demo.",
    "Use the signed-in terminal for current data, source checks, and saved work.",
    REPLAY_DISCLAIMERS.noLive,
  ],
};

const sourceLocker: ReplayDialogCopy = {
  title: "SOURCE LOCKER · CAPTURED BRIEF",
  lines: [
    "These packets were captured with the terminal brief and are replayed as approved artifacts.",
    REPLAY_DISCLAIMERS.captured,
    "Retrieval gaps and partial evidence are preserved instead of being hidden.",
  ],
};

/* ── Module-load validation ───────────────────────────────────────────────── */

const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const FORBIDDEN_TAG_RE =
  /<\/?\s*(?:a|script|iframe|img|object|embed|link|meta|style|form|input|button|svg|video|audio|source|base)\b/i;
const FORBIDDEN_ATTR_RE = /\s(?:on\w+|href|src)\s*=/i;
const JAVASCRIPT_URL_RE = /javascript\s*:/i;

// Terminal-produced HTML includes span markup, so a wide captured row is
// longer than its visible 202-column text representation.
const MAX_ROW_LENGTH = 1_000;
const MAX_ROWS = 64;

/** A captured terminal frame must retain both its identity and evidence state. */
const ROW_REQUIRED_MARKERS = ["market arcade", "evidence partial", "t brief"] as const;
/** Replay controls must state that this is captured, not live, content. */
const PILOT_REQUIRED_MARKERS = ["captured", "signed-in", "not live"] as const;
/** The source locker must explain that it replays captured evidence locally. */
const SOURCE_REQUIRED_MARKERS = ["captured", "replayed", "no source request"] as const;

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
 * packets while `partial` and `complete` evidence retain at least 1.
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
  if (!["unavailable", "partial", "complete"].includes(dossier.evidenceStatus)) {
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
    fail(`${dossier.evidenceStatus} evidence must have at least 1 packet`);
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
    if (typeof packet.excerpt !== "string" || packet.excerpt.length > 600) {
      fail(`packet ${index} excerpt must be a string of at most 600 chars`);
    }
    if (packet.excerpt.trim() === "" && packet.retrieval !== "challenged") {
      fail(`packet ${index} needs a non-empty excerpt unless retrieval was challenged`);
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
  statusLabel: "CAPTURED REPLAY · AUG 02 2026 · NO NETWORK",
  dossier,
  pilot,
  sourceLocker,
};

validateReplayArtifact(REPLAY_SCREEN);
