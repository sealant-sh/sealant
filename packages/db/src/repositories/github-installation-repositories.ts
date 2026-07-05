import { and, asc, eq, isNull, like } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  githubAppInstallations,
  githubInstallationRepositories,
  githubInstallationUserGrants,
  type GitHubInstallationRepository,
  type NewGitHubInstallationRepository,
} from "../schema.js";

// Treat a user-provided search term as a literal substring: escape LIKE metacharacters so a term
// such as "a_b" or "50%" matches literally instead of being interpreted as a wildcard pattern.
const escapeLikePattern = (value: string): string =>
  value.replace(/[\\%_]/g, (char) => `\\${char}`);

export interface UpsertGitHubInstallationRepositoryInput {
  readonly id: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly externalRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName?: string;
  readonly defaultBranch?: string;
  readonly isPrivate?: boolean;
  readonly isArchived?: boolean;
  readonly pushedAt?: Date;
  readonly lastSyncedAt?: Date;
  readonly removedAt?: Date | null;
}

export interface ListGitHubInstallationRepositoriesInput {
  readonly installationId: string;
  readonly includeRemoved?: boolean;
  readonly search?: string;
}

export interface ListGitHubRepositoriesForUserInput {
  readonly userId: string;
  readonly installationId?: string;
  readonly search?: string;
}

/** @deprecated Use GitHubInstallationRepositoryCacheRepo + GitHubInstallationRepositoryCacheRepoLive instead. */
export const createGitHubInstallationRepositoryCacheRepository = (): never => {
  throw new Error(
    "createGitHubInstallationRepositoryCacheRepository is disabled during the Effect transition.",
  );
};

/** @deprecated Use GitHubInstallationRepositoryCacheRepoService instead. */
export type GitHubInstallationRepositoryCacheRepository =
  GitHubInstallationRepositoryCacheRepoService;

const gitHubInstallationRepositoryCacheRepoOperationSchema = Schema.Literals([
  "getInstallationRepositoryByExternalRepoId",
  "getInstallationRepositoryById",
  "getInstallationRepositoryByRepoId",
  "listRepositoriesForInstallation",
  "listRepositoriesForUser",
  "markInstallationRepositoriesRemoved",
  "upsertInstallationRepository",
]);

