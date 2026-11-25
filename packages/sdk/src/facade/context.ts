import type { Effect } from "effect";

import type { SdkRuntime, SdkServices } from "../effect/runtime.js";
import { captureCallerTrace, type CallerTrace } from "../effect/trace.js";
import type { SealantInternalConfig } from "../internal/config.js";

/** What every facade object needs: the execution boundary and the resolved (host-local) config. */
export interface SdkContext {
  readonly runtime: SdkRuntime;
  readonly config: SealantInternalConfig;
}

/** The caller's trace right now (see `captureCallerTrace`); call it before a call's first `await`. */
export const captureTrace = (ctx: SdkContext): CallerTrace | undefined =>
  captureCallerTrace(ctx.config.traceContext);

/**
 * A `run` bound to the caller's trace captured now, for a call that makes several requests across
 * `await`s (a polling loop), so each continues the trace the call started in.
 */
export const bindRun = (
  ctx: SdkContext,
): (<A, E>(effect: Effect.Effect<A, E, SdkServices>) => Promise<A>) => {
  const trace = captureTrace(ctx);
  return (effect) => ctx.runtime.run(effect, trace);
};

/** An AsyncIterable whose iteration rejects — for surface that is typed now but not yet implemented. */
export const notImplementedAsyncIterable = <A>(
  operation: string,
  error: Error,
): AsyncIterable<A> => ({
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.reject(error),
      return: () => Promise.resolve({ done: true as const, value: undefined }),
    };
  },
});
