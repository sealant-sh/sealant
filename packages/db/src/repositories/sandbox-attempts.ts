import { and, desc, eq, inArray } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
import {
  sandboxAttempts,
  sandboxAttemptSnapshots,
  type NewSandboxAttempt,
  type NewSandboxAttemptSnapshot,
  type SandboxAttempt,
  type SandboxAttemptSnapshot,
  type SandboxAttemptStatus,
  type SandboxAttemptTriggerType,
} from "../schema.js";

export interface CreateQueuedSandboxAttemptInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly repositoryId?: string;
  readonly repositoryProfileRevisionId?: string;
  readonly profileRevisionId?: string;
  readonly issueId?: string;
  readonly triggerType?: SandboxAttemptTriggerType;
  readonly triggerRef?: string;
  readonly requestedByUserId?: string;
  readonly retryOfRunId?: string;
  readonly queuedAt?: Date;
}

export interface SetSandboxAttemptSnapshotInput {
  readonly runId: string;
  readonly userSpecPayload: SandboxAttemptSnapshot["userSpecPayload"];
  readonly resolvedSpecPayload: SandboxAttemptSnapshot["resolvedSpecPayload"];
  readonly blueprintPayload: SandboxAttemptSnapshot["blueprintPayload"];
  readonly profileConfigSnapshot?: SandboxAttemptSnapshot["profileConfigSnapshot"];
  readonly repositoryProfileConfigSnapshot?: SandboxAttemptSnapshot["repositoryProfileConfigSnapshot"];
}

export interface MarkSandboxAttemptRunningInput {
  readonly id: string;
  readonly startedAt?: Date;
}

export interface MarkSandboxAttemptSucceededInput {
  readonly id: string;
  readonly finishedAt?: Date;
}

export interface MarkSandboxAttemptFailedInput {
  readonly id: string;
  readonly finishedAt?: Date;
}

export interface MarkSandboxAttemptCancelledInput {
  readonly id: string;
  readonly cancelReason: string;
  readonly finishedAt?: Date;
}

