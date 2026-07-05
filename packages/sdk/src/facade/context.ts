import type { SdkRuntime } from "../effect/runtime.js";
import type { SealantInternalConfig } from "../internal/config.js";

/** What every facade object needs: the execution boundary and the resolved (host-local) config. */
export interface SdkContext {
  readonly runtime: SdkRuntime;
  readonly config: SealantInternalConfig;
}

/** An AsyncIterable whose iteration rejects — for surface that is typed now but not yet implemented. */
export const notImplementedAsyncIterable = <A>(
  operation: string,
  error: Error,
): AsyncIterable<A> => ({
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.reject(error),
      return: () => Promise.resolve({ done: true as const, value: undefined as never }),
    };
  },
});
