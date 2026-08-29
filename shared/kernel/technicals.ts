/**
 * framework-free kernel — extracted from .pi/extensions/market-terminal.ts, stage 1 slice 1.
 * Technical indicators (SMA/EMA/Wilder RSI/MACD/momentum), the
 * TechnicalSnapshot builder, the canvas block type family, and the TA canvas
 * block formatters.
 */

import { CHART_SCOPE_CONFIGS } from "./quotes.js";
import type { ChartScope, ChartSession, Quote } from "./quotes.js";

export type ResearchIntent = "brief" | "why";
export type TechnicalSignal = "bullish" | "neutral" | "bearish";
export type TechnicalSnapshot = {
	symbol: string;
	currency: string;
	asOf: number;
	interval: string;
	timezone: string;
	chartScope: ChartScope;
	price: number;
	changePercent: number | null;
	previousClose: number | null;
	signal: TechnicalSignal;
	sma20: number | null;
	ema12: number | null;
	ema26: number | null;
	rsi14: number | null;
	macd: number | null;
	macdSignal: number | null;
	macdHistogram: number | null;
	momentum1h: number | null;
	lastBarReturn: number | null;
	lastBarReturnLabel: string;
	closeLow: number | null;
	closeHigh: number | null;
	rangeBars: number;
	score: number;
	signalCount: number;
	sessionPolicy: string;
	pricePoints: number[];
	priceTimes: number[];
	priceSessions: ChartSession[];
	rsiPoints: number[];
	rsiTimes: number[];
	rsiSessions: ChartSession[];
	trendPoints: number[];
	trendTimes: number[];
	trendSessions: ChartSession[];
	macdHistogramPoints: number[];
	macdHistogramTimes: number[];
	macdHistogramSessions: ChartSession[];
	source: string;
};

export type CanvasMetricItem = { label: string; value: string; delta?: string; note?: string; sourceIds?: string[] };
export type CanvasTableBlock = { id?: string; kind: "table"; title?: string; columns: string[]; rows: string[][]; totalRows?: number; sourceIds?: string[]; dossierHint?: DossierHint };
export type CanvasNewsItem = { headline: string; source?: string; url?: string; note?: string; sourceIds?: string[] };
export type CanvasBulletItem = { text: string; role?: "fact" | "interpretation" | "risk" | "catalyst"; sourceIds?: string[] };
export type CanvasSourceItem = { id: string; label: string; url: string; status?: "search-only" | "fetched" | "challenged" | "failed" | "limited" };
export type DossierHint = "read" | "evidence" | "unknowns" | "scenarios" | "technical" | "sources";
export type EvidenceStatus = "pending" | "available" | "partial" | "blocked" | "none";
export type EvidencePacket = {
	sourceId: string;
	sourceTitle: string;
	sourceDomain: string;
	sourceUrl: string;
	excerpt: string;
	retrievalStatus: "fetched" | "challenged" | "limited" | "failed";
	extractedAt: number;
	extractionMode: string;
	truncated: boolean;
	failureNote?: string;
};
export type DossierCitation = { sourceId: string; quote: string };
export type CanvasChartAnnotation = { label: string; value: number; role?: "support" | "resistance" | "signal" };
export type CanvasChartBlock = {
	id?: string;
	kind: "chart";
	title?: string;
	symbol?: string;
	points: number[];
	pointTimes?: number[];
	pointSessions?: ChartSession[];
	reference?: number;
	interval?: string;
	timezone?: string;
	currency?: string;
	asOf?: number;
	format?: "price" | "percent" | "number";
	minValue?: number;
	maxValue?: number;
	height?: number;
	chartStyle?: "points" | "line" | "histogram";
	chartScope?: ChartScope;
	annotations?: CanvasChartAnnotation[];
	sourceIds?: string[];
	dossierHint?: DossierHint;
};
export type CanvasBlock =
	| { id?: string; kind: "text"; title?: string; text: string; sourceIds?: string[]; dossierHint?: DossierHint }
	| { id?: string; kind: "metrics"; title?: string; items: CanvasMetricItem[]; sourceIds?: string[]; dossierHint?: DossierHint }
	| CanvasTableBlock
	| { id?: string; kind: "news"; title?: string; items: CanvasNewsItem[]; sourceIds?: string[]; dossierHint?: DossierHint }
	| { id?: string; kind: "bullets"; title?: string; items: CanvasBulletItem[]; sourceIds?: string[]; dossierHint?: DossierHint }
	| { id?: string; kind: "sources"; title?: string; items: CanvasSourceItem[]; sourceIds?: string[]; dossierHint?: DossierHint }
	| CanvasChartBlock;
