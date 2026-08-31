/**
 * instance-based market state — stage 1 slice 2.
 *
 * MarketState is the per-session container for ALL mutable research/UI-adjacent
 * state that previously lived at module scope in .pi/extensions/market-terminal.ts.
 * The Pi runtime constructs one module-scope singleton inside the extension;
 * the browser adapter constructs one instance per session with its own ports.
 *
 * This module is framework-free: no @earendil-works imports. It reads no
 * process.env directly (environment belongs to createNodeKernelPorts in
 * ./ports.js), so tests and the browser slice can construct instances with
 * injected fakes.
 *
 * The research/archive/precache domain types that the extension declared
 * locally also moved here so the container can own them without importing the
 * extension (which would be circular).
 */

import { CryptoPulseCache } from "../crypto-pulse.js";
import { ResearchCandidateRegistry } from "../unbrowser-mcp.js";
import type { MarketEventScout, MarketEventScoutRunResult } from "../market-event-scout.js";
import type { KernelPorts } from "./ports.js";
import type { ChartScope } from "./quotes.js";
import type { Canvas, EvidencePacket, EvidenceStatus, ResearchIntent } from "./technicals.js";

// ── Research identity / job domain ──────────────────────────────────────────

export type ResearchIdentity = { researchKey: string; intent: ResearchIntent; contextLabel: string };
export type ResearchActivity = "seeding" | "fetching" | "extracting" | "synthesizing";
export type ResearchOutcome = "queued" | "running" | "partial" | "complete" | "failed" | "cancelled";
export type ResearchSchedulerPhase = "queued" | "dispatched" | "running" | "cancelling" | "settled";
export type ResearchPromptVariant = "legacy" | "compact" | "compact-strict" | "paired-v1";

/** Paired pre-cache identity carrying exact BRIEF and WHY identities. */
export type PairedCacheIdentity = { researchKey: string; intent: ResearchIntent; contextLabel: string; question: string };
export type PairedCacheTarget = {
	brief: PairedCacheIdentity;
	why: PairedCacheIdentity;
	neededBrief: boolean;
	neededWhy: boolean;
};
export type PrecacheReservationRef = { ledgerPath: string; ledgerDate: string; pairKey: string; attempt: number };

export type ResearchJob = {
	id: string;
	symbol: string;
	question: string;
	returnTo: "quote" | "market";
	outcome: ResearchOutcome;
	activity: ResearchActivity;
	startedAt: number;
	updatedAt: number;
	slotHeld: boolean;
	phase: ResearchSchedulerPhase;
	settledAt?: number;
	toolName?: string;
	error?: string;
	publishedBlocks: number;
	evidencePackets?: EvidencePacket[];
	chartScope: ChartScope;
  origin?: "precache" | "scout";
	promptVariant?: ResearchPromptVariant;
	pairedTarget?: PairedCacheTarget;
  tokenLimit?: number;
  precacheReservation?: PrecacheReservationRef;
  modelProvider?: "openrouter";
  modelId?: string;
  scoutCandidateId?: string;
} & ResearchIdentity;

// ── Research archive domain ─────────────────────────────────────────────────

export type ResearchGeneration = {
  promptVariant?: string;
  origin?: "precache" | "scout";
  qualityGate?: boolean;
  scoutCandidateId?: string;
};

export type ArchivedResearch = {
	archiveId: string;
	symbol: string;
	question?: string;
	asOf: number;
	archivedAt: number;
	canvas: Canvas;
	chartScope?: ChartScope;
	quality?: CanvasQualityTelemetry;
	generation?: ResearchGeneration;
};

export type ResearchArchiveFile = { version: 1; updatedAt: number; entries: ArchivedResearch[] };

// ── Canvas quality telemetry (archive seed) ─────────────────────────────────

/** Stable, machine-readable failure codes for quality telemetry (ledger seed). */
export type CanvasQualityCode =
	| "NOT_COMPLETE"
	| "EVIDENCE_BLOCKED"
	| "EVIDENCE_NONE"
	| "EVIDENCE_PENDING"
	| "NO_FETCHED_PACKETS"
	| "READ_COUNT"
	| "READ_NO_SOURCEIDS"
	| "READ_UNFETCHED_SOURCES"
	| "READ_UNSUPPORTED_ITEMS"
	| "EVIDENCE_UNSUPPORTED"
	| "SCENARIO_IN_BRIEF";

export type CanvasQualityTelemetry = {
	usable: boolean;
	codes: CanvasQualityCode[];
	evidenceStatus: EvidenceStatus;
	fetchedCount: number;
	qualityVersion: number;
};

// ── Pre-cache plan domain ───────────────────────────────────────────────────

export type PrecacheResearchRequest = {
	symbol: string;
	question: string;
	chartScope: ChartScope;
	researchKey: string;
	intent: ResearchIntent;
	contextLabel: string;
	/** Optional paired target for warm contexts (BRIEF + WHY in one run). */
	pairedTarget?: PairedCacheTarget;
	/** Per-run token ceiling reserved for this paired attempt. */
	tokenLimit?: number;
	/** Parent-only durable reservation correlation; never sent to the worker. */
	precacheReservation?: PrecacheReservationRef;
};

