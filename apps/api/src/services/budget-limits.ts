import { env } from "../runtime-env.js";
import { makeRateWindow, type BudgetLimits } from "./budgets.js";

/** This process's budgets, read once from the environment (CORE-04). */
export const budgetLimits: BudgetLimits = {
  principalRequestsPerMinute: env.SEALANT_BUDGET_PRINCIPAL_REQUESTS_PER_MINUTE,
  ownerLaunchesPerMinute: env.SEALANT_BUDGET_OWNER_LAUNCHES_PER_MINUTE,
  ownerLiveWorkspaces: env.SEALANT_BUDGET_OWNER_LIVE_WORKSPACES,
  ownerActiveRuns: env.SEALANT_BUDGET_OWNER_ACTIVE_RUNS,
  ownerInferenceTokensPerDay: env.SEALANT_BUDGET_OWNER_INFERENCE_TOKENS_PER_DAY,
};

/** One window of launches per owner, shared by every route that starts work. */
export const ownerLaunchWindow = makeRateWindow();
