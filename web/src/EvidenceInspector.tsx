import { useEffect, useRef } from "react";
import {
  dossierPacketCount,
  effectiveEvidenceStatus,
  EVIDENCE_STATUS_LABEL,
  retrievalStatusOf,
  RETRIEVAL_STATUS_LABEL,
  type DossierCitation,
  type DossierPacket,
  type TerminalDossier,
} from "./dossier";
import { sanitizePublicUrl } from "../../shared/public-url";

/* ── Small safety helpers ──────────────────────────────────────────────── */

/** Only http(s) URLs may leave the terminal as real external anchors. */
function safeExternalUrl(url: unknown): string | undefined {
  return typeof url === "string" ? sanitizePublicUrl(url) || undefined : undefined;
}

function formatExtractedAt(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  try {
    return new Date(value).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function nonNullPackets(dossier?: TerminalDossier): DossierPacket[] {
  if (!Array.isArray(dossier?.packets)) return [];
  return dossier.packets.filter(
    (p): p is DossierPacket => Boolean(p && typeof p === "object"),
  );
}

function summarySourceIds(dossier?: TerminalDossier): string[] {
  if (!Array.isArray(dossier?.summarySourceIds)) return [];
  return [...new Set(
    dossier.summarySourceIds
      .filter((sourceId): sourceId is string => typeof sourceId === "string")
      .map((sourceId) => sourceId.trim().slice(0, 40))
      .filter(Boolean),
  )];
}

function summaryCitations(dossier?: TerminalDossier): DossierCitation[] {
  if (!Array.isArray(dossier?.summaryCitations)) return [];
  const seen = new Set<string>();
  const citations: DossierCitation[] = [];
  for (const citation of dossier.summaryCitations) {
    if (!citation || typeof citation !== "object") continue;
    const sourceId = typeof citation.sourceId === "string"
      ? citation.sourceId.trim().slice(0, 40)
      : "";
    const quote = typeof citation.quote === "string"
      ? citation.quote.replace(/\s+/g, " ").trim().slice(0, 500)
      : "";
    const key = `${sourceId}:${quote}`;
    if (!sourceId || quote.length < 8 || seen.has(key)) continue;
    seen.add(key);
    citations.push({ sourceId, quote });
  }
  return citations;
}

function packetAnchorId(sourceId: string): string {
  return `evidence-packet-${encodeURIComponent(sourceId)}`;
}

/* ── Evidence control (status chrome) ─────────────────────────────────── */

interface EvidenceControlProps {
  dossier?: TerminalDossier;
  open: boolean;
  onOpen: () => void;
  triggerRef?: React.Ref<HTMLButtonElement>;
}

/**
 * Compact terminal-style research status chip. Lives in the browser chrome's
 * status line and appears only while a dossier exists. `EVIDENCE BLOCKED`
 * is painted red and flashing so a walled-off research job cannot be missed.
 */
export function EvidenceControl({
  dossier,
  open,
  onOpen,
  triggerRef,
}: EvidenceControlProps) {
  const status = effectiveEvidenceStatus(dossier);
  const count = dossierPacketCount(dossier);
  const blocked = status === "blocked";
  const label = status === "none"
    ? "NO EVIDENCE"
    : `EVIDENCE ${EVIDENCE_STATUS_LABEL[status]}`;

  return (
    <button
      ref={triggerRef}
      type="button"
      className={`evidence-chip evidence-chip-${status}${
        open ? " evidence-chip-open" : ""
      }`}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`${label}${
        count > 0 ? `, ${count} packet${count === 1 ? "" : "s"}` : ""
      }. Open the source locker.`}
    >
      <span className="evidence-lamp" aria-hidden="true" />
      <span className="evidence-chip-text">{label}</span>
      {!blocked && <span className="evidence-chip-count">{count}</span>}
    </button>
  );
}

/* ── Evidence locker (dossier inspector) ──────────────────────────────── */

interface EvidenceInspectorProps {
  dossier?: TerminalDossier;
  onClose: () => void;
}

/**
 * "Source locker" panel: THE READ first, then packet statuses with short
 * excerpts. Every source URL is a real external anchor opened in a new tab
 * with `rel="noreferrer"`. Escape (handled at the app shell) and the visible
 * close/eject controls both dismiss it; Tab is trapped inside the cartridge.
 */
export function EvidenceInspector({
  dossier,
  onClose,
}: EvidenceInspectorProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const status = effectiveEvidenceStatus(dossier);
  const count = dossierPacketCount(dossier);
  const packets = nonNullPackets(dossier);
  const citations = summaryCitations(dossier);
  const citedSourceIds = [...new Set([
    ...summarySourceIds(dossier),
    ...citations.map((citation) => citation.sourceId),
  ])];
  const packetIds = new Set(packets.map((packet) => packet.sourceId));

  // Move focus into the dialog on open so keyboard users land on the
  // visible close control instead of the page behind it.
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = [
      ...panel.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="evidence-overlay" onClick={onClose}>
      <div
        ref={panelRef}
        className="evidence-cartridge"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-read-title"
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="evidence-cartridge-head">
          <div className="evidence-cartridge-brand">
            <span className="evidence-brand-signal">SIGNAL</span> // SOURCE
            LOCKER
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="evidence-close"
            onClick={onClose}
            aria-label="Close the source locker"
          >
            [X] CLOSE
          </button>
        </header>

        <div className="evidence-cartridge-meta">
          <span>INTENT: {dossier?.intent?.toUpperCase() ?? "—"}</span>
          <span>STAGE: {dossier?.stage?.toUpperCase() ?? "—"}</span>
          <span
            className={`evidence-status evidence-status-${status}`}
            aria-label={`Evidence status ${EVIDENCE_STATUS_LABEL[status]}`}
          >
            STATUS: {EVIDENCE_STATUS_LABEL[status]}
          </span>
        </div>

        <div className="evidence-cartridge-body">
          <section className="evidence-read" aria-labelledby="evidence-read-title">
            <div className="evidence-section-kicker">THE READ</div>
            <h2 id="evidence-read-title" className="evidence-read-title">
              {dossier?.title || "Research dossier"}
            </h2>
            <p className="evidence-read-summary">
              {dossier?.summary ||
                "No dossier summary yet — the packets below show what was retrieved."}
            </p>
            <div className="evidence-read-citations" aria-label="Sources cited by the read">
              {citedSourceIds.length > 0 ? (
                <>
                  <span>CITED PACKETS:</span>
                  {citedSourceIds.map((sourceId) => (
                    packetIds.has(sourceId) ? (
                      <a
                        key={sourceId}
                        className="evidence-citation"
                        href={`#${packetAnchorId(sourceId)}`}
                      >
                        [{sourceId}]
                      </a>
                    ) : (
                      <span key={sourceId} className="evidence-citation evidence-citation-missing">
                        [{sourceId}]
                      </span>
                    )
                  ))}
                </>
              ) : (
                <span className="evidence-citation-missing">NO PACKET CITED</span>
              )}
            </div>
            {citations.length > 0 && (
              <div className="evidence-read-excerpts" aria-label="Cited source excerpts">
                {citations.map((citation) => (
                  <div className="evidence-read-excerpt" key={`${citation.sourceId}:${citation.quote}`}>
                    {packetIds.has(citation.sourceId) ? (
                      <a className="evidence-citation" href={`#${packetAnchorId(citation.sourceId)}`}>
                        [{citation.sourceId}]
                      </a>
                    ) : (
                      <span className="evidence-citation-missing">[{citation.sourceId}]</span>
                    )}
                    <q>{citation.quote}</q>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="evidence-packets" aria-label="Evidence packets">
            <div className="evidence-section-kicker">
              PACKETS <span className="evidence-section-count">({count})</span>
            </div>
            {packets.length === 0 ? (
              <div className="evidence-empty">
                {status === "blocked"
                  ? "No packets captured — sources are blocked."
                  : "No packets captured. Awaiting retrieval…"}
              </div>
            ) : (
              packets.map((packet, index) => (
                <EvidencePacketRow
                  key={packet.sourceId || index}
                  packet={packet}
                  index={index}
                />
              ))
            )}
          </section>
        </div>

        <footer className="evidence-cartridge-foot">
          <span className="evidence-foot-hint">ESC TO EJECT</span>
          <button type="button" className="evidence-eject" onClick={onClose}>
            EJECT CARTRIDGE
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ── Single source packet row ─────────────────────────────────────────── */

function EvidencePacketRow({
  packet,
  index,
}: {
  packet: DossierPacket;
  index: number;
}) {
  const retrieval = retrievalStatusOf(packet);
  const href = safeExternalUrl(packet.sourceUrl);
  const time = formatExtractedAt(packet.extractedAt);

  return (
    <article
      id={packetAnchorId(packet.sourceId)}
      className={`evidence-packet evidence-packet-${retrieval}`}
      tabIndex={-1}
    >
      <div className="evidence-packet-head">
        <span className="evidence-packet-idx">P{index + 1} // {packet.sourceId}</span>
        <span
          className={`evidence-retrieval evidence-retrieval-${retrieval}`}
          aria-label={`Retrieval ${RETRIEVAL_STATUS_LABEL[retrieval]}`}
        >
          {RETRIEVAL_STATUS_LABEL[retrieval]}
        </span>
        {packet.sourceDomain && (
          <span className="evidence-packet-source">{packet.sourceDomain}</span>
        )}
        {time && <span className="evidence-packet-time">{time}</span>}
      </div>

      {packet.sourceTitle && (
        <h3 className="evidence-packet-title">{packet.sourceTitle}</h3>
      )}

      {packet.excerpt && (
        <p
          className={`evidence-packet-excerpt${
            packet.truncated ? " evidence-packet-excerpt-clamped" : ""
          }`}
        >
          {packet.excerpt}
        </p>
      )}

      <div className="evidence-packet-foot">
        {href ? (
          <a
            className="evidence-open"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            OPEN SOURCE ↗
          </a>
        ) : (
          <span className="evidence-nolink">NO LINK</span>
        )}
        {packet.truncated && <span className="evidence-truncated">TRUNCATED</span>}
        {packet.extractionMode ? (
          <span className="evidence-mode">MODE:{packet.extractionMode}</span>
        ) : null}
        {packet.failureNote ? (
          <span className="evidence-note">{packet.failureNote}</span>
        ) : null}
      </div>
    </article>
  );
}
