/**
 * Budgets (CORE-04): explicit per-principal and per-owner limits on requests, concurrent work and
 * inference spend, beside the per-container resources the runtimes already set.
 *
 * A budget refuses new work with a stated reason and a `Retry-After`; it never stops work that is
 * already running. Request windows are held in this process's memory, so with N API replicas a
 * caller may reach N times the configured rate; concurrency and spend are read from Postgres and
 * hold across replicas. `0` turns one budget off, and start-up logs which are off.
 */
import { createHash } from "node:crypto";

export interface BudgetLimits {
  /** Requests per minute for one principal (one service key, the gateway, one bearer). */
  readonly principalRequestsPerMinute: number;
  /** Launches per minute for one owner: workspace creates and restarts, run creates, inference. */
  readonly ownerLaunchesPerMinute: number;
  /** Workspaces one owner may hold queued, running or ready at once. */
  readonly ownerLiveWorkspaces: number;
  /** Runs one owner may hold queued or running at once. */
  readonly ownerActiveRuns: number;
  /** Inference tokens (input + output) one owner may spend per UTC day. */
  readonly ownerInferenceTokensPerDay: number;
}

export type BudgetDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly budget: keyof BudgetLimits;
      readonly limit: number;
      readonly retryAfterSeconds: number;
    };

const ALLOWED: BudgetDecision = { allowed: true };

/** Idle subjects are swept at most this often, however many requests arrive. */
const SWEEP_EVERY_MS = 5_000;
/** Past this many subjects, a subject not yet known is counted under one shared name. */
const MAX_SUBJECTS = 50_000;
/** Where subjects beyond the cap are counted together, so the map's size has a ceiling. */
export const OVERFLOW_SUBJECT = "overflow";

/**
 * A sliding one-minute window per subject. `take` spends one unit when the subject is under its
 * limit and says how long until the oldest unit leaves the window when it is not.
 *
 * Subjects can be attacker-chosen (any bearer on the session surface names one before it is
 * validated), so memory is bounded twice: idle subjects are swept on a timer, not per request, and
 * once `maxSubjects` are live every unknown subject shares one window. A flood of distinct
 * subjects then throttles itself and cannot grow the map or make each request scan it.
 */
export const makeRateWindow = (windowMs = 60_000, maxSubjects = MAX_SUBJECTS) => {
  const hits = new Map<string, Array<number>>();
  let sweptAt = 0;
  const sweep = (now: number) => {
    if (now - sweptAt < SWEEP_EVERY_MS) return;
    sweptAt = now;
    for (const [subject, times] of hits) {
      if (times.every((time) => now - time >= windowMs)) hits.delete(subject);
    }
  };
  return {
    take: (requested: string, limit: number, now: number): number | null => {
      if (limit <= 0) return null;
      sweep(now);
      const subject = hits.has(requested) || hits.size < maxSubjects ? requested : OVERFLOW_SUBJECT;
      const live = (hits.get(subject) ?? []).filter((time) => now - time < windowMs);
      if (live.length >= limit) {
        hits.set(subject, live);
        const oldest = live[0] ?? now;
        return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      }
      live.push(now);
      hits.set(subject, live);
      return null;
    },
    subjects: () => hits.size,
  };
};

export type RateWindow = ReturnType<typeof makeRateWindow>;

export const rateDecision = (
  window: RateWindow,
  budget: keyof BudgetLimits,
  subject: string,
  limit: number,
  now: number,
): BudgetDecision => {
  const retryAfterSeconds = window.take(subject, limit, now);
  return retryAfterSeconds === null
    ? ALLOWED
    : { allowed: false, budget, limit, retryAfterSeconds };
};

/** A count read from the database against its ceiling. `limit <= 0` is off. */
export const ceilingDecision = (
  budget: keyof BudgetLimits,
  current: number,
  limit: number,
  retryAfterSeconds: number,
): BudgetDecision =>
  limit <= 0 || current < limit ? ALLOWED : { allowed: false, budget, limit, retryAfterSeconds };

/** A bearer's subject: never the secret, and short enough to log. */
export const bearerSubject = (secret: string): string =>
  `bearer:${createHash("sha256").update(secret).digest("hex").slice(0, 16)}`;

const WORDS: Readonly<Record<keyof BudgetLimits, string>> = {
  principalRequestsPerMinute: "requests per minute for this credential",
  ownerLaunchesPerMinute: "launches per minute for this owner",
  ownerLiveWorkspaces: "live workspaces for this owner",
  ownerActiveRuns: "active runs for this owner",
  ownerInferenceTokensPerDay: "inference tokens per day for this owner",
};

export const budgetMessage = (decision: Extract<BudgetDecision, { allowed: false }>): string =>
  `Budget reached: ${decision.limit} ${WORDS[decision.budget]}. Nothing that is running was stopped; retry in ${decision.retryAfterSeconds}s.`;

/** Which budgets are off, for the start-up log. */
export const budgetsOff = (limits: BudgetLimits): ReadonlyArray<keyof BudgetLimits> =>
  (Object.keys(WORDS) as Array<keyof BudgetLimits>).filter((name) => limits[name] <= 0);

/** Seconds until the next UTC midnight: when a daily budget has room again. */
export const secondsUntilUtcMidnight = (now: Date): number => {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
};
