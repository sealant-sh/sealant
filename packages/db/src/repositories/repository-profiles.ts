import { and, asc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  repositories,
  repositoryProfileProfileLinks,
  repositoryProfileRevisions,
  repositoryProfiles,
  type NewRepository,
  type NewRepositoryProfile,
  type NewRepositoryProfileProfileLink,
  type NewRepositoryProfileRevision,
  type ProfileStatus,
  type Repository,
  type RepositoryProfile,
  type RepositoryProfileProfileLink,
  type RepositoryProfileRevision,
  type SourceProvider,
} from "../schema.js";

export interface UpsertRepositoryInput {
  readonly id: string;
  readonly provider?: SourceProvider;
  readonly externalId?: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch?: string;
  readonly url?: string;
  readonly isArchived?: boolean;
  readonly lastSyncedAt?: Date;
}

export interface CreateRepositoryProfileInput {
  readonly id: string;
  readonly repositoryId: string;
  readonly name: string;
  readonly description?: string;
  readonly status?: ProfileStatus;
}

export interface CreateRepositoryProfileRevisionInput {
  readonly id: string;
  readonly repositoryProfileId: string;
  readonly version?: number;
  readonly createdByUserId?: string;
  readonly changeSummary?: string;
  readonly fingerprint: string;
  readonly runTemplate: RepositoryProfileRevision["runTemplate"];
  readonly policyConfig?: RepositoryProfileRevision["policyConfig"];
  readonly setAsActive?: boolean;
}

export interface ReplaceRepositoryProfileLinksInput {
  readonly repositoryProfileRevisionId: string;
  readonly links: readonly {
    id: string;
    profileRevisionId: string;
    precedence?: number;
    isRequired?: boolean;
  }[];
}

export interface SetActiveRepositoryProfileRevisionInput {
  readonly repositoryProfileId: string;
  readonly revisionId: string;
}

export interface ListRepositoryProfilesInput {
  readonly repositoryId: string;
  readonly status?: ProfileStatus;
  readonly limit?: number;
}

export interface RepositoryProfileRevisionBundle {
  readonly repositoryProfile: RepositoryProfile;
  readonly revision: RepositoryProfileRevision;
  readonly profileLinks: readonly RepositoryProfileProfileLink[];
}

/** @deprecated Use RepositoryProfileRepo + RepositoryProfileRepoLive instead. */
export const createRepositoryProfileRepository = (): never => {
  throw new Error("createRepositoryProfileRepository is disabled during the Effect transition.");
};

/** @deprecated Use RepositoryProfileRepoService instead. */
export type RepositoryProfileRepository = RepositoryProfileRepoService;

const repositoryProfileRepoOperationSchema = Schema.Literals([
  "createRepositoryProfile",
  "createRepositoryProfileRevision",
  "getRepositoryById",
  "getRepositoryByProviderExternalId",
  "getRepositoryByProviderOwnerName",
  "getRepositoryProfileRevisionBundle",
  "listRepositoryProfiles",
  "replaceRepositoryProfileLinks",
  "setActiveRepositoryProfileRevision",
  "upsertRepository",
]);

