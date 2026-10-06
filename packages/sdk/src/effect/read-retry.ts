/**
 * Retrying a read of a run while it is being waited on. Every read is an idempotent GET, so a read
 * the control plane refused for now (a 429 from a budget), failed on its side (5xx), or that never
 * arrived (a transport error) is read again, after the `Retry-After` the answer named or a short
 * backoff, within a bounded total wait. Anything else (a 404, a 400, a body that does not decode)
 * fails at once. Either way the failure names the run, so a caller can still read its result.
 */
import { BudgetExceededError, RunInternalServerError } from "@sealant/api-contracts";
import { Duration, Effect, Result } from "effect";
import { HttpClientError } from "effect/unstable/http";

import { SealantApiError } from "../errors.js";
import { toSealantError } from "../internal/map-error.js";

/** The first backoff when the answer names no `Retry-After`; it doubles up to the cap. */
const READ_RETRY_FIRST_MS = 100;
const READ_RETRY_MAX_BACKOFF_MS = 2_000;
/** The most one read waits across all its retries: a whole budget window, and no more. */
export const READ_RETRY_BUDGET_MS = 60_000;

/** `Retry-After` in milliseconds: delay-seconds or an HTTP date. */
const retryAfterMs = (value: string | undefined, now: number): number | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
};

const statusOf = (error: unknown): number | undefined => {
  if (error instanceof BudgetExceededError) return 429;
  if (error instanceof RunInternalServerError) return 500;
  if (HttpClientError.isHttpClientError(error) && "response" in error.reason) {
    return error.reason.response.status;
  }
  return undefined;
};

/**
 * How long to wait before reading again after `error` on retry number `attempt` (from 0), or
 * `undefined` when the failure is not one a second read can fix.
 */
export const readRetryDelayMs = (
  error: unknown,
  attempt: number,
  now: number = Date.now(),
): number | undefined => {
  const backoff = Math.min(READ_RETRY_FIRST_MS * 2 ** attempt, READ_RETRY_MAX_BACKOFF_MS);
  if (error instanceof BudgetExceededError) {
    return Math.max(error.retryAfterSeconds * 1_000, backoff);
  }
  if (error instanceof RunInternalServerError) return backoff;
  if (!HttpClientError.isHttpClientError(error)) return undefined;
  const { reason } = error;
  if (reason instanceof HttpClientError.TransportError) return backoff;
  if (!("response" in reason)) return undefined;
  const status = reason.response.status;
  if (status !== 429 && status < 500) return undefined;
  const after = retryAfterMs(reason.response.headers["retry-after"], now);
  return after === undefined ? backoff : Math.max(after, backoff);
};

/**
 * Runs `read`, reading again on a failure {@link readRetryDelayMs} admits, until the total wait
 * would pass {@link READ_RETRY_BUDGET_MS} or `deadline`. The failure it ends with names the run.
 */
export const retryRead = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  options: { readonly runId: string; readonly what: string; readonly deadline: number },
): Effect.Effect<A, SealantApiError, R> =>
  Effect.gen(function* () {
    let waited = 0;
    for (let attempt = 0; ; attempt += 1) {
      const result = yield* Effect.result(read);
      if (Result.isSuccess(result)) return result.success;
      const error = result.failure;
      const now = Date.now();
      const delay = readRetryDelayMs(error, attempt, now);
      const room = Math.min(READ_RETRY_BUDGET_MS - waited, options.deadline - now);
      if (delay === undefined || delay > room) {
        const mapped = toSealantError(error);
        const status = statusOf(error);
        const tries = attempt === 0 ? "" : ` (read ${String(attempt + 1)} times)`;
        return yield* Effect.fail(
          new SealantApiError(
            `Reading ${options.what} of exec run ${options.runId} failed${tries}: ${mapped.message}`,
            { code: mapped.code, ...(status === undefined ? {} : { status }), cause: error },
          ),
        );
      }
      yield* Effect.sleep(Duration.millis(delay));
      waited += delay;
    }
  });
