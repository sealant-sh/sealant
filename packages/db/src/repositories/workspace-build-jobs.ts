import type { NewWorkspace } from "@sealant/validators";
import { and, asc, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  workspaceBuildJobs,
  type NewWorkspaceBuildJob,
  type WorkspaceBuildJob,
  type WorkspaceBuildJobProgress,
  type WorkspaceBuildJobStatus,
} from "../schema.js";

/** One succeeded publish, as the image retention sweep sees it. */
export interface PublishedWorkspaceImage {
  readonly jobId: string;
  readonly runId: string | null;
  readonly registryId: string;
  /** The `<repository>:<tag>` (or `<registry>/<repository>:<tag>`) the image was published as. */
  readonly publishedReference: string;
  /** The repository the client asked for; the fallback when the reference carries no tag. */
  readonly repository: string;
  readonly digest: string;
  readonly planHash: string | null;
  readonly publishedAt: Date;
}

export interface EnqueueWorkspaceBuildJobInput {
  readonly id: string;
  readonly runId?: string;
  readonly registryId: string;
  readonly repository: string;
  readonly tag: string;
  readonly requestPayload: NewWorkspace;
  /** Sealed (encrypted) `secretEnv` JSON; cleared by `clearSecretEnv` after launch. */
  readonly secretEnvSealed?: string;
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

/**
 * The claim a worker holds on a job: who claimed it and which claim (each claim increments
 * `attemptCount`). A lease can expire under a slow build and another worker claim the job; the
 * claim is what tells the two apart.
 */
export interface WorkspaceBuildJobClaim {
  readonly workerId: string;
  readonly attemptCount: number;
}

export interface MarkWorkspaceBuildJobSucceededInput {
  readonly id: string;
  /**
   * The claim this success is made under. The write lands only while the job is still `running`
   * under exactly this claim, so a claimant whose lease expired and was taken over can never also
   * commit success and go on to launch the same run a second time (review 5 #1): its call answers
   * `null`.
   */
  readonly claim: WorkspaceBuildJobClaim;
  readonly builderId: string;
  readonly resultPayload?: NonNullable<WorkspaceBuildJob["resultPayload"]>;
  readonly publishedReference: string;
  readonly publishedDigestReference: string;
  readonly publishedDigest: string;
  readonly finishedAt?: Date;
}

export interface RecordWorkspaceBuildJobProgressInput {
  readonly id: string;
  /** Fenced like success: written only while the job is `running` under exactly this claim. */
  readonly claim: WorkspaceBuildJobClaim;
  /** The build's progress; absent renews the lease alone (the build is alive, and quiet). */
  readonly progress?: WorkspaceBuildJobProgress;
  /**
   * The claim's lease is renewed by this much from now: a build that keeps moving keeps its
   * claim, however long it takes, and only a build that stops moving lets it lapse.
   */
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export interface MarkWorkspaceBuildJobFailedInput {
  readonly id: string;
  /**
   * The claim this failure is reported under, when a worker's build failed. Fenced like success:
   * the write lands only while the job is still `running` under exactly this claim, so a claimant
   * whose lease expired and was taken over never marks its successor's job failed (review 6 #8);
   * its call answers `null`. Absent (the API failing a job it never claimed): unfenced.
   */
  readonly claim?: WorkspaceBuildJobClaim;
  readonly errorMessage: string;
  readonly errorCode?: string;
  readonly finishedAt?: Date;
}

const requiredDate = (value: Date | undefined): Date => {
  return value ?? new Date();
};

/** @deprecated Use WorkspaceBuildJobRepo + WorkspaceBuildJobRepoLive instead. */
export const createWorkspaceBuildJobRepository = (): never => {
  throw new Error("createWorkspaceBuildJobRepository is disabled during the Effect transition.");
};

/** @deprecated Use WorkspaceBuildJobRepoService instead. */
export type WorkspaceBuildJobRepository = WorkspaceBuildJobRepoService;

const workspaceBuildJobRepoOperationSchema = Schema.Literals([
  "claimJobById",
  "claimNextQueuedJob",
  "clearSecretEnv",
  "getJobById",
  "getJobByIdempotencyKey",
  "getLatestJobByRunId",
  "getLatestSucceededJobByPlanHash",
  "insertQueuedJob",
  "listJobsByStatus",
  "listLatestJobsByRunIds",
  "listPublishedImages",
  "markJobFailed",
  "markJobRunning",
  "markJobSucceeded",
  "recordJobProgress",
  "cancelUnbuiltJob",
]);

export class WorkspaceBuildJobRepoInvariantError extends Schema.TaggedErrorClass<WorkspaceBuildJobRepoInvariantError>()(
  "WorkspaceBuildJobRepoInvariantError",
  {
    operation: workspaceBuildJobRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class WorkspaceBuildJobRepoUnexpectedError extends Schema.TaggedErrorClass<WorkspaceBuildJobRepoUnexpectedError>()(
  "WorkspaceBuildJobRepoUnexpectedError",
  {
    operation: workspaceBuildJobRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const workspaceBuildJobRepoErrorSchema = Schema.Union([
  WorkspaceBuildJobRepoInvariantError,
  WorkspaceBuildJobRepoUnexpectedError,
]);

export type WorkspaceBuildJobRepoError = typeof workspaceBuildJobRepoErrorSchema.Type;

type WorkspaceBuildJobRepoOperation = typeof workspaceBuildJobRepoOperationSchema.Type;

const mapWorkspaceBuildJobRepoError = (
  operation: WorkspaceBuildJobRepoOperation,
  cause: unknown,
): WorkspaceBuildJobRepoError => {
  if (
    cause instanceof WorkspaceBuildJobRepoInvariantError ||
    cause instanceof WorkspaceBuildJobRepoUnexpectedError
  ) {
    return cause;
  }

  return new WorkspaceBuildJobRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withWorkspaceBuildJobRepoError = <A>(
  operation: WorkspaceBuildJobRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, WorkspaceBuildJobRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapWorkspaceBuildJobRepoError(operation, cause)));
};

export interface WorkspaceBuildJobRepoService {
  readonly insertQueuedJob: (
    input: EnqueueWorkspaceBuildJobInput,
  ) => Effect.Effect<WorkspaceBuildJob, WorkspaceBuildJobRepoError>;
  readonly getJobById: (
    id: string,
  ) => Effect.Effect<WorkspaceBuildJob | undefined, WorkspaceBuildJobRepoError>;
  readonly getJobByIdempotencyKey: (
    idempotencyKey: string,
  ) => Effect.Effect<WorkspaceBuildJob | undefined, WorkspaceBuildJobRepoError>;
  readonly getLatestJobByRunId: (
    runId: string,
  ) => Effect.Effect<WorkspaceBuildJob | undefined, WorkspaceBuildJobRepoError>;
  /**
   * Latest succeeded job (in the given registry) whose recorded compile-result
   * `metadata.planHash` matches. Keyed by hash, NOT repository:tag — the SDK names every create
   * with a fresh random tag, so the hash is the only stable identity an unchanged plan has.
   */
  readonly getLatestSucceededJobByPlanHash: (input: {
    readonly registryId: string;
    readonly planHash: string;
  }) => Effect.Effect<WorkspaceBuildJob | undefined, WorkspaceBuildJobRepoError>;
  readonly listLatestJobsByRunIds: (
    runIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, WorkspaceBuildJob>, WorkspaceBuildJobRepoError>;
  readonly listJobsByStatus: (
    status: WorkspaceBuildJobStatus,
    limit?: number,
  ) => Effect.Effect<Array<WorkspaceBuildJob>, WorkspaceBuildJobRepoError>;
  readonly claimNextQueuedJob: (
    input: ClaimNextWorkspaceBuildJobInput,
  ) => Effect.Effect<WorkspaceBuildJob | null, WorkspaceBuildJobRepoError>;
  readonly claimJobById: (
    input: ClaimWorkspaceBuildJobByIdInput,
  ) => Effect.Effect<WorkspaceBuildJob | null, WorkspaceBuildJobRepoError>;
  readonly markJobRunning: (
    input: MarkWorkspaceBuildJobRunningInput,
  ) => Effect.Effect<WorkspaceBuildJob | null, WorkspaceBuildJobRepoError>;
  readonly markJobSucceeded: (
    input: MarkWorkspaceBuildJobSucceededInput,
  ) => Effect.Effect<WorkspaceBuildJob | null, WorkspaceBuildJobRepoError>;
  readonly markJobFailed: (
    input: MarkWorkspaceBuildJobFailedInput,
  ) => Effect.Effect<WorkspaceBuildJob | null, WorkspaceBuildJobRepoError>;
  /**
   * Record the build's progress and renew the claim's lease. Answers false when the claim no
   * longer holds the job (it was taken over, or the job settled): nothing was written.
   */
  readonly recordJobProgress: (
    input: RecordWorkspaceBuildJobProgressInput,
  ) => Effect.Effect<boolean, WorkspaceBuildJobRepoError>;
  /**
   * Fail a job whose image is not built yet (`queued` or `running`), because its workspace was
   * stopped. The worker building it finds out at its next progress write (it no longer holds a
   * running job) and stops; a fenced success can no longer land, so nothing launches. Answers the
   * job when it was cancelled, null when it had already settled.
   */
  readonly cancelUnbuiltJob: (input: {
    readonly id: string;
    readonly errorMessage: string;
    readonly errorCode: string;
  }) => Effect.Effect<WorkspaceBuildJob | null, WorkspaceBuildJobRepoError>;
  /** Drop the sealed secret env once the launch phase has settled; idempotent. */
  readonly clearSecretEnv: (id: string) => Effect.Effect<void, WorkspaceBuildJobRepoError>;
  /**
   * Every succeeded job that recorded a published digest, newest publish first. The image
   * retention sweep's view of what the store may hold: one row per publish, so a digest republished
   * under several jobs appears once per job.
   */
  readonly listPublishedImages: () => Effect.Effect<
    Array<PublishedWorkspaceImage>,
    WorkspaceBuildJobRepoError
  >;
}

export class WorkspaceBuildJobRepo extends Context.Service<
  WorkspaceBuildJobRepo,
  WorkspaceBuildJobRepoService
>()("WorkspaceBuildJobRepo") {}

export const WorkspaceBuildJobRepoLive = Layer.effect(
  WorkspaceBuildJobRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      insertQueuedJob: (input) =>
        withWorkspaceBuildJobRepoError(
          "insertQueuedJob",
          Effect.gen(function* () {
            const [job] = yield* db
              .insert(workspaceBuildJobs)
              .values({
                id: input.id,
                ...(input.runId === undefined ? {} : { runId: input.runId }),
                status: "queued",
                registryId: input.registryId,
                repository: input.repository,
                tag: input.tag,
                requestPayload: input.requestPayload,
                ...(input.secretEnvSealed === undefined
                  ? {}
                  : { secretEnvSealed: input.secretEnvSealed }),
                ...(input.idempotencyKey === undefined
                  ? {}
                  : { idempotencyKey: input.idempotencyKey }),
                ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
                ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
              } satisfies NewWorkspaceBuildJob)
              .returning();

            if (job === undefined) {
              return yield* new WorkspaceBuildJobRepoInvariantError({
                operation: "insertQueuedJob",
                message: "Failed to insert workspace build job.",
              });
            }

            return job;
          }),
        ),

      getJobById: (id) =>
        withWorkspaceBuildJobRepoError(
          "getJobById",
          Effect.gen(function* () {
            const [job] = yield* db
              .select()
              .from(workspaceBuildJobs)
              .where(eq(workspaceBuildJobs.id, id))
              .limit(1);

            return job;
          }),
        ),

      getJobByIdempotencyKey: (idempotencyKey) =>
        withWorkspaceBuildJobRepoError(
          "getJobByIdempotencyKey",
          Effect.gen(function* () {
            const [job] = yield* db
              .select()
              .from(workspaceBuildJobs)
              .where(eq(workspaceBuildJobs.idempotencyKey, idempotencyKey))
              .limit(1);

            return job;
          }),
        ),

      getLatestJobByRunId: (runId) =>
        withWorkspaceBuildJobRepoError(
          "getLatestJobByRunId",
          Effect.gen(function* () {
            const [job] = yield* db
              .select()
              .from(workspaceBuildJobs)
              .where(eq(workspaceBuildJobs.runId, runId))
              .orderBy(desc(workspaceBuildJobs.createdAt))
              .limit(1);

            return job;
          }),
        ),

      getLatestSucceededJobByPlanHash: (input) =>
        withWorkspaceBuildJobRepoError(
          "getLatestSucceededJobByPlanHash",
          Effect.gen(function* () {
            const [job] = yield* db
              .select()
              .from(workspaceBuildJobs)
              .where(
                and(
                  eq(workspaceBuildJobs.status, "succeeded"),
                  eq(workspaceBuildJobs.registryId, input.registryId),
                  sql`${workspaceBuildJobs.resultPayload} #>> '{metadata,planHash}' = ${input.planHash}`,
                ),
              )
              .orderBy(desc(workspaceBuildJobs.finishedAt))
              .limit(1);

            return job;
          }),
        ),

      listLatestJobsByRunIds: (runIds) =>
        withWorkspaceBuildJobRepoError(
          "listLatestJobsByRunIds",
          Effect.gen(function* () {
            if (runIds.length === 0) {
              return new Map();
            }

            const jobs = yield* db
              .select()
              .from(workspaceBuildJobs)
              .where(inArray(workspaceBuildJobs.runId, [...runIds]))
              .orderBy(desc(workspaceBuildJobs.createdAt));

            const latestJobsByRunId = new Map<string, WorkspaceBuildJob>();

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
        withWorkspaceBuildJobRepoError(
          "listJobsByStatus",
          db
            .select()
            .from(workspaceBuildJobs)
            .where(eq(workspaceBuildJobs.status, status))
            .orderBy(asc(workspaceBuildJobs.createdAt))
            .limit(limit)
            .pipe(Effect.map((jobs) => [...jobs])),
        ),

      listPublishedImages: () =>
        withWorkspaceBuildJobRepoError(
          "listPublishedImages",
          db
            .select({
              jobId: workspaceBuildJobs.id,
              runId: workspaceBuildJobs.runId,
              registryId: workspaceBuildJobs.registryId,
              publishedReference: workspaceBuildJobs.publishedReference,
              repository: workspaceBuildJobs.repository,
              digest: workspaceBuildJobs.publishedDigest,
              planHash: sql<
                string | null
              >`${workspaceBuildJobs.resultPayload} #>> '{metadata,planHash}'`,
              finishedAt: workspaceBuildJobs.finishedAt,
              updatedAt: workspaceBuildJobs.updatedAt,
            })
            .from(workspaceBuildJobs)
            .where(
              and(
                eq(workspaceBuildJobs.status, "succeeded"),
                isNotNull(workspaceBuildJobs.publishedDigest),
                isNotNull(workspaceBuildJobs.publishedReference),
              ),
            )
            .orderBy(desc(workspaceBuildJobs.finishedAt), desc(workspaceBuildJobs.createdAt))
            .pipe(
              Effect.map((rows) =>
                rows.flatMap((row) =>
                  row.digest === null || row.publishedReference === null
                    ? []
                    : [
                        {
                          jobId: row.jobId,
                          runId: row.runId,
                          registryId: row.registryId,
                          publishedReference: row.publishedReference,
                          repository: row.repository,
                          digest: row.digest,
                          planHash: row.planHash,
                          publishedAt: row.finishedAt ?? row.updatedAt,
                        },
                      ],
                ),
              ),
            ),
        ),

      claimNextQueuedJob: (input) =>
        withWorkspaceBuildJobRepoError(
          "claimNextQueuedJob",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const now = requiredDate(input.now);
              const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
              const claimable = or(
                and(
                  eq(workspaceBuildJobs.status, "queued"),
                  lte(workspaceBuildJobs.availableAt, now),
                ),
                and(
                  eq(workspaceBuildJobs.status, "running"),
                  lte(workspaceBuildJobs.leaseExpiresAt, now),
                ),
              );

              // SKIP LOCKED + the claimable guard repeated in the UPDATE: two workers claiming
              // concurrently must not both win the same job (under read committed the plain
              // SELECT-then-UPDATE both saw the row as claimable), and a worker must not block
              // on — or return empty because of — a row a sibling is mid-claim on.
              const [candidate] = yield* tx
                .select()
                .from(workspaceBuildJobs)
                .where(claimable)
                .orderBy(asc(workspaceBuildJobs.availableAt), asc(workspaceBuildJobs.createdAt))
                .limit(1)
                .for("update", { skipLocked: true });

              if (candidate === undefined) {
                return null;
              }

              const [claimed] = yield* tx
                .update(workspaceBuildJobs)
                .set({
                  status: "running",
                  workerId: input.workerId,
                  claimedAt: now,
                  leaseExpiresAt,
                  startedAt: sql`coalesce(${workspaceBuildJobs.startedAt}, ${now})`,
                  attemptCount: sql`${workspaceBuildJobs.attemptCount} + 1`,
                  progress: null,
                })
                .where(and(eq(workspaceBuildJobs.id, candidate.id), claimable))
                .returning();

              return claimed ?? null;
            }),
          ),
        ),

      claimJobById: (input) =>
        withWorkspaceBuildJobRepoError(
          "claimJobById",
          Effect.gen(function* () {
            const now = requiredDate(input.now);
            const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);

            // One guarded UPDATE: the claimable predicate lives in the WHERE so a concurrent
            // claimer's committed win makes this a no-op instead of a double claim.
            const [claimed] = yield* db
              .update(workspaceBuildJobs)
              .set({
                status: "running",
                workerId: input.workerId,
                claimedAt: now,
                leaseExpiresAt,
                startedAt: sql`coalesce(${workspaceBuildJobs.startedAt}, ${now})`,
                attemptCount: sql`${workspaceBuildJobs.attemptCount} + 1`,
                progress: null,
              })
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
              .returning();

            return claimed ?? null;
          }),
        ),

      markJobRunning: (input) =>
        withWorkspaceBuildJobRepoError(
          "markJobRunning",
          Effect.gen(function* () {
            const now = requiredDate(input.now);
            const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);

            const [job] = yield* db
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
          }),
        ),

      markJobSucceeded: (input) =>
        withWorkspaceBuildJobRepoError(
          "markJobSucceeded",
          Effect.gen(function* () {
            const [job] = yield* db
              .update(workspaceBuildJobs)
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
              .where(
                and(
                  eq(workspaceBuildJobs.id, input.id),
                  eq(workspaceBuildJobs.status, "running"),
                  eq(workspaceBuildJobs.workerId, input.claim.workerId),
                  eq(workspaceBuildJobs.attemptCount, input.claim.attemptCount),
                ),
              )
              .returning();

            return job ?? null;
          }),
        ),

      markJobFailed: (input) =>
        withWorkspaceBuildJobRepoError(
          "markJobFailed",
          Effect.gen(function* () {
            const [job] = yield* db
              .update(workspaceBuildJobs)
              .set({
                status: "failed",
                ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
                errorMessage: input.errorMessage,
                finishedAt: input.finishedAt ?? new Date(),
                leaseExpiresAt: null,
              })
              .where(
                input.claim === undefined
                  ? eq(workspaceBuildJobs.id, input.id)
                  : and(
                      eq(workspaceBuildJobs.id, input.id),
                      eq(workspaceBuildJobs.status, "running"),
                      eq(workspaceBuildJobs.workerId, input.claim.workerId),
                      eq(workspaceBuildJobs.attemptCount, input.claim.attemptCount),
                    ),
              )
              .returning();

            return job ?? null;
          }),
        ),

      recordJobProgress: (input) =>
        withWorkspaceBuildJobRepoError(
          "recordJobProgress",
          Effect.gen(function* () {
            const now = requiredDate(input.now);
            const updated = yield* db
              .update(workspaceBuildJobs)
              .set({
                ...(input.progress === undefined ? {} : { progress: input.progress }),
                leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs),
              })
              .where(
                and(
                  eq(workspaceBuildJobs.id, input.id),
                  eq(workspaceBuildJobs.status, "running"),
                  eq(workspaceBuildJobs.workerId, input.claim.workerId),
                  eq(workspaceBuildJobs.attemptCount, input.claim.attemptCount),
                ),
              )
              .returning({ id: workspaceBuildJobs.id });
            return updated.length > 0;
          }),
        ),

      cancelUnbuiltJob: (input) =>
        withWorkspaceBuildJobRepoError(
          "cancelUnbuiltJob",
          Effect.gen(function* () {
            const [job] = yield* db
              .update(workspaceBuildJobs)
              .set({
                status: "failed",
                errorCode: input.errorCode,
                errorMessage: input.errorMessage,
                finishedAt: new Date(),
                leaseExpiresAt: null,
              })
              .where(
                and(
                  eq(workspaceBuildJobs.id, input.id),
                  inArray(workspaceBuildJobs.status, ["queued", "running"]),
                ),
              )
              .returning();
            return job ?? null;
          }),
        ),

      clearSecretEnv: (id) =>
        withWorkspaceBuildJobRepoError(
          "clearSecretEnv",
          Effect.gen(function* () {
            yield* db
              .update(workspaceBuildJobs)
              .set({ secretEnvSealed: null })
              .where(eq(workspaceBuildJobs.id, id));
          }),
        ),
    } satisfies WorkspaceBuildJobRepoService;
  }),
);
