import { and, asc, eq, sql } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
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

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createProfileRepository = (client: DatabaseClient) => {
  const { db } = client;

  const createProfile = async (input: CreateProfileInput): Promise<Profile> => {
    const [created] = await db
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

    return assertInserted(created, "Failed to create profile.");
  };

  const getProfileById = async (id: string): Promise<Profile | undefined> => {
    const [row] = await db.select().from(profiles).where(eq(profiles.id, id)).limit(1);
    return row;
  };

  const listProfilesByOwner = async (
    input: ListProfilesByOwnerInput,
  ): Promise<readonly Profile[]> => {
    const limit = input.limit ?? 100;

    if (input.status === undefined) {
      return db
        .select()
        .from(profiles)
        .where(eq(profiles.ownerUserId, input.ownerUserId))
        .orderBy(asc(profiles.createdAt))
        .limit(limit);
    }

    return db
      .select()
      .from(profiles)
      .where(and(eq(profiles.ownerUserId, input.ownerUserId), eq(profiles.status, input.status)))
      .orderBy(asc(profiles.createdAt))
      .limit(limit);
  };

  const getProfileRevisionGraph = async (
    revisionId: string,
  ): Promise<ProfileRevisionGraph | null> => {
    const [revision] = await db
      .select()
      .from(profileRevisions)
      .where(eq(profileRevisions.id, revisionId))
      .limit(1);

    if (revision === undefined) {
      return null;
    }

    const [sshSettings] = await db
      .select()
      .from(profileSshSettings)
      .where(eq(profileSshSettings.profileRevisionId, revisionId))
      .limit(1);

    const envVars = await db
      .select()
      .from(profileEnvVars)
      .where(eq(profileEnvVars.profileRevisionId, revisionId))
      .orderBy(asc(profileEnvVars.key));

    const secretBindings = await db
      .select()
      .from(profileSecretBindings)
      .where(eq(profileSecretBindings.profileRevisionId, revisionId))
      .orderBy(asc(profileSecretBindings.targetKey));

    const sshKeyBindings = await db
      .select()
      .from(profileSshKeyBindings)
      .where(eq(profileSshKeyBindings.profileRevisionId, revisionId))
      .orderBy(asc(profileSshKeyBindings.purpose), asc(profileSshKeyBindings.sshKeyId));

    return {
      revision,
      envVars,
      secretBindings,
      sshSettings: sshSettings ?? null,
      sshKeyBindings,
    };
  };

  const getActiveProfileRevision = async (
    profileId: string,
  ): Promise<ProfileRevisionGraph | null> => {
    const [profile] = await db
      .select({ activeRevisionId: profiles.activeRevisionId })
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1);

    if (profile === undefined || profile.activeRevisionId === null) {
      return null;
    }

    return getProfileRevisionGraph(profile.activeRevisionId);
  };

  const setActiveProfileRevision = async (
    input: SetActiveProfileRevisionInput,
  ): Promise<Profile | null> => {
    return db.transaction(async (tx) => {
      const [revision] = await tx
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

      const [updated] = await tx
        .update(profiles)
        .set({ activeRevisionId: input.revisionId })
        .where(eq(profiles.id, input.profileId))
        .returning();

      return updated ?? null;
    });
  };

  const createProfileRevisionGraph = async (
    input: CreateProfileRevisionGraphInput,
  ): Promise<ProfileRevisionGraph> => {
    return db.transaction(async (tx) => {
      const [profile] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.id, input.profileId))
        .limit(1);

      if (profile === undefined) {
        throw new Error(`Profile not found: ${input.profileId}`);
      }

      const [versionRow] = await tx
        .select({ maxVersion: sql<number>`coalesce(max(${profileRevisions.version}), 0)` })
        .from(profileRevisions)
        .where(eq(profileRevisions.profileId, input.profileId));

      const version = input.version ?? (versionRow?.maxVersion ?? 0) + 1;
      const [revision] = await tx
        .insert(profileRevisions)
        .values({
          id: input.id,
          profileId: input.profileId,
          version,
          ...(input.createdByUserId === undefined
            ? {}
            : { createdByUserId: input.createdByUserId }),
          ...(input.changeSummary === undefined ? {} : { changeSummary: input.changeSummary }),
          fingerprint: input.fingerprint,
          configPatch: input.configPatch,
        } satisfies NewProfileRevision)
        .returning();

      const insertedRevision = assertInserted(revision, "Failed to create profile revision.");

      const envVars =
        input.envVars === undefined || input.envVars.length === 0
          ? []
          : await tx
              .insert(profileEnvVars)
              .values(
                input.envVars.map((entry) => {
                  return {
                    id: entry.id,
                    profileRevisionId: insertedRevision.id,
                    key: entry.key,
                    value: entry.value,
                  } satisfies NewProfileEnvVar;
                }),
              )
              .returning();

      const secretBindings =
        input.secretBindings === undefined || input.secretBindings.length === 0
          ? []
          : await tx
              .insert(profileSecretBindings)
              .values(
                input.secretBindings.map((binding) => {
                  return {
                    id: binding.id,
                    profileRevisionId: insertedRevision.id,
                    targetKey: binding.targetKey,
                    secretId: binding.secretId,
                    ...(binding.secretVersionId === undefined
                      ? {}
                      : { secretVersionId: binding.secretVersionId }),
                    ...(binding.isRequired === undefined ? {} : { isRequired: binding.isRequired }),
                  } satisfies NewProfileSecretBinding;
                }),
              )
              .returning();

      const sshSettings =
        input.sshSettings === undefined
          ? null
          : assertInserted(
              (
                await tx
                  .insert(profileSshSettings)
                  .values({
                    profileRevisionId: insertedRevision.id,
                    ...(input.sshSettings.enabled === undefined
                      ? {}
                      : { enabled: input.sshSettings.enabled }),
                    ...(input.sshSettings.listenPort === undefined
                      ? {}
                      : { listenPort: input.sshSettings.listenPort }),
                    ...(input.sshSettings.hostAllowlist === undefined
                      ? {}
                      : { hostAllowlist: input.sshSettings.hostAllowlist }),
                    ...(input.sshSettings.sessionTimeoutMinutes === undefined
                      ? {}
                      : { sessionTimeoutMinutes: input.sshSettings.sessionTimeoutMinutes }),
                    ...(input.sshSettings.authorizedKeysRef === undefined
                      ? {}
                      : { authorizedKeysRef: input.sshSettings.authorizedKeysRef }),
                  } satisfies NewProfileSshSetting)
                  .returning()
              )[0],
              "Failed to create profile SSH settings.",
            );

      const sshKeyBindings =
        input.sshKeyBindings === undefined || input.sshKeyBindings.length === 0
          ? []
          : await tx
              .insert(profileSshKeyBindings)
              .values(
                input.sshKeyBindings.map((binding) => {
                  return {
                    profileRevisionId: insertedRevision.id,
                    sshKeyId: binding.sshKeyId,
                    ...(binding.purpose === undefined ? {} : { purpose: binding.purpose }),
                  } satisfies NewProfileSshKeyBinding;
                }),
              )
              .returning();

      if (input.setAsActive ?? true) {
        await tx
          .update(profiles)
          .set({ activeRevisionId: insertedRevision.id })
          .where(eq(profiles.id, input.profileId));
      }

      return {
        revision: insertedRevision,
        envVars,
        secretBindings,
        sshSettings,
        sshKeyBindings,
      };
    });
  };

  return {
    createProfile,
    createProfileRevisionGraph,
    getActiveProfileRevision,
    getProfileById,
    getProfileRevisionGraph,
    listProfilesByOwner,
    setActiveProfileRevision,
  };
};

export type ProfileRepository = ReturnType<typeof createProfileRepository>;
