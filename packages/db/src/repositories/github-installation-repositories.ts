import { and, asc, eq, isNull, like } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
import {
  githubAppInstallations,
  githubInstallationRepositories,
  githubInstallationUserGrants,
  type GitHubInstallationRepository,
  type NewGitHubInstallationRepository,
} from "../schema.js";

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

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createGitHubInstallationRepositoryCacheRepository = (client: DatabaseClient) => {
  const { db } = client;

  const upsertInstallationRepository = async (
    input: UpsertGitHubInstallationRepositoryInput,
  ): Promise<GitHubInstallationRepository> => {
    const fullName = input.fullName ?? `${input.owner}/${input.name}`;
    const [record] = await db
      .insert(githubInstallationRepositories)
      .values({
        id: input.id,
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        externalRepositoryId: input.externalRepositoryId,
        owner: input.owner,
        name: input.name,
        fullName,
        ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
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
          ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
          ...(input.isPrivate === undefined ? {} : { isPrivate: input.isPrivate }),
          ...(input.isArchived === undefined ? {} : { isArchived: input.isArchived }),
          ...(input.pushedAt === undefined ? {} : { pushedAt: input.pushedAt }),
          ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
          removedAt: input.removedAt ?? null,
        },
      })
      .returning();

    return assertInserted(record, "Failed to upsert GitHub installation repository.");
  };

  const markInstallationRepositoriesRemoved = async (input: {
    readonly installationId: string;
    readonly preservedExternalRepositoryIds: readonly string[];
    readonly removedAt?: Date;
  }): Promise<number> => {
    const activeRows = await db
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
      .filter((row) => !input.preservedExternalRepositoryIds.includes(row.externalRepositoryId))
      .map((row) => row.id);

    if (staleIds.length === 0) {
      return 0;
    }

    const updated = await Promise.all(
      staleIds.map(async (id) => {
        const [row] = await db
          .update(githubInstallationRepositories)
          .set({ removedAt: input.removedAt ?? new Date() })
          .where(eq(githubInstallationRepositories.id, id))
          .returning({ id: githubInstallationRepositories.id });

        return row;
      }),
    );

    return updated.filter((row) => row !== undefined).length;
  };

  const listRepositoriesForInstallation = async (
    input: ListGitHubInstallationRepositoriesInput,
  ): Promise<readonly GitHubInstallationRepository[]> => {
    const whereClauses = [
      eq(githubInstallationRepositories.installationId, input.installationId),
      ...(input.includeRemoved ? [] : [isNull(githubInstallationRepositories.removedAt)]),
      ...(input.search === undefined || input.search.trim().length === 0
        ? []
        : [like(githubInstallationRepositories.fullName, `%${input.search.trim()}%`)]),
    ];

    return db
      .select()
      .from(githubInstallationRepositories)
      .where(and(...whereClauses))
      .orderBy(asc(githubInstallationRepositories.fullName));
  };

  const listRepositoriesForUser = async (
    input: ListGitHubRepositoriesForUserInput,
  ): Promise<readonly GitHubInstallationRepository[]> => {
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
        : [like(githubInstallationRepositories.fullName, `%${input.search.trim()}%`)]),
    ];

    const rows = await db
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

    return rows.map((row) => row.installationRepository);
  };

  const getInstallationRepositoryById = async (
    id: string,
  ): Promise<GitHubInstallationRepository | undefined> => {
    const [record] = await db
      .select()
      .from(githubInstallationRepositories)
      .where(eq(githubInstallationRepositories.id, id))
      .limit(1);

    return record;
  };

  const getInstallationRepositoryByRepoId = async (input: {
    readonly installationId: string;
    readonly repositoryId: string;
  }): Promise<GitHubInstallationRepository | undefined> => {
    const [record] = await db
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
  };

  const getInstallationRepositoryByExternalRepoId = async (input: {
    readonly installationId: string;
    readonly externalRepositoryId: string;
  }): Promise<GitHubInstallationRepository | undefined> => {
    const [record] = await db
      .select()
      .from(githubInstallationRepositories)
      .where(
        and(
          eq(githubInstallationRepositories.installationId, input.installationId),
          eq(githubInstallationRepositories.externalRepositoryId, input.externalRepositoryId),
        ),
      )
      .limit(1);

    return record;
  };

  return {
    getInstallationRepositoryByExternalRepoId,
    getInstallationRepositoryById,
    getInstallationRepositoryByRepoId,
    listRepositoriesForInstallation,
    listRepositoriesForUser,
    markInstallationRepositoriesRemoved,
    upsertInstallationRepository,
  };
};

export type GitHubInstallationRepositoryCacheRepository = ReturnType<
  typeof createGitHubInstallationRepositoryCacheRepository
>;
