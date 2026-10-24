import { ConnectedAccountRepo } from "@sealant/db";
import { Effect, Layer } from "effect";

/**
 * The migration that added defaults pointed every person at their account named `default`. A
 * control plane from before it, still serving during a rolling upgrade, can connect a first
 * account with no default; this start points them at it too. A failure is logged, never fatal.
 */
export const ConnectedAccountDefaultsBackfillLive: Layer.Layer<never, never, ConnectedAccountRepo> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const accounts = yield* ConnectedAccountRepo;
      const written = yield* accounts.backfillDefaults;
      if (written > 0) {
        yield* Effect.logInfo(
          `[api] connected accounts: ${written} defaults now name the account named default`,
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("[api] connected accounts: the default backfill failed", error),
      ),
    ),
  );
