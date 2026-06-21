import type { NewSandbox } from "@sealant/validators";
import { and, asc, desc, eq, inArray, lte, or } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
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
  readonly resultPayload?: NonNullable<SandboxBuildJob["resultPayload"]>;
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

/** @deprecated Use SandboxBuildJobRepo + SandboxBuildJobRepoLive instead. */
export const createSandboxBuildJobRepository = (): never => {
  throw new Error("createSandboxBuildJobRepository is disabled during the Effect transition.");
};

/** @deprecated Use SandboxBuildJobRepoService instead. */
export type SandboxBuildJobRepository = SandboxBuildJobRepoService;

const sandboxBuildJobRepoOperationSchema = Schema.Literals([
  "claimJobById",
  "claimNextQueuedJob",
  "getJobById",
  "getJobByIdempotencyKey",
  "getLatestJobByRunId",
  "insertQueuedJob",
  "listJobsByStatus",
  "listLatestJobsByRunIds",
  "markJobFailed",
  "markJobRunning",
  "markJobSucceeded",
]);

export class SandboxBuildJobRepoInvariantError extends Schema.TaggedErrorClass<SandboxBuildJobRepoInvariantError>()("SandboxBuildJobRepoInvariantError", {
  operation: sandboxBuildJobRepoOperationSchema,
  message: Schema.String,
}) {}

