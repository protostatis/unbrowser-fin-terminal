import type { ConformanceTraceEvent } from "./conformance-trace.js";

export type BrowserWorkerTraceEvent = {
	type?: unknown;
	outcome?: unknown;
	toolName?: unknown;
	canvas?: unknown;
	[key: string]: unknown;
};

export interface ConformanceProjection {
	commands: string[];
	inputs: string[];
	panelOpened: boolean;
	panelClosed: boolean;
	settles: Array<{ outcome: string; contextLabel?: string }>;
	archiveIds: string[];
	researchOutcomes: string[];
	researchTools: string[];
	finalCanvas?: { stage?: string; sourceIds: string[] };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

/** Remove timestamps/ids/layout noise and retain the behavior contract. */
export function projectPiTrace(events: readonly ConformanceTraceEvent[]): ConformanceProjection {
	const projection: ConformanceProjection = {
		commands: [], inputs: [], panelOpened: false, panelClosed: false, settles: [], archiveIds: [], researchOutcomes: [], researchTools: [],
	};
	for (const event of events) {
		const payload = event.payload;
		switch (event.kind) {
			case "command":
				if (typeof payload.name === "string") projection.commands.push(payload.name);
				break;
			case "input":
				if (typeof payload.data === "string") projection.inputs.push(payload.data);
				break;
			case "panel":
				if (payload.opened === true) projection.panelOpened = true;
				if (payload.opened === false) projection.panelClosed = true;
				break;
			case "settle":
				if (typeof payload.outcome === "string") projection.settles.push({
					outcome: payload.outcome,
					...(typeof payload.contextLabel === "string" ? { contextLabel: payload.contextLabel } : {}),
				});
				break;
			case "archive": {
				const entries = record(payload.entries);
				if (Array.isArray(entries?.ids)) projection.archiveIds.push(...entries.ids.filter((id): id is string => typeof id === "string"));
				break;
			}
			case "state": {
				const research = record(payload.research);
				if (typeof research?.outcome === "string") projection.researchOutcomes.push(research.outcome);
				if (typeof research?.toolName === "string") projection.researchTools.push(research.toolName);
				const dossier = record(payload.dossier);
				if (dossier && dossier.stage === "complete") {
					const sourceIds = Array.isArray(dossier.summarySourceIds)
						? dossier.summarySourceIds.filter((id): id is string => typeof id === "string")
						: [];
					projection.finalCanvas = { stage: "complete", sourceIds: unique(sourceIds) };
				}
				break;
			}
		}
	}
	projection.commands = unique(projection.commands);
	projection.inputs = projection.inputs;
	projection.researchOutcomes = unique(projection.researchOutcomes);
	projection.researchTools = unique(projection.researchTools);
	projection.archiveIds = unique(projection.archiveIds);
	return projection;
}

/** Project the browser worker stream onto the same stable facts as the Pi trace. */
export function projectBrowserWorkerTrace(events: readonly BrowserWorkerTraceEvent[]): ConformanceProjection {
	const projection: ConformanceProjection = {
		commands: [], inputs: [], panelOpened: false, panelClosed: false, settles: [], archiveIds: [], researchOutcomes: [], researchTools: [],
	};
	for (const event of events) {
		if (event.type === "job") {
			if (typeof event.outcome === "string") projection.researchOutcomes.push(event.outcome);
			if (typeof event.toolName === "string") projection.researchTools.push(event.toolName);
		}
		if (event.type === "started") projection.panelOpened = true;
		if (event.type === "settled" && typeof event.outcome === "string") projection.settles.push({ outcome: event.outcome });
		if (event.type === "canvas") {
			const canvas = record(event.canvas);
			const blocks = Array.isArray(canvas?.blocks) ? canvas.blocks : [];
			const sourceIds = unique(blocks.flatMap((block) => {
				const value = record(block);
				return Array.isArray(value?.sourceIds) ? value.sourceIds.filter((id): id is string => typeof id === "string") : [];
			}));
			// Technical block ids (for example TA1) are local presentation
			// references; the Pi trace records the externally cited S-* sources.
			projection.finalCanvas = { stage: typeof canvas?.stage === "string" ? canvas.stage : undefined, sourceIds: sourceIds.filter((id) => /^S-[A-Za-z0-9_-]+$/.test(id)) };
		}
	}
	projection.researchOutcomes = unique(projection.researchOutcomes);
	projection.researchTools = unique(projection.researchTools);
	return projection;
}

/** Stable worker tool contract shared by Pi and browser research attempts. */
export const CONFORMANCE_RESEARCH_TOOLS = ["market_technicals", "market_discover", "market_extract", "market_canvas"] as const;
