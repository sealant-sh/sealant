import { Schema } from "effect";

/**
 * A budget refused new work (429). Nothing already running was stopped. `budget` names which
 * limit, `retryAfterSeconds` when there is room again: the rest of a rate window, or an estimate
 * for a concurrency ceiling that only frees when the owner's own work settles.
 */
export class BudgetExceededError extends Schema.TaggedErrorClass<BudgetExceededError>()(
  "BudgetExceededError",
  {
    message: Schema.String,
    budget: Schema.String,
    limit: Schema.Number,
    retryAfterSeconds: Schema.Number,
  },
  { httpApiStatus: 429 },
) {}
