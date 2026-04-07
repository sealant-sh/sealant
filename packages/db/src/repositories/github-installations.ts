import { and, asc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  githubAppInstallations,
  githubInstallationUserGrants,
  type GitHubAppInstallation,
  type GitHubInstallationAccountType,
  type GitHubInstallationRepositorySelection,
  type GitHubInstallationStatus,
  type GitHubInstallationUserGrant,
  type NewGitHubAppInstallation,
  type NewGitHubInstallationUserGrant,
} from "../schema.js";

export interface UpsertGitHubInstallationInput {
  readonly id: string;
  readonly externalInstallationId: string;
  readonly externalAccountId?: string;
  readonly accountLogin: string;
  readonly accountType: GitHubInstallationAccountType;
  readonly targetType?: GitHubInstallationAccountType;
  readonly status?: GitHubInstallationStatus;
  readonly permissions?: Record<string, string>;
  readonly repositorySelection?: GitHubInstallationRepositorySelection;
  readonly installedAt?: Date;
  readonly suspendedAt?: Date | null;
  readonly lastSyncedAt?: Date;
}

export interface SetGitHubInstallationStatusInput {
  readonly installationId: string;
  readonly status: GitHubInstallationStatus;
  readonly suspendedAt?: Date | null;
  readonly lastSyncedAt?: Date;
}

export interface GrantGitHubInstallationToUserInput {
  readonly installationId: string;
  readonly userId: string;
  readonly grantedByUserId?: string;
  readonly grantedAt?: Date;
}

export interface RevokeGitHubInstallationGrantInput {
  readonly installationId: string;
  readonly userId: string;
  readonly revokedAt?: Date;
}

export interface ListGitHubInstallationsForUserInput {
  readonly userId: string;
  readonly status?: GitHubInstallationStatus;
}

/** @deprecated Use GitHubInstallationRepo + GitHubInstallationRepoLive instead. */
export const createGitHubInstallationRepository = (): never => {
  throw new Error("createGitHubInstallationRepository is disabled during the Effect transition.");
};

/** @deprecated Use GitHubInstallationRepoService instead. */
export type GitHubInstallationRepository = GitHubInstallationRepoService;

const gitHubInstallationRepoOperationSchema = Schema.Literal(
  "getInstallationByExternalId",
  "getInstallationById",
  "grantInstallationToUser",
  "listActiveInstallations",
  "listInstallationGrants",
  "listInstallationsForUser",
  "revokeInstallationGrant",
  "setInstallationStatus",
  "upsertInstallation",
  "userHasInstallationGrant",
);

export class GitHubInstallationRepoInvariantError extends Schema.TaggedError<GitHubInstallationRepoInvariantError>(
  "GitHubInstallationRepoInvariantError",
)("GitHubInstallationRepoInvariantError", {
  operation: gitHubInstallationRepoOperationSchema,
  message: Schema.String,
}) {}

