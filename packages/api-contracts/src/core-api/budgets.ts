import { Schema } from "effect";
import { HttpApiMiddleware } from "effect/http-api";

/** Admission refused only this HTTP request before its handler did work. */
export const requestBudgetRefusalSchema = Schema.Struct({
  phase: Schema.Literal("before-work"),
  bucket: Schema.Literals(["owner", "unowned", "key", "principal"]),
});
/** Admission metadata absent from older servers and non-admission budget errors. */
export type RequestBudgetRefusal = typeof requestBudgetRefusalSchema.Type;

/** What every budget refusal says: which limit, and when there is room again. */
export const budgetExceededFields = {
  message: Schema.String,
  budget: Schema.String,
  limit: Schema.Number,
  retryAfterSeconds: Schema.Number,
  refusal: Schema.optional(requestBudgetRefusalSchema),
};

/**
 * A budget refused new work (429). Nothing already running was stopped. `budget` names which
 * limit, `retryAfterSeconds` when there is room again: the rest of a rate window, or an estimate
 * for a concurrency ceiling that only frees when the owner's own work settles.
 */
export class BudgetExceededError extends Schema.TaggedError<BudgetExceededError>()(
  "BudgetExceededError",
  budgetExceededFields,
  { httpApiStatus: 429 },
) {}

/** Declares request admission failures on every control-plane endpoint. */
export class RequestBudget extends HttpApiMiddleware.Service<RequestBudget>()(
  "@sealant/api-contracts/RequestBudget",
  { error: BudgetExceededError },
) {}