export type CanvasStage = "partial" | "complete";
export type Canvas = {
	symbol: string;
	title: string;
	content: string;
	blocks?: CanvasBlock[];
	updatedAt: number;
	researchId?: string;
	stage?: CanvasStage;
	chartScope?: ChartScope;
	researchKey?: string;
	intent?: ResearchIntent;
	contextLabel?: string;
	evidencePackets?: EvidencePacket[];
	evidenceBlocker?: string;
	evidenceCitations?: DossierCitation[];
};

export function dollars(value: number | null, currency = "USD"): string {
	if (value === null || !Number.isFinite(value)) return "--";
	try {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency,
			maximumFractionDigits: 2,
		}).format(value);
	} catch {
		return `${currency} ${value.toFixed(2)}`;
	}
}

export function safeChartTimezone(timezone: string | undefined): string {
	if (!timezone) return "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
		return timezone;
	} catch {
		return "UTC";
	}
}

export function quoteTimestampLabel(timestamp: number | null, timezone: string): string {
	if (!timestamp) return "time unavailable";
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: safeChartTimezone(timezone),
		timeZoneName: "short",
	}).format(timestamp);
}

export function smaSeries(points: number[], period: number): Array<number | null> {
	const result: Array<number | null> = Array.from({ length: points.length }, () => null);
	if (points.length < period) return result;
	let sum = 0;
	for (let index = 0; index < points.length; index++) {
		sum += points[index]!;
		if (index >= period) sum -= points[index - period]!;
		if (index >= period - 1) result[index] = sum / period;
	}
	return result;
}

export function emaSeries(points: number[], period: number): Array<number | null> {
	const result: Array<number | null> = Array.from({ length: points.length }, () => null);
	if (points.length < period) return result;
	const seed = points.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
	result[period - 1] = seed;
	const multiplier = 2 / (period + 1);
	for (let index = period; index < points.length; index++) {
		result[index] = (points[index]! - result[index - 1]!) * multiplier + result[index - 1]!;
	}
	return result;
}

export function rsiSeries(points: number[], period = 14): Array<{ index: number; value: number }> {
	const result: Array<{ index: number; value: number }> = [];
	if (points.length <= period) return result;
	let gains = 0;
	let losses = 0;
	for (let index = 1; index <= period; index++) {
		const change = points[index]! - points[index - 1]!;
		if (change > 0) gains += change;
		else if (change < 0) losses -= change;
	}
	let averageGain = gains / period;
	let averageLoss = losses / period;
	const valueFor = () => averageGain === 0 && averageLoss === 0
		? 50
		: averageLoss === 0 ? 100 : averageGain === 0 ? 0 : 100 - 100 / (1 + averageGain / averageLoss);
	result.push({ index: period, value: valueFor() });
	for (let index = period + 1; index < points.length; index++) {
		const change = points[index]! - points[index - 1]!;
		const gain = Math.max(0, change);
		const loss = Math.max(0, -change);
		averageGain = ((averageGain * (period - 1)) + gain) / period;
		averageLoss = ((averageLoss * (period - 1)) + loss) / period;
		result.push({ index, value: valueFor() });
	}
	return result;
}

export function sampledIndices(length: number, limit = 48): number[] {
	if (length <= limit) return Array.from({ length }, (_, index) => index);
	return Array.from({ length: limit }, (_, index) => Math.min(length - 1, Math.round((index / (limit - 1)) * (length - 1))));
}

export function sampleIndexedValues(series: Array<number | null>, limit = 48): { indices: number[]; values: number[] } {
	const available = series.flatMap((value, index) => value === null || !Number.isFinite(value) ? [] : [{ index, value }]);
	const sample = sampledIndices(available.length, limit).map((index) => available[index]!);
	return { indices: sample.map((item) => item.index), values: sample.map((item) => item.value) };
}

