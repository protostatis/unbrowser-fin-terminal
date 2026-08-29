/**
 * framework-free kernel — extracted from .pi/extensions/market-terminal.ts, stage 1 slice 1.
 * Mover scoring domain: session-aware volume resolution, eligibility, and
 * percentile ranking over the fixed mover universe.
 */

import type { Quote } from "./quotes.js";

export const MOVER_UNIVERSE = [
	"AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "AVGO", "NFLX", "ORCL", "CRM", "PLTR", "INTC", "MU", "QCOM",
	"ADBE", "NOW", "PANW", "CRWD", "AMAT", "LRCX", "KLAC", "ADI", "TXN", "MRVL", "ARM", "SMCI", "DELL", "IBM", "CSCO", "UBER", "ABNB", "SNOW",
	"JPM", "BAC", "GS", "V", "MA", "COIN", "BRK-B", "MS", "C", "WFC", "AXP", "SCHW", "BLK", "COF", "HOOD", "PYPL", "SOFI",
	"XOM", "CVX", "COP", "SLB", "EOG", "OXY", "MPC", "VLO",
	"LLY", "UNH", "JNJ", "PFE", "ABBV", "MRK", "AMGN", "GILD", "TMO", "ABT", "MDT", "BMY", "CVS", "HCA",
	"WMT", "COST", "HD", "DIS", "NKE", "MCD", "F", "GM", "TGT", "LOW", "SBUX", "CMG", "BKNG", "MAR", "RCL", "CCL", "DAL", "UAL", "LULU", "ROST", "TJX", "KO", "PEP", "PM",
	"BA", "CAT", "GE", "T", "VZ", "DE", "RTX", "LMT", "HON", "UPS", "FDX", "ETN", "CMCSA", "TMUS", "SNAP", "PINS", "ROKU", "NEE", "FCX", "NEM",
] as const;
export const MOVER_LIMIT = 100;
export const MOVER_MOVEMENT_WEIGHT = 0.65;
export const MOVER_VOLUME_WEIGHT = 0.35;

export function percentileScore(values: number[], value: number): number {
	if (values.length <= 1) return 1;
	let below = 0;
	let equal = 0;
	for (const candidate of values) {
		if (candidate < value) below++;
		else if (candidate === value) equal++;
	}
	return (below + Math.max(0, equal - 1) / 2) / (values.length - 1);
}

