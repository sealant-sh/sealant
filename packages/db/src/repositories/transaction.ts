import { Context, Effect, Layer, Schema } from "effect";
import { SqlError } from "effect/unstable/sql/SqlError";

import { SealantDB } from "../client.js";

export class DatabaseTransactionError extends Schema.TaggedErrorClass<DatabaseTransactionError>()(
  "DatabaseTransactionError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Run several repository operations as ONE database transaction. The repositories share the
 * process's Postgres client, and a transaction is ambient to the fiber that runs it: every query
 * any repository makes inside `run` joins it, and a failure of the effect rolls all of them back.
 */
export interface DatabaseTransactionService {
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DatabaseTransactionError, R>;
}

export class DatabaseTransaction extends Context.Service<
  DatabaseTransaction,
  DatabaseTransactionService
>()("DatabaseTransaction") {}

export const DatabaseTransactionLive: Layer.Layer<DatabaseTransaction, never, SealantDB> =
  Layer.effect(
    DatabaseTransaction,
    Effect.gen(function* () {
      const db = yield* SealantDB;
      return {
        run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          db
            .transaction(() => effect)
            .pipe(
              // Only the transaction's own failure (begin, commit) is translated; the effect's
              // errors pass through as they are.
              Effect.mapError((error) =>
                error instanceof SqlError
                  ? new DatabaseTransactionError({ message: error.message, cause: error })
                  : error,
              ),
            ),
      } satisfies DatabaseTransactionService;
    }),
  );
