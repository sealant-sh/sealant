/**
 * Inference spend per owner per UTC day (CORE-04). `record` adds one exchange's usage in a single
 * upsert, so concurrent exchanges on several API replicas add up instead of overwriting.
 */
import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import { inferenceUsage } from "../schema/control-plane.js";

export class InferenceUsageRepoError extends Schema.TaggedErrorClass<InferenceUsageRepoError>()(
  "InferenceUsageRepoError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export interface InferenceUsageRepoService {
  /** Tokens (input + output) the owner has spent on `day` (`YYYY-MM-DD`, UTC). */
  readonly tokensOn: (
    ownerUserId: string,
    day: string,
  ) => Effect.Effect<number, InferenceUsageRepoError>;
  readonly record: (input: {
    readonly ownerUserId: string;
    readonly day: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }) => Effect.Effect<void, InferenceUsageRepoError>;
}

export class InferenceUsageRepo extends Context.Service<
  InferenceUsageRepo,
  InferenceUsageRepoService
>()("InferenceUsageRepo") {}

const withRepoError = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new InferenceUsageRepoError({
          operation,
          message: cause instanceof Error ? cause.message : `${operation} failed.`,
          cause,
        }),
    ),
  );

export const InferenceUsageRepoLive: Layer.Layer<InferenceUsageRepo, never, SealantDB> =
  Layer.effect(
    InferenceUsageRepo,
    Effect.gen(function* () {
      const db = yield* SealantDB;
      return {
        tokensOn: (ownerUserId, day) =>
          withRepoError(
            "tokensOn",
            Effect.gen(function* () {
              const [row] = yield* db
                .select({
                  inputTokens: inferenceUsage.inputTokens,
                  outputTokens: inferenceUsage.outputTokens,
                })
                .from(inferenceUsage)
                .where(
                  and(eq(inferenceUsage.ownerUserId, ownerUserId), eq(inferenceUsage.day, day)),
                )
                .limit(1);
              return row === undefined ? 0 : row.inputTokens + row.outputTokens;
            }),
          ),
        record: (input) =>
          withRepoError(
            "record",
            Effect.gen(function* () {
              yield* db
                .insert(inferenceUsage)
                .values({
                  ownerUserId: input.ownerUserId,
                  day: input.day,
                  exchanges: 1,
                  inputTokens: input.inputTokens,
                  outputTokens: input.outputTokens,
                })
                .onConflictDoUpdate({
                  target: [inferenceUsage.ownerUserId, inferenceUsage.day],
                  set: {
                    exchanges: sql`${inferenceUsage.exchanges} + 1`,
                    inputTokens: sql`${inferenceUsage.inputTokens} + ${input.inputTokens}`,
                    outputTokens: sql`${inferenceUsage.outputTokens} + ${input.outputTokens}`,
                    updatedAt: new Date(),
                  },
                });
            }),
          ),
      };
    }),
  );