export function positiveFinite(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function isExtendedSession(marketState: string): boolean {
	const state = (marketState || "").toUpperCase();
	return state.startsWith("PRE") || state.startsWith("POST");
}

/** Volume basis for an entire mover snapshot:
 *  - "live"  → each PRE/POST quote ranks on its own extended-session volume;
 *              quotes whose extended volume is missing rank movement-only ($VOL 0).
 *  - "proxy" → PRE/POST quotes without extended-session volume rank on the
 *              regular-session figure, uniformly, always labeled as a proxy.
 * A snapshot picks ONE basis so a pre-market move is never pitted against a
 * previous-session proxy inside the same percentile distribution. */
export type MoverVolumeBasis = "live" | "proxy";

export type MoverVolumeResolution = {
	/** Shares used for the $VOL leg of the mover score. */
	volume: number;
	/** Which session the volume figure actually measures. */
	session: "pre" | "post" | "regular";
	/** True when the volume leg fell back to a different session than the one the quote trades in. */
	proxied: boolean;
};

/**
 * Session-aware volume for mover scoring.
 *
 * - PRE → prefer live pre-market volume; under the "proxy" basis, fall back to
 *   the regular-session volume (proxy signal) when Yahoo ships no pre-market
 *   volume. Under the "live" basis, a missing pre-market volume resolves to 0
 *   so the quote ranks movement-first instead of inheriting a foreign figure.
 * - POST → same, preferring post-market volume.
 * - regular → the regular-session volume, unchanged from the legacy formula.
 */
export function moverVolume(quote: Quote, basis: MoverVolumeBasis = "proxy"): MoverVolumeResolution {
	const state = (quote.marketState || "").toUpperCase();
	const regular = positiveFinite(quote.volume);
	if (state.startsWith("PRE")) {
		const pre = positiveFinite(quote.preMarketVolume);
		if (pre !== null) return { volume: pre, session: "pre", proxied: false };
		if (basis === "proxy" && regular !== null) return { volume: regular, session: "regular", proxied: true };
		return { volume: 0, session: "pre", proxied: false };
	}
	if (state.startsWith("POST")) {
		const post = positiveFinite(quote.postMarketVolume);
		if (post !== null) return { volume: post, session: "post", proxied: false };
		if (basis === "proxy" && regular !== null) return { volume: regular, session: "regular", proxied: true };
		return { volume: 0, session: "post", proxied: false };
	}
	return { volume: regular ?? 0, session: "regular", proxied: false };
}

/**
 * Extended sessions may carry a real pre/post-market move while Yahoo has not
 * yet populated any volume field. Those quotes stay eligible (movement-first),
 * because dropping them makes the pre-market mover list vanish entirely.
 */
export function moverEligible(marketState: string, volume: number | null): boolean {
	if (isExtendedSession(marketState)) return true;
	return positiveFinite(volume) !== null;
}

/** Compact volume always ≤ 5 chars ("1.2M", "988K", "45M", "900"), offsets the
 *  session tag so the row label stays inside the fixed 11-char field. */
export function compactMoverVolume(volume: number): string {
	if (volume >= 1_000_000) {
		const millions = volume / 1_000_000;
		return `${millions >= 100 ? String(Math.round(millions)) : String(Math.round(millions * 10) / 10)}M`;
	}
	if (volume >= 1_000) {
		const thousands = volume / 1_000;
		return `${thousands >= 100 ? String(Math.round(thousands)) : String(Math.round(thousands * 10) / 10)}K`;
	}
	return String(Math.round(volume));
}

/** Short, honest volume-leg label for a mover row.
 *  Live extended-session volume: "VOL PM 1.2M" / "VOL AF 988K".
 *  Proxied (regular-session figure): "VOL 8.1M~" — always marked, never dressed as extended volume.
 *  Movement-only (no usable volume): "VOL --". */
export function moverVolumeRowLabel(quote: Quote, basis: MoverVolumeBasis = "proxy"): string {
	const resolution = moverVolume(quote, basis);
	if (resolution.volume <= 0) return "VOL --";
	const sessionLabel = resolution.proxied ? "" : resolution.session === "pre" ? "PM " : resolution.session === "post" ? "AF " : "";
	const proxyMark = resolution.proxied ? "~" : "";
	return `VOL ${sessionLabel}${compactMoverVolume(resolution.volume)}${proxyMark}`;
}

export function eligibleMoverQuotes(quotes: Quote[]): Quote[] {
	const eligibleSymbols = new Set<string>(MOVER_UNIVERSE);
	return quotes.filter((quote) =>
		eligibleSymbols.has(quote.symbol)
		&& typeof quote.changePercent === "number"
		&& Number.isFinite(quote.changePercent)
		&& Number.isFinite(quote.price)
		&& quote.price > 0
		&& moverEligible(quote.marketState, quote.volume),
	);
}

export function rankMovers(quotes: Quote[], limit = MOVER_LIMIT): RankedMover[] {
	const candidates = eligibleMoverQuotes(quotes);
	// One basis per snapshot: if ANY candidate carries a live extended-session
	// volume figure, everyone else in an extended session ranks movement-first
	// rather than inheriting a regular-session proxy into a mixed distribution.
	// When NO candidate has live extended volume, extended quotes uniformly use
	// the regular-session figure as a labeled liquidity proxy.
	const hasLiveExtendedVolume = candidates.some(
		(quote) => (quote.marketState || "").toUpperCase().startsWith("PRE")
			? positiveFinite(quote.preMarketVolume) !== null
			: (quote.marketState || "").toUpperCase().startsWith("POST")
				? positiveFinite(quote.postMarketVolume) !== null
				: false,
	);
	const basis: MoverVolumeBasis = hasLiveExtendedVolume ? "live" : "proxy";
	const withVolume = candidates.map((quote) => ({ quote, volume: moverVolume(quote, basis) }));
	const movements = withVolume.map((entry) => Math.abs(entry.quote.changePercent!));
	const dollarVolumes = withVolume.map((entry) => entry.quote.price * entry.volume.volume);
	// When no candidate has any usable volume (e.g. a pre-market move with no
	// extended volume anywhere), the $VOL leg is meaningless; flag the snapshot
	// as move-only so the UI stops implying 65/35 liquidity scoring.
	const moveOnly = dollarVolumes.every((dollarVolume) => dollarVolume <= 0);
	return withVolume
		.map(({ quote, volume }): RankedMover => {
			const movement = Math.abs(quote.changePercent!);
			const dollarVolume = quote.price * volume.volume;
			const movementPercentile = percentileScore(movements, movement);
			const volumePercentile = moveOnly
				? 0
				: percentileScore(dollarVolumes, dollarVolume);
			// Move-only snapshots score purely on movement; otherwise 65/35.
			const score = moveOnly
				? movementPercentile
				: movementPercentile * MOVER_MOVEMENT_WEIGHT + volumePercentile * MOVER_VOLUME_WEIGHT;
			return {
				quote,
				score,
				movementPercentile,
				volumePercentile,
				dollarVolume,
				volumeSource: volume.session,
				volumeProxied: volume.proxied,
				volumeBasis: basis,
				moveOnly,
			};
		})
		.sort((a, b) => b.score - a.score
			|| Math.abs(b.quote.changePercent!) - Math.abs(a.quote.changePercent!)
			|| b.dollarVolume - a.dollarVolume
			|| a.quote.symbol.localeCompare(b.quote.symbol))
		.slice(0, Math.max(0, limit));
}

export type RankedMover = {
	quote: Quote;
	score: number;
	movementPercentile: number;
	volumePercentile: number;
	dollarVolume: number;
	/** Which session the $VOL leg measured: "pre" | "post" | "regular". */
	volumeSource: "pre" | "post" | "regular";
	/** True when the volume leg fell back to a different session as a liquidity proxy. */
	volumeProxied: boolean;
	/** Volume basis chosen for the whole snapshot: "live" or "proxy". */
	volumeBasis: MoverVolumeBasis;
	/** True when no candidate had usable volume — the score is movement-only. */
	moveOnly: boolean;
};
