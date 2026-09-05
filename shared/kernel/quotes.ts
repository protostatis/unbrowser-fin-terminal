/**
 * framework-free kernel — extracted from .pi/extensions/market-terminal.ts, stage 1 slice 1.
 * Quote-domain model: chart scopes, the Quote type, the Yahoo chart payload
 * parser, and the deterministic Monday pre-market mock fixture.
 */

export type ChartScope = "day" | "week" | "month" | "year" | "max";
export type ChartSession = "pre" | "regular" | "post" | "unknown";

export type Quote = {
	symbol: string;
	name: string;
	exchange: string;
	currency: string;
	price: number;
	change: number | null;
	changePercent: number | null;
	previousClose: number | null;
	dayLow: number | null;
	dayHigh: number | null;
	volume: number | null;
	preMarketVolume: number | null;
	postMarketVolume: number | null;
	/**
	 * Yahoo meta.hasPrePostMarketData. Indices (^GSPC, ^N225, …) report false:
	 * they never emit pre/post bars, so in extended sessions their DAY chart
	 * is the prior regular session (stale) and the board needs a proxy feed
	 * (index futures). Absent (older fixtures) means unknown → treat as false.
	 */
	hasPrePostMarketData?: boolean;
	marketState: string;
	updatedAt: number | null;
	points: number[];
	pointTimes: number[];
	pointSessions: ChartSession[];
	pointVolumes: number[];
	pointOpens: number[];
	pointHighs: number[];
	pointLows: number[];
	timezone: string;
	interval: string;
	source: string;
	chartScope: ChartScope;
};

export const CHART_SCOPE_CONFIGS: Record<ChartScope, { label: string; yahooRange: string; yahooInterval: string; includePrePost: boolean; key: number }> = {
	day:   { label: "DAY",   yahooRange: "1d",  yahooInterval: "5m",  includePrePost: true,  key: 1 },
	week:  { label: "WEEK",  yahooRange: "5d",  yahooInterval: "15m", includePrePost: false, key: 2 },
	month: { label: "MONTH", yahooRange: "1mo", yahooInterval: "60m", includePrePost: false, key: 3 },
	year:  { label: "YEAR",  yahooRange: "1y",  yahooInterval: "1d",  includePrePost: false, key: 4 },
	max:   { label: "TOTAL", yahooRange: "max", yahooInterval: "1mo", includePrePost: false, key: 5 },
};

export const SCOPE_KEYS: Record<number, ChartScope> = { 1: "day", 2: "week", 3: "month", 4: "year", 5: "max" };

export const DEFAULT_CHART_SCOPE: ChartScope = "day";

export const SCOPE_LABEL_ORDER: ChartScope[] = ["day", "week", "month", "year", "max"];
export const CHART_SCOPE_SET = new Set<ChartScope>(SCOPE_LABEL_ORDER);

export function normalizeChartScope(value: unknown): ChartScope {
	return typeof value === "string" && CHART_SCOPE_SET.has(value as ChartScope) ? value as ChartScope : DEFAULT_CHART_SCOPE;
}

/**
 * Pure parser for a Yahoo chart v8 response → Quote.
 *
 * The chart API does not reliably ship meta.marketState / preMarketPrice /
 * postMarketPrice (verified against the live endpoint: the current meta carries
 * neither). The session is therefore DERIVED from the chart's own bars: each
 * bar is tagged pre/regular/post against currentTradingPeriod, and the last
 * bar determines the live session (REGULAR/PRE/POST). The extended price is the
 * last close in that session's bars (the chart includes pre/post bars when
 * includePrePost=true). meta.marketState, when present, still wins — some
 * deployments/response variants return it.
 */
export function normalizeMarketState(raw: string): string {
	const upper = raw.toUpperCase().replace("PREPRE", "PRE").replace("POSTPOST", "POST");
	if (upper === "PRE" || upper === "POST" || upper === "REGULAR" || upper === "CLOSED") return upper;
	return "UNKNOWN";
}

