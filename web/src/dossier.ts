/**
 * Research dossier protocol — browser-native inspection layer.
 *
 * The backend extension enriches `FrameMessage.state.dossier` with this
 * optional shape. The browser layer is strictly additive and tolerant: old
 * server frames carry no `dossier` key at all, and mid-flight research can
 * produce partial payloads, so every field below is optional and the UI
 * degrades gracefully instead of breaking the terminal.
 */

export type ResearchIntent = "brief" | "why";
export type DossierStage = "partial" | "complete";
export type EvidenceStatus =
  | "pending"
  | "available"
  | "partial"
  | "blocked"
  | "none";
export type RetrievalStatus = "fetched" | "challenged" | "limited" | "failed";

export interface DossierPacket {
  sourceId: string;
  sourceTitle: string;
  sourceDomain: string;
  sourceUrl: string;
  retrievalStatus: RetrievalStatus;
  extractedAt: number;
  extractionMode: string;
  truncated: boolean;
  excerpt?: string;
  failureNote?: string;
}

export interface DossierCitation {
  sourceId: string;
  quote: string;
}

export interface TerminalDossier {
  title?: string;
  intent?: ResearchIntent;
  stage?: DossierStage;
  summary?: string;
  summarySourceIds?: string[];
  summaryCitations?: DossierCitation[];
  evidenceStatus?: EvidenceStatus;
  packets?: DossierPacket[];
}

/** Human-readable (terminal uppercase) label per evidence status. */
export const EVIDENCE_STATUS_LABEL: Record<EvidenceStatus, string> = {
  pending: "PENDING",
  available: "AVAILABLE",
  partial: "PARTIAL",
  blocked: "BLOCKED",
  none: "NONE",
};

/** Human-readable (terminal uppercase) label per retrieval status. */
export const RETRIEVAL_STATUS_LABEL: Record<RetrievalStatus, string> = {
  fetched: "FETCHED",
  challenged: "CHALLENGED",
  limited: "LIMITED",
  failed: "FAILED",
};

const EVIDENCE_STATUS_KEYS: EvidenceStatus[] = [
  "pending",
  "available",
  "partial",
  "blocked",
  "none",
];

const RETRIEVAL_STATUS_KEYS: RetrievalStatus[] = [
  "fetched",
  "challenged",
  "limited",
  "failed",
];

/**
 * Effective evidence status, tolerant of partial or stale state payloads.
 * When the server omitted the status, infer it from the packet list.
 */
export function effectiveEvidenceStatus(
  dossier?: TerminalDossier,
): EvidenceStatus {
  const raw = dossier?.evidenceStatus;
  if (raw && EVIDENCE_STATUS_KEYS.includes(raw)) return raw;
  return dossierPacketCount(dossier) > 0 ? "available" : "pending";
}

/** Number of captured source packets (missing/invalid arrays count as zero). */
export function dossierPacketCount(dossier?: TerminalDossier): number {
  return dossier?.packets?.length ?? 0;
}

/** Coerce a packet's retrieval status, tolerating unknown/omitted values. */
export function retrievalStatusOf(packet: DossierPacket): RetrievalStatus {
  return RETRIEVAL_STATUS_KEYS.includes(packet.retrievalStatus)
    ? packet.retrievalStatus
    : "failed";
}
