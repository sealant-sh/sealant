import { and, asc, desc, eq, inArray, lte, or } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
import type { NewSandbox, SandboxBuild } from "../payloads.js";
import {
  sandboxBuildJobs,
  type NewSandboxBuildJob,
  type SandboxBuildJob,
  type SandboxBuildJobStatus,
} from "../schema.js";

export interface EnqueueSandboxBuildJobInput {
  readonly id: string;
  readonly runId?: string;
  readonly registryId: string;
  readonly repository: string;
  readonly tag: string;
  readonly requestPayload: NewSandbox;
  readonly idempotencyKey?: string;
  readonly availableAt?: Date;
  readonly maxAttempts?: number;
}

export interface ClaimNextSandboxBuildJobInput {
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export interface MarkSandboxBuildJobRunningInput {
  readonly id: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export interface ClaimSandboxBuildJobByIdInput {
  readonly id: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export interface MarkSandboxBuildJobSucceededInput {
  readonly id: string;
  readonly builderId: string;
  readonly resultPayload?: SandboxBuild;
  readonly publishedReference: string;
  readonly publishedDigestReference: string;
  readonly publishedDigest: string;
  readonly finishedAt?: Date;
}

export interface MarkSandboxBuildJobFailedInput {
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
export const createSandboxBuildJobRepository = (client: DatabaseClient) => {
  const { db } = client;

  const insertQueuedJob = async (input: EnqueueSandboxBuildJobInput): Promise<SandboxBuildJob> => {
    const [job] = await db
      .insert(sandboxBuildJobs)
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
      } satisfies NewSandboxBuildJob)
      .returning();

    if (job === undefined) {
      throw new Error("Failed to insert sandbox build job.");
    }

    return job;
  };

  const getJobById = async (id: string): Promise<SandboxBuildJob | undefined> => {
    const [job] = await db
      .select()
      .from(sandboxBuildJobs)
      .where(eq(sandboxBuildJobs.id, id))
      .limit(1);
    return job;
  };

  const getJobByIdempotencyKey = async (
    idempotencyKey: string,
  ): Promise<SandboxBuildJob | undefined> => {
    const [job] = await db
      .select()
      .from(sandboxBuildJobs)
      .where(eq(sandboxBuildJobs.idempotencyKey, idempotencyKey))
      .limit(1);

    return job;
  };

  const getLatestJobByRunId = async (runId: string): Promise<SandboxBuildJob | undefined> => {
    const [job] = await db
      .select()
      .from(sandboxBuildJobs)
      .where(eq(sandboxBuildJobs.runId, runId))
      .orderBy(desc(sandboxBuildJobs.createdAt))
      .limit(1);

    return job;
  };

  const listLatestJobsByRunIds = async (
    runIds: readonly string[],
  ): Promise<ReadonlyMap<string, SandboxBuildJob>> => {
    if (runIds.length === 0) {
      return new Map();
    }

    const jobs = await db
      .select()
      .from(sandboxBuildJobs)
      .where(inArray(sandboxBuildJobs.runId, [...runIds]))
      .orderBy(desc(sandboxBuildJobs.createdAt));

    const latestJobsByRunId = new Map<string, SandboxBuildJob>();

    for (const job of jobs) {
      if (job.runId === null || latestJobsByRunId.has(job.runId)) {
        continue;
      }

      latestJobsByRunId.set(job.runId, job);
    }

    return latestJobsByRunId;
  };

  const listJobsByStatus = async (
    status: SandboxBuildJobStatus,
    limit = 50,
  ): Promise<Array<SandboxBuildJob>> => {
    return db
      .select()
      .from(sandboxBuildJobs)
      .where(eq(sandboxBuildJobs.status, status))
      .orderBy(asc(sandboxBuildJobs.createdAt))
      .limit(limit);
  };

  const claimNextQueuedJob = async (
    input: ClaimNextSandboxBuildJobInput,
  ): Promise<SandboxBuildJob | null> => {
    const now = requiredDate(input.now);
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);

    // Claiming is kept inside one transaction so the worker does not read one
    // queued job and accidentally let another worker claim the same row before
    // the status update happens.
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(sandboxBuildJobs)
        .where(
          or(
            and(eq(sandboxBuildJobs.status, "queued"), lte(sandboxBuildJobs.availableAt, now)),
            and(eq(sandboxBuildJobs.status, "running"), lte(sandboxBuildJobs.leaseExpiresAt, now)),
          ),
        )
        .orderBy(asc(sandboxBuildJobs.availableAt), asc(sandboxBuildJobs.createdAt))
        .limit(1);

      if (candidate === undefined) {
        return null;
      }

      const [claimed] = await tx
        .update(sandboxBuildJobs)
        .set({
          status: "running",
          workerId: input.workerId,
          claimedAt: now,
          leaseExpiresAt,
          startedAt: candidate.startedAt ?? now,
          attemptCount: candidate.attemptCount + 1,
        })
        .where(eq(sandboxBuildJobs.id, candidate.id))
        .returning();

      return claimed ?? null;
    });
  };

  const claimJobById = async (
    input: ClaimSandboxBuildJobByIdInput,
  ): Promise<SandboxBuildJob | null> => {
    const now = requiredDate(input.now);
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);

    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(sandboxBuildJobs)
        .where(
          and(
            eq(sandboxBuildJobs.id, input.id),
            or(
              eq(sandboxBuildJobs.status, "queued"),
              and(
                eq(sandboxBuildJobs.status, "running"),
                lte(sandboxBuildJobs.leaseExpiresAt, now),
              ),
            ),
          ),
        )
        .limit(1);

      if (candidate === undefined) {
        return null;
      }

      const [claimed] = await tx
        .update(sandboxBuildJobs)
        .set({
          status: "running",
          workerId: input.workerId,
          claimedAt: now,
          leaseExpiresAt,
          startedAt: candidate.startedAt ?? now,
          attemptCount: candidate.attemptCount + 1,
        })
        .where(eq(sandboxBuildJobs.id, candidate.id))
        .returning();

      return claimed ?? null;
    });
  };

  const markJobRunning = async (
    input: MarkSandboxBuildJobRunningInput,
  ): Promise<SandboxBuildJob | null> => {
    const now = requiredDate(input.now);
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
    const [job] = await db
      .update(sandboxBuildJobs)
      .set({
        status: "running",
        workerId: input.workerId,
        claimedAt: now,
        startedAt: now,
        leaseExpiresAt,
      })
      .where(eq(sandboxBuildJobs.id, input.id))
      .returning();

    return job ?? null;
  };

  const markJobSucceeded = async (
    input: MarkSandboxBuildJobSucceededInput,
  ): Promise<SandboxBuildJob | null> => {
    const [job] = await db
      .update(sandboxBuildJobs)
      .set({
        status: "succeeded",
        builderId: input.builderId,
        ...(input.resultPayload === undefined ? {} : { resultPayload: input.resultPayload }),
        publishedReference: input.publishedReference,
        publishedDigestReference: input.publishedDigestReference,
        publishedDigest: input.publishedDigest,
        finishedAt: input.finishedAt ?? new Date(),
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
      })
      .where(eq(sandboxBuildJobs.id, input.id))
      .returning();

    return job ?? null;
  };

  const markJobFailed = async (
    input: MarkSandboxBuildJobFailedInput,
  ): Promise<SandboxBuildJob | null> => {
    const [job] = await db
      .update(sandboxBuildJobs)
      .set({
        status: "failed",
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        errorMessage: input.errorMessage,
        finishedAt: input.finishedAt ?? new Date(),
        leaseExpiresAt: null,
      })
      .where(eq(sandboxBuildJobs.id, input.id))
      .returning();

    return job ?? null;
  };

  return {
    claimJobById,
    claimNextQueuedJob,
    getJobById,
    getJobByIdempotencyKey,
    getLatestJobByRunId,
    insertQueuedJob,
    listLatestJobsByRunIds,
    listJobsByStatus,
    markJobFailed,
    markJobRunning,
    markJobSucceeded,
  };
};

export type SandboxBuildJobRepository = ReturnType<typeof createSandboxBuildJobRepository>;