export function parseChartPayloadToQuote(
	symbol: string,
	payload: unknown,
	cfg: { yahooInterval: string; includePrePost: boolean; chartScope: ChartScope },
): Quote {
	const chart = (payload as {
		chart?: { result?: Array<{ meta?: Record<string, unknown>; timestamp?: Array<number | null>; indicators?: { quote?: Array<{ close?: Array<number | null>; open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; volume?: Array<number | null> }> } }> };
	})?.chart?.result?.[0];
	const meta = chart?.meta;
	if (!chart || !meta) throw new Error("quote response contained no chart data");

	const rawCloses = chart.indicators?.quote?.[0]?.close ?? [];
	const rawOpens = chart.indicators?.quote?.[0]?.open ?? [];
	const rawHighs = chart.indicators?.quote?.[0]?.high ?? [];
	const rawLows = chart.indicators?.quote?.[0]?.low ?? [];
	const rawVolumes = chart.indicators?.quote?.[0]?.volume ?? [];
	const rawTimes = chart.timestamp ?? [];
	const validCloses = rawCloses.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	const tradingPeriods = meta.currentTradingPeriod && typeof meta.currentTradingPeriod === "object"
		? meta.currentTradingPeriod as Record<string, unknown>
		: {};
	const periodBounds = (key: "pre" | "regular" | "post"): { start: number; end: number } | undefined => {
		const value = tradingPeriods[key];
		if (!value || typeof value !== "object") return undefined;
		const period = value as Record<string, unknown>;
		return typeof period.start === "number" && typeof period.end === "number"
			? { start: period.start, end: period.end }
			: undefined;
	};
	const pre = cfg.includePrePost ? periodBounds("pre") : undefined;
	const regular = periodBounds("regular");
	const post = cfg.includePrePost ? periodBounds("post") : undefined;
	const sessionAt = (timestampSeconds: number): ChartSession => {
		if (regular && timestampSeconds >= regular.start && timestampSeconds < regular.end) return "regular";
		if (pre && timestampSeconds >= pre.start && timestampSeconds < pre.end) return "pre";
		if (post && timestampSeconds >= post.start && timestampSeconds <= post.end) return "post";
		return "unknown";
	};
	const alignedPoints: number[] = [];
	const alignedTimes: number[] = [];
	const alignedSessions: ChartSession[] = [];
	const alignedVolumes: number[] = [];
	const alignedOpens: number[] = [];
	const alignedHighs: number[] = [];
	const alignedLows: number[] = [];
	for (let index = 0; index < rawCloses.length; index++) {
		const close = rawCloses[index];
		const timestamp = rawTimes[index];
		if (typeof close !== "number" || !Number.isFinite(close) || typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
		alignedPoints.push(close);
		alignedTimes.push(timestamp * 1000);
		alignedSessions.push(sessionAt(timestamp));
		const volume = rawVolumes[index];
		alignedVolumes.push(typeof volume === "number" && Number.isFinite(volume) ? volume : 0);
		const open = rawOpens[index];
		const high = rawHighs[index];
		const low = rawLows[index];
		alignedOpens.push(typeof open === "number" && Number.isFinite(open) ? open : close);
		alignedHighs.push(typeof high === "number" && Number.isFinite(high) ? high : close);
		alignedLows.push(typeof low === "number" && Number.isFinite(low) ? low : close);
	}
	const hasTimedSeries = alignedPoints.length >= 2;
	const closes = hasTimedSeries ? alignedPoints : validCloses;
	const pointTimes = hasTimedSeries ? alignedTimes : [];
	const pointSessions = hasTimedSeries ? alignedSessions : [];
	const number = (key: string): number | null => (typeof meta[key] === "number" ? (meta[key] as number) : null);
	const metaState = typeof meta.marketState === "string" ? normalizeMarketState(meta.marketState) : "UNKNOWN";
	// Derive the session from the last tagged bar: includePrePost=true carries
	// pre/post bars, so the last bar tells us which session is live without
	// trusting meta keys that the current endpoint omits. A single valid bar
	// (e.g. the first data point of an early pre-market refresh) is enough.
	const lastSession = alignedPoints.length > 0 ? alignedSessions.at(-1) : undefined;
	const derivedState = lastSession === "pre" ? "PRE" : lastSession === "post" ? "POST" : lastSession === "regular" ? "REGULAR" : "CLOSED";
	const marketState = metaState !== "UNKNOWN" ? metaState : derivedState;
	// Last close of the active session — the live price including pre/post bars.
	const lastSessionClose = alignedPoints.length > 0 ? alignedPoints.at(-1) : undefined;
	const extendedPrice = marketState === "POST"
		? number("postMarketPrice") ?? (lastSession === "post" ? lastSessionClose : null) ?? null
		: marketState === "PRE" ? number("preMarketPrice") ?? (lastSession === "pre" ? lastSessionClose : null) ?? null : null;
	const price = extendedPrice ?? number("regularMarketPrice") ?? closes.at(-1);
	if (price === undefined || price === null) throw new Error("quote response contained no market price");
	const previousClose = number("previousClose") ?? number("chartPreviousClose");
	// Yahoo exposes two different references here. `previousClose` is the
	// latest regular-session close, while `chartPreviousClose` is the close
	// immediately before the requested chart range. Movers and quote headers
	// must follow the selected scope, otherwise WEEK/MONTH silently display the
	// current daily move even though their chart starts much earlier.
	const scopeBaseline = cfg.chartScope === "day"
		? previousClose
		: number("chartPreviousClose") ?? closes[0] ?? previousClose;
	const change = scopeBaseline === null ? null : price - scopeBaseline;
	// Pre/post volume is not part of the public chart meta; the bars also tag it
	// null there. Opportunistic capture keeps the mover volume leg honest when a
	// future/alternate feed does ship it. Volumes are aligned with sessions at
	// build time, so skipped invalid bars cannot misalign the sum.
	const extendedTime = marketState === "POST"
		? number("postMarketTime")
		: marketState === "PRE" ? number("preMarketTime") : null;
	const lastBarTimestampMs = alignedTimes.length > 0 ? alignedTimes.at(-1) ?? null : null;
	const regularTimeMs = number("regularMarketTime") !== null ? number("regularMarketTime")! * 1000 : null;
	// During extended sessions prefer the latest pre/post bar time over the
	// (stale) regular-session timestamp; otherwise prefer meta.
	const updatedAtMs = extendedTime !== null ? extendedTime * 1000
		: marketState === "PRE" || marketState === "POST"
			? lastBarTimestampMs ?? regularTimeMs
			: regularTimeMs ?? lastBarTimestampMs;
	const barVolume = (session: ChartSession): number | null => {
		if (alignedVolumes.length === 0) return null;
		let sum = 0;
		for (let index = 0; index < alignedSessions.length; index++) {
			if (alignedSessions[index] !== session) continue;
			const volume = alignedVolumes[index]!;
			if (volume > 0) sum += volume;
		}
		return sum > 0 ? sum : null;
	};

	return {
		symbol,
		name: typeof meta.longName === "string" ? meta.longName : typeof meta.shortName === "string" ? meta.shortName : symbol,
		exchange: typeof meta.fullExchangeName === "string" ? meta.fullExchangeName : "--",
		currency: typeof meta.currency === "string" && meta.currency.trim() ? meta.currency.trim().toUpperCase() : "XXX",
		hasPrePostMarketData: meta.hasPrePostMarketData === true,
		price,
		change,
		changePercent: change === null || scopeBaseline === null || scopeBaseline === 0 ? null : (change / scopeBaseline) * 100,
		previousClose,
		dayLow: number("regularMarketDayLow"),
		dayHigh: number("regularMarketDayHigh"),
		volume: number("regularMarketVolume"),
		preMarketVolume: number("preMarketVolume") ?? barVolume("pre"),
		postMarketVolume: number("postMarketVolume") ?? barVolume("post"),
		marketState,
		updatedAt: updatedAtMs ?? pointTimes.at(-1) ?? null,
		points: closes,
		pointTimes,
		pointSessions,
		pointVolumes: hasTimedSeries && alignedVolumes.length === closes.length ? alignedVolumes : [],
		pointOpens: hasTimedSeries && alignedOpens.length === closes.length ? alignedOpens : [],
		pointHighs: hasTimedSeries && alignedHighs.length === closes.length ? alignedHighs : [],
		pointLows: hasTimedSeries && alignedLows.length === closes.length ? alignedLows : [],
		timezone: typeof meta.exchangeTimezoneName === "string" ? meta.exchangeTimezoneName : "UTC",
		interval: typeof meta.dataGranularity === "string" ? meta.dataGranularity : cfg.yahooInterval,
		source: "Yahoo Finance chart API (public/delayed; verify before trading)",
		chartScope: cfg.chartScope,
	};
}

/**
 * Monday pre-market mock.
 *
 * The public Yahoo chart API cannot be observed in a PRE session on weekends
 * (the last bar is Friday's post bar), so tests that need "as of Monday
 * pre-market" behavior build a synthetic chart payload. Set
 * MARKET_MOCK_MONDAY=1 to serve these instead of the live feed — useful for
 * local dev, demos, and verifying the PRE session path through the REAL parser
 * and mover pipeline on any day of the week.
 *
 * Deterministic: the same symbol always produces the same Friday close, pre
 * move, and volume, so snapshots are reproducible across runs.
 */
export function readMarketMockMonday(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.MARKET_MOCK_MONDAY ?? "").trim() === "1";
}