export class RepositoryProfileRepoInvariantError extends Schema.TaggedErrorClass<RepositoryProfileRepoInvariantError>()(
  "RepositoryProfileRepoInvariantError",
  {
    operation: repositoryProfileRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class RepositoryProfileRepoUnexpectedError extends Schema.TaggedErrorClass<RepositoryProfileRepoUnexpectedError>()(
  "RepositoryProfileRepoUnexpectedError",
  {
    operation: repositoryProfileRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const repositoryProfileRepoErrorSchema = Schema.Union([
  RepositoryProfileRepoInvariantError,
  RepositoryProfileRepoUnexpectedError,
]);

export type RepositoryProfileRepoError = typeof repositoryProfileRepoErrorSchema.Type;

type RepositoryProfileRepoOperation = typeof repositoryProfileRepoOperationSchema.Type;

const mapRepositoryProfileRepoError = (
  operation: RepositoryProfileRepoOperation,
  cause: unknown,
): RepositoryProfileRepoError => {
  if (
    cause instanceof RepositoryProfileRepoInvariantError ||
    cause instanceof RepositoryProfileRepoUnexpectedError
  ) {
    return cause;
  }

  return new RepositoryProfileRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withRepositoryProfileRepoError = <A>(
  operation: RepositoryProfileRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, RepositoryProfileRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapRepositoryProfileRepoError(operation, cause)));
};

export interface RepositoryProfileRepoService {
  readonly upsertRepository: (
    input: UpsertRepositoryInput,
  ) => Effect.Effect<Repository, RepositoryProfileRepoError>;
  readonly getRepositoryById: (
    id: string,
  ) => Effect.Effect<Repository | undefined, RepositoryProfileRepoError>;
  readonly getRepositoryByProviderExternalId: (input: {
    readonly provider: SourceProvider;
    readonly externalId: string;
  }) => Effect.Effect<Repository | undefined, RepositoryProfileRepoError>;
  readonly getRepositoryByProviderOwnerName: (input: {
    readonly provider: SourceProvider;
    readonly owner: string;
    readonly name: string;
  }) => Effect.Effect<Repository | undefined, RepositoryProfileRepoError>;
  readonly createRepositoryProfile: (
    input: CreateRepositoryProfileInput,
  ) => Effect.Effect<RepositoryProfile, RepositoryProfileRepoError>;
  readonly listRepositoryProfiles: (
    input: ListRepositoryProfilesInput,
  ) => Effect.Effect<readonly RepositoryProfile[], RepositoryProfileRepoError>;
  readonly setActiveRepositoryProfileRevision: (
    input: SetActiveRepositoryProfileRevisionInput,
  ) => Effect.Effect<RepositoryProfile | null, RepositoryProfileRepoError>;
  readonly createRepositoryProfileRevision: (
    input: CreateRepositoryProfileRevisionInput,
  ) => Effect.Effect<RepositoryProfileRevision, RepositoryProfileRepoError>;
  readonly replaceRepositoryProfileLinks: (
    input: ReplaceRepositoryProfileLinksInput,
  ) => Effect.Effect<readonly RepositoryProfileProfileLink[], RepositoryProfileRepoError>;
  readonly getRepositoryProfileRevisionBundle: (
    revisionId: string,
  ) => Effect.Effect<RepositoryProfileRevisionBundle | null, RepositoryProfileRepoError>;
}

export class RepositoryProfileRepo extends Context.Service<
  RepositoryProfileRepo,
  RepositoryProfileRepoService
>()("RepositoryProfileRepo") {}

export const RepositoryProfileRepoLive = Layer.effect(
  RepositoryProfileRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      upsertRepository: (input) =>
        withRepositoryProfileRepoError(
          "upsertRepository",
          Effect.gen(function* () {
            const [repository] = yield* db
              .insert(repositories)
              .values({
                id: input.id,
                ...(input.provider === undefined ? {} : { provider: input.provider }),
                ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
                owner: input.owner,
                name: input.name,
                ...(input.defaultBranch === undefined
                  ? {}
                  : { defaultBranch: input.defaultBranch }),
                ...(input.url === undefined ? {} : { url: input.url }),
                ...(input.isArchived === undefined ? {} : { isArchived: input.isArchived }),
                ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
              } satisfies NewRepository)
              .onConflictDoUpdate({
                target: repositories.id,
                set: {
                  ...(input.provider === undefined ? {} : { provider: input.provider }),
                  ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
                  owner: input.owner,
                  name: input.name,
                  ...(input.defaultBranch === undefined
                    ? {}
                    : { defaultBranch: input.defaultBranch }),
                  ...(input.url === undefined ? {} : { url: input.url }),
                  ...(input.isArchived === undefined ? {} : { isArchived: input.isArchived }),
                  ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
                },
              })
              .returning();

            if (repository === undefined) {
              return yield* new RepositoryProfileRepoInvariantError({
                operation: "upsertRepository",
                message: "Failed to upsert repository.",
              });
            }

            return repository;
          }),
        ),

      getRepositoryById: (id) =>
        withRepositoryProfileRepoError(
          "getRepositoryById",
          db.query.repositories.findFirst({ where: { id } }),
        ),

      getRepositoryByProviderExternalId: (input) =>
        withRepositoryProfileRepoError(
          "getRepositoryByProviderExternalId",
          Effect.gen(function* () {
            const [repository] = yield* db
              .select()
              .from(repositories)
              .where(
                and(
                  eq(repositories.provider, input.provider),
                  eq(repositories.externalId, input.externalId),
                ),
              )
              .limit(1);

            return repository;
          }),
        ),

      getRepositoryByProviderOwnerName: (input) =>
        withRepositoryProfileRepoError(
          "getRepositoryByProviderOwnerName",
          Effect.gen(function* () {
            const [repository] = yield* db
              .select()
              .from(repositories)
              .where(
                and(
                  eq(repositories.provider, input.provider),
                  eq(repositories.owner, input.owner),
                  eq(repositories.name, input.name),
                ),
              )
              .limit(1);

            return repository;
          }),
        ),

      createRepositoryProfile: (input) =>
        withRepositoryProfileRepoError(
          "createRepositoryProfile",
          Effect.gen(function* () {
            const [profile] = yield* db
              .insert(repositoryProfiles)
              .values({
                id: input.id,
                repositoryId: input.repositoryId,
                name: input.name,
                ...(input.description === undefined ? {} : { description: input.description }),
                ...(input.status === undefined ? {} : { status: input.status }),
              } satisfies NewRepositoryProfile)
              .returning();

            if (profile === undefined) {
              return yield* new RepositoryProfileRepoInvariantError({
                operation: "createRepositoryProfile",
                message: "Failed to create repository profile.",
              });
            }

            return profile;
          }),
        ),

      listRepositoryProfiles: (input) =>
        withRepositoryProfileRepoError(
          "listRepositoryProfiles",
          Effect.gen(function* () {
            const limit = input.limit ?? 100;

            if (input.status === undefined) {
              return yield* db
                .select()
                .from(repositoryProfiles)
                .where(eq(repositoryProfiles.repositoryId, input.repositoryId))
                .orderBy(asc(repositoryProfiles.createdAt))
                .limit(limit);
            }

            return yield* db
              .select()
              .from(repositoryProfiles)
              .where(
                and(
                  eq(repositoryProfiles.repositoryId, input.repositoryId),
                  eq(repositoryProfiles.status, input.status),
                ),
              )
              .orderBy(asc(repositoryProfiles.createdAt))
              .limit(limit);
          }),
        ),

      setActiveRepositoryProfileRevision: (input) =>
        withRepositoryProfileRepoError(
          "setActiveRepositoryProfileRevision",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [revision] = yield* tx
                .select({ id: repositoryProfileRevisions.id })
                .from(repositoryProfileRevisions)
                .where(
                  and(
                    eq(repositoryProfileRevisions.id, input.revisionId),
                    eq(repositoryProfileRevisions.repositoryProfileId, input.repositoryProfileId),
                  ),
                )
                .limit(1);

              if (revision === undefined) {
                return null;
              }

              const [updated] = yield* tx
                .update(repositoryProfiles)
                .set({ activeRevisionId: input.revisionId })
                .where(eq(repositoryProfiles.id, input.repositoryProfileId))
                .returning();

              return updated ?? null;
            }),
          ),
        ),

      createRepositoryProfileRevision: (input) =>
        withRepositoryProfileRepoError(
          "createRepositoryProfileRevision",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [profile] = yield* tx
                .select({ id: repositoryProfiles.id })
                .from(repositoryProfiles)
                .where(eq(repositoryProfiles.id, input.repositoryProfileId))
                .limit(1);

              if (profile === undefined) {
                return yield* new RepositoryProfileRepoInvariantError({
                  operation: "createRepositoryProfileRevision",
                  message: `Repository profile not found: ${input.repositoryProfileId}`,
                });
              }

              const [versionRow] = yield* tx
                .select({
                  maxVersion: sql<number>`coalesce(max(${repositoryProfileRevisions.version}), 0)`,
                })
                .from(repositoryProfileRevisions)
                .where(
                  eq(repositoryProfileRevisions.repositoryProfileId, input.repositoryProfileId),
                );

              const version = input.version ?? (versionRow?.maxVersion ?? 0) + 1;
              const [revision] = yield* tx
                .insert(repositoryProfileRevisions)
                .values({
                  id: input.id,
                  repositoryProfileId: input.repositoryProfileId,
                  version,
                  ...(input.createdByUserId === undefined
                    ? {}
                    : { createdByUserId: input.createdByUserId }),
                  ...(input.changeSummary === undefined
                    ? {}
                    : { changeSummary: input.changeSummary }),
                  fingerprint: input.fingerprint,
                  runTemplate: input.runTemplate,
                  ...(input.policyConfig === undefined ? {} : { policyConfig: input.policyConfig }),
                } satisfies NewRepositoryProfileRevision)
                .returning();

              if (revision === undefined) {
                return yield* new RepositoryProfileRepoInvariantError({
                  operation: "createRepositoryProfileRevision",
                  message: "Failed to create repository profile revision.",
                });
              }

              if (input.setAsActive ?? true) {
                yield* tx
                  .update(repositoryProfiles)
                  .set({ activeRevisionId: revision.id })
                  .where(eq(repositoryProfiles.id, input.repositoryProfileId));
              }

              return revision;
            }),
          ),
        ),

      replaceRepositoryProfileLinks: (input) =>
        withRepositoryProfileRepoError(
          "replaceRepositoryProfileLinks",
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(repositoryProfileProfileLinks)
                .where(
                  eq(
                    repositoryProfileProfileLinks.repositoryProfileRevisionId,
                    input.repositoryProfileRevisionId,
                  ),
                );

              if (input.links.length === 0) {
                return [];
              }

              return yield* tx
                .insert(repositoryProfileProfileLinks)
                .values(
                  input.links.map((link) => {
                    return {
                      id: link.id,
                      repositoryProfileRevisionId: input.repositoryProfileRevisionId,
                      profileRevisionId: link.profileRevisionId,
                      ...(link.precedence === undefined ? {} : { precedence: link.precedence }),
                      ...(link.isRequired === undefined ? {} : { isRequired: link.isRequired }),
                    } satisfies NewRepositoryProfileProfileLink;
                  }),
                )
                .returning();
            }),
          ),
        ),

      getRepositoryProfileRevisionBundle: (revisionId) =>
        withRepositoryProfileRepoError(
          "getRepositoryProfileRevisionBundle",
          Effect.gen(function* () {
            const revision = yield* db.query.repositoryProfileRevisions.findFirst({
              where: { id: revisionId },
              with: {
                repositoryProfile: true,
                profileLinks: {
                  orderBy: { precedence: "asc", profileRevisionId: "asc" },
                },
              },
            });

            if (revision === undefined) {
              return null;
            }

            if (revision.repositoryProfile === null) {
              return null;
            }

            return {
              repositoryProfile: revision.repositoryProfile,
              revision,
              profileLinks: revision.profileLinks,
            };
          }),
        ),
    } satisfies RepositoryProfileRepoService;
  }),
);
