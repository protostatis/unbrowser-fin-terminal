import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TerminalFrame } from "./TerminalFrame";

type PreviewState =
  | "entry"
  | "waiting"
  | "running"
  | "result"
  | "claim"
  | "claiming"
  | "auth"
  | "importing"
  | "ended"
  | "private"
  | "workspace"
  | "cancelled"
  | "expired"
  | "unavailable"
  | "error";

type TerminalStage = "running" | "result" | "private";
type CartridgeKind =
  | "claim"
  | "claiming"
  | "auth"
  | "importing"
  | "ended"
  | "private"
  | "cancelled"
  | "expired"
  | "unavailable"
  | "error";
type AccountMode = "new" | "existing";
type Tone = "accent" | "text" | "muted" | "dim" | "success" | "error" | "warning" | "borderMuted";

const PREVIEW_STATES: ReadonlyArray<{ id: PreviewState; label: string }> = [
  { id: "entry", label: "Entry" },
  { id: "waiting", label: "Waiting" },
  { id: "running", label: "Running" },
  { id: "result", label: "Result" },
  { id: "claim", label: "Claim" },
  { id: "claiming", label: "Securing" },
  { id: "auth", label: "Auth" },
  { id: "importing", label: "Import" },
  { id: "ended", label: "Ended" },
  { id: "private", label: "Private" },
  { id: "workspace", label: "Workspace" },
  { id: "cancelled", label: "Cancelled" },
  { id: "expired", label: "Expired" },
  { id: "unavailable", label: "Unavailable" },
  { id: "error", label: "Error" },
];

const VALID_STATES = new Set<PreviewState>(PREVIEW_STATES.map(({ id }) => id));

function stateFromLocation(): PreviewState {
  const requested = new URLSearchParams(window.location.search).get("state") as PreviewState | null;
  return requested && VALID_STATES.has(requested) ? requested : "result";
}

function cleanPreview(): boolean {
  return new URLSearchParams(window.location.search).get("clean") === "1";
}

