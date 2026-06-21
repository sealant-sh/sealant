import { and, asc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  profileEnvVars,
  profileRevisions,
  profileSecretBindings,
  profileSshKeyBindings,
  profileSshSettings,
  profiles,
  type NewProfile,
  type NewProfileEnvVar,
  type NewProfileRevision,
  type NewProfileSecretBinding,
  type NewProfileSshKeyBinding,
  type NewProfileSshSetting,
  type Profile,
  type ProfileEnvVar,
  type ProfileRevision,
  type ProfileSecretBinding,
  type ProfileSshKeyBinding,
  type ProfileSshSetting,
  type ProfileStatus,
} from "../schema.js";

export interface CreateProfileInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly status?: ProfileStatus;
}

export interface ProfileRevisionEnvVarInput {
  readonly id: string;
  readonly key: string;
  readonly value: string;
}

export interface ProfileRevisionSecretBindingInput {
  readonly id: string;
  readonly targetKey: string;
  readonly secretId: string;
  readonly secretVersionId?: string;
  readonly isRequired?: boolean;
}

export interface ProfileRevisionSshSettingsInput {
  readonly enabled?: boolean;
  readonly listenPort?: number;
  readonly hostAllowlist?: string[];
  readonly sessionTimeoutMinutes?: number;
  readonly authorizedKeysRef?: string;
}

export interface ProfileRevisionSshKeyBindingInput {
  readonly sshKeyId: string;
  readonly purpose?: ProfileSshKeyBinding["purpose"];
}

export interface CreateProfileRevisionGraphInput {
  readonly id: string;
  readonly profileId: string;
  readonly version?: number;
  readonly createdByUserId?: string;
  readonly changeSummary?: string;
  readonly fingerprint: string;
  readonly configPatch: ProfileRevision["configPatch"];
  readonly envVars?: readonly ProfileRevisionEnvVarInput[];
  readonly secretBindings?: readonly ProfileRevisionSecretBindingInput[];
  readonly sshSettings?: ProfileRevisionSshSettingsInput;
  readonly sshKeyBindings?: readonly ProfileRevisionSshKeyBindingInput[];
  readonly setAsActive?: boolean;
}

export interface SetActiveProfileRevisionInput {
  readonly profileId: string;
  readonly revisionId: string;
}

export interface ListProfilesByOwnerInput {
  readonly ownerUserId: string;
  readonly status?: ProfileStatus;
  readonly limit?: number;
}

export interface ProfileRevisionGraph {
  readonly revision: ProfileRevision;
  readonly envVars: readonly ProfileEnvVar[];
  readonly secretBindings: readonly ProfileSecretBinding[];
  readonly sshSettings: ProfileSshSetting | null;
  readonly sshKeyBindings: readonly ProfileSshKeyBinding[];
}

/** @deprecated Use ProfileRepo + ProfileRepoLive instead. */
export const createProfileRepository = (): never => {
  throw new Error("createProfileRepository is disabled during the Effect transition.");
};

/** @deprecated Use ProfileRepoService instead. */
export type ProfileRepository = ProfileRepoService;

const profileRepoOperationSchema = Schema.Literals([
  "createProfile",
  "createProfileRevisionGraph",
  "getActiveProfileRevision",
  "getProfileById",
  "getProfileRevisionGraph",
  "listProfilesByOwner",
  "setActiveProfileRevision",
]);

export class ProfileRepoInvariantError extends Schema.TaggedErrorClass<ProfileRepoInvariantError>()("ProfileRepoInvariantError", {
  operation: profileRepoOperationSchema,
  message: Schema.String,
}) {}

