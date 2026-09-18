/**
 * The per-owner budgets as handlers apply them (CORE-04). Each is checked before the work it
 * guards is created, so a refusal has no effect to undo.
 */
import { BudgetExceededError } from "@sealant/api-contracts";
import { RunRepo, WorkspaceRepo } from "@sealant/db";
import { Effect } from "effect";

import { budgetLimits, ownerLaunchWindow } from "./budget-limits.js";
import {
  budgetMessage,
  ceilingDecision,
  rateDecision,
  type BudgetDecision,
  type BudgetLimits,
  type RateWindow,
} from "./budgets.js";

/** How long to suggest waiting on a concurrency ceiling: it frees when the owner's work settles. */
const CEILING_RETRY_SECONDS = 30;

const refuse = (decision: BudgetDecision) =>
  decision.allowed
    ? Effect.void
    : Effect.fail(
        new BudgetExceededError({
          message: budgetMessage(decision),
          budget: decision.budget,
          limit: decision.limit,
          retryAfterSeconds: decision.retryAfterSeconds,
        }),
      );

export interface OwnerBudgetOptions {
  readonly limits?: BudgetLimits;
  readonly window?: RateWindow;
  readonly now?: number;
}

/** One launch for this owner: a workspace create or restart, a run create, an inference exchange. */
export const spendOwnerLaunch = (ownerUserId: string, options: OwnerBudgetOptions = {}) =>
  refuse(
    rateDecision(
      options.window ?? ownerLaunchWindow,
      "ownerLaunchesPerMinute",
      `owner:${ownerUserId}`,
      (options.limits ?? budgetLimits).ownerLaunchesPerMinute,
      options.now ?? Date.now(),
    ),
  );

/** Room for one more live workspace. A count that cannot be read fails the request (500): it is neither a refusal nor a pass. */
export const requireLiveWorkspaceRoom = (ownerUserId: string, options: OwnerBudgetOptions = {}) =>
  Effect.gen(function* () {
    const limit = (options.limits ?? budgetLimits).ownerLiveWorkspaces;
    if (limit <= 0) return;
    const live = yield* (yield* WorkspaceRepo)
      .listWorkspaces({ ownerUserId, statuses: ["queued", "running", "ready"], limit: limit + 1 })
      .pipe(Effect.orDie);
    yield* refuse(
      ceilingDecision("ownerLiveWorkspaces", live.length, limit, CEILING_RETRY_SECONDS),
    );
  });

/** Room for one more active run. */
export const requireActiveRunRoom = (ownerUserId: string, options: OwnerBudgetOptions = {}) =>
  Effect.gen(function* () {
    const limit = (options.limits ?? budgetLimits).ownerActiveRuns;
    if (limit <= 0) return;
    const active = yield* (yield* RunRepo)
      .listRuns({ ownerUserId, statuses: ["queued", "running"], limit: limit + 1 })
      .pipe(Effect.orDie);
    yield* refuse(ceilingDecision("ownerActiveRuns", active.length, limit, CEILING_RETRY_SECONDS));
  });
