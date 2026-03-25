import { and, asc, eq, isNull } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
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

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createGitHubInstallationRepository = (client: DatabaseClient) => {
  const { db } = client;

  const upsertInstallation = async (
    input: UpsertGitHubInstallationInput,
  ): Promise<GitHubAppInstallation> => {
    const [installation] = await db
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

    return assertInserted(installation, "Failed to upsert GitHub installation.");
  };

  const getInstallationById = async (id: string): Promise<GitHubAppInstallation | undefined> => {
    const [installation] = await db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.id, id))
      .limit(1);

    return installation;
  };

  const getInstallationByExternalId = async (
    externalInstallationId: string,
  ): Promise<GitHubAppInstallation | undefined> => {
    const [installation] = await db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.externalInstallationId, externalInstallationId))
      .limit(1);

    return installation;
  };

  const listInstallationsForUser = async (
    input: ListGitHubInstallationsForUserInput,
  ): Promise<readonly GitHubAppInstallation[]> => {
    const whereClauses = [
      eq(githubInstallationUserGrants.userId, input.userId),
      isNull(githubInstallationUserGrants.revokedAt),
      ...(input.status === undefined ? [] : [eq(githubAppInstallations.status, input.status)]),
    ];

    const rows = await db
      .select({ installation: githubAppInstallations })
      .from(githubInstallationUserGrants)
      .innerJoin(
        githubAppInstallations,
        eq(githubAppInstallations.id, githubInstallationUserGrants.installationId),
      )
      .where(and(...whereClauses))
      .orderBy(asc(githubAppInstallations.accountLogin));

    return rows.map((row) => row.installation);
  };

  const listActiveInstallations = async (): Promise<readonly GitHubAppInstallation[]> => {
    return db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.status, "active"))
      .orderBy(asc(githubAppInstallations.accountLogin));
  };

  const setInstallationStatus = async (
    input: SetGitHubInstallationStatusInput,
  ): Promise<GitHubAppInstallation | null> => {
    const [installation] = await db
      .update(githubAppInstallations)
      .set({
        status: input.status,
        ...(input.suspendedAt === undefined ? {} : { suspendedAt: input.suspendedAt }),
        ...(input.lastSyncedAt === undefined ? {} : { lastSyncedAt: input.lastSyncedAt }),
      })
      .where(eq(githubAppInstallations.id, input.installationId))
      .returning();

    return installation ?? null;
  };

  const grantInstallationToUser = async (
    input: GrantGitHubInstallationToUserInput,
  ): Promise<GitHubInstallationUserGrant> => {
    const [grant] = await db
      .insert(githubInstallationUserGrants)
      .values({
        installationId: input.installationId,
        userId: input.userId,
        ...(input.grantedByUserId === undefined ? {} : { grantedByUserId: input.grantedByUserId }),
        ...(input.grantedAt === undefined ? {} : { grantedAt: input.grantedAt }),
      } satisfies NewGitHubInstallationUserGrant)
      .onConflictDoUpdate({
        target: [githubInstallationUserGrants.installationId, githubInstallationUserGrants.userId],
        set: {
          revokedAt: null,
          ...(input.grantedByUserId === undefined
            ? {}
            : { grantedByUserId: input.grantedByUserId }),
          grantedAt: input.grantedAt ?? new Date(),
        },
      })
      .returning();

    return assertInserted(grant, "Failed to grant GitHub installation access.");
  };

  const revokeInstallationGrant = async (
    input: RevokeGitHubInstallationGrantInput,
  ): Promise<GitHubInstallationUserGrant | null> => {
    const [grant] = await db
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
  };

  const userHasInstallationGrant = async (input: {
    readonly installationId: string;
    readonly userId: string;
  }): Promise<boolean> => {
    const [grant] = await db
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
  };

  const listInstallationGrants = async (
    installationId: string,
  ): Promise<readonly GitHubInstallationUserGrant[]> => {
    return db
      .select()
      .from(githubInstallationUserGrants)
      .where(eq(githubInstallationUserGrants.installationId, installationId))
      .orderBy(asc(githubInstallationUserGrants.userId));
  };

  return {
    getInstallationByExternalId,
    getInstallationById,
    grantInstallationToUser,
    listActiveInstallations,
    listInstallationGrants,
    listInstallationsForUser,
    revokeInstallationGrant,
    setInstallationStatus,
    upsertInstallation,
    userHasInstallationGrant,
  };
};

export type GitHubInstallationRepository = ReturnType<typeof createGitHubInstallationRepository>;