export class GitHubInstallationRepositoryCacheRepoInvariantError extends Schema.TaggedErrorClass<GitHubInstallationRepositoryCacheRepoInvariantError>()(
  "GitHubInstallationRepositoryCacheRepoInvariantError",
  {
    operation: gitHubInstallationRepositoryCacheRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class GitHubInstallationRepositoryCacheRepoUnexpectedError extends Schema.TaggedErrorClass<GitHubInstallationRepositoryCacheRepoUnexpectedError>()(
  "GitHubInstallationRepositoryCacheRepoUnexpectedError",
  {
    operation: gitHubInstallationRepositoryCacheRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const gitHubInstallationRepositoryCacheRepoErrorSchema = Schema.Union([
  GitHubInstallationRepositoryCacheRepoInvariantError,
  GitHubInstallationRepositoryCacheRepoUnexpectedError,
]);

export type GitHubInstallationRepositoryCacheRepoError =
  typeof gitHubInstallationRepositoryCacheRepoErrorSchema.Type;

type GitHubInstallationRepositoryCacheRepoOperation =
  typeof gitHubInstallationRepositoryCacheRepoOperationSchema.Type;

const mapGitHubInstallationRepositoryCacheRepoError = (
  operation: GitHubInstallationRepositoryCacheRepoOperation,
  cause: unknown,
): GitHubInstallationRepositoryCacheRepoError => {
  if (
    cause instanceof GitHubInstallationRepositoryCacheRepoInvariantError ||
    cause instanceof GitHubInstallationRepositoryCacheRepoUnexpectedError
  ) {
    return cause;
  }

  return new GitHubInstallationRepositoryCacheRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withGitHubInstallationRepositoryCacheRepoError = <A>(
  operation: GitHubInstallationRepositoryCacheRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, GitHubInstallationRepositoryCacheRepoError> => {
  return effect.pipe(
    Effect.mapError((cause) => mapGitHubInstallationRepositoryCacheRepoError(operation, cause)),
  );
};

export interface GitHubInstallationRepositoryCacheRepoService {
  readonly upsertInstallationRepository: (
    input: UpsertGitHubInstallationRepositoryInput,
  ) => Effect.Effect<GitHubInstallationRepository, GitHubInstallationRepositoryCacheRepoError>;
  readonly markInstallationRepositoriesRemoved: (input: {
    readonly installationId: string;
    readonly preservedExternalRepositoryIds: readonly string[];
    readonly removedAt?: Date;
  }) => Effect.Effect<number, GitHubInstallationRepositoryCacheRepoError>;
  readonly listRepositoriesForInstallation: (
    input: ListGitHubInstallationRepositoriesInput,
  ) => Effect.Effect<
    readonly GitHubInstallationRepository[],
    GitHubInstallationRepositoryCacheRepoError
  >;
  readonly listRepositoriesForUser: (
    input: ListGitHubRepositoriesForUserInput,
  ) => Effect.Effect<
    readonly GitHubInstallationRepository[],
    GitHubInstallationRepositoryCacheRepoError
  >;
  readonly getInstallationRepositoryById: (
    id: string,
  ) => Effect.Effect<
    GitHubInstallationRepository | undefined,
    GitHubInstallationRepositoryCacheRepoError
  >;
  readonly getInstallationRepositoryByRepoId: (input: {
    readonly installationId: string;
    readonly repositoryId: string;
  }) => Effect.Effect<
    GitHubInstallationRepository | undefined,
    GitHubInstallationRepositoryCacheRepoError
  >;
  readonly getInstallationRepositoryByExternalRepoId: (input: {
    readonly installationId: string;
    readonly externalRepositoryId: string;
  }) => Effect.Effect<
    GitHubInstallationRepository | undefined,
    GitHubInstallationRepositoryCacheRepoError
  >;
}

export class GitHubInstallationRepositoryCacheRepo extends Context.Service<
  GitHubInstallationRepositoryCacheRepo,
  GitHubInstallationRepositoryCacheRepoService
>()("GitHubInstallationRepositoryCacheRepo") {}

export const GitHubInstallationRepositoryCacheRepoLive = Layer.effect(
  GitHubInstallationRepositoryCacheRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      upsertInstallationRepository: (input) =>
        withGitHubInstallationRepositoryCacheRepoError(
          "upsertInstallationRepository",
          Effect.gen(function* () {
            const fullName = input.fullName ?? `${input.owner}/${input.name}`;

            const [record] = yield* db
              .insert(githubInstallationRepositories)
              .values({
                id: input.id,
                installationId: input.installationId,
                repositoryId: input.repositoryId,
                externalRepositoryId: input.externalRepositoryId,
                owner: input.owner,
                name: input.name,
                fullName,
                ...(input.defaultBranch === undefined
                  ? {}
                  : { defaultBranch: input.defaultBranch }),
                ...(input.isPrivate === undefined ? {} : { isPrivate: input.isPrivate }),
                ...(input.isArchived === undefined ? {} : { isArchived: input.isArchived }),
                ...(input.pushedAt === undefined ? {} : { pushedAt: input.pushedAt }),
                ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
                ...(input.removedAt === undefined ? {} : { removedAt: input.removedAt }),
              } satisfies NewGitHubInstallationRepository)
              .onConflictDoUpdate({
                target: [
                  githubInstallationRepositories.installationId,
                  githubInstallationRepositories.externalRepositoryId,
                ],
                set: {
                  repositoryId: input.repositoryId,
                  owner: input.owner,
                  name: input.name,
                  fullName,
                  ...(input.defaultBranch === undefined
                    ? {}
                    : { defaultBranch: input.defaultBranch }),
                  ...(input.isPrivate === undefined ? {} : { isPrivate: input.isPrivate }),
                  ...(input.isArchived === undefined ? {} : { isArchived: input.isArchived }),
                  ...(input.pushedAt === undefined ? {} : { pushedAt: input.pushedAt }),
                  ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
                  removedAt: input.removedAt ?? null,
                },
              })
              .returning();

            if (record === undefined) {
              return yield* new GitHubInstallationRepositoryCacheRepoInvariantError({
                operation: "upsertInstallationRepository",
                message: "Failed to upsert GitHub installation repository.",
              });
            }

            return record;
          }),
        ),

      markInstallationRepositoriesRemoved: (input) =>
        withGitHubInstallationRepositoryCacheRepoError(
          "markInstallationRepositoriesRemoved",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const activeRows = yield* tx
                .select({
                  id: githubInstallationRepositories.id,
                  externalRepositoryId: githubInstallationRepositories.externalRepositoryId,
                })
                .from(githubInstallationRepositories)
                .where(
                  and(
                    eq(githubInstallationRepositories.installationId, input.installationId),
                    isNull(githubInstallationRepositories.removedAt),
                  ),
                );

              const staleIds = activeRows
                .filter((row: { readonly externalRepositoryId: string }) => {
                  return !input.preservedExternalRepositoryIds.includes(row.externalRepositoryId);
                })
                .map((row: { readonly id: string }) => row.id);

              if (staleIds.length === 0) {
                return 0;
              }

              const updated = yield* Effect.forEach(staleIds, (id) =>
                tx
                  .update(githubInstallationRepositories)
                  .set({ removedAt: input.removedAt ?? new Date() })
                  .where(eq(githubInstallationRepositories.id, id))
                  .returning({ id: githubInstallationRepositories.id })
                  .pipe(Effect.map((rows) => rows[0])),
              );

              return updated.filter((row: { readonly id: string } | undefined) => row !== undefined)
                .length;
            }),
          ),
        ),

      listRepositoriesForInstallation: (input) =>
        withGitHubInstallationRepositoryCacheRepoError(
          "listRepositoriesForInstallation",
          Effect.gen(function* () {
            const whereClauses = [
              eq(githubInstallationRepositories.installationId, input.installationId),
              ...(input.includeRemoved ? [] : [isNull(githubInstallationRepositories.removedAt)]),
              ...(input.search === undefined || input.search.trim().length === 0
                ? []
                : [
                    like(
                      githubInstallationRepositories.fullName,
                      `%${escapeLikePattern(input.search.trim())}%`,
                    ),
                  ]),
            ];

            return yield* db
              .select()
              .from(githubInstallationRepositories)
              .where(and(...whereClauses))
              .orderBy(asc(githubInstallationRepositories.fullName));
          }),
        ),

      listRepositoriesForUser: (input) =>
        withGitHubInstallationRepositoryCacheRepoError(
          "listRepositoriesForUser",
          Effect.gen(function* () {
            const whereClauses = [
              eq(githubInstallationUserGrants.userId, input.userId),
              isNull(githubInstallationUserGrants.revokedAt),
              eq(githubAppInstallations.status, "active"),
              isNull(githubInstallationRepositories.removedAt),
              ...(input.installationId === undefined
                ? []
                : [eq(githubInstallationRepositories.installationId, input.installationId)]),
              ...(input.search === undefined || input.search.trim().length === 0
                ? []
                : [
                    like(
                      githubInstallationRepositories.fullName,
                      `%${escapeLikePattern(input.search.trim())}%`,
                    ),
                  ]),
            ];

            const rows = yield* db
              .select({ installationRepository: githubInstallationRepositories })
              .from(githubInstallationRepositories)
              .innerJoin(
                githubAppInstallations,
                eq(githubAppInstallations.id, githubInstallationRepositories.installationId),
              )
              .innerJoin(
                githubInstallationUserGrants,
                eq(githubInstallationUserGrants.installationId, githubAppInstallations.id),
              )
              .where(and(...whereClauses))
              .orderBy(asc(githubInstallationRepositories.fullName));

            return rows.map(
              (row: { readonly installationRepository: GitHubInstallationRepository }) => {
                return row.installationRepository;
              },
            );
          }),
        ),

      getInstallationRepositoryById: (id) =>
        withGitHubInstallationRepositoryCacheRepoError(
          "getInstallationRepositoryById",
          Effect.gen(function* () {
            const [record] = yield* db
              .select()
              .from(githubInstallationRepositories)
              .where(eq(githubInstallationRepositories.id, id))
              .limit(1);

            return record;
          }),
        ),

      getInstallationRepositoryByRepoId: (input) =>
        withGitHubInstallationRepositoryCacheRepoError(
          "getInstallationRepositoryByRepoId",
          Effect.gen(function* () {
            const [record] = yield* db
              .select()
              .from(githubInstallationRepositories)
              .where(
                and(
                  eq(githubInstallationRepositories.installationId, input.installationId),
                  eq(githubInstallationRepositories.repositoryId, input.repositoryId),
                ),
              )
              .limit(1);

            return record;
          }),
        ),

      getInstallationRepositoryByExternalRepoId: (input) =>
        withGitHubInstallationRepositoryCacheRepoError(
          "getInstallationRepositoryByExternalRepoId",
          Effect.gen(function* () {
            const [record] = yield* db
              .select()
              .from(githubInstallationRepositories)
              .where(
                and(
                  eq(githubInstallationRepositories.installationId, input.installationId),
                  eq(
                    githubInstallationRepositories.externalRepositoryId,
                    input.externalRepositoryId,
                  ),
                ),
              )
              .limit(1);

            return record;
          }),
        ),
    } satisfies GitHubInstallationRepositoryCacheRepoService;
  }),
);
