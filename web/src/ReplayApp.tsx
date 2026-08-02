import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  REPLAY_DISCLAIMERS,
  REPLAY_EVIDENCE_STATUS_LABEL,
  REPLAY_RETRIEVAL_STATUS_LABEL,
  REPLAY_SCREEN,
} from "./replay-artifacts";

type Dialog = "pilot" | "source" | null;

/**
 * Static replay-only demo app.
 *
 * Renders the pre-built fixture in the same terminal/status/modal visual
 * language as the live build and makes no WebSocket, fetch, auth, identity,
 * persistence, redirect, model, or source request. The capture button explains
 * the frozen public artifact, and the source locker replays its evidence.
 * Escape closes every dialog; no other key handling exists here.
 */
export function ReplayApp() {
  const [dialog, setDialog] = useState<Dialog>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDialog(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Land keyboard focus inside the opened dialog.
  useEffect(() => {
    if (dialog) closeButtonRef.current?.focus();
  }, [dialog]);

  const open = (nextDialog: Exclude<Dialog, null>, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    setDialog(nextDialog);
  };
  const close = () => {
    setDialog(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div className="terminal replay-terminal">
      <div
        className="terminal-frame replay-frame"
        role="region"
        aria-label="Captured market-terminal replay. Frozen, read-only sample with no live connection or input."
      >
        {REPLAY_SCREEN.rows.map((html, index) => (
          <div
            key={index}
            className="term-row"
            dangerouslySetInnerHTML={{ __html: sanitizeReplayHtml(html || "&nbsp;") }}
          />
        ))}
      </div>

      <p className="replay-disclosure">
        {REPLAY_DISCLAIMERS.nonFinancial} {REPLAY_DISCLAIMERS.noLive} Captured {REPLAY_SCREEN.capturedAt} {REPLAY_SCREEN.captureTimezone}.
      </p>

      <div className="status-line replay-status">
        <span className="status-conn" aria-live="polite">
          <span className="status-dot replay-dot" aria-hidden="true" />
          <span>{REPLAY_SCREEN.statusLabel}</span>
        </span>

        <button
          type="button"
          className="evidence-chip replay-chip-pilot"
          onClick={(event) => open("pilot", event.currentTarget)}
          aria-haspopup="dialog"
          aria-expanded={dialog === "pilot"}
          aria-label={`Captured product replay. ${REPLAY_DISCLAIMERS.noLive}`}
        >
          <span className="evidence-lamp" aria-hidden="true" />
          <span className="evidence-chip-text">CAPTURED REPLAY</span>
        </button>

        <button
          type="button"
          className="evidence-chip evidence-chip-none"
          onClick={(event) => open("source", event.currentTarget)}
          aria-haspopup="dialog"
          aria-expanded={dialog === "source"}
          aria-label={`Source locker. ${REPLAY_DISCLAIMERS.captured}`}
        >
          <span className="evidence-lamp" aria-hidden="true" />
          <span className="evidence-chip-text">SOURCE LOCKER</span>
        </button>
      </div>

      {dialog === "pilot" && (
        <ReplayDialog
          brand="SIGNAL // STATIC PILOT"
          title={REPLAY_SCREEN.pilot.title}
          lines={REPLAY_SCREEN.pilot.lines}
          onClose={close}
          closeRef={closeButtonRef}
        />
      )}

      {dialog === "source" && (
        <ReplayDialog
          brand="SIGNAL // SOURCE LOCKER"
          title={REPLAY_SCREEN.sourceLocker.title}
          lines={REPLAY_SCREEN.sourceLocker.lines}
          onClose={close}
          closeRef={closeButtonRef}
        >
          <div className="evidence-cartridge-meta">
            <span>INTENT: {REPLAY_SCREEN.dossier.intent.toUpperCase()}</span>
            <span>STAGE: {REPLAY_SCREEN.dossier.stage.toUpperCase()}</span>
            <span className={`evidence-status evidence-status-${REPLAY_SCREEN.dossier.evidenceStatus}`}>
              STATUS:{" "}
              {REPLAY_EVIDENCE_STATUS_LABEL[REPLAY_SCREEN.dossier.evidenceStatus]}
            </span>
            <span>PACKETS: {REPLAY_SCREEN.dossier.packets.length} / {REPLAY_SCREEN.dossier.sourceCount} SOURCES</span>
          </div>
          <div className="replay-dialog-rule" aria-hidden="true" />
          {REPLAY_SCREEN.dossier.packets.length === 0 ? (
            <p className="replay-dialog-empty">
              No sources captured — this demo performs no retrieval and holds no
              third-party material.
            </p>
          ) : (
            <div className="evidence-packets">
              {REPLAY_SCREEN.dossier.packets.map((packet) => (
                <article
                  key={packet.id}
                  className="evidence-packet evidence-packet-fetched"
                >
                  <div className="evidence-packet-head">
                    <span className="evidence-packet-idx">{packet.id}</span>
                    <span
                      className={`evidence-retrieval evidence-retrieval-${packet.retrieval}`}
                    >
                      {REPLAY_RETRIEVAL_STATUS_LABEL[packet.retrieval]}
                    </span>
                    <span className="evidence-packet-source">{packet.domain}</span>
                    {packet.capturedAt && (
                      <span className="evidence-packet-time">{packet.capturedAt}</span>
                    )}
                  </div>
                  <h3 className="evidence-packet-title">{packet.title}</h3>
                  <p className="evidence-packet-excerpt">{packet.excerpt}</p>
                  <div className="evidence-packet-foot">
                    {packet.mode && <span className="evidence-mode">MODE:{packet.mode}</span>}
                    {packet.note && <span className="evidence-note">{packet.note}</span>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </ReplayDialog>
      )}
    </div>
  );
}

/**
 * Captures are stored as terminal-generated HTML. Only text and spans with the
 * three palette properties emitted by the renderer may reach the DOM; all
 * other markup and styles are converted to plain text.
 */
function sanitizeReplayHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const output = document.createElement("span");
  const palette = new Set(["color", "background-color", "font-weight"]);
  const safeRgb = (value: string) => /^rgb\((?:[0-9]{1,3},){2}[0-9]{1,3}\)$/.test(value);

  for (const node of Array.from(template.content.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      output.append(node.textContent ?? "");
      continue;
    }
    if (!(node instanceof HTMLSpanElement)) {
      output.append(node.textContent ?? "");
      continue;
    }
    const span = document.createElement("span");
    span.textContent = node.textContent ?? "";
    for (const declaration of node.style) {
      const value = node.style.getPropertyValue(declaration).trim();
      if (!palette.has(declaration)) continue;
      if ((declaration === "color" || declaration === "background-color") && !safeRgb(value)) continue;
      if (declaration === "font-weight" && value !== "700") continue;
      span.style.setProperty(declaration, value);
    }
    output.append(span);
  }
  return output.innerHTML;
}

/* ── Explanatory dialog (same modal language as the evidence locker) ─────── */

function ReplayDialog({
  brand,
  title,
  lines,
  onClose,
  closeRef,
  children,
}: {
  brand: string;
  title: string;
  lines: string[];
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement>;
  children?: ReactNode;
}) {
  return (
    <div className="evidence-overlay replay-overlay" onClick={onClose}>
      <div
        className="evidence-cartridge replay-cartridge"
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="evidence-cartridge-head">
          <div className="evidence-cartridge-brand">{brand}</div>
          <button
            ref={closeRef}
            type="button"
            className="evidence-close"
            onClick={onClose}
            aria-label="Close this dialog"
          >
            [X] CLOSE
          </button>
        </header>

        <div className="replay-dialog-body">
          <h2 id="replay-dialog-title" className="replay-dialog-title">
            {title}
          </h2>
          {lines.map((line, index) => (
            <p key={index} className="replay-dialog-line">
              {line}
            </p>
          ))}
          {children}
        </div>

        <footer className="evidence-cartridge-foot">
          <span className="evidence-foot-hint">ESC TO CLOSE</span>
          <button type="button" className="evidence-eject" onClick={onClose}>
            DISMISS
          </button>
        </footer>
      </div>
    </div>
  );
}