export class SandboxBuildJobRepoUnexpectedError extends Schema.TaggedErrorClass<SandboxBuildJobRepoUnexpectedError>()("SandboxBuildJobRepoUnexpectedError", {
  operation: sandboxBuildJobRepoOperationSchema,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const sandboxBuildJobRepoErrorSchema = Schema.Union([
  SandboxBuildJobRepoInvariantError,
  SandboxBuildJobRepoUnexpectedError,
]);

export type SandboxBuildJobRepoError = typeof sandboxBuildJobRepoErrorSchema.Type;

type SandboxBuildJobRepoOperation = typeof sandboxBuildJobRepoOperationSchema.Type;

const mapSandboxBuildJobRepoError = (
  operation: SandboxBuildJobRepoOperation,
  cause: unknown,
): SandboxBuildJobRepoError => {
  if (
    cause instanceof SandboxBuildJobRepoInvariantError ||
    cause instanceof SandboxBuildJobRepoUnexpectedError
  ) {
    return cause;
  }

  return new SandboxBuildJobRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withSandboxBuildJobRepoError = <A>(
  operation: SandboxBuildJobRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, SandboxBuildJobRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapSandboxBuildJobRepoError(operation, cause)));
};

export interface SandboxBuildJobRepoService {
  readonly insertQueuedJob: (
    input: EnqueueSandboxBuildJobInput,
  ) => Effect.Effect<SandboxBuildJob, SandboxBuildJobRepoError>;
  readonly getJobById: (
    id: string,
  ) => Effect.Effect<SandboxBuildJob | undefined, SandboxBuildJobRepoError>;
  readonly getJobByIdempotencyKey: (
    idempotencyKey: string,
  ) => Effect.Effect<SandboxBuildJob | undefined, SandboxBuildJobRepoError>;
  readonly getLatestJobByRunId: (
    runId: string,
  ) => Effect.Effect<SandboxBuildJob | undefined, SandboxBuildJobRepoError>;
  readonly listLatestJobsByRunIds: (
    runIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, SandboxBuildJob>, SandboxBuildJobRepoError>;
  readonly listJobsByStatus: (
    status: SandboxBuildJobStatus,
    limit?: number,
  ) => Effect.Effect<Array<SandboxBuildJob>, SandboxBuildJobRepoError>;
  readonly claimNextQueuedJob: (
    input: ClaimNextSandboxBuildJobInput,
  ) => Effect.Effect<SandboxBuildJob | null, SandboxBuildJobRepoError>;
  readonly claimJobById: (
    input: ClaimSandboxBuildJobByIdInput,
  ) => Effect.Effect<SandboxBuildJob | null, SandboxBuildJobRepoError>;
  readonly markJobRunning: (
    input: MarkSandboxBuildJobRunningInput,
  ) => Effect.Effect<SandboxBuildJob | null, SandboxBuildJobRepoError>;
  readonly markJobSucceeded: (
    input: MarkSandboxBuildJobSucceededInput,
  ) => Effect.Effect<SandboxBuildJob | null, SandboxBuildJobRepoError>;
  readonly markJobFailed: (
    input: MarkSandboxBuildJobFailedInput,
  ) => Effect.Effect<SandboxBuildJob | null, SandboxBuildJobRepoError>;
}

export class SandboxBuildJobRepo extends Context.Service<
  SandboxBuildJobRepo,
  SandboxBuildJobRepoService
>()("SandboxBuildJobRepo") {}

export const SandboxBuildJobRepoLive = Layer.effect(
  SandboxBuildJobRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      insertQueuedJob: (input) =>
        withSandboxBuildJobRepoError(
          "insertQueuedJob",
          Effect.gen(function* () {
            const [job] = yield* db
              .insert(sandboxBuildJobs)
              .values({
                id: input.id,
                ...(input.runId === undefined ? {} : { runId: input.runId }),
                status: "queued",
                registryId: input.registryId,
                repository: input.repository,
                tag: input.tag,
                requestPayload: input.requestPayload,
                ...(input.idempotencyKey === undefined
                  ? {}
                  : { idempotencyKey: input.idempotencyKey }),
                ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
                ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
              } satisfies NewSandboxBuildJob)
              .returning();

            if (job === undefined) {
              return yield* new SandboxBuildJobRepoInvariantError({
                operation: "insertQueuedJob",
                message: "Failed to insert sandbox build job.",
              });
            }

            return job;
          }),
        ),

      getJobById: (id) =>
        withSandboxBuildJobRepoError(
          "getJobById",
          Effect.gen(function* () {
            const [job] = yield* db
              .select()
              .from(sandboxBuildJobs)
              .where(eq(sandboxBuildJobs.id, id))
              .limit(1);

            return job;
          }),
        ),

      getJobByIdempotencyKey: (idempotencyKey) =>
        withSandboxBuildJobRepoError(
          "getJobByIdempotencyKey",
          Effect.gen(function* () {
            const [job] = yield* db
              .select()
              .from(sandboxBuildJobs)
              .where(eq(sandboxBuildJobs.idempotencyKey, idempotencyKey))
              .limit(1);

            return job;
          }),
        ),

      getLatestJobByRunId: (runId) =>
        withSandboxBuildJobRepoError(
          "getLatestJobByRunId",
          Effect.gen(function* () {
            const [job] = yield* db
              .select()
              .from(sandboxBuildJobs)
              .where(eq(sandboxBuildJobs.runId, runId))
              .orderBy(desc(sandboxBuildJobs.createdAt))
              .limit(1);

            return job;
          }),
        ),

      listLatestJobsByRunIds: (runIds) =>
        withSandboxBuildJobRepoError(
          "listLatestJobsByRunIds",
          Effect.gen(function* () {
            if (runIds.length === 0) {
              return new Map();
            }

            const jobs = yield* db
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
          }),
        ),

      listJobsByStatus: (status, limit = 50) =>
        withSandboxBuildJobRepoError(
          "listJobsByStatus",
          db
            .select()
            .from(sandboxBuildJobs)
            .where(eq(sandboxBuildJobs.status, status))
            .orderBy(asc(sandboxBuildJobs.createdAt))
            .limit(limit)
            .pipe(Effect.map((jobs) => [...jobs])),
        ),

      claimNextQueuedJob: (input) =>
        withSandboxBuildJobRepoError(
          "claimNextQueuedJob",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const now = requiredDate(input.now);
              const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);

              const [candidate] = yield* tx
                .select()
                .from(sandboxBuildJobs)
                .where(
                  or(
                    and(
                      eq(sandboxBuildJobs.status, "queued"),
                      lte(sandboxBuildJobs.availableAt, now),
                    ),
                    and(
                      eq(sandboxBuildJobs.status, "running"),
                      lte(sandboxBuildJobs.leaseExpiresAt, now),
                    ),
                  ),
                )
                .orderBy(asc(sandboxBuildJobs.availableAt), asc(sandboxBuildJobs.createdAt))
                .limit(1);

              if (candidate === undefined) {
                return null;
              }

              const [claimed] = yield* tx
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
            }),
          ),
        ),

      claimJobById: (input) =>
        withSandboxBuildJobRepoError(
          "claimJobById",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const now = requiredDate(input.now);
              const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);

              const [candidate] = yield* tx
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

              const [claimed] = yield* tx
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
            }),
          ),
        ),

      markJobRunning: (input) =>
        withSandboxBuildJobRepoError(
          "markJobRunning",
          Effect.gen(function* () {
            const now = requiredDate(input.now);
            const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);

            const [job] = yield* db
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
          }),
        ),

      markJobSucceeded: (input) =>
        withSandboxBuildJobRepoError(
          "markJobSucceeded",
          Effect.gen(function* () {
            const [job] = yield* db
              .update(sandboxBuildJobs)
              .set({
                status: "succeeded",
                builderId: input.builderId,
                ...(input.resultPayload === undefined
                  ? {}
                  : { resultPayload: input.resultPayload }),
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
          }),
        ),

      markJobFailed: (input) =>
        withSandboxBuildJobRepoError(
          "markJobFailed",
          Effect.gen(function* () {
            const [job] = yield* db
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
          }),
        ),
    } satisfies SandboxBuildJobRepoService;
  }),
);