export interface ListSandboxAttemptsInput {
  readonly ownerUserId?: string;
  readonly repositoryId?: string;
  readonly issueId?: string;
  readonly statuses?: readonly SandboxAttemptStatus[];
  readonly limit?: number;
}

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createSandboxAttemptRepository = (client: DatabaseClient) => {
  const { db } = client;

  const createQueuedAttempt = async (
    input: CreateQueuedSandboxAttemptInput,
  ): Promise<SandboxAttempt> => {
    const [attempt] = await db
      .insert(sandboxAttempts)
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
        ...(input.issueId === undefined ? {} : { issueId: input.issueId }),
        ...(input.triggerType === undefined ? {} : { triggerType: input.triggerType }),
        ...(input.triggerRef === undefined ? {} : { triggerRef: input.triggerRef }),
        ...(input.requestedByUserId === undefined
          ? {}
          : { requestedByUserId: input.requestedByUserId }),
        ...(input.retryOfRunId === undefined ? {} : { retryOfRunId: input.retryOfRunId }),
        ...(input.queuedAt === undefined ? {} : { queuedAt: input.queuedAt }),
      } satisfies NewSandboxAttempt)
      .returning();

    return assertInserted(attempt, "Failed to create queued sandbox attempt.");
  };

  const getAttemptById = async (id: string): Promise<SandboxAttempt | undefined> => {
    const [attempt] = await db
      .select()
      .from(sandboxAttempts)
      .where(eq(sandboxAttempts.id, id))
      .limit(1);

    return attempt;
  };

  const getAttemptSnapshotByRunId = async (
    runId: string,
  ): Promise<SandboxAttemptSnapshot | undefined> => {
    const [snapshot] = await db
      .select()
      .from(sandboxAttemptSnapshots)
      .where(eq(sandboxAttemptSnapshots.runId, runId))
      .limit(1);

    return snapshot;
  };

  const setAttemptSnapshot = async (
    input: SetSandboxAttemptSnapshotInput,
  ): Promise<SandboxAttemptSnapshot> => {
    const [snapshot] = await db
      .insert(sandboxAttemptSnapshots)
      .values({
        runId: input.runId,
        userSpecPayload: input.userSpecPayload,
        resolvedSpecPayload: input.resolvedSpecPayload,
        blueprintPayload: input.blueprintPayload,
        ...(input.profileConfigSnapshot === undefined
          ? {}
          : { profileConfigSnapshot: input.profileConfigSnapshot }),
        ...(input.repositoryProfileConfigSnapshot === undefined
          ? {}
          : { repositoryProfileConfigSnapshot: input.repositoryProfileConfigSnapshot }),
      } satisfies NewSandboxAttemptSnapshot)
      .onConflictDoUpdate({
        target: sandboxAttemptSnapshots.runId,
        set: {
          userSpecPayload: input.userSpecPayload,
          resolvedSpecPayload: input.resolvedSpecPayload,
          blueprintPayload: input.blueprintPayload,
          ...(input.profileConfigSnapshot === undefined
            ? {}
            : { profileConfigSnapshot: input.profileConfigSnapshot }),
          ...(input.repositoryProfileConfigSnapshot === undefined
            ? {}
            : { repositoryProfileConfigSnapshot: input.repositoryProfileConfigSnapshot }),
        },
      })
      .returning();

    return assertInserted(snapshot, `Failed to set attempt snapshot for ${input.runId}.`);
  };

  const markAttemptRunning = async (
    input: MarkSandboxAttemptRunningInput,
  ): Promise<SandboxAttempt | null> => {
    const startedAt = input.startedAt ?? new Date();
    const [attempt] = await db
      .update(sandboxAttempts)
      .set({
        status: "running",
        startedAt,
      })
      .where(eq(sandboxAttempts.id, input.id))
      .returning();

    return attempt ?? null;
  };

  const finalizeAttempt = async (
    id: string,
    status: SandboxAttemptStatus,
    finishedAt: Date,
    extra: Partial<Pick<SandboxAttempt, "cancelReason">> = {},
  ): Promise<SandboxAttempt | null> => {
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(sandboxAttempts)
        .where(eq(sandboxAttempts.id, id))
        .limit(1);

      if (existing === undefined) {
        return null;
      }

      const durationMs =
        existing.startedAt === null
          ? null
          : Math.max(0, finishedAt.getTime() - existing.startedAt.getTime());

      const [updated] = await tx
        .update(sandboxAttempts)
        .set({
          status,
          finishedAt,
          durationMs,
          ...extra,
        })
        .where(eq(sandboxAttempts.id, id))
        .returning();

      return updated ?? null;
    });
  };

  const markAttemptSucceeded = async (
    input: MarkSandboxAttemptSucceededInput,
  ): Promise<SandboxAttempt | null> => {
    return finalizeAttempt(input.id, "succeeded", input.finishedAt ?? new Date());
  };

  const markAttemptFailed = async (
    input: MarkSandboxAttemptFailedInput,
  ): Promise<SandboxAttempt | null> => {
    return finalizeAttempt(input.id, "failed", input.finishedAt ?? new Date());
  };

  const markAttemptCancelled = async (
    input: MarkSandboxAttemptCancelledInput,
  ): Promise<SandboxAttempt | null> => {
    return finalizeAttempt(input.id, "cancelled", input.finishedAt ?? new Date(), {
      cancelReason: input.cancelReason,
    });
  };

  const listAttempts = async (
    input: ListSandboxAttemptsInput = {},
  ): Promise<readonly SandboxAttempt[]> => {
    const whereClauses = [
      ...(input.ownerUserId === undefined
        ? []
        : [eq(sandboxAttempts.ownerUserId, input.ownerUserId)]),
      ...(input.repositoryId === undefined
        ? []
        : [eq(sandboxAttempts.repositoryId, input.repositoryId)]),
      ...(input.issueId === undefined ? [] : [eq(sandboxAttempts.issueId, input.issueId)]),
      ...(input.statuses === undefined || input.statuses.length === 0
        ? []
        : [inArray(sandboxAttempts.status, [...input.statuses])]),
    ];

    if (whereClauses.length === 0) {
      return db
        .select()
        .from(sandboxAttempts)
        .orderBy(desc(sandboxAttempts.createdAt))
        .limit(input.limit ?? 100);
    }

    return db
      .select()
      .from(sandboxAttempts)
      .where(and(...whereClauses))
      .orderBy(desc(sandboxAttempts.createdAt))
      .limit(input.limit ?? 100);
  };

  return {
    createQueuedAttempt,
    getAttemptById,
    getAttemptSnapshotByRunId,
    listAttempts,
    markAttemptCancelled,
    markAttemptFailed,
    markAttemptRunning,
    markAttemptSucceeded,
    setAttemptSnapshot,
  };
};

export type SandboxAttemptRepository = ReturnType<typeof createSandboxAttemptRepository>;