/** The first warm job acts as an extraction canary; the rest of the plan waits for its verdict. */
export type PrecacheCanaryState = "none" | "required" | "active" | "passed";

// ── Default watchlist ───────────────────────────────────────────────────────

export const DEFAULT_WATCHLIST = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "TSLA", "JPM", "XLE", "TLT", "GLD", "BTC-USD"] as const;

// ── MarketState ─────────────────────────────────────────────────────────────

/**
 * Instance-based container for every mutable research/UI-adjacent value the
 * extension kept at module scope. Field initialization mirrors the extension
 * exactly (same types, same defaults); reset methods mutate in place because
 * open terminal panels hold the watchlist/queue arrays by reference.
 */
export class MarketState {
	private readonly _ports: KernelPorts;

	/** Injected environment ports (clock/storage/transport/events). */
	get ports(): KernelPorts {
		return this._ports;
	}

	researchJobs = new Map<string, ResearchJob>();
	researchQueue: string[] = [];
	latestResearchBySymbol = new Map<string, string>();
	canvases = new Map<string, Canvas>();
	researchArchive = new Map<string, ArchivedResearch[]>();
	toolResearchJobs = new Map<string, string>();
	researchExtracts = new Map<string, Map<string, string>>();
	workerSubmittedResearch = new Set<string>();
	workerFinalizations = new Set<string>();
	/** Complete strict pair splits held until both archive mutation and validation finish. */
	pendingPairedCanvases = new Map<string, { brief: Canvas; why: Canvas }>();
	// Extraction attempts include bot-walled fetches (failures count against
	// the budget by design), so the cap must leave recovery room above the
	// prompt's 2–4 extractions or a single blocked source kills the whole run.
	researchCandidates = new ResearchCandidateRegistry({ maxExtractions: 8, ttlMs: 15 * 60_000 });
	researchSequence = 0;
	publicSessionResearchRuns = 0;
	// Mutable, session-scoped watchlist so users can add/remove tickers in-terminal.
	watchlist: string[] = [...DEFAULT_WATCHLIST];
	archiveCwd: string | undefined;
	archivePath: string | undefined;
	archiveReady: Promise<void> | undefined;
	archiveWriteQueue: Promise<void> = Promise.resolve();
	/** Once-per-bootstrap guard for the research cache pre-warm; cleared by resetResearchJobs. */
	precacheWarmState = false;
	/** Pre-warm candidates not yet submitted to the research queue; drained progressively. */
	precachePending: PrecacheResearchRequest[] = [];
	/** Consecutive non-usable pre-warm completions before the warm circuit opens. */
	precacheDegradedStreak = 0;
	/** Cooldown while the pre-warm circuit is open (configured-but-broken extractor outage). */
	precacheCircuitOpenUntil = 0;
	precacheCanaryState: PrecacheCanaryState = "none";
	precacheCanaryJobId: string | undefined;
	/** Bumped on resetResearchJobs; warm continuations verify it after every await. */
	warmGeneration = 0;
	precacheLedgerWriteQueue: Promise<void> = Promise.resolve();
	runningResearchId: string | undefined;
	marketScout: MarketEventScout | undefined;
	marketScoutCwd: string | undefined;
	marketScoutTimer: ReturnType<typeof setTimeout> | undefined;
	marketScoutAbort: AbortController | undefined;
	marketScoutInFlight: Promise<MarketEventScoutRunResult> | undefined;
	marketScoutDrain: Promise<void> | undefined;
	marketScoutSchedulerActive = false;
	marketScoutGeneration = 0;
	marketScoutLastError: string | undefined;
	marketScoutLastNotifiedError: string | undefined;
	/** Monotonic request sequence so a superseded refresh can never write stale UI. */
	cryptoPulseRequestSequence = 0;
	/** Shared, session-scoped crypto pulse cache (stale-while-revalidate). */
	readonly CRYPTO_PULSE_CACHE = new CryptoPulseCache(60_000);

	constructor(ports: KernelPorts) {
		this._ports = ports;
	}

	/** Session reset: restore the default watchlist in place (panels hold the array by reference). */
	resetWatchlist(): void {
		// Open panels retain this array by reference, so session resets mutate it.
		this.watchlist.splice(0, this.watchlist.length, ...DEFAULT_WATCHLIST);
	}

	/**
	 * Session reset for the research pipeline. The extension wraps this method
	 * with the process-scoped resets (worker coordinator, worker bridge, and
	 * the pre-warm hooks) that stay at module scope.
	 */
	resetResearchJobs(): void {
		this.researchJobs.clear();
		this.researchCandidates.reset();
		this.researchExtracts.clear();
		this.latestResearchBySymbol.clear();
		this.researchQueue.splice(0, this.researchQueue.length);
		this.workerSubmittedResearch.clear();
		this.workerFinalizations.clear();
		this.pendingPairedCanvases.clear();
		this.toolResearchJobs.clear();
		this.runningResearchId = undefined;
		this.publicSessionResearchRuns = 0;
		this.precacheWarmState = false;
		this.precachePending = [];
		this.precacheCanaryState = "none";
		this.precacheCanaryJobId = undefined;
		this.warmGeneration += 1;
	}
}
