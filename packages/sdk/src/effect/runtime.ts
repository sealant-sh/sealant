/**
 * The SDK runtime — the Effect-core boundary the Promise facade runs against.
 *
 * The app `Layer` is built ONCE into a process-lifetime `Scope`, lazily and memoized, mirroring the
 * `Scope.make` + `Layer.buildWithScope` idiom in `apps/worker/src/workers/telemetry.ts`. It provides:
 *   - `SealantApiClient` — the contract-derived control-plane client (reads/writes over HTTP);
 *   - `SealantRuntime` — the docker-exec transport to the in-sandbox daemon (harness execution);
 *   - `TelemetryIngester` — drains + persists the run's telemetry (host-local, over its own DB pool).
 * The latter two are the host-local slice: ingestion runs in-process against the control-plane
 * Postgres. Every operation runs against this context and surfaces a plain `SealantError` (the typed
 * Effect failure is squashed and mapped here). `dispose()` closes the scope (HTTP client, DB pool,
 * daemon connections) and is idempotent.
 */
import { makeSealantDBLayer } from "@sealant/db";
import { SealantRuntime, SealantRuntimeDockerExecLive } from "@sealant/sandboxes";
import {
  InlineByteaArtifactStoreLive,
  PostgresTelemetrySinkLive,
  TelemetrySink,
} from "@sealant/telemetry";
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect";

import type { SealantInternalConfig } from "../internal/config.js";
import { toSealantError } from "../internal/map-error.js";
import { SealantApiClient, sealantApiClientLayer } from "./api-client.js";

/** Services the SDK runtime provides to operation effects. */
export type SdkServices = SealantApiClient | SealantRuntime | TelemetrySink;

export interface SdkRuntime {
  /** Provide the app context and run an operation effect, surfacing plain `SealantError`s. */
  readonly run: <A, E, R extends SdkServices>(effect: Effect.Effect<A, E, R>) => Promise<A>;
  /** Dispose the runtime scope (HTTP client, DB pool, daemon connections). Idempotent. */
  readonly dispose: () => Promise<void>;
}

interface BuiltRuntime {
  readonly context: Context.Context<SdkServices>;
  readonly scope: Scope.Closeable;
}

// The built layer also re-exports `SealantTransport` (via `provideMerge` inside the docker-exec
// runtime layer) and its error channel is `SqlError` (the DB pool can fail to construct); the
// runtime only surfaces `SdkServices`, so the extra service is erased at the context boundary below.
// `TelemetrySink` is exposed directly: the run path drains the harness's telemetry and persists it
// via the sink, bounded to the harness process (no separate ingester, no daemon shutdown).
const makeAppLayer = (config: SealantInternalConfig) => {
  const dbLayer = makeSealantDBLayer(config.hostLocal.databaseUrl);
  const artifactLayer = InlineByteaArtifactStoreLive.pipe(Layer.provide(dbLayer));
  const sinkLayer = PostgresTelemetrySinkLive.pipe(
    Layer.provide(Layer.mergeAll(dbLayer, artifactLayer)),
  );
  return Layer.mergeAll(sealantApiClientLayer(config), SealantRuntimeDockerExecLive, sinkLayer);
};

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
