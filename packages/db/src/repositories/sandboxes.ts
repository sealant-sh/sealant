import { and, desc, eq, inArray } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
import {
  sandboxRunLinks,
  sandboxes,
  type NewSandbox,
  type NewSandboxRunLink,
  type Sandbox,
  type SandboxRunLink,
  type SandboxRunLinkRelation,
  type SandboxStatus,
} from "../schema.js";

export interface CreateSandboxInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly repositoryId?: string;
  readonly repositoryProfileRevisionId?: string;
  readonly profileRevisionId?: string;
  readonly requestedByUserId?: string;
  readonly status?: SandboxStatus;
}

export interface ListSandboxesInput {
  readonly ownerUserId?: string;
  readonly repositoryId?: string;
  readonly statuses?: readonly SandboxStatus[];
  readonly limit?: number;
}

export interface SetSandboxStatusInput {
  readonly id: string;
  readonly status: SandboxStatus;
}

export interface LinkSandboxAttemptInput {
  readonly sandboxId: string;
  readonly attemptId: string;
  readonly relation?: SandboxRunLinkRelation;
  readonly linkedAt?: Date;
}

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createSandboxRepository = (client: DatabaseClient) => {
  const { db } = client;

  const createSandbox = async (input: CreateSandboxInput): Promise<Sandbox> => {
    const [sandbox] = await db
      .insert(sandboxes)
      .values({
        id: input.id,
        ownerUserId: input.ownerUserId,
        ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
        ...(input.repositoryProfileRevisionId === undefined
          ? {}
          : { repositoryProfileRevisionId: input.repositoryProfileRevisionId }),
        ...(input.profileRevisionId === undefined
          ? {}
          : { profileRevisionId: input.profileRevisionId }),
        ...(input.requestedByUserId === undefined
          ? {}
          : { requestedByUserId: input.requestedByUserId }),
        ...(input.status === undefined ? {} : { status: input.status }),
      } satisfies NewSandbox)
      .returning();

    return assertInserted(sandbox, "Failed to create sandbox.");
  };

  const getSandboxById = async (id: string): Promise<Sandbox | undefined> => {
    const [sandbox] = await db.select().from(sandboxes).where(eq(sandboxes.id, id)).limit(1);
    return sandbox;
  };

  const listSandboxes = async (input: ListSandboxesInput = {}): Promise<readonly Sandbox[]> => {
    const whereClauses = [
      ...(input.ownerUserId === undefined ? [] : [eq(sandboxes.ownerUserId, input.ownerUserId)]),
      ...(input.repositoryId === undefined ? [] : [eq(sandboxes.repositoryId, input.repositoryId)]),
      ...(input.statuses === undefined || input.statuses.length === 0
        ? []
        : [inArray(sandboxes.status, [...input.statuses])]),
    ];

    if (whereClauses.length === 0) {
      return db
        .select()
        .from(sandboxes)
        .orderBy(desc(sandboxes.createdAt))
        .limit(input.limit ?? 100);
    }

    return db
      .select()
      .from(sandboxes)
      .where(and(...whereClauses))
      .orderBy(desc(sandboxes.createdAt))
      .limit(input.limit ?? 100);
  };

  const setSandboxStatus = async (input: SetSandboxStatusInput): Promise<Sandbox | null> => {
    const [sandbox] = await db
      .update(sandboxes)
      .set({ status: input.status })
      .where(eq(sandboxes.id, input.id))
      .returning();

    return sandbox ?? null;
  };

  const linkSandboxAttempt = async (input: LinkSandboxAttemptInput): Promise<SandboxRunLink> => {
    return db.transaction(async (tx) => {
      const [link] = await tx
        .insert(sandboxRunLinks)
        .values({
          sandboxId: input.sandboxId,
          runId: input.attemptId,
          ...(input.relation === undefined ? {} : { relation: input.relation }),
          ...(input.linkedAt === undefined ? {} : { linkedAt: input.linkedAt }),
        } satisfies NewSandboxRunLink)
        .onConflictDoUpdate({
          target: [sandboxRunLinks.sandboxId, sandboxRunLinks.runId],
          set: {
            relation: input.relation ?? "launch",
            linkedAt: input.linkedAt ?? new Date(),
          },
        })
        .returning();

      const insertedLink = assertInserted(link, "Failed to link sandbox attempt.");

      await tx
        .update(sandboxes)
        .set({ latestRunId: insertedLink.runId })
        .where(eq(sandboxes.id, insertedLink.sandboxId));

      return insertedLink;
    });
  };

  const listSandboxAttemptLinks = async (
    sandboxId: string,
    limit = 100,
  ): Promise<readonly SandboxRunLink[]> => {
    return db
      .select()
      .from(sandboxRunLinks)
      .where(eq(sandboxRunLinks.sandboxId, sandboxId))
      .orderBy(desc(sandboxRunLinks.linkedAt))
      .limit(limit);
  };

  return {
    createSandbox,
    getSandboxById,
    linkSandboxAttempt,
    listSandboxes,
    listSandboxAttemptLinks,
    setSandboxStatus,
  };
};

export type SandboxRepository = ReturnType<typeof createSandboxRepository>;
