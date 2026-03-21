import { and, desc, eq, inArray } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
import {
  runInputSnapshots,
  workspaceRuns,
  type NewRunInputSnapshot,
  type NewWorkspaceRun,
  type RunInputSnapshot,
  type WorkspaceRun,
  type WorkspaceRunStatus,
  type WorkspaceRunTriggerType,
} from "../schema.js";

export interface CreateQueuedWorkspaceRunInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly repositoryId?: string;
  readonly repositoryProfileRevisionId?: string;
  readonly profileRevisionId?: string;
  readonly issueId?: string;
  readonly triggerType?: WorkspaceRunTriggerType;
  readonly triggerRef?: string;
  readonly requestedByUserId?: string;
  readonly retryOfRunId?: string;
  readonly queuedAt?: Date;
}

export interface SetRunInputSnapshotInput {
  readonly runId: string;
  readonly userSpecPayload: RunInputSnapshot["userSpecPayload"];
  readonly resolvedSpecPayload: RunInputSnapshot["resolvedSpecPayload"];
  readonly blueprintPayload: RunInputSnapshot["blueprintPayload"];
  readonly profileConfigSnapshot?: RunInputSnapshot["profileConfigSnapshot"];
  readonly repositoryProfileConfigSnapshot?: RunInputSnapshot["repositoryProfileConfigSnapshot"];
}

export interface MarkWorkspaceRunRunningInput {
  readonly id: string;
  readonly startedAt?: Date;
}

export interface MarkWorkspaceRunSucceededInput {
  readonly id: string;
  readonly finishedAt?: Date;
}

export interface MarkWorkspaceRunFailedInput {
  readonly id: string;
  readonly finishedAt?: Date;
}

export interface MarkWorkspaceRunCancelledInput {
  readonly id: string;
  readonly cancelReason: string;
  readonly finishedAt?: Date;
}

export interface ListWorkspaceRunsInput {
  readonly ownerUserId?: string;
  readonly repositoryId?: string;
  readonly issueId?: string;
  readonly statuses?: readonly WorkspaceRunStatus[];
  readonly limit?: number;
}

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createWorkspaceRunRepository = (client: DatabaseClient) => {
  const { db } = client;

  const createQueuedRun = async (input: CreateQueuedWorkspaceRunInput): Promise<WorkspaceRun> => {
    const [run] = await db
      .insert(workspaceRuns)
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
      } satisfies NewWorkspaceRun)
      .returning();

    return assertInserted(run, "Failed to create queued workspace run.");
  };

  const getRunById = async (id: string): Promise<WorkspaceRun | undefined> => {
    const [run] = await db.select().from(workspaceRuns).where(eq(workspaceRuns.id, id)).limit(1);
    return run;
  };

  const setRunInputSnapshot = async (
    input: SetRunInputSnapshotInput,
  ): Promise<RunInputSnapshot> => {
    const [snapshot] = await db
      .insert(runInputSnapshots)
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
      } satisfies NewRunInputSnapshot)
      .onConflictDoUpdate({
        target: runInputSnapshots.runId,
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

    return assertInserted(snapshot, `Failed to set run input snapshot for run ${input.runId}.`);
  };

  const markRunRunning = async (
    input: MarkWorkspaceRunRunningInput,
  ): Promise<WorkspaceRun | null> => {
    const startedAt = input.startedAt ?? new Date();
    const [run] = await db
      .update(workspaceRuns)
      .set({
        status: "running",
        startedAt,
      })
      .where(eq(workspaceRuns.id, input.id))
      .returning();

    return run ?? null;
  };

  const finalizeRun = async (
    id: string,
    status: WorkspaceRunStatus,
    finishedAt: Date,
    extra: Partial<Pick<WorkspaceRun, "cancelReason">> = {},
  ): Promise<WorkspaceRun | null> => {
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(workspaceRuns)
        .where(eq(workspaceRuns.id, id))
        .limit(1);

      if (existing === undefined) {
        return null;
      }

      const durationMs =
        existing.startedAt === null
          ? null
          : Math.max(0, finishedAt.getTime() - existing.startedAt.getTime());

      const [updated] = await tx
        .update(workspaceRuns)
        .set({
          status,
          finishedAt,
          durationMs,
          ...extra,
        })
        .where(eq(workspaceRuns.id, id))
        .returning();

      return updated ?? null;
    });
  };

  const markRunSucceeded = async (
    input: MarkWorkspaceRunSucceededInput,
  ): Promise<WorkspaceRun | null> => {
    return finalizeRun(input.id, "succeeded", input.finishedAt ?? new Date());
  };

  const markRunFailed = async (
    input: MarkWorkspaceRunFailedInput,
  ): Promise<WorkspaceRun | null> => {
    return finalizeRun(input.id, "failed", input.finishedAt ?? new Date());
  };

  const markRunCancelled = async (
    input: MarkWorkspaceRunCancelledInput,
  ): Promise<WorkspaceRun | null> => {
    return finalizeRun(input.id, "cancelled", input.finishedAt ?? new Date(), {
      cancelReason: input.cancelReason,
    });
  };

  const listRuns = async (input: ListWorkspaceRunsInput = {}): Promise<readonly WorkspaceRun[]> => {
    const whereClauses = [
      ...(input.ownerUserId === undefined
        ? []
        : [eq(workspaceRuns.ownerUserId, input.ownerUserId)]),
      ...(input.repositoryId === undefined
        ? []
        : [eq(workspaceRuns.repositoryId, input.repositoryId)]),
      ...(input.issueId === undefined ? [] : [eq(workspaceRuns.issueId, input.issueId)]),
      ...(input.statuses === undefined || input.statuses.length === 0
        ? []
        : [inArray(workspaceRuns.status, [...input.statuses])]),
    ];

    if (whereClauses.length === 0) {
      return db
        .select()
        .from(workspaceRuns)
        .orderBy(desc(workspaceRuns.createdAt))
        .limit(input.limit ?? 100);
    }

    return db
      .select()
      .from(workspaceRuns)
      .where(and(...whereClauses))
      .orderBy(desc(workspaceRuns.createdAt))
      .limit(input.limit ?? 100);
  };

  return {
    createQueuedRun,
    getRunById,
    listRuns,
    markRunCancelled,
    markRunFailed,
    markRunRunning,
    markRunSucceeded,
    setRunInputSnapshot,
  };
};

export type WorkspaceRunRepository = ReturnType<typeof createWorkspaceRunRepository>;