// Monday 2026-08-24, EDT = UTC-4.
export const MOCK_MON_0000_ET = 1_787_529_600;
export const MOCK_PRE_START = MOCK_MON_0000_ET + 4 * 3_600;       // 04:00 ET
export const MOCK_REGULAR_START = MOCK_MON_0000_ET + 9.5 * 3_600; // 09:30 ET
export const MOCK_REGULAR_END = MOCK_MON_0000_ET + 16 * 3_600;    // 16:00 ET
export const MOCK_MON_BARS = 5;

export function mockSymbolHash(symbol: string): number {
	let hash = 0;
	for (const char of symbol) hash = ((hash << 5) - hash + char.charCodeAt(0)) >>> 0;
	return hash;
}

/** Deterministic per-symbol Monday pre-market fixture. */
export function mockMondaySymbol(symbol: string): { fridayClose: number; preMovePct: number; fridayVol: number } {
	const hash = mockSymbolHash(symbol);
	// Spread the 32-bit hash across independent bands so price/move/volume vary
	// for short symbols too (`hash >>> 16` collapses for 4–6 char names).
	const priceBand = (hash ^ (hash << 9 >>> 0)) % 960;
	const moveBand = ((hash * 2654435761) >>> 0) % 160;
	const volBand = ((hash ^ (hash << 13 >>> 0)) >>> 8) % 115_000_000;
	const fridayClose = 40 + priceBand;
	const preMovePct = Math.round(moveBand - 80) / 10; // −8.0..+7.9
	const fridayVol = 5_000_000 + volBand;
	return { fridayClose, preMovePct, fridayVol };
}

