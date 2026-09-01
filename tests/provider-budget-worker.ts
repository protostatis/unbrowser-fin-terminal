import { createPersistentProviderBudget } from "../server/provider-budget.js";

const [filePath, principal] = process.argv.slice(2);
if (!filePath || !principal) throw new Error("file path and principal are required");

const budget = createPersistentProviderBudget({
	filePath,
	config: {
		principalDailyResearchRequests: 2,
		principalDailyImportRequests: 1,
		globalDailyBudgetUsd: 1,
		inputUsdPerMillionTokens: 1,
		outputUsdPerMillionTokens: 1,
		importEstimateUsd: 0.1,
	},
});

console.log(JSON.stringify(await budget.consume(principal, "research", 0.5)));
