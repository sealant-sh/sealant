import { ConnectedAccountRepo } from "@sealant/db";
import { Effect, Layer } from "effect";

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