export function technicalSnapshot(quote: Quote): TechnicalSnapshot {
	const scope = quote.chartScope;
	const points = quote.points.filter((value) => Number.isFinite(value));
	if (points.length < 1) throw new Error("Technical analysis requires at least one valid chart close");
	const sma20Values = smaSeries(points, 20);
	const ema12Series = emaSeries(points, 12);
	const ema26Series = emaSeries(points, 26);
	const macdSeries = points.map((_, index) => ema12Series[index] !== null && ema26Series[index] !== null ? ema12Series[index]! - ema26Series[index]! : null);
	const validMacd = macdSeries.filter((value): value is number => value !== null);
	const macdSignalSeries = emaSeries(validMacd, 9);
	let macdIndex = 0;
	const macdHistogramSeries = macdSeries.map((value) => {
		if (value === null) return null;
		const signal = macdSignalSeries[macdIndex++] ?? null;
		return signal === null ? null : value - signal;
	});
	const trendDistanceSeries = points.map((value, index) => {
		const average = sma20Values[index];
		return average === null || average === 0 ? null : ((value / average) - 1) * 100;
	});
	const rsi = rsiSeries(points, 14);
	const sma20 = sma20Values.at(-1) ?? null;
	const ema12 = ema12Series.at(-1) ?? null;
	const ema26 = ema26Series.at(-1) ?? null;
	const macd = validMacd.at(-1) ?? null;
	const macdSignal = macdSignalSeries.at(-1) ?? null;
	const macdHistogram = macd !== null && macdSignal !== null ? macd - macdSignal : null;
	const rsi14 = rsi.at(-1)?.value ?? null;
	const timed = quote.pointTimes.length === points.length;
	const sessioned = quote.pointSessions.length === points.length;
	let momentum1h: number | null = null;
	let lastBarReturn: number | null = null;
	let lastBarReturnLabel = scope === "day" ? "1h momentum" : `${quote.interval} return`;

	// Day scope: compute same-session ~1h momentum as before
	if (scope === "day" && timed && sessioned) {
		const lastIndex = points.length - 1;
		const lastTime = quote.pointTimes[lastIndex]!;
		const session = quote.pointSessions[lastIndex]!;
		let anchorIndex = -1;
		let bestDistance = Number.POSITIVE_INFINITY;
		if (session !== "unknown") {
			for (let index = lastIndex - 1; index >= 0; index--) {
				if (quote.pointSessions[index] !== session) continue;
				const distance = Math.abs(lastTime - quote.pointTimes[index]! - 60 * 60_000);
				if (distance < bestDistance) {
					bestDistance = distance;
					anchorIndex = index;
				}
			}
		}
		if (anchorIndex >= 0 && bestDistance <= 15 * 60_000 && points[anchorIndex] !== 0) momentum1h = ((points[lastIndex]! / points[anchorIndex]!) - 1) * 100;
	}

	// Non-day scopes: compute last-bar return (compare last close to second-to-last close)
	if (scope !== "day" && points.length >= 2) {
		const prev = points[points.length - 2]!;
		const last = points[points.length - 1]!;
		if (prev !== 0) lastBarReturn = ((last / prev) - 1) * 100;
	}

	const levelWindow = points.slice(-Math.min(48, points.length));
	const closeLow = levelWindow.length > 0 ? Math.min(...levelWindow) : null;
	const closeHigh = levelWindow.length > 0 ? Math.max(...levelWindow) : null;
	const calculationPrice = points.at(-1)!;
	const calculationAsOf = timed ? quote.pointTimes.at(-1)! : quote.updatedAt ?? Date.now();
	let score = 0;
	let signalCount = 0;
	if (sma20 !== null) {
		signalCount++;
		const tolerance = Math.max(Math.abs(sma20) * 1e-6, 1e-8);
		score += calculationPrice > sma20 + tolerance ? 1 : calculationPrice < sma20 - tolerance ? -1 : 0;
	}
	if (rsi14 !== null) {
		signalCount++;
		score += rsi14 >= 55 ? 1 : rsi14 <= 45 ? -1 : 0;
	}
	if (macdHistogram !== null) {
		signalCount++;
		const tolerance = Math.max(Math.abs(calculationPrice) * 1e-9, 1e-10);
		score += macdHistogram > tolerance ? 1 : macdHistogram < -tolerance ? -1 : 0;
	}
	const signal: TechnicalSignal = score >= 2 ? "bullish" : score <= -2 ? "bearish" : "neutral";
	const priceSample = sampledIndices(points.length);
	const rsiSample = sampledIndices(rsi.length);
	const trendSample = sampleIndexedValues(trendDistanceSeries);
	const macdHistogramSample = sampleIndexedValues(macdHistogramSeries);
	return {
		symbol: quote.symbol,
		currency: quote.currency,
		asOf: calculationAsOf,
		interval: quote.interval,
		timezone: quote.timezone,
		chartScope: scope,
		price: calculationPrice,
		changePercent: quote.previousClose === null || quote.previousClose === 0 ? null : ((calculationPrice / quote.previousClose) - 1) * 100,
		previousClose: quote.previousClose,
		signal,
		sma20,
		ema12,
		ema26,
		rsi14,
		macd,
		macdSignal,
		macdHistogram,
		momentum1h,
		lastBarReturn,
		lastBarReturnLabel,
		closeLow,
		closeHigh,
		rangeBars: levelWindow.length,
		score,
		signalCount,
		sessionPolicy: scope === "day" ? "extended-hours-inclusive aligned closes" : `${CHART_SCOPE_CONFIGS[scope].label} chart closes, ${quote.interval} bars`,
		pricePoints: priceSample.map((index) => points[index]!),
		priceTimes: timed ? priceSample.map((index) => quote.pointTimes[index]!) : [],
		priceSessions: sessioned ? priceSample.map((index) => quote.pointSessions[index]!) : [],
		rsiPoints: rsiSample.map((index) => rsi[index]!.value),
		rsiTimes: timed ? rsiSample.map((index) => quote.pointTimes[rsi[index]!.index]!) : [],
		rsiSessions: sessioned ? rsiSample.map((index) => quote.pointSessions[rsi[index]!.index]!) : [],
		trendPoints: trendSample.values,
		trendTimes: timed ? trendSample.indices.map((index) => quote.pointTimes[index]!) : [],
		trendSessions: sessioned ? trendSample.indices.map((index) => quote.pointSessions[index]!) : [],
		macdHistogramPoints: macdHistogramSample.values,
		macdHistogramTimes: timed ? macdHistogramSample.indices.map((index) => quote.pointTimes[index]!) : [],
		macdHistogramSessions: sessioned ? macdHistogramSample.indices.map((index) => quote.pointSessions[index]!) : [],
		source: quote.source,
	};
}