export class GitHubInstallationRepoUnexpectedError extends Schema.TaggedError<GitHubInstallationRepoUnexpectedError>(
  "GitHubInstallationRepoUnexpectedError",
)("GitHubInstallationRepoUnexpectedError", {
  operation: gitHubInstallationRepoOperationSchema,
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export const gitHubInstallationRepoErrorSchema = Schema.Union(
  GitHubInstallationRepoInvariantError,
  GitHubInstallationRepoUnexpectedError,
);

export type GitHubInstallationRepoError = typeof gitHubInstallationRepoErrorSchema.Type;

type GitHubInstallationRepoOperation = typeof gitHubInstallationRepoOperationSchema.Type;

const mapGitHubInstallationRepoError = (
  operation: GitHubInstallationRepoOperation,
  cause: unknown,
): GitHubInstallationRepoError => {
  if (
    cause instanceof GitHubInstallationRepoInvariantError ||
    cause instanceof GitHubInstallationRepoUnexpectedError
  ) {
    return cause;
  }

  return new GitHubInstallationRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withGitHubInstallationRepoError = <A>(
  operation: GitHubInstallationRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, GitHubInstallationRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapGitHubInstallationRepoError(operation, cause)));
};

export interface GitHubInstallationRepoService {
  readonly upsertInstallation: (
    input: UpsertGitHubInstallationInput,
  ) => Effect.Effect<GitHubAppInstallation, GitHubInstallationRepoError>;
  readonly getInstallationById: (
    id: string,
  ) => Effect.Effect<GitHubAppInstallation | undefined, GitHubInstallationRepoError>;
  readonly getInstallationByExternalId: (
    externalInstallationId: string,
  ) => Effect.Effect<GitHubAppInstallation | undefined, GitHubInstallationRepoError>;
  readonly listInstallationsForUser: (
    input: ListGitHubInstallationsForUserInput,
  ) => Effect.Effect<readonly GitHubAppInstallation[], GitHubInstallationRepoError>;
  readonly listActiveInstallations: () => Effect.Effect<
    readonly GitHubAppInstallation[],
    GitHubInstallationRepoError
  >;
  readonly setInstallationStatus: (
    input: SetGitHubInstallationStatusInput,
  ) => Effect.Effect<GitHubAppInstallation | null, GitHubInstallationRepoError>;
  readonly grantInstallationToUser: (
    input: GrantGitHubInstallationToUserInput,
  ) => Effect.Effect<GitHubInstallationUserGrant, GitHubInstallationRepoError>;
  readonly revokeInstallationGrant: (
    input: RevokeGitHubInstallationGrantInput,
  ) => Effect.Effect<GitHubInstallationUserGrant | null, GitHubInstallationRepoError>;
  readonly userHasInstallationGrant: (input: {
    readonly installationId: string;
    readonly userId: string;
  }) => Effect.Effect<boolean, GitHubInstallationRepoError>;
  readonly listInstallationGrants: (
    installationId: string,
  ) => Effect.Effect<readonly GitHubInstallationUserGrant[], GitHubInstallationRepoError>;
}

export class GitHubInstallationRepo extends Context.Tag("GitHubInstallationRepo")<
  GitHubInstallationRepo,
  GitHubInstallationRepoService
>() {}

export const GitHubInstallationRepoLive = Layer.effect(
  GitHubInstallationRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      upsertInstallation: (input) =>
        withGitHubInstallationRepoError(
          "upsertInstallation",
          Effect.gen(function* () {
            const [installation] = yield* db
              .insert(githubAppInstallations)
              .values({
                id: input.id,
                externalInstallationId: input.externalInstallationId,
                ...(input.externalAccountId === undefined
                  ? {}
                  : { externalAccountId: input.externalAccountId }),
                accountLogin: input.accountLogin,
                accountType: input.accountType,
                ...(input.targetType === undefined ? {} : { targetType: input.targetType }),
                ...(input.status === undefined ? {} : { status: input.status }),
                ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
                ...(input.repositorySelection === undefined
                  ? {}
                  : { repositorySelection: input.repositorySelection }),
                ...(input.installedAt === undefined ? {} : { installedAt: input.installedAt }),
                ...(input.suspendedAt === undefined ? {} : { suspendedAt: input.suspendedAt }),
                ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
              } satisfies NewGitHubAppInstallation)
              .onConflictDoUpdate({
                target: githubAppInstallations.externalInstallationId,
                set: {
                  ...(input.externalAccountId === undefined
                    ? {}
                    : { externalAccountId: input.externalAccountId }),
                  accountLogin: input.accountLogin,
                  accountType: input.accountType,
                  ...(input.targetType === undefined ? {} : { targetType: input.targetType }),
                  ...(input.status === undefined ? {} : { status: input.status }),
                  ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
                  ...(input.repositorySelection === undefined
                    ? {}
                    : { repositorySelection: input.repositorySelection }),
                  ...(input.installedAt === undefined ? {} : { installedAt: input.installedAt }),
                  ...(input.suspendedAt === undefined ? {} : { suspendedAt: input.suspendedAt }),
                  ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
                },
              })
              .returning();

            if (installation === undefined) {
              return yield* new GitHubInstallationRepoInvariantError({
                operation: "upsertInstallation",
                message: "Failed to upsert GitHub installation.",
              });
            }

            return installation;
          }),
        ),

      getInstallationById: (id) =>
        withGitHubInstallationRepoError(
          "getInstallationById",
          Effect.gen(function* () {
            const [installation] = yield* db
              .select()
              .from(githubAppInstallations)
              .where(eq(githubAppInstallations.id, id))
              .limit(1);

            return installation;
          }),
        ),

      getInstallationByExternalId: (externalInstallationId) =>
        withGitHubInstallationRepoError(
          "getInstallationByExternalId",
          Effect.gen(function* () {
            const [installation] = yield* db
              .select()
              .from(githubAppInstallations)
              .where(eq(githubAppInstallations.externalInstallationId, externalInstallationId))
              .limit(1);

            return installation;
          }),
        ),

      listInstallationsForUser: (input) =>
        withGitHubInstallationRepoError(
          "listInstallationsForUser",
          Effect.gen(function* () {
            const whereClauses = [
              eq(githubInstallationUserGrants.userId, input.userId),
              isNull(githubInstallationUserGrants.revokedAt),
              ...(input.status === undefined
                ? []
                : [eq(githubAppInstallations.status, input.status)]),
            ];

            const rows = yield* db
              .select({ installation: githubAppInstallations })
              .from(githubInstallationUserGrants)
              .innerJoin(
                githubAppInstallations,
                eq(githubAppInstallations.id, githubInstallationUserGrants.installationId),
              )
              .where(and(...whereClauses))
              .orderBy(asc(githubAppInstallations.accountLogin));

            return rows.map((row: { readonly installation: GitHubAppInstallation }) => {
              return row.installation;
            });
          }),
        ),

      listActiveInstallations: () =>
        withGitHubInstallationRepoError(
          "listActiveInstallations",
          db
            .select()
            .from(githubAppInstallations)
            .where(eq(githubAppInstallations.status, "active"))
            .orderBy(asc(githubAppInstallations.accountLogin)),
        ),

      setInstallationStatus: (input) =>
        withGitHubInstallationRepoError(
          "setInstallationStatus",
          Effect.gen(function* () {
            const [installation] = yield* db
              .update(githubAppInstallations)
              .set({
                status: input.status,
                ...(input.suspendedAt === undefined ? {} : { suspendedAt: input.suspendedAt }),
                ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
              })
              .where(eq(githubAppInstallations.id, input.installationId))
              .returning();

            return installation ?? null;
          }),
        ),

      grantInstallationToUser: (input) =>
        withGitHubInstallationRepoError(
          "grantInstallationToUser",
          Effect.gen(function* () {
            const [grant] = yield* db
              .insert(githubInstallationUserGrants)
              .values({
                installationId: input.installationId,
                userId: input.userId,
                ...(input.grantedByUserId === undefined
                  ? {}
                  : { grantedByUserId: input.grantedByUserId }),
                ...(input.grantedAt === undefined ? {} : { grantedAt: input.grantedAt }),
              } satisfies NewGitHubInstallationUserGrant)
              .onConflictDoUpdate({
                target: [
                  githubInstallationUserGrants.installationId,
                  githubInstallationUserGrants.userId,
                ],
                set: {
                  revokedAt: null,
                  ...(input.grantedByUserId === undefined
                    ? {}
                    : { grantedByUserId: input.grantedByUserId }),
                  grantedAt: input.grantedAt ?? new Date(),
                },
              })
              .returning();

            if (grant === undefined) {
              return yield* new GitHubInstallationRepoInvariantError({
                operation: "grantInstallationToUser",
                message: "Failed to grant GitHub installation access.",
              });
            }

            return grant;
          }),
        ),

      revokeInstallationGrant: (input) =>
        withGitHubInstallationRepoError(
          "revokeInstallationGrant",
          Effect.gen(function* () {
            const [grant] = yield* db
              .update(githubInstallationUserGrants)
              .set({
                revokedAt: input.revokedAt ?? new Date(),
              })
              .where(
                and(
                  eq(githubInstallationUserGrants.installationId, input.installationId),
                  eq(githubInstallationUserGrants.userId, input.userId),
                ),
              )
              .returning();

            return grant ?? null;
          }),
        ),

      userHasInstallationGrant: (input) =>
        withGitHubInstallationRepoError(
          "userHasInstallationGrant",
          Effect.gen(function* () {
            const [grant] = yield* db
              .select({ installationId: githubInstallationUserGrants.installationId })
              .from(githubInstallationUserGrants)
              .where(
                and(
                  eq(githubInstallationUserGrants.installationId, input.installationId),
                  eq(githubInstallationUserGrants.userId, input.userId),
                  isNull(githubInstallationUserGrants.revokedAt),
                ),
              )
              .limit(1);

            return grant !== undefined;
          }),
        ),

      listInstallationGrants: (installationId) =>
        withGitHubInstallationRepoError(
          "listInstallationGrants",
          db
            .select()
            .from(githubInstallationUserGrants)
            .where(eq(githubInstallationUserGrants.installationId, installationId))
            .orderBy(asc(githubInstallationUserGrants.userId)),
        ),
    } satisfies GitHubInstallationRepoService;
  }),
);
