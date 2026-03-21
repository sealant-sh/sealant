import { and, asc, eq, lte, or } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
import type {
  WorkspaceBuildJobRequestPayload,
  WorkspaceBuildJobResultPayload,
} from "../payloads.js";
import {
  workspaceBuildJobs,
  type NewWorkspaceBuildJob,
  type WorkspaceBuildJob,
  type WorkspaceBuildJobStatus,
} from "../schema.js";

export interface EnqueueWorkspaceBuildJobInput {
  readonly id: string;
  readonly runId?: string;
  readonly registryId: string;
  readonly repository: string;
  readonly tag: string;
  readonly requestPayload: WorkspaceBuildJobRequestPayload;
  readonly idempotencyKey?: string;
  readonly availableAt?: Date;
  readonly maxAttempts?: number;
}

export interface ClaimNextWorkspaceBuildJobInput {
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export interface MarkWorkspaceBuildJobRunningInput {
  readonly id: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export interface ClaimWorkspaceBuildJobByIdInput {
  readonly id: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export interface MarkWorkspaceBuildJobSucceededInput {
  readonly id: string;
  readonly executorId: string;
  readonly resultPayload?: WorkspaceBuildJobResultPayload;
  readonly publishedReference: string;
  readonly publishedDigestReference: string;
  readonly publishedDigest: string;
  readonly finishedAt?: Date;
}

export interface MarkWorkspaceBuildJobFailedInput {
  readonly id: string;
  readonly errorMessage: string;
  readonly errorCode?: string;
  readonly finishedAt?: Date;
}

const requiredDate = (value: Date | undefined): Date => {
  return value ?? new Date();
};

// "Repository" here means a small database access layer, not a Git repository.
// The API and worker can both call these functions instead of re-implementing
// job queries and status transitions in multiple places.
export const createWorkspaceBuildJobRepository = (client: DatabaseClient) => {
  const { db } = client;

  const insertQueuedJob = async (
    input: EnqueueWorkspaceBuildJobInput,
  ): Promise<WorkspaceBuildJob> => {
    const [job] = await db
      .insert(workspaceBuildJobs)
      .values({
        id: input.id,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        status: "queued",
        registryId: input.registryId,
        repository: input.repository,
        tag: input.tag,
        requestPayload: input.requestPayload,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      } satisfies NewWorkspaceBuildJob)
      .returning();

    if (job === undefined) {
      throw new Error("Failed to insert workspace build job.");
    }

    return job;
  };

  const getJobById = async (id: string): Promise<WorkspaceBuildJob | undefined> => {
    const [job] = await db
      .select()
      .from(workspaceBuildJobs)
      .where(eq(workspaceBuildJobs.id, id))
      .limit(1);
    return job;
  };

  const listJobsByStatus = async (
    status: WorkspaceBuildJobStatus,
    limit = 50,
  ): Promise<Array<WorkspaceBuildJob>> => {
    return db
      .select()
      .from(workspaceBuildJobs)
      .where(eq(workspaceBuildJobs.status, status))
      .orderBy(asc(workspaceBuildJobs.createdAt))
      .limit(limit);
  };

  const claimNextQueuedJob = async (
    input: ClaimNextWorkspaceBuildJobInput,
  ): Promise<WorkspaceBuildJob | null> => {
    const now = requiredDate(input.now);
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);

    // Claiming is kept inside one transaction so the worker does not read one
    // queued job and accidentally let another worker claim the same row before
    // the status update happens.
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(workspaceBuildJobs)
        .where(
          or(
            and(eq(workspaceBuildJobs.status, "queued"), lte(workspaceBuildJobs.availableAt, now)),
            and(
              eq(workspaceBuildJobs.status, "running"),
              lte(workspaceBuildJobs.leaseExpiresAt, now),
            ),
          ),
        )
        .orderBy(asc(workspaceBuildJobs.availableAt), asc(workspaceBuildJobs.createdAt))
        .limit(1);

      if (candidate === undefined) {
        return null;
      }

      const [claimed] = await tx
        .update(workspaceBuildJobs)
        .set({
          status: "running",
          workerId: input.workerId,
          claimedAt: now,
          leaseExpiresAt,
          startedAt: candidate.startedAt ?? now,
          attemptCount: candidate.attemptCount + 1,
        })
        .where(eq(workspaceBuildJobs.id, candidate.id))
        .returning();

      return claimed ?? null;
    });
  };

  const claimJobById = async (
    input: ClaimWorkspaceBuildJobByIdInput,
  ): Promise<WorkspaceBuildJob | null> => {
    const now = requiredDate(input.now);
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);

    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(workspaceBuildJobs)
        .where(
          and(
            eq(workspaceBuildJobs.id, input.id),
            or(
              eq(workspaceBuildJobs.status, "queued"),
              and(
                eq(workspaceBuildJobs.status, "running"),
                lte(workspaceBuildJobs.leaseExpiresAt, now),
              ),
            ),
          ),
        )
        .limit(1);

      if (candidate === undefined) {
        return null;
      }

      const [claimed] = await tx
        .update(workspaceBuildJobs)
        .set({
          status: "running",
          workerId: input.workerId,
          claimedAt: now,
          leaseExpiresAt,
          startedAt: candidate.startedAt ?? now,
          attemptCount: candidate.attemptCount + 1,
        })
        .where(eq(workspaceBuildJobs.id, candidate.id))
        .returning();

      return claimed ?? null;
    });
  };

  const markJobRunning = async (
    input: MarkWorkspaceBuildJobRunningInput,
  ): Promise<WorkspaceBuildJob | null> => {
    const now = requiredDate(input.now);
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
    const [job] = await db
      .update(workspaceBuildJobs)
      .set({
        status: "running",
        workerId: input.workerId,
        claimedAt: now,
        startedAt: now,
        leaseExpiresAt,
      })
      .where(eq(workspaceBuildJobs.id, input.id))
      .returning();

    return job ?? null;
  };

  const markJobSucceeded = async (
    input: MarkWorkspaceBuildJobSucceededInput,
  ): Promise<WorkspaceBuildJob | null> => {
    const [job] = await db
      .update(workspaceBuildJobs)
      .set({
        status: "succeeded",
        executorId: input.executorId,
        ...(input.resultPayload === undefined ? {} : { resultPayload: input.resultPayload }),
        publishedReference: input.publishedReference,
        publishedDigestReference: input.publishedDigestReference,
        publishedDigest: input.publishedDigest,
        finishedAt: input.finishedAt ?? new Date(),
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
      })
      .where(eq(workspaceBuildJobs.id, input.id))
      .returning();

    return job ?? null;
  };

  const markJobFailed = async (
    input: MarkWorkspaceBuildJobFailedInput,
  ): Promise<WorkspaceBuildJob | null> => {
    const [job] = await db
      .update(workspaceBuildJobs)
      .set({
        status: "failed",
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        errorMessage: input.errorMessage,
        finishedAt: input.finishedAt ?? new Date(),
        leaseExpiresAt: null,
      })
      .where(eq(workspaceBuildJobs.id, input.id))
      .returning();

    return job ?? null;
  };

  return {
    claimJobById,
    claimNextQueuedJob,
    getJobById,
    insertQueuedJob,
    listJobsByStatus,
    markJobFailed,
    markJobRunning,
    markJobSucceeded,
  };
};

export type WorkspaceBuildJobRepository = ReturnType<typeof createWorkspaceBuildJobRepository>;