export function technicalCanvasBlocks(snapshot: TechnicalSnapshot): CanvasBlock[] {
	const scope = snapshot.chartScope;
	const scopeLabel = CHART_SCOPE_CONFIGS[scope].label;
	const isDay = scope === "day";
	const metric = (label: string, value: number | null, formatter: (input: number) => string): CanvasMetricItem | undefined => value === null
		? undefined
		: { label, value: formatter(value), sourceIds: ["TA1"] };
	const priceMetric = (label: string, value: number | null) => metric(label, value, (input) => dollars(input, snapshot.currency));
	const numberMetric = (label: string, value: number | null) => metric(label, value, (input) => input.toFixed(2));
	const annotations: CanvasChartAnnotation[] = [];
	if (snapshot.closeLow !== null) annotations.push({ label: `${snapshot.rangeBars}-bar close low`, value: snapshot.closeLow, role: "signal" });
	if (snapshot.closeHigh !== null) annotations.push({ label: `${snapshot.rangeBars}-bar close high`, value: snapshot.closeHigh, role: "signal" });
	const blocks: CanvasBlock[] = [];
	if (snapshot.pricePoints.length >= 2) {
		const chartTitle = isDay
			? "Price Action · Extended Hours Included"
			: `Price Action · ${scopeLabel} Chart · ${snapshot.interval} bars`;
		blocks.push({
			id: "ta-price",
			kind: "chart",
			title: chartTitle,
			symbol: snapshot.symbol,
			points: snapshot.pricePoints,
			...(snapshot.priceTimes.length === snapshot.pricePoints.length ? { pointTimes: snapshot.priceTimes } : {}),
			...(snapshot.priceSessions.length === snapshot.pricePoints.length ? { pointSessions: snapshot.priceSessions } : {}),
			reference: isDay ? (snapshot.previousClose ?? undefined) : undefined,
			interval: snapshot.interval,
			timezone: snapshot.timezone,
			currency: snapshot.currency,
			asOf: snapshot.asOf,
			format: "price",
			height: 7,
			annotations,
			chartScope: scope,
			sourceIds: ["TA1"],
		});
	}
	const taTitlePrefix = `${scopeLabel} scope`;
	const momentumItem = isDay
		? metric(`${snapshot.lastBarReturnLabel}`, snapshot.momentum1h, (input) => `${input >= 0 ? "+" : ""}${input.toFixed(2)}%`)
		: metric(snapshot.lastBarReturnLabel, snapshot.lastBarReturn, (input) => `${input >= 0 ? "+" : ""}${input.toFixed(2)}%`);
	blocks.push({
			id: "ta-metrics",
			kind: "metrics",
			title: `TA Heuristic · ${scopeLabel} · ${snapshot.signal.toUpperCase()} · ${snapshot.score}/${snapshot.signalCount}`,
			items: [
				priceMetric("Last aligned close", snapshot.price),
				priceMetric("SMA 20 bars", snapshot.sma20),
				priceMetric("EMA 12 bars", snapshot.ema12),
				priceMetric("EMA 26 bars", snapshot.ema26),
				numberMetric("RSI 14 bars (Wilder)", snapshot.rsi14),
				metric("MACD 12/26 bars", snapshot.macd, (input) => input.toFixed(3)),
				metric("MACD signal 9 bars", snapshot.macdSignal, (input) => input.toFixed(3)),
				metric("MACD histogram", snapshot.macdHistogram, (input) => input.toFixed(3)),
				momentumItem,
			].filter((item): item is CanvasMetricItem => Boolean(item)),
		});
	if (snapshot.trendPoints.length >= 2) {
		const extent = Math.max(0.1, ...snapshot.trendPoints.map((value) => Math.abs(value)));
		blocks.push({
			id: "ta-trend",
			kind: "chart",
			title: `Trend Distance · Close vs SMA 20 · ${scopeLabel}`,
			symbol: snapshot.symbol,
			points: snapshot.trendPoints,
			...(snapshot.trendTimes.length === snapshot.trendPoints.length ? { pointTimes: snapshot.trendTimes } : {}),
			...(snapshot.trendSessions.length === snapshot.trendPoints.length ? { pointSessions: snapshot.trendSessions } : {}),
			reference: 0,
			interval: snapshot.interval,
			timezone: snapshot.timezone,
			asOf: snapshot.asOf,
			format: "percent",
			minValue: -extent,
			maxValue: extent,
			height: 7,
			chartStyle: "line",
			chartScope: scope,
			sourceIds: ["TA1"],
		});
	}
	if (snapshot.rsiPoints.length >= 2) {
		blocks.push({
			id: "ta-rsi",
			kind: "chart",
			title: `RSI 14 · Wilder · ${scopeLabel} bars`,
			symbol: snapshot.symbol,
			points: snapshot.rsiPoints,
			...(snapshot.rsiTimes.length === snapshot.rsiPoints.length ? { pointTimes: snapshot.rsiTimes } : {}),
			...(snapshot.rsiSessions.length === snapshot.rsiPoints.length ? { pointSessions: snapshot.rsiSessions } : {}),
			reference: 50,
			interval: snapshot.interval,
			timezone: snapshot.timezone,
			asOf: snapshot.asOf,
			format: "number",
			minValue: 0,
			maxValue: 100,
			height: 7,
			chartStyle: "line",
			annotations: [
				{ label: "Overbought", value: 70, role: "resistance" },
				{ label: "Oversold", value: 30, role: "support" },
			],
			chartScope: scope,
			sourceIds: ["TA1"],
		});
	}
	if (snapshot.macdHistogramPoints.length >= 2) {
		const extent = Math.max(0.001, ...snapshot.macdHistogramPoints.map((value) => Math.abs(value)));
		blocks.push({
			id: "ta-macd",
			kind: "chart",
			title: `MACD Histogram · 12/26/9 · ${scopeLabel}`,
			symbol: snapshot.symbol,
			points: snapshot.macdHistogramPoints,
			...(snapshot.macdHistogramTimes.length === snapshot.macdHistogramPoints.length ? { pointTimes: snapshot.macdHistogramTimes } : {}),
			...(snapshot.macdHistogramSessions.length === snapshot.macdHistogramPoints.length ? { pointSessions: snapshot.macdHistogramSessions } : {}),
			reference: 0,
			interval: snapshot.interval,
			timezone: snapshot.timezone,
			asOf: snapshot.asOf,
			format: "number",
			minValue: -extent,
			maxValue: extent,
			height: 7,
			chartStyle: "histogram",
			chartScope: scope,
			sourceIds: ["TA1"],
		});
	}

	const readBullets: CanvasBulletItem[] = [];
	const signalSentence = isDay
		? `${snapshot.symbol} intraday heuristic is ${snapshot.signal} (${snapshot.score} score from ${snapshot.signalCount} available checks: price/SMA20, Wilder RSI14, and MACD histogram).`
		: `${snapshot.symbol} ${scopeLabel.toLowerCase()} heuristic is ${snapshot.signal} (${snapshot.score} score from ${snapshot.signalCount} available checks: price/SMA20, Wilder RSI14, and MACD histogram).`;
	readBullets.push({ text: signalSentence, role: "interpretation", sourceIds: ["TA1"] });
	const barNote = isDay
		? `Indicators use ${snapshot.sessionPolicy}; the last calculation bar is ${quoteTimestampLabel(snapshot.asOf, snapshot.timezone)}.`
		: `Indicators use ${scopeLabel.toLowerCase()} chart closes (${snapshot.interval} bars); the last calculation bar is ${quoteTimestampLabel(snapshot.asOf, snapshot.timezone)}.`;
	readBullets.push({ text: barNote, role: "fact", sourceIds: ["TA1"] });
	if (snapshot.closeLow !== null && snapshot.closeHigh !== null) {
		readBullets.push({ text: `The observed ${snapshot.rangeBars}-bar close range is ${dollars(snapshot.closeLow, snapshot.currency)}–${dollars(snapshot.closeHigh, snapshot.currency)}; these are range extrema, not validated support/resistance.`, role: "fact" as const, sourceIds: ["TA1"] });
	}
	if (isDay && snapshot.momentum1h === null) {
		readBullets.push({ text: "Same-session 1h momentum is unavailable because no bar was within 15 minutes of the one-hour anchor.", role: "fact" as const, sourceIds: ["TA1"] });
	}
	if (!isDay && snapshot.lastBarReturn === null) {
		readBullets.push({ text: `${snapshot.lastBarReturnLabel} is unavailable (requires at least 2 aligned closes).`, role: "fact" as const, sourceIds: ["TA1"] });
	}
	readBullets.push({ text: `SMA/EMA/RSI/MACD are ${snapshot.interval}-bar based; scope is ${taTitlePrefix} (${CHART_SCOPE_CONFIGS[scope].label}).`, role: "fact", sourceIds: ["TA1"] });
	readBullets.push({ text: "Trend distance is close minus SMA20 in percent (zero = at SMA20); MACD histogram bars show positive/negative momentum around zero; RSI guides mark 70/50/30.", role: "fact", sourceIds: ["TA1"] });

	blocks.push(
		{
			id: "ta-read",
			kind: "bullets",
			title: `Technical Read · ${scopeLabel}`,
			items: readBullets,
		},
		{
			id: "ta-sources",
			kind: "sources",
			title: "TA Source",
			items: [{
				id: "TA1",
				label: isDay
					? "Yahoo Finance intraday chart API · deterministic, extended-hours-inclusive indicators"
					: `Yahoo Finance ${scopeLabel.toLowerCase()} chart API · deterministic ${snapshot.interval} bar indicators`,
				url: `https://finance.yahoo.com/quote/${encodeURIComponent(snapshot.symbol)}`,
				status: "fetched",
			}],
		},
	);
	return blocks;
}