export class ProfileRepoUnexpectedError extends Schema.TaggedErrorClass<ProfileRepoUnexpectedError>()("ProfileRepoUnexpectedError", {
  operation: profileRepoOperationSchema,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const profileRepoErrorSchema = Schema.Union([
  ProfileRepoInvariantError,
  ProfileRepoUnexpectedError,
]);

export type ProfileRepoError = typeof profileRepoErrorSchema.Type;

type ProfileRepoOperation = typeof profileRepoOperationSchema.Type;

const mapProfileRepoError = (operation: ProfileRepoOperation, cause: unknown): ProfileRepoError => {
  if (cause instanceof ProfileRepoInvariantError || cause instanceof ProfileRepoUnexpectedError) {
    return cause;
  }

  return new ProfileRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withProfileRepoError = <A>(
  operation: ProfileRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, ProfileRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapProfileRepoError(operation, cause)));
};

export interface ProfileRepoService {
  readonly createProfile: (input: CreateProfileInput) => Effect.Effect<Profile, ProfileRepoError>;
  readonly getProfileById: (id: string) => Effect.Effect<Profile | undefined, ProfileRepoError>;
  readonly listProfilesByOwner: (
    input: ListProfilesByOwnerInput,
  ) => Effect.Effect<readonly Profile[], ProfileRepoError>;
  readonly getProfileRevisionGraph: (
    revisionId: string,
  ) => Effect.Effect<ProfileRevisionGraph | null, ProfileRepoError>;
  readonly getActiveProfileRevision: (
    profileId: string,
  ) => Effect.Effect<ProfileRevisionGraph | null, ProfileRepoError>;
  readonly setActiveProfileRevision: (
    input: SetActiveProfileRevisionInput,
  ) => Effect.Effect<Profile | null, ProfileRepoError>;
  readonly createProfileRevisionGraph: (
    input: CreateProfileRevisionGraphInput,
  ) => Effect.Effect<ProfileRevisionGraph, ProfileRepoError>;
}

export class ProfileRepo extends Context.Service<ProfileRepo, ProfileRepoService>()("ProfileRepo") {}

export const ProfileRepoLive = Layer.effect(
  ProfileRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    const getProfileRevisionGraph = (
      revisionId: string,
    ): Effect.Effect<ProfileRevisionGraph | null, unknown> => {
      return Effect.gen(function* () {
        const revision = yield* db.query.profileRevisions.findFirst({
          where: { id: revisionId },
          with: {
            sshSettings: true,
            envVars: { orderBy: { key: "asc" } },
            secretBindings: { orderBy: { targetKey: "asc" } },
            sshKeyBindings: { orderBy: { purpose: "asc", sshKeyId: "asc" } },
          },
        });

        if (revision === undefined) {
          return null;
        }

        return {
          revision,
          envVars: revision.envVars,
          secretBindings: revision.secretBindings,
          sshSettings: revision.sshSettings,
          sshKeyBindings: revision.sshKeyBindings,
        };
      });
    };

    return {
      createProfile: (input) =>
        withProfileRepoError(
          "createProfile",
          Effect.gen(function* () {
            const [created] = yield* db
              .insert(profiles)
              .values({
                id: input.id,
                ownerUserId: input.ownerUserId,
                slug: input.slug,
                name: input.name,
                ...(input.description === undefined ? {} : { description: input.description }),
                ...(input.status === undefined ? {} : { status: input.status }),
              } satisfies NewProfile)
              .returning();

            if (created === undefined) {
              return yield* new ProfileRepoInvariantError({
                operation: "createProfile",
                message: "Failed to create profile.",
              });
            }

            return created;
          }),
        ),

      getProfileById: (id) =>
        withProfileRepoError("getProfileById", db.query.profiles.findFirst({ where: { id } })),

      listProfilesByOwner: (input) =>
        withProfileRepoError(
          "listProfilesByOwner",
          Effect.gen(function* () {
            const limit = input.limit ?? 100;

            if (input.status === undefined) {
              return yield* db
                .select()
                .from(profiles)
                .where(eq(profiles.ownerUserId, input.ownerUserId))
                .orderBy(asc(profiles.createdAt))
                .limit(limit);
            }

            return yield* db
              .select()
              .from(profiles)
              .where(
                and(eq(profiles.ownerUserId, input.ownerUserId), eq(profiles.status, input.status)),
              )
              .orderBy(asc(profiles.createdAt))
              .limit(limit);
          }),
        ),

      getProfileRevisionGraph: (revisionId) =>
        withProfileRepoError("getProfileRevisionGraph", getProfileRevisionGraph(revisionId)),

      getActiveProfileRevision: (profileId) =>
        withProfileRepoError(
          "getActiveProfileRevision",
          Effect.gen(function* () {
            const [profile] = yield* db
              .select({ activeRevisionId: profiles.activeRevisionId })
              .from(profiles)
              .where(eq(profiles.id, profileId))
              .limit(1);

            if (profile === undefined || profile.activeRevisionId === null) {
              return null;
            }

            return yield* getProfileRevisionGraph(profile.activeRevisionId);
          }),
        ),

      setActiveProfileRevision: (input) =>
        withProfileRepoError(
          "setActiveProfileRevision",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [revision] = yield* tx
                .select({ id: profileRevisions.id })
                .from(profileRevisions)
                .where(
                  and(
                    eq(profileRevisions.id, input.revisionId),
                    eq(profileRevisions.profileId, input.profileId),
                  ),
                )
                .limit(1);

              if (revision === undefined) {
                return null;
              }

              const [updated] = yield* tx
                .update(profiles)
                .set({ activeRevisionId: input.revisionId })
                .where(eq(profiles.id, input.profileId))
                .returning();

              return updated ?? null;
            }),
          ),
        ),

      createProfileRevisionGraph: (input) =>
        withProfileRepoError(
          "createProfileRevisionGraph",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [profile] = yield* tx
                .select({ id: profiles.id })
                .from(profiles)
                .where(eq(profiles.id, input.profileId))
                .limit(1);

              if (profile === undefined) {
                return yield* new ProfileRepoInvariantError({
                  operation: "createProfileRevisionGraph",
                  message: `Profile not found: ${input.profileId}`,
                });
              }

              const [versionRow] = yield* tx
                .select({ maxVersion: sql<number>`coalesce(max(${profileRevisions.version}), 0)` })
                .from(profileRevisions)
                .where(eq(profileRevisions.profileId, input.profileId));

              const version = input.version ?? (versionRow?.maxVersion ?? 0) + 1;
              const [revision] = yield* tx
                .insert(profileRevisions)
                .values({
                  id: input.id,
                  profileId: input.profileId,
                  version,
                  ...(input.createdByUserId === undefined
                    ? {}
                    : { createdByUserId: input.createdByUserId }),
                  ...(input.changeSummary === undefined
                    ? {}
                    : { changeSummary: input.changeSummary }),
                  fingerprint: input.fingerprint,
                  configPatch: input.configPatch,
                } satisfies NewProfileRevision)
                .returning();

              if (revision === undefined) {
                return yield* new ProfileRepoInvariantError({
                  operation: "createProfileRevisionGraph",
                  message: "Failed to create profile revision.",
                });
              }

              const envVars =
                input.envVars === undefined || input.envVars.length === 0
                  ? []
                  : yield* tx
                      .insert(profileEnvVars)
                      .values(
                        input.envVars.map((entry) => {
                          return {
                            id: entry.id,
                            profileRevisionId: revision.id,
                            key: entry.key,
                            value: entry.value,
                          } satisfies NewProfileEnvVar;
                        }),
                      )
                      .returning();

              const secretBindings =
                input.secretBindings === undefined || input.secretBindings.length === 0
                  ? []
                  : yield* tx
                      .insert(profileSecretBindings)
                      .values(
                        input.secretBindings.map((binding) => {
                          return {
                            id: binding.id,
                            profileRevisionId: revision.id,
                            targetKey: binding.targetKey,
                            secretId: binding.secretId,
                            ...(binding.secretVersionId === undefined
                              ? {}
                              : { secretVersionId: binding.secretVersionId }),
                            ...(binding.isRequired === undefined
                              ? {}
                              : { isRequired: binding.isRequired }),
                          } satisfies NewProfileSecretBinding;
                        }),
                      )
                      .returning();

              const sshSettingsInput = input.sshSettings;
              const sshSettings =
                sshSettingsInput === undefined
                  ? null
                  : yield* Effect.gen(function* () {
                      const [insertedSshSettings] = yield* tx
                        .insert(profileSshSettings)
                        .values({
                          profileRevisionId: revision.id,
                          ...(sshSettingsInput.enabled === undefined
                            ? {}
                            : { enabled: sshSettingsInput.enabled }),
                          ...(sshSettingsInput.listenPort === undefined
                            ? {}
                            : { listenPort: sshSettingsInput.listenPort }),
                          ...(sshSettingsInput.hostAllowlist === undefined
                            ? {}
                            : { hostAllowlist: sshSettingsInput.hostAllowlist }),
                          ...(sshSettingsInput.sessionTimeoutMinutes === undefined
                            ? {}
                            : { sessionTimeoutMinutes: sshSettingsInput.sessionTimeoutMinutes }),
                          ...(sshSettingsInput.authorizedKeysRef === undefined
                            ? {}
                            : { authorizedKeysRef: sshSettingsInput.authorizedKeysRef }),
                        } satisfies NewProfileSshSetting)
                        .returning();

                      if (insertedSshSettings === undefined) {
                        return yield* new ProfileRepoInvariantError({
                          operation: "createProfileRevisionGraph",
                          message: "Failed to create profile SSH settings.",
                        });
                      }

                      return insertedSshSettings;
                    });

              const sshKeyBindings =
                input.sshKeyBindings === undefined || input.sshKeyBindings.length === 0
                  ? []
                  : yield* tx
                      .insert(profileSshKeyBindings)
                      .values(
                        input.sshKeyBindings.map((binding) => {
                          return {
                            profileRevisionId: revision.id,
                            sshKeyId: binding.sshKeyId,
                            ...(binding.purpose === undefined ? {} : { purpose: binding.purpose }),
                          } satisfies NewProfileSshKeyBinding;
                        }),
                      )
                      .returning();

              if (input.setAsActive ?? true) {
                yield* tx
                  .update(profiles)
                  .set({ activeRevisionId: revision.id })
                  .where(eq(profiles.id, input.profileId));
              }

              return {
                revision,
                envVars,
                secretBindings,
                sshSettings,
                sshKeyBindings,
              };
            }),
          ),
        ),
    } satisfies ProfileRepoService;
  }),
);
