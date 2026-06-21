import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  packageResolutionCacheEntries,
  type NewPackageResolutionCacheEntry,
  type PackageResolutionCacheEntry,
} from "../schema.js";

export interface UpsertPackageResolutionCacheEntryInput {
  readonly query: string;
  readonly resolutionPayload: Record<string, unknown>;
  readonly expiresAt: Date;
}

/** @deprecated Use PackageResolutionCacheRepo + PackageResolutionCacheRepoLive instead. */
export const createPackageResolutionCacheRepository = (): never => {
  throw new Error(
    "createPackageResolutionCacheRepository is disabled during the Effect transition.",
  );
};

/** @deprecated Use PackageResolutionCacheRepoService instead. */
export type PackageResolutionCacheRepository = PackageResolutionCacheRepoService;

const packageResolutionCacheRepoOperationSchema = Schema.Literal("getByQuery", "upsertByQuery");

export class PackageResolutionCacheRepoInvariantError extends Schema.TaggedError<PackageResolutionCacheRepoInvariantError>(
  "PackageResolutionCacheRepoInvariantError",
)("PackageResolutionCacheRepoInvariantError", {
  operation: packageResolutionCacheRepoOperationSchema,
  message: Schema.String,
}) {}

export class PackageResolutionCacheRepoUnexpectedError extends Schema.TaggedError<PackageResolutionCacheRepoUnexpectedError>(
  "PackageResolutionCacheRepoUnexpectedError",
)("PackageResolutionCacheRepoUnexpectedError", {
  operation: packageResolutionCacheRepoOperationSchema,
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export const packageResolutionCacheRepoErrorSchema = Schema.Union(
  PackageResolutionCacheRepoInvariantError,
  PackageResolutionCacheRepoUnexpectedError,
);

export type PackageResolutionCacheRepoError = typeof packageResolutionCacheRepoErrorSchema.Type;

type PackageResolutionCacheRepoOperation = typeof packageResolutionCacheRepoOperationSchema.Type;

const mapPackageResolutionCacheRepoError = (
  operation: PackageResolutionCacheRepoOperation,
  cause: unknown,
): PackageResolutionCacheRepoError => {
  if (
    cause instanceof PackageResolutionCacheRepoInvariantError ||
    cause instanceof PackageResolutionCacheRepoUnexpectedError
  ) {
    return cause;
  }

  return new PackageResolutionCacheRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withPackageResolutionCacheRepoError = <A>(
  operation: PackageResolutionCacheRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, PackageResolutionCacheRepoError> => {
  return effect.pipe(
    Effect.mapError((cause) => mapPackageResolutionCacheRepoError(operation, cause)),
  );
};

export interface PackageResolutionCacheRepoService {
  readonly getByQuery: (
    query: string,
  ) => Effect.Effect<PackageResolutionCacheEntry | null, PackageResolutionCacheRepoError>;
  readonly upsertByQuery: (
    input: UpsertPackageResolutionCacheEntryInput,
  ) => Effect.Effect<PackageResolutionCacheEntry, PackageResolutionCacheRepoError>;
}

export class PackageResolutionCacheRepo extends Context.Tag("PackageResolutionCacheRepo")<
  PackageResolutionCacheRepo,
  PackageResolutionCacheRepoService
>() {}

export const PackageResolutionCacheRepoLive = Layer.effect(
  PackageResolutionCacheRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      getByQuery: (query) =>
        withPackageResolutionCacheRepoError(
          "getByQuery",
          Effect.gen(function* () {
            // Atomic read+touch: increment the hit counter in a single statement so concurrent
            // reads cannot lose updates, and so a "read" never leaves a half-applied write.
            const [entry] = yield* db
              .update(packageResolutionCacheEntries)
              .set({
                lastUsedAt: new Date(),
                hitCount: sql`${packageResolutionCacheEntries.hitCount} + 1`,
              })
              .where(eq(packageResolutionCacheEntries.query, query))
              .returning();

            return entry ?? null;
          }),
        ),

      upsertByQuery: (input) =>
        withPackageResolutionCacheRepoError(
          "upsertByQuery",
          Effect.gen(function* () {
            const now = new Date();
            const [entry] = yield* db
              .insert(packageResolutionCacheEntries)
              .values({
                query: input.query,
                resolutionPayload: input.resolutionPayload,
                fetchedAt: now,
                expiresAt: input.expiresAt,
                lastUsedAt: now,
                hitCount: 0,
              } satisfies NewPackageResolutionCacheEntry)
              .onConflictDoUpdate({
                target: packageResolutionCacheEntries.query,
                set: {
                  resolutionPayload: input.resolutionPayload,
                  fetchedAt: now,
                  expiresAt: input.expiresAt,
                  lastUsedAt: now,
                },
              })
              .returning();

            if (entry === undefined) {
              return yield* new PackageResolutionCacheRepoInvariantError({
                operation: "upsertByQuery",
                message: "Failed to upsert package resolution cache entry.",
              });
            }

            return entry;
          }),
        ),
    } satisfies PackageResolutionCacheRepoService;
  }),
);