export function mockMondayChartPayload(symbol: string): unknown {
	const vm = mockMondaySymbol(symbol);
	const preClose = vm.fridayClose * (1 + vm.preMovePct / 100);

	// A Monday pre-market chart (range=1d, includePrePost) carries PRE bars from
	// 04:00 ET up to ~08:55 ET — with the public feed shipping 0 volume for them.
	// meta.regularMarketVolume supplies Friday's session volume for the proxy leg.
	const preTimestamps: number[] = [];
	const preCloses: number[] = [];
	for (let i = 0; i < MOCK_MON_BARS; i++) {
		const last = i === MOCK_MON_BARS - 1;
		preTimestamps.push(last
			? MOCK_PRE_START + 295 * 60 // 08:55 ET, just before open
			: MOCK_PRE_START + i * 60 * 60); // 05:00, 06:00, 07:00, 08:00 ET
		preCloses.push(last ? preClose : vm.fridayClose * (1 + vm.preMovePct / 100 / 2));
	}

	return {
		chart: {
			result: [{
				meta: {
					symbol,
					currency: "USD",
					longName: `${symbol} Inc.`,
					shortName: symbol,
					fullExchangeName: "NasdaqGS",
					exchangeTimezoneName: "America/New_York",
					dataGranularity: "5m",
					regularMarketPrice: vm.fridayClose,
					regularMarketVolume: vm.fridayVol,
					regularMarketTime: MOCK_REGULAR_END,
					previousClose: vm.fridayClose,
					chartPreviousClose: vm.fridayClose,
					currentTradingPeriod: {
						pre: { start: MOCK_PRE_START, end: MOCK_REGULAR_START, timezone: "America/New_York", gmtoffset: -14400 },
						regular: { start: MOCK_REGULAR_START, end: MOCK_REGULAR_END, timezone: "America/New_York", gmtoffset: -14400 },
						post: { start: MOCK_REGULAR_END, end: MOCK_REGULAR_END + 4 * 3_600, timezone: "America/New_York", gmtoffset: -14400 },
					},
					// Deliberately NO marketState / preMarketPrice / preMarketVolume,
					// exactly like the live public endpoint (verified 2026-08-22).
				},
				timestamp: preTimestamps,
				indicators: { quote: [{ close: preCloses, volume: preTimestamps.map(() => 0) }] },
			}],
		},
	};
}
