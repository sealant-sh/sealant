/**
 * The SDK runtime — the Effect-core boundary the Promise facade runs against.
 *
 * The app `Layer` is built ONCE into a process-lifetime `Scope`, lazily and memoized. It provides a
 * single service — `SealantApiClient`, the contract-derived control-plane client — so the SDK is a
 * THIN HTTP CLIENT: every operation (create/run/read) is an HTTP call to `baseUrl`. Run execution and
 * telemetry ingest moved SERVER-SIDE (the worker), so the SDK no longer opens a Postgres pool, spawns
 * docker, or writes telemetry. Every operation surfaces a plain `SealantError` (the typed Effect
 * failure is squashed and mapped here). `dispose()` closes the scope (the HTTP client) and is idempotent.
 */
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect";

import type { SealantInternalConfig } from "../internal/config.js";
import { toSealantError } from "../internal/map-error.js";
import { SealantApiClient, sealantApiClientLayer } from "./api-client.js";

/** Services the SDK runtime provides to operation effects. */
export type SdkServices = SealantApiClient;

export interface SdkRuntime {
  /** Provide the app context and run an operation effect, surfacing plain `SealantError`s. */
  readonly run: <A, E, R extends SdkServices>(effect: Effect.Effect<A, E, R>) => Promise<A>;
  /** Dispose the runtime scope (the HTTP client). Idempotent. */
  readonly dispose: () => Promise<void>;
}

interface BuiltRuntime {
  readonly context: Context.Context<SdkServices>;
  readonly scope: Scope.Closeable;
}

// A single service: the contract-derived HTTP client. No DB pool, no docker-exec, no telemetry sink.
const makeAppLayer = (config: SealantInternalConfig) => sealantApiClientLayer(config);

export const makeSdkRuntime = (config: SealantInternalConfig): SdkRuntime => {
  const appLayer = makeAppLayer(config);
  let built: Promise<BuiltRuntime> | undefined;

  const build = (): Promise<BuiltRuntime> => {
    if (built === undefined) {
      built = Effect.runPromiseExit(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const context = yield* Layer.buildWithScope(appLayer, scope);
          // The layer provides a superset of SdkServices; narrow to the surfaced services.
          return { context: context as Context.Context<SdkServices>, scope } satisfies BuiltRuntime;
        }),
      ).then((exit) => {
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        // The layer's error channel is non-`never` (e.g. SqlError: the DB pool can fail to construct),
        // so route a build failure through the SAME funnel as operations instead of leaking a raw
        // Effect/SQL error out of the public Promise API. Reset memoization so a transient first-build
        // failure (DB momentarily down) can be retried instead of poisoning the runtime forever.
        built = undefined;
        throw toSealantError(Cause.squash(exit.cause));
      });
    }
    return built;
  };

  return {
    run: async <A, E, R extends SdkServices>(effect: Effect.Effect<A, E, R>): Promise<A> => {
      const { context } = await build();
      // R extends SdkServices and the context provides SdkServices, so all requirements are met
      // (TS can't reduce Exclude<R, SdkServices> to never for a generic R).
      const provided = Effect.provide(effect, context) as Effect.Effect<A, E>;
      const exit = await Effect.runPromiseExit(provided);
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      // Squash the Cause to its underlying failure/defect value, then map to a plain error.
      throw toSealantError(Cause.squash(exit.cause));
    },
    dispose: async () => {
      if (built === undefined) {
        return;
      }
      const current = built;
      built = undefined;
      const { scope } = await current;
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    },
  };
};
