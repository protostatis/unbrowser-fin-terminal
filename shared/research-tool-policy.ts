/** Tools exposed to an isolated market research model, shared by Node and browser hosts. */
export const MARKET_RESEARCH_TOOL_NAMES = [
	"market_technicals",
	"market_discover",
	"market_extract",
	"market_canvas",
] as const;

export type MarketResearchToolName = (typeof MARKET_RESEARCH_TOOL_NAMES)[number];

export function isMarketResearchToolName(name: string): name is MarketResearchToolName {
	return (MARKET_RESEARCH_TOOL_NAMES as readonly string[]).includes(name);
}
