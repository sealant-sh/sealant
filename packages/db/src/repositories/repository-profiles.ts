import { and, asc, eq, sql } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
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

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createRepositoryProfileRepository = (client: DatabaseClient) => {
  const { db } = client;

  const upsertRepository = async (input: UpsertRepositoryInput): Promise<Repository> => {
    const [repository] = await db
      .insert(repositories)
      .values({
        id: input.id,
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
        owner: input.owner,
        name: input.name,
        ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
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
          ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.isArchived === undefined ? {} : { isArchived: input.isArchived }),
          ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
        },
      })
      .returning();

    return assertInserted(repository, "Failed to upsert repository.");
  };

  const getRepositoryById = async (id: string): Promise<Repository | undefined> => {
    const [repository] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, id))
      .limit(1);
    return repository;
  };

  const getRepositoryByProviderExternalId = async (input: {
    readonly provider: SourceProvider;
    readonly externalId: string;
  }): Promise<Repository | undefined> => {
    const [repository] = await db
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
  };

  const getRepositoryByProviderOwnerName = async (input: {
    readonly provider: SourceProvider;
    readonly owner: string;
    readonly name: string;
  }): Promise<Repository | undefined> => {
    const [repository] = await db
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
  };

  const createRepositoryProfile = async (
    input: CreateRepositoryProfileInput,
  ): Promise<RepositoryProfile> => {
    const [profile] = await db
      .insert(repositoryProfiles)
      .values({
        id: input.id,
        repositoryId: input.repositoryId,
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
      } satisfies NewRepositoryProfile)
      .returning();

    return assertInserted(profile, "Failed to create repository profile.");
  };

  const listRepositoryProfiles = async (
    input: ListRepositoryProfilesInput,
  ): Promise<readonly RepositoryProfile[]> => {
    const limit = input.limit ?? 100;

    if (input.status === undefined) {
      return db
        .select()
        .from(repositoryProfiles)
        .where(eq(repositoryProfiles.repositoryId, input.repositoryId))
        .orderBy(asc(repositoryProfiles.createdAt))
        .limit(limit);
    }

    return db
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
  };

  const setActiveRepositoryProfileRevision = async (
    input: SetActiveRepositoryProfileRevisionInput,
  ): Promise<RepositoryProfile | null> => {
    return db.transaction(async (tx) => {
      const [revision] = await tx
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

      const [updated] = await tx
        .update(repositoryProfiles)
        .set({ activeRevisionId: input.revisionId })
        .where(eq(repositoryProfiles.id, input.repositoryProfileId))
        .returning();

      return updated ?? null;
    });
  };

  const createRepositoryProfileRevision = async (
    input: CreateRepositoryProfileRevisionInput,
  ): Promise<RepositoryProfileRevision> => {
    return db.transaction(async (tx) => {
      const [profile] = await tx
        .select({ id: repositoryProfiles.id })
        .from(repositoryProfiles)
        .where(eq(repositoryProfiles.id, input.repositoryProfileId))
        .limit(1);

      if (profile === undefined) {
        throw new Error(`Repository profile not found: ${input.repositoryProfileId}`);
      }

      const [versionRow] = await tx
        .select({
          maxVersion: sql<number>`coalesce(max(${repositoryProfileRevisions.version}), 0)`,
        })
        .from(repositoryProfileRevisions)
        .where(eq(repositoryProfileRevisions.repositoryProfileId, input.repositoryProfileId));

      const version = input.version ?? (versionRow?.maxVersion ?? 0) + 1;
      const [revision] = await tx
        .insert(repositoryProfileRevisions)
        .values({
          id: input.id,
          repositoryProfileId: input.repositoryProfileId,
          version,
          ...(input.createdByUserId === undefined
            ? {}
            : { createdByUserId: input.createdByUserId }),
          ...(input.changeSummary === undefined ? {} : { changeSummary: input.changeSummary }),
          fingerprint: input.fingerprint,
          runTemplate: input.runTemplate,
          ...(input.policyConfig === undefined ? {} : { policyConfig: input.policyConfig }),
        } satisfies NewRepositoryProfileRevision)
        .returning();

      const insertedRevision = assertInserted(
        revision,
        "Failed to create repository profile revision.",
      );

      if (input.setAsActive ?? true) {
        await tx
          .update(repositoryProfiles)
          .set({ activeRevisionId: insertedRevision.id })
          .where(eq(repositoryProfiles.id, input.repositoryProfileId));
      }

      return insertedRevision;
    });
  };

  const replaceRepositoryProfileLinks = async (
    input: ReplaceRepositoryProfileLinksInput,
  ): Promise<readonly RepositoryProfileProfileLink[]> => {
    return db.transaction(async (tx) => {
      await tx
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

      return tx
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
    });
  };

  const getRepositoryProfileRevisionBundle = async (
    revisionId: string,
  ): Promise<RepositoryProfileRevisionBundle | null> => {
    const [revision] = await db
      .select()
      .from(repositoryProfileRevisions)
      .where(eq(repositoryProfileRevisions.id, revisionId))
      .limit(1);

    if (revision === undefined) {
      return null;
    }

    const [repositoryProfile] = await db
      .select()
      .from(repositoryProfiles)
      .where(eq(repositoryProfiles.id, revision.repositoryProfileId))
      .limit(1);

    if (repositoryProfile === undefined) {
      return null;
    }

    const profileLinks = await db
      .select()
      .from(repositoryProfileProfileLinks)
      .where(eq(repositoryProfileProfileLinks.repositoryProfileRevisionId, revision.id))
      .orderBy(
        asc(repositoryProfileProfileLinks.precedence),
        asc(repositoryProfileProfileLinks.profileRevisionId),
      );

    return {
      repositoryProfile,
      revision,
      profileLinks,
    };
  };

  return {
    createRepositoryProfile,
    createRepositoryProfileRevision,
    getRepositoryById,
    getRepositoryByProviderExternalId,
    getRepositoryByProviderOwnerName,
    getRepositoryProfileRevisionBundle,
    listRepositoryProfiles,
    replaceRepositoryProfileLinks,
    setActiveRepositoryProfileRevision,
    upsertRepository,
  };
};

export type RepositoryProfileRepository = ReturnType<typeof createRepositoryProfileRepository>;