function accountFromLocation(): AccountMode {
  return new URLSearchParams(window.location.search).get("account") === "existing"
    ? "existing"
    : "new";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function segment(text: string, tone: Tone = "text", strong = false): string {
  const content = strong ? `<strong>${escapeHtml(text)}</strong>` : escapeHtml(text);
  return `<span class="tc tc-${tone}">${content}</span>`;
}

function divider(character = "─", width = 124): string {
  return segment(character.repeat(width), "borderMuted");
}

function terminalRows(stage: TerminalStage, accountMode: AccountMode): string[] {
  const running = stage === "running";
  const privateWorkspace = stage === "private";
  const ledgerBalance = accountMode === "new" ? "$1.00" : "$3.42";
  const statusTone: Tone = running ? "warning" : "success";
  const status = running ? "SYNTHESIZING" : "COMPLETE";
  const timestamp = running ? "14:36:42" : "14:37:18";

  return [
    `${segment("MARKET MAP", "accent", true)}${segment("  /  ", "dim")}${segment("AAPL", "text", true)}${segment("  /  DISCOVERY CANVAS  /  DAY", "muted")}                                      ${segment(`${timestamp} UTC`, "dim")}`,
    divider(),
    `${segment("AAPL", "accent", true)}  ${segment("APPLE INC", "text", true)}                ${segment("209.47", "text", true)}   ${segment("-4.36  -2.04%", "error")}       ${segment("VOL  61.2M", "muted")}       ${segment("NASDAQ", "dim")}`,
    `${segment("RANGE", "dim")}  206.31 ├──────────────────────────────●────────┤ 214.62      ${segment("AFTER HOURS  209.81  +0.16%", "muted")}`,
    "",
    `${segment("DISCOVERY CANVAS", "accent", true)}  ${segment("AAPL EARNINGS-DROP RE-RATING", "text", true)}`,
    `${segment(status, statusTone, true)}  ${segment("·", "dim")}  ${segment(running ? "08 BLOCKS" : "12 BLOCKS", "text")}  ${segment("·", "dim")}  ${segment(running ? "7 / 9 SOURCES" : "9 SOURCES", "text")}  ${segment("·", "dim")}  ${segment(running ? "EVIDENCE BUILDING" : "EVIDENCE AVAILABLE", statusTone)}`,
    divider("═"),
    `${segment("THE READ", "accent", true)}  ${segment("01", "dim")}`,
    "",
    `${segment("POST-EARNINGS RESET LOOKS MORE LIKE MULTIPLE COMPRESSION THAN AN ESTIMATE BREAK", "text", true)}`,
    `${segment("Apple cleared the quarter, but the tape repriced the durability of Services growth and the", "muted")}`,
    `${segment("near-term cost of the AI infrastructure cycle. The drawdown is consistent with a higher", "muted")}`,
    `${segment("discount rate on unchanged cash-flow expectations—not a new demand shock.", "muted")}`,
    "",
    `${segment("BASE CASE", "accent", true)}   ${segment("Range-bound re-rating", "text")}       ${segment("CONFIDENCE  68%", "success")}`,
    `${segment("BULL CASE", "success", true)}   ${segment("Services acceleration absorbs capex anxiety", "text")}`,
    `${segment("BEAR CASE", "error", true)}   ${segment("Margin guide turns AI spend into an earnings revision cycle", "text")}`,
    "",
    divider(),
    `${segment("EVIDENCE MATRIX", "accent", true)}                                       ${segment(running ? "FETCHING  07 / 09" : "VERIFIED  09 / 09", statusTone, true)}`,
    `${segment("01", "dim")}  ${segment("FETCHED", "success")}   investor.apple.com   ${segment("Q3 FY26 results and prepared remarks", "text")}                  ${segment("PRIMARY", "muted")}`,
    `${segment("02", "dim")}  ${segment("FETCHED", "success")}   sec.gov              ${segment("10-Q: revenue mix, margins, and capital commitments", "text")}  ${segment("PRIMARY", "muted")}`,
    `${segment("03", "dim")}  ${segment("FETCHED", "success")}   reuters.com          ${segment("Apple shares fall as capex outlook resets expectations", "text")} ${segment("NEWS", "muted")}`,
    `${segment("04", "dim")}  ${segment("FETCHED", "success")}   bloomberg.com        ${segment("Services print offsets a cautious expense guide", "text")}       ${segment("NEWS", "muted")}`,
    `${segment("05", "dim")}  ${segment(running ? "READING" : "FETCHED", running ? "warning" : "success")}   finance.yahoo.com   ${segment("Call transcript: management Q&A on AI investment", "text")}     ${segment("TRANSCRIPT", "muted")}`,
    `${segment("06", "dim")}  ${segment(running ? "QUEUED" : "FETCHED", running ? "dim" : "success")}   wsj.com              ${segment("Investor response to the post-print valuation reset", "text")}    ${segment("NEWS", "muted")}`,
    "",
    divider(),
    `${segment("CATALYST TRACK", "accent", true)}  ${segment("NEXT 30 DAYS", "dim")}`,
    `${segment("AUG 07", "warning", true)}  ${segment("10-Q filing detail", "text")}                 ${segment("Watch capex commitments and geographic revenue mix", "muted")}`,
    `${segment("AUG 13", "muted", true)}  ${segment("US CPI", "text")}                            ${segment("Sensitivity: long-duration multiple / megacap basket", "muted")}`,
    `${segment("SEP 09", "muted", true)}  ${segment("Product event window", "text")}               ${segment("Watch device mix and on-device AI positioning", "muted")}`,
    "",
    `${segment("INVALIDATION", "error", true)}  ${segment("Forward gross-margin guide below 45.0%, or Services growth decelerates below 10%.", "text")}`,
    `${segment("CONFIRMATION", "success", true)}  ${segment("Two closes above 214.60 with upward FY27 EPS revisions.", "text")}`,
    "",
    divider(),
    privateWorkspace
      ? `${segment("WORKSPACE", "success", true)}  ${segment("PRIVATE / SAVED", "text")}     ${segment(`LEDGER  ${ledgerBalance}`, "success")}     ${segment("COMPUTE  SLEEPS WHEN IDLE", "muted")}`
      : `${segment("PUBLIC SESSION", "accent", true)}  ${segment("AAPL BRIEF", "text")}     ${segment(running ? "RESEARCH IN PROGRESS" : "RESULT READY", statusTone)}     ${segment("NOT FINANCIAL ADVICE", "dim")}`,
    `${segment("COMMAND", "dim")}  ${segment("[↑↓] NAVIGATE", "muted")}  ${segment("[ENTER] OPEN", "muted")}  ${segment("[R] RESEARCH", "muted")}  ${segment("[E] EVIDENCE", "muted")}  ${segment("[?] HELP", "muted")}`,
  ];
}

/**
 * Isolated, fixture-only implementation handoff for public-result conversion.
 * This component does not import admission, auth, billing, gateway, or socket code.
 */
export function PublicConversionPreview() {
  const [state, setState] = useState<PreviewState>(stateFromLocation);
  const [accountMode, setAccountMode] = useState<AccountMode>(accountFromLocation);
  const accountModeRef = useRef(accountMode);
  const claimTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreClaimFocusRef = useRef(false);
  const clean = cleanPreview();
  accountModeRef.current = accountMode;

  const go = useCallback((next: PreviewState, nextAccountMode?: AccountMode) => {
    const resolvedAccountMode = nextAccountMode ?? accountModeRef.current;
    accountModeRef.current = resolvedAccountMode;
    setState(next);
    setAccountMode(resolvedAccountMode);
    const url = new URL(window.location.href);
    url.searchParams.set("state", next);
    url.searchParams.set("account", resolvedAccountMode);
    window.history.replaceState({}, "", url);
  }, []);

  const dismissToResult = useCallback(() => {
    restoreClaimFocusRef.current = true;
    go("result");
  }, [go]);

  useEffect(() => {
    const onPopState = () => {
      const nextAccountMode = accountFromLocation();
      accountModeRef.current = nextAccountMode;
      setAccountMode(nextAccountMode);
      setState(stateFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (state !== "result" || !restoreClaimFocusRef.current) return;
    restoreClaimFocusRef.current = false;
    requestAnimationFrame(() => claimTriggerRef.current?.focus({ preventScroll: true }));
  }, [state]);

  return (
    <div
      className="conversion-preview"
      data-preview-state={state}
      data-preview-clean={clean ? "true" : "false"}
    >
      {!clean && <PreviewSwitcher state={state} onChange={go} />}

      {state === "entry" && (
        <AdmissionScreen
          mode="entry"
          onChange={go}
          onExistingSignIn={() => go("workspace", "existing")}
        />
      )}
      {state === "waiting" && (
        <AdmissionScreen
          mode="waiting"
          onChange={go}
          onExistingSignIn={() => go("workspace", "existing")}
        />
      )}
      {state === "running" && (
        <TerminalShell stage="running" accountMode={accountMode} onClaim={() => go("claim")} />
      )}
      {state === "result" && (
        <TerminalShell
          stage="result"
          accountMode={accountMode}
          onClaim={() => go("claim")}
          claimTriggerRef={claimTriggerRef}
        />
      )}
      {state === "claim" && (
        <TerminalShell stage="result" accountMode={accountMode} onClaim={() => go("claim")}>
          <WorkspaceCartridge
            kind="claim"
            accountMode={accountMode}
            onChange={go}
            onDismissResult={dismissToResult}
          />
        </TerminalShell>
      )}
      {state === "claiming" && (
        <TerminalShell stage="result" accountMode={accountMode} onClaim={() => go("claim")}>
          <WorkspaceCartridge
            kind="claiming"
            accountMode={accountMode}
            onChange={go}
            onDismissResult={dismissToResult}
          />
        </TerminalShell>
      )}
      {state === "auth" && (
        <TerminalShell stage="result" accountMode={accountMode} onClaim={() => go("claim")}>
          <WorkspaceCartridge
            kind="auth"
            accountMode={accountMode}
            onChange={go}
            onDismissResult={dismissToResult}
          />
        </TerminalShell>
      )}
      {state === "importing" && (
        <TerminalShell stage="private" accountMode={accountMode} onClaim={() => go("claim")}>
          <WorkspaceCartridge
            kind="importing"
            accountMode={accountMode}
            onChange={go}
            onDismissResult={dismissToResult}
          />
        </TerminalShell>
      )}
      {state === "ended" && (
        <TerminalShell stage="result" accountMode={accountMode} muted onClaim={() => go("claim")}>
          <WorkspaceCartridge
            kind="ended"
            accountMode={accountMode}
            onChange={go}
            onDismissResult={dismissToResult}
          />
        </TerminalShell>
      )}
      {state === "private" && (
        <TerminalShell stage="private" accountMode={accountMode} onClaim={() => go("claim")}>
          <WorkspaceCartridge
            kind="private"
            accountMode={accountMode}
            onChange={go}
            onDismissResult={dismissToResult}
          />
        </TerminalShell>
      )}
      {state === "workspace" && (
        <TerminalShell stage="private" accountMode={accountMode} onClaim={() => go("claim")} />
      )}
      {state === "cancelled" && (
        <TerminalShell stage="result" accountMode={accountMode} onClaim={() => go("claim")}>
          <WorkspaceCartridge
            kind="cancelled"
            accountMode={accountMode}
            onChange={go}
            onDismissResult={dismissToResult}
          />
        </TerminalShell>
      )}
      {state === "expired" && (
        <TerminalShell stage="result" accountMode={accountMode} onClaim={() => go("claim")}>
          <WorkspaceCartridge
            kind="expired"
            accountMode={accountMode}
            onChange={go}
            onDismissResult={dismissToResult}
          />
        </TerminalShell>
      )}
      {state === "unavailable" && (
        <TerminalShell stage="result" accountMode={accountMode} muted onClaim={() => go("claim")}>
          <WorkspaceCartridge
            kind="unavailable"
            accountMode={accountMode}
            onChange={go}
            onDismissResult={dismissToResult}
          />
        </TerminalShell>
      )}
      {state === "error" && (
        <TerminalShell stage="private" accountMode={accountMode} onClaim={() => go("claim")}>
          <WorkspaceCartridge
            kind="error"
            accountMode={accountMode}
            onChange={go}
            onDismissResult={dismissToResult}
          />
        </TerminalShell>
      )}
    </div>
  );
}

function PreviewSwitcher({
  state,
  onChange,
}: {
  state: PreviewState;
  onChange: (state: PreviewState) => void;
}) {
  return (
    <nav className="conversion-preview-switcher" aria-label="Preview state selector">
      <span className="conversion-preview-label">PREVIEW ONLY</span>
      <div className="conversion-preview-options">
        {PREVIEW_STATES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-current={state === id ? "page" : undefined}
            onClick={() => onChange(id)}
          >
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

function AdmissionScreen({
  mode,
  onChange,
  onExistingSignIn,
}: {
  mode: "entry" | "waiting";
  onChange: (state: PreviewState) => void;
  onExistingSignIn: () => void;
}) {
  const waiting = mode === "waiting";

  return (
    <main className="public-admission conversion-admission" aria-live="polite">
      <div className="conversion-admission-topline" aria-hidden="true">
        <span>MARKET TERMINAL / PUBLIC RELAY</span>
        <span className="conversion-relay-live"><i /> RELAY ONLINE</span>
      </div>

      <div className="conversion-grid-coordinate conversion-grid-coordinate-x" aria-hidden="true">X / 017.44</div>
      <div className="conversion-grid-coordinate conversion-grid-coordinate-y" aria-hidden="true">Y / 093.11</div>

      <section className={`public-admission-card conversion-admission-card${waiting ? " conversion-waiting-card" : ""}`}>
        <header className="conversion-admission-header">
          <p className="public-admission-kicker">SIGNAL // LIVE MARKET TERMINAL</p>
          <span className="conversion-seat-status"><i /> 01 SEAT READY</span>
        </header>

        {waiting ? (
          <WaitingContent onCancel={() => onChange("entry")} />
        ) : (
          <>
            <h1>Open a live market terminal.</h1>
            <p className="conversion-admission-lede">
              Build a sourced market brief inside a fresh, isolated session. No account required.
            </p>

            <dl className="conversion-session-contract" aria-label="Public session limits">
              <div><dt>SESSION</dt><dd>15 MIN</dd></div>
              <div><dt>RESEARCH</dt><dd>5 RUNS</dd></div>
              <div><dt>ACCESS</dt><dd>NO ACCOUNT</dd></div>
            </dl>

            <div className="conversion-turnstile" aria-label="Human verification complete">
              <span className="conversion-turnstile-check" aria-hidden="true">✓</span>
              <span><strong>HUMAN VERIFIED</strong><small>Cloudflare Turnstile</small></span>
              <span className="conversion-turnstile-mark" aria-hidden="true">CF</span>
            </div>

            <button
              type="button"
              className="public-admission-action conversion-primary-action"
              onClick={() => onChange("waiting")}
            >
              <span>START PUBLIC SESSION</span><span aria-hidden="true">→</span>
            </button>

            <button type="button" className="conversion-text-action" onClick={onExistingSignIn}>
              HAVE A WORKSPACE? <strong>SIGN IN →</strong>
            </button>
          </>
        )}
      </section>

      <footer className="conversion-admission-disclosure">
        <span>PUBLIC / DELAYED DATA</span>
        <span>NOT FINANCIAL ADVICE</span>
        <span>UNSAVED PUBLIC DATA IS DISCARDED</span>
      </footer>
    </main>
  );
}

function WaitingContent({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="conversion-waiting-content">
      <div className="conversion-queue-readout">
        <span>QUEUE POSITION</span>
        <strong>02</strong>
        <small>TICKET 8F4A / EXPIRES 09:42</small>
      </div>
      <div className="conversion-waiting-copy">
        <p className="public-admission-state">WAITING FOR AN ISOLATED WORKER</p>
        <h1>Keep this relay open.</h1>
        <p>A clean terminal is being assigned. Your place is held in this tab and admission will continue automatically.</p>
      </div>
      <ol className="conversion-assignment-track" aria-label="Worker assignment progress">
        <li className="is-complete"><span />Human verified</li>
        <li className="is-active"><span />Seat reserved</li>
        <li><span />Worker attached</li>
      </ol>
      <div className="conversion-waiting-foot">
        <span><i /> CHECKING EVERY 2 SECONDS</span>
        <button type="button" onClick={onCancel}>CANCEL TICKET</button>
      </div>
    </div>
  );
}

function TerminalShell({
  stage,
  accountMode,
  muted = false,
  onClaim,
  claimTriggerRef,
  children,
}: {
  stage: TerminalStage;
  accountMode: AccountMode;
  muted?: boolean;
  onClaim: () => void;
  claimTriggerRef?: React.RefObject<HTMLButtonElement>;
  children?: React.ReactNode;
}) {
  const rows = useMemo(() => terminalRows(stage, accountMode), [accountMode, stage]);
  const running = stage === "running";
  const privateWorkspace = stage === "private";
  const ledgerBalance = accountMode === "new" ? "$1.00" : "$3.42";

  return (
    <main className={`terminal conversion-terminal${muted ? " conversion-terminal-muted" : ""}`}>
      <TerminalFrame rows={rows} columns={144} />

      {running && (
        <div className="research-beacon research-beacon-synthesizing" role="status" aria-live="polite">
          <span className="research-beacon-lamp" aria-hidden="true" />
          <span className="research-beacon-channel">AGENT // AAPL</span>
          <strong className="research-beacon-phase">SYNTHESIZING</strong>
          <span className="research-beacon-live">LIVE</span>
        </div>
      )}

      <div className="status-line conversion-status-line">
        <span className={`conversion-brief-state ${running ? "is-running" : "is-complete"}`}>
          {running ? "BRIEF RUNNING · SOURCES 7/9" : privateWorkspace ? "AAPL BRIEF · SAVED" : "BRIEF COMPLETE · EVIDENCE 9/9"}
        </span>
        <div className="conversion-status-actions">
          <button type="button" className={`evidence-chip evidence-chip-${running ? "pending" : "available"}`}>
            <span className="evidence-lamp" aria-hidden="true" />
            <span className="evidence-chip-text">{running ? "EVIDENCE BUILDING" : "EVIDENCE"}</span>
            <span className="evidence-chip-count">{running ? "7" : "9"}</span>
          </button>
          {!running && !privateWorkspace && (
            <button ref={claimTriggerRef} type="button" className="conversion-claim-chip" onClick={onClaim}>
              KEEP THIS IN MY WORKSPACE <span aria-hidden="true">→</span>
            </button>
          )}
        </div>
      </div>

      <footer className={`conversion-session-footer${privateWorkspace ? " is-private" : ""}`}>
        <span>{privateWorkspace ? "PRIVATE WORKSPACE" : "PUBLIC SESSION"}</span>
        <span>{privateWorkspace ? `LEDGER  ${ledgerBalance}` : running ? "4 RUNS REMAIN" : "4 RUNS · 11:42 LEFT"}</span>
        <span>{privateWorkspace ? "COMPUTE SLEEPS WHEN IDLE" : "UNSAVED DATA EXPIRES WITH SESSION"}</span>
      </footer>

      <div className={`public-session-banner conversion-session-banner${privateWorkspace ? " is-private" : ""}`} role="status">
        {privateWorkspace ? "PRIVATE / PERSISTENT" : "PUBLIC / ISOLATED / LIVE"}
      </div>

      {children}
    </main>
  );
}

function WorkspaceCartridge({
  kind,
  accountMode,
  onChange,
  onDismissResult,
}: {
  kind: CartridgeKind;
  accountMode: AccountMode;
  onChange: (state: PreviewState, accountMode?: AccountMode) => void;
  onDismissResult: () => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const isPrivate = kind === "private";
  const isError = kind === "error";
  const isEnded = kind === "ended";
  const isUnavailable = kind === "unavailable";
  const isWarning = kind === "claiming" || kind === "cancelled" || kind === "expired" || isEnded;

  const capsuleOrTransaction = {
    claim: "CAPSULE  AAPL-8F4A",
    claiming: "CAPSULE  AAPL-8F4A",
    auth: "AUTH CLAIM  CLM-77C2",
    importing: "IMPORT TXN  IMP-42D1",
    ended: "CAPSULE  AAPL-8F4A",
    private: "IMPORT TXN  IMP-42D1",
    cancelled: "AUTH CLAIM  CLM-77C2",
    expired: "AUTH CLAIM  CLM-77C2",
    unavailable: "CAPSULE  AAPL-8F4A",
    error: "IMPORT TXN  IMP-42D1",
  }[kind];
  const cartridgeStatus = {
    claim: "CAPSULE AVAILABLE",
    claiming: "CREATING AUTH CLAIM",
    auth: "AUTH CLAIM ISSUED",
    importing: "IMPORTING",
    ended: "CAPSULE AVAILABLE",
    private: "IMPORT COMPLETE",
    cancelled: "AUTH CANCELLED",
    expired: "AUTH CLAIM EXPIRED",
    unavailable: "CAPSULE EXPIRED",
    error: "IMPORT PAUSED",
  }[kind];
  const footerHint = {
    claim: "RESULT CAPSULE · AVAILABLE WHILE SESSION IS LIVE",
    claiming: "CREATING AUTH CLAIM · TTL NOT STARTED",
    auth: "AUTH CLAIM · 29:58 · SINGLE USE",
    importing: "AUTH CLAIM · CONSUMED · IMPORT ATOMIC",
    ended: "RESULT CAPSULE · 28:14 REMAINING",
    private: "STATE SAVED · WORKER ASLEEP",
    cancelled: "AUTH CLAIM · 26:11 · NOT CONSUMED",
    expired: "AUTH CLAIM EXPIRED · RESULT CAPSULE 08:42",
    unavailable: "RESULT CAPSULE · EXPIRED · DELETED",
    error: "IMPORT TRANSACTION · RETRYABLE · 18:43",
  }[kind];

  const close = useCallback(() => {
    if (isPrivate) onChange("workspace");
    else if (isEnded || isUnavailable) onChange("entry");
    else onDismissResult();
  }, [isEnded, isPrivate, isUnavailable, onChange, onDismissResult]);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [kind]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        titleRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === titleRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!(active instanceof Node) || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  let body: React.ReactNode;
  switch (kind) {
    case "claim":
      body = (
        <ClaimOffer
          titleRef={titleRef}
          onCreate={() => onChange("claiming", "new")}
          onDismiss={close}
          onSignIn={() => onChange("auth", "existing")}
        />
      );
      break;
    case "claiming":
      body = <ClaimCreating titleRef={titleRef} onCancel={close} />;
      break;
    case "auth":
      body = (
        <AuthHandoff
          titleRef={titleRef}
          accountMode={accountMode}
          onContinue={() => onChange("importing")}
          onCancel={() => onChange("cancelled")}
        />
      );
      break;
    case "importing":
      body = <ImportingWorkspace titleRef={titleRef} accountMode={accountMode} />;
      break;
    case "ended":
      body = (
        <SessionEnded
          titleRef={titleRef}
          onCreate={() => onChange("claiming", "new")}
          onRestart={() => onChange("entry")}
        />
      );
      break;
    case "private":
      body = (
        <PrivateReady
          titleRef={titleRef}
          accountMode={accountMode}
          onOpen={() => onChange("workspace")}
        />
      );
      break;
    case "cancelled":
      body = (
        <AuthCancelled
          titleRef={titleRef}
          onRetry={() => onChange("auth")}
          onReturn={close}
        />
      );
      break;
    case "expired":
      body = (
        <ClaimExpired
          titleRef={titleRef}
          onReissue={() => onChange("claiming")}
          onReturn={close}
        />
      );
      break;
    case "unavailable":
      body = <CapsuleUnavailable titleRef={titleRef} onRestart={() => onChange("entry")} />;
      break;
    case "error":
      body = (
        <ClaimError
          titleRef={titleRef}
          onRetry={() => onChange("importing")}
          onEmpty={() => onChange("workspace")}
        />
      );
      break;
  }

  return (
    <div
      className={`evidence-overlay conversion-claim-overlay conversion-claim-${kind}`}
      onClick={close}
    >
      <section
        ref={dialogRef}
        className="evidence-cartridge conversion-claim-cartridge"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversion-claim-title"
        aria-describedby="conversion-claim-desc"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="evidence-cartridge-head conversion-claim-head">
          <div className="evidence-cartridge-brand">
            <span className={isError || isUnavailable ? "conversion-error-signal" : "evidence-brand-signal"}>SIGNAL</span>
            {" // PRIVATE WORKSPACE"}
          </div>
          <button type="button" className="evidence-close" onClick={close} aria-label="Close workspace claim">
            [X] CLOSE
          </button>
        </header>

        <div className="evidence-cartridge-meta conversion-claim-meta">
          <span>{capsuleOrTransaction}</span>
          <span>BRIEF  12 BLOCKS</span>
          <span className={
            isError || isUnavailable
              ? "evidence-status-blocked"
              : kind === "importing"
                ? "conversion-status-active"
              : isWarning
                ? "evidence-status-partial"
                : "evidence-status-available"
          }>
            {cartridgeStatus}
          </span>
        </div>

        <div className="conversion-claim-body">{body}</div>

        <footer className="evidence-cartridge-foot conversion-claim-foot">
          <span className="evidence-foot-hint">{footerHint}</span>
          <span>{isError ? "RETRY SAFE · ESC CLOSE" : kind === "importing" ? "IMPORT CONTINUES · ESC HIDE" : "ESC CLOSE"}</span>
        </footer>
      </section>
    </div>
  );
}

function ClaimOffer({
  titleRef,
  onCreate,
  onDismiss,
  onSignIn,
}: {
  titleRef: React.RefObject<HTMLHeadingElement>;
  onCreate: () => void;
  onDismiss: () => void;
  onSignIn: () => void;
}) {
  return (
    <>
      <p className="conversion-claim-eyebrow">YOUR RESULT IS READY TO MOVE</p>
      <h2 id="conversion-claim-title" ref={titleRef} tabIndex={-1}>Keep this brief. Make the terminal yours.</h2>
      <p id="conversion-claim-desc" className="conversion-claim-intro">
        The completed result capsule is available while this public session is live. Create a private workspace and continue from this exact market state.
      </p>
      <TransferManifest />
      <NewAccountStarterBalance />
      <div className="conversion-claim-actions">
        <button type="button" className="conversion-cartridge-primary" onClick={onCreate}>CREATE WORKSPACE <span>→</span></button>
        <button type="button" className="conversion-cartridge-secondary" onClick={onDismiss}>NOT NOW</button>
      </div>
      <button type="button" className="conversion-existing-account" onClick={onSignIn}>
        ALREADY HAVE AN ACCOUNT? <strong>SIGN IN</strong>
      </button>
    </>
  );
}

function ClaimCreating({
  titleRef,
  onCancel,
}: {
  titleRef: React.RefObject<HTMLHeadingElement>;
  onCancel: () => void;
}) {
  return (
    <>
      <p className="conversion-claim-eyebrow is-warning">SECURING RESULT TRANSFER</p>
      <h2 id="conversion-claim-title" ref={titleRef} tabIndex={-1}>Creating a one-time sign-in claim.</h2>
      <p id="conversion-claim-desc" className="conversion-claim-intro">
        The completed result capsule already exists. Its retention window is unchanged; the separate 30-minute authentication clock starts only after claim issuance.
      </p>
      <TransitionTrack
        steps={[
          { label: "RESULT CAPSULE AVAILABLE", state: "complete" },
          { label: "CREATE OPAQUE AUTH CLAIM", state: "active" },
          { label: "OPEN SAME-TAB SIGN-IN", state: "waiting" },
        ]}
      />
      <p className="conversion-progress-note"><i /> KEEP THIS TAB OPEN · CLAIM TTL NOT STARTED</p>
      <div className="conversion-claim-actions is-single">
        <button type="button" className="conversion-cartridge-secondary" onClick={onCancel}>CANCEL AND RETURN</button>
      </div>
    </>
  );
}

function AuthHandoff({
  titleRef,
  accountMode,
  onContinue,
  onCancel,
}: {
  titleRef: React.RefObject<HTMLHeadingElement>;
  accountMode: AccountMode;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const existingAccount = accountMode === "existing";
  return (
    <>
      <p className="conversion-claim-eyebrow">AUTH CLAIM ISSUED · SINGLE USE</p>
      <h2 id="conversion-claim-title" ref={titleRef} tabIndex={-1}>Your result is secured for sign-in.</h2>
      <p id="conversion-claim-desc" className="conversion-claim-intro">
        Continue in this tab to {existingAccount ? "sign in to your existing workspace" : "create your account and private workspace"}. The opaque authentication claim expires in 29:58.
      </p>
      <div className="conversion-lifecycle-grid">
        <span>RESULT CAPSULE</span><strong>AVAILABLE / AAPL-8F4A</strong>
        <span>AUTH CLAIM</span><strong className="is-success">ISSUED / CLM-77C2</strong>
        <span>AUTH TTL</span><strong className="is-warning">29:58 REMAINING</strong>
        <span>ACCOUNT PATH</span><strong>{existingAccount ? "EXISTING ACCOUNT" : "NEW ACCOUNT"}</strong>
      </div>
      <div className="conversion-claim-actions">
        <button type="button" className="conversion-cartridge-primary" onClick={onContinue}>CONTINUE TO SECURE SIGN-IN <span>→</span></button>
        <button type="button" className="conversion-cartridge-secondary" onClick={onCancel}>CANCEL</button>
      </div>
      <p className="conversion-error-help">No credential, browser cookie, or public ticket is stored in the result capsule.</p>
    </>
  );
}

function ImportingWorkspace({
  titleRef,
  accountMode,
}: {
  titleRef: React.RefObject<HTMLHeadingElement>;
  accountMode: AccountMode;
}) {
  return (
    <>
      <p className="conversion-claim-eyebrow">AUTH RETURN VERIFIED</p>
      <h2 id="conversion-claim-title" ref={titleRef} tabIndex={-1}>Bringing your result into the workspace.</h2>
      <p id="conversion-claim-desc" className="conversion-claim-intro">
        The single-use authentication claim has been consumed. The import transaction can now retry safely without creating another workspace or starter grant.
      </p>
      <TransitionTrack
        vertical
        steps={[
          { label: "IDENTITY VERIFIED", detail: "OAuth return nonce matched", state: "complete" },
          {
            label: accountMode === "new" ? "WORKSPACE PROVISIONED" : "EXISTING WORKSPACE FOUND",
            detail: accountMode === "new" ? "Account-scoped workspace ready" : "Current ledger retained",
            state: "complete",
          },
          { label: "ATTACH AAPL CAPSULE", detail: "12 blocks · 9 evidence packets", state: "active" },
          { label: "CONFIRM LEDGER + SLEEP POLICY", detail: "Waiting for atomic import", state: "waiting" },
        ]}
      />
      <p className="conversion-progress-note"><i /> IMPORT CONTINUES AUTOMATICALLY · SAFE TO HIDE</p>
    </>
  );
}

function AuthCancelled({
  titleRef,
  onRetry,
  onReturn,
}: {
  titleRef: React.RefObject<HTMLHeadingElement>;
  onRetry: () => void;
  onReturn: () => void;
}) {
  return (
    <>
      <p className="conversion-claim-eyebrow is-warning">SIGN-IN CANCELLED</p>
      <h2 id="conversion-claim-title" ref={titleRef} tabIndex={-1}>Nothing moved. Your result is still here.</h2>
      <p id="conversion-claim-desc" className="conversion-claim-intro">
        The authentication claim was not consumed and remains valid for 26:11. The result capsule is still available while this public session remains live.
      </p>
      <div className="conversion-lifecycle-grid">
        <span>AUTH CLAIM</span><strong className="is-warning">NOT CONSUMED</strong>
        <span>AUTH TTL</span><strong>26:11 REMAINING</strong>
        <span>RESULT CAPSULE</span><strong className="is-success">AVAILABLE</strong>
      </div>
      <div className="conversion-claim-actions">
        <button type="button" className="conversion-cartridge-primary" onClick={onRetry}>RETRY SIGN-IN <span>→</span></button>
        <button type="button" className="conversion-cartridge-secondary" onClick={onReturn}>RETURN TO TERMINAL</button>
      </div>
    </>
  );
}

function ClaimExpired({
  titleRef,
  onReissue,
  onReturn,
}: {
  titleRef: React.RefObject<HTMLHeadingElement>;
  onReissue: () => void;
  onReturn: () => void;
}) {
  return (
    <>
      <div className="conversion-error-code is-warning">E_AUTH / TTL</div>
      <p className="conversion-claim-eyebrow is-warning">AUTH CLAIM EXPIRED</p>
      <h2 id="conversion-claim-title" ref={titleRef} tabIndex={-1}>The sign-in claim expired. The result capsule did not.</h2>
      <p id="conversion-claim-desc" className="conversion-claim-intro">
        Issue a new single-use claim while the completed result capsule remains transferable for another 08:42.
      </p>
      <div className="conversion-lifecycle-grid">
        <span>AUTH CLAIM</span><strong className="is-error">EXPIRED / DELETED</strong>
        <span>RESULT CAPSULE</span><strong className="is-success">AVAILABLE</strong>
        <span>CAPSULE TTL</span><strong className="is-warning">08:42 REMAINING</strong>
      </div>
      <div className="conversion-claim-actions">
        <button type="button" className="conversion-cartridge-primary" onClick={onReissue}>ISSUE NEW CLAIM <span>↻</span></button>
        <button type="button" className="conversion-cartridge-secondary" onClick={onReturn}>RETURN TO TERMINAL</button>
      </div>
    </>
  );
}

function CapsuleUnavailable({
  titleRef,
  onRestart,
}: {
  titleRef: React.RefObject<HTMLHeadingElement>;
  onRestart: () => void;
}) {
  return (
    <>
      <div className="conversion-error-code">E_CAPSULE / GONE</div>
      <p className="conversion-claim-eyebrow is-error">TRANSFER WINDOW CLOSED</p>
      <h2 id="conversion-claim-title" ref={titleRef} tabIndex={-1}>This result can no longer be imported.</h2>
      <p id="conversion-claim-desc" className="conversion-claim-intro">
        The durable result capsule expired and was deleted. The frozen snapshot remains visible in this tab, but no server-side artifact is available to claim.
      </p>
      <div className="conversion-lifecycle-grid">
        <span>RESULT CAPSULE</span><strong className="is-error">EXPIRED / DELETED</strong>
        <span>AUTH CLAIM</span><strong>NOT ISSUED</strong>
        <span>RECOVERY</span><strong>NEW PUBLIC SESSION</strong>
      </div>
      <div className="conversion-claim-actions is-single">
        <button type="button" className="conversion-cartridge-primary" onClick={onRestart}>START NEW PUBLIC SESSION <span>→</span></button>
      </div>
    </>
  );
}

type TransitionStep = {
  label: string;
  detail?: string;
  state: "complete" | "active" | "waiting";
};

function TransitionTrack({
  steps,
  vertical = false,
}: {
  steps: TransitionStep[];
  vertical?: boolean;
}) {
  return (
    <ol className={`conversion-transfer-progress${vertical ? " is-vertical" : ""}`} aria-label="Transfer progress">
      {steps.map((step) => (
        <li key={step.label} className={`is-${step.state}`}>
          <span className="conversion-progress-marker" aria-hidden="true">
            {step.state === "complete" ? "✓" : step.state === "active" ? "●" : "·"}
          </span>
          <span>
            <strong>{step.label}</strong>
            {step.detail && <small>{step.detail}</small>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function SessionEnded({
  titleRef,
  onCreate,
  onRestart,
}: {
  titleRef: React.RefObject<HTMLHeadingElement>;
  onCreate: () => void;
  onRestart: () => void;
}) {
  return (
    <>
      <p className="conversion-claim-eyebrow is-warning">PUBLIC WORKER RELEASED</p>
      <h2 id="conversion-claim-title" ref={titleRef} tabIndex={-1}>Your session is complete. Your result can still move.</h2>
      <p id="conversion-claim-desc" className="conversion-claim-intro">
        The isolated worker has been destroyed. A durable result capsule remains available in this tab for another 28:14.
      </p>
      <TransferManifest compact />
      <NewAccountStarterBalance />
      <div className="conversion-claim-actions">
        <button type="button" className="conversion-cartridge-primary" onClick={onCreate}>CREATE WORKSPACE <span>→</span></button>
        <button type="button" className="conversion-cartridge-secondary" onClick={onRestart}>NEW PUBLIC SESSION</button>
      </div>
      <p className="conversion-expiry-note"><i /> RESULT CAPSULE  28:14 REMAINING</p>
    </>
  );
}

function PrivateReady({
  titleRef,
  accountMode,
  onOpen,
}: {
  titleRef: React.RefObject<HTMLHeadingElement>;
  accountMode: AccountMode;
  onOpen: () => void;
}) {
  const isNewAccount = accountMode === "new";
  const ledgerBalance = isNewAccount ? "$1.00" : "$3.42";
  return (
    <>
      <div className="conversion-ready-mark" aria-hidden="true"><span>✓</span></div>
      <p className="conversion-claim-eyebrow is-success">TRANSFER CONFIRMED</p>
      <h2 id="conversion-claim-title" ref={titleRef} tabIndex={-1}>Private workspace ready.</h2>
      <p id="conversion-claim-desc" className="conversion-claim-intro">
        The AAPL brief is saved. {isNewAccount ? "Your new-account starter balance is now in the ledger." : "Your existing ledger balance is unchanged."} Your terminal state persists while compute sleeps.
      </p>
      <dl className="conversion-ready-grid">
        <div><dt>BRIEF</dt><dd>AAPL IMPORTED</dd></div>
        <div><dt>EVIDENCE</dt><dd>9 PACKETS</dd></div>
        <div><dt>WATCHLIST</dt><dd>RESTORED</dd></div>
        <div><dt>STATE</dt><dd>SAVED</dd></div>
        <div><dt>{isNewAccount ? "STARTER BALANCE" : "ACCOUNT BALANCE"}</dt><dd className="is-money">{ledgerBalance}</dd></div>
        <div><dt>COMPUTE</dt><dd>SLEEPS WHEN IDLE</dd></div>
      </dl>
      <div className="conversion-claim-actions is-single">
        <button type="button" className="conversion-cartridge-primary is-success" onClick={onOpen}>OPEN MY TERMINAL <span>→</span></button>
      </div>
    </>
  );
}

function ClaimError({
  titleRef,
  onRetry,
  onEmpty,
}: {
  titleRef: React.RefObject<HTMLHeadingElement>;
  onRetry: () => void;
  onEmpty: () => void;
}) {
  return (
    <>
      <div className="conversion-error-code">E_IMPORT / 02</div>
      <p className="conversion-claim-eyebrow is-error">WORKSPACE CREATED · IMPORT PAUSED</p>
      <h2 id="conversion-claim-title" ref={titleRef} tabIndex={-1}>Your result is safe. The transfer needs another try.</h2>
      <p id="conversion-claim-desc" className="conversion-claim-intro">
        Authentication succeeded and the one-time claim was consumed, but the AAPL capsule did not attach. The idempotent import transaction remains retryable for 18:43.
      </p>
      <div className="conversion-error-detail">
        <span>LAST STEP</span><strong>ATTACH RESULT TO WORKSPACE</strong>
        <span>WORKSPACE</span><strong>READY / EMPTY</strong>
        <span>AUTH CLAIM</span><strong>CONSUMED</strong>
        <span>IMPORT TXN</span><strong className="is-warning">RETRYABLE</strong>
      </div>
      <div className="conversion-claim-actions">
        <button type="button" className="conversion-cartridge-primary" onClick={onRetry}>RETRY IMPORT <span>↻</span></button>
        <button type="button" className="conversion-cartridge-secondary" onClick={onEmpty}>OPEN EMPTY WORKSPACE</button>
      </div>
      <p className="conversion-error-help">If retry fails, the empty workspace remains available and support can recover the claim ID.</p>
    </>
  );
}

function TransferManifest({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`conversion-transfer-manifest${compact ? " is-compact" : ""}`}>
      <div><span className="conversion-manifest-marker">✓</span><span><strong>AAPL BRIEF</strong><small>12 research blocks</small></span></div>
      <div><span className="conversion-manifest-marker">✓</span><span><strong>EVIDENCE</strong><small>9 source packets</small></span></div>
      <div><span className="conversion-manifest-marker">✓</span><span><strong>TERMINAL STATE</strong><small>Watchlist + context</small></span></div>
    </div>
  );
}

function NewAccountStarterBalance() {
  return (
    <div className="conversion-starter-balance">
      <div>
        <span>NEW-ACCOUNT STARTER BALANCE</span>
        <strong><small>USD</small> $1.00</strong>
      </div>
      <p>Eligible new accounts receive this after workspace creation. Existing accounts keep their ledger balance. Actual research cost appears only after completion.</p>
    </div>
  );
}
