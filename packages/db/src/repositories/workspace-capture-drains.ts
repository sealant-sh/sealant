import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  workspaceCaptureDrains,
  type NewWorkspaceCaptureDrain,
  type WorkspaceCaptureDrain,
  type WorkspaceCaptureDrainState,
} from "../schema.js";

const workspaceCaptureDrainRepoOperationSchema = Schema.Literals([
  "claimLease",
  "recordProgress",
  "releaseLease",
  "getByRunId",
  "listByRunIds",
  "recordSchedule",
]);

type WorkspaceCaptureDrainRepoOperation = typeof workspaceCaptureDrainRepoOperationSchema.Type;

export class WorkspaceCaptureDrainRepoUnexpectedError extends Schema.TaggedErrorClass<WorkspaceCaptureDrainRepoUnexpectedError>()(
  "WorkspaceCaptureDrainRepoUnexpectedError",
  {
    operation: workspaceCaptureDrainRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type WorkspaceCaptureDrainRepoError = WorkspaceCaptureDrainRepoUnexpectedError;

const withRepoError = <A>(
  operation: WorkspaceCaptureDrainRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, WorkspaceCaptureDrainRepoError> =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof WorkspaceCaptureDrainRepoUnexpectedError
        ? cause
        : new WorkspaceCaptureDrainRepoUnexpectedError({
            operation,
            message: cause instanceof Error ? cause.message : `${operation} failed.`,
            cause,
          }),
    ),
  );

/** The drain's progress and observation, written together on every drain iteration. */
export interface WorkspaceCaptureDrainProgress {
  readonly state?: WorkspaceCaptureDrainState;
  readonly detail?: string | null;
  readonly lastStatus?: Readonly<Record<string, unknown>> | null;
  readonly lastProgressAt?: Date | null;
  readonly unreachableSince?: Date | null;
  readonly keptLogged?: boolean;
  readonly silentLogged?: boolean;
  readonly observedAt?: Date;
}

export interface WorkspaceCaptureDrainSchedule {
  readonly preservationStartsAt: Date | null;
  readonly uploadBytesPerSecond?: number | null;
  readonly uploadSampleBytes?: number | null;
  readonly uploadSampledAt?: Date | null;
}

export interface WorkspaceCaptureDrainRepoService {
  /**
   * Take (or renew) the run's drain lease for `owner`, for `leaseMs` of database time. Succeeds
   * when nobody holds it, the holder's lease expired (its worker died), or `owner` already holds
   * it; returns the row. Returns `undefined` while another owner's lease is live. Atomic: two
   * workers racing for one run get one row between them.
   */
  readonly claimLease: (input: {
    readonly runId: string;
    readonly owner: string;
    readonly leaseMs: number;
  }) => Effect.Effect<WorkspaceCaptureDrain | undefined, WorkspaceCaptureDrainRepoError>;
  /**
   * Write progress and renew the lease, fenced on `owner`: `undefined` when the lease was lost
   * (it expired and another worker took the run), and nothing is written.
   */
  readonly recordProgress: (input: {
    readonly runId: string;
    readonly owner: string;
    readonly leaseMs: number;
    readonly progress: WorkspaceCaptureDrainProgress;
  }) => Effect.Effect<WorkspaceCaptureDrain | undefined, WorkspaceCaptureDrainRepoError>;
  /** Give the lease up (fenced on `owner`); the observation stays. */
  readonly releaseLease: (input: {
    readonly runId: string;
    readonly owner: string;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  readonly getByRunId: (
    runId: string,
  ) => Effect.Effect<WorkspaceCaptureDrain | undefined, WorkspaceCaptureDrainRepoError>;
  readonly listByRunIds: (
    runIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, WorkspaceCaptureDrain>, WorkspaceCaptureDrainRepoError>;
  /** Persist the deadline sweep's schedule and throughput sample; the lease is untouched. */
  readonly recordSchedule: (input: {
    readonly runId: string;
    readonly schedule: WorkspaceCaptureDrainSchedule;
  }) => Effect.Effect<WorkspaceCaptureDrain, WorkspaceCaptureDrainRepoError>;
}

export class WorkspaceCaptureDrainRepo extends Context.Service<
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoService
>()("WorkspaceCaptureDrainRepo") {}

const leaseExpiry = (leaseMs: number) =>
  sql`now() + (${Math.max(0, Math.round(leaseMs))} * interval '1 millisecond')`;

const progressColumns = (progress: WorkspaceCaptureDrainProgress) => ({
  ...(progress.state === undefined ? {} : { state: progress.state }),
  ...(progress.detail === undefined ? {} : { detail: progress.detail }),
  ...(progress.lastStatus === undefined ? {} : { lastStatus: progress.lastStatus }),
  ...(progress.lastProgressAt === undefined ? {} : { lastProgressAt: progress.lastProgressAt }),
  ...(progress.unreachableSince === undefined
    ? {}
    : { unreachableSince: progress.unreachableSince }),
  ...(progress.keptLogged === undefined ? {} : { keptLogged: progress.keptLogged }),
  ...(progress.silentLogged === undefined ? {} : { silentLogged: progress.silentLogged }),
  ...(progress.observedAt === undefined ? {} : { observedAt: progress.observedAt }),
});

export const WorkspaceCaptureDrainRepoLive: Layer.Layer<
  WorkspaceCaptureDrainRepo,
  never,
  SealantDB
> = Layer.effect(
  WorkspaceCaptureDrainRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      claimLease: (input) =>
        withRepoError(
          "claimLease",
          Effect.gen(function* () {
            const [row] = yield* db
              .insert(workspaceCaptureDrains)
              .values({
                runId: input.runId,
                leaseOwner: input.owner,
                leaseExpiresAt: leaseExpiry(input.leaseMs),
              })
              .onConflictDoUpdate({
                target: workspaceCaptureDrains.runId,
                set: { leaseOwner: input.owner, leaseExpiresAt: leaseExpiry(input.leaseMs) },
                // Free, expired (its worker died), or already ours; a live lease of another
                // owner updates nothing and the insert returns no row.
                setWhere: sql`(${or(
                  isNull(workspaceCaptureDrains.leaseOwner),
                  isNull(workspaceCaptureDrains.leaseExpiresAt),
                  lte(workspaceCaptureDrains.leaseExpiresAt, sql`now()`),
                  eq(workspaceCaptureDrains.leaseOwner, input.owner),
                )})`,
              })
              .returning();
            return row;
          }),
        ),

      recordProgress: (input) =>
        withRepoError(
          "recordProgress",
          Effect.gen(function* () {
            const [row] = yield* db
              .update(workspaceCaptureDrains)
              .set({
                ...progressColumns(input.progress),
                leaseExpiresAt: leaseExpiry(input.leaseMs),
              })
              .where(
                and(
                  eq(workspaceCaptureDrains.runId, input.runId),
                  eq(workspaceCaptureDrains.leaseOwner, input.owner),
                ),
              )
              .returning();
            return row;
          }),
        ),

      releaseLease: (input) =>
        withRepoError(
          "releaseLease",
          db
            .update(workspaceCaptureDrains)
            .set({ leaseOwner: null, leaseExpiresAt: null })
            .where(
              and(
                eq(workspaceCaptureDrains.runId, input.runId),
                eq(workspaceCaptureDrains.leaseOwner, input.owner),
              ),
            )
            .pipe(Effect.asVoid),
        ),

      getByRunId: (runId) =>
        withRepoError(
          "getByRunId",
          Effect.gen(function* () {
            const [row] = yield* db
              .select()
              .from(workspaceCaptureDrains)
              .where(eq(workspaceCaptureDrains.runId, runId))
              .limit(1);
            return row;
          }),
        ),

      listByRunIds: (runIds) =>
        withRepoError(
          "listByRunIds",
          Effect.gen(function* () {
            if (runIds.length === 0) {
              return new Map<string, WorkspaceCaptureDrain>();
            }
            const rows = yield* db
              .select()
              .from(workspaceCaptureDrains)
              .where(inArray(workspaceCaptureDrains.runId, [...runIds]));
            return new Map(rows.map((row: WorkspaceCaptureDrain) => [row.runId, row] as const));
          }),
        ),

      recordSchedule: (input) =>
        withRepoError(
          "recordSchedule",
          Effect.gen(function* () {
            const columns = {
              preservationStartsAt: input.schedule.preservationStartsAt,
              ...(input.schedule.uploadBytesPerSecond === undefined
                ? {}
                : { uploadBytesPerSecond: input.schedule.uploadBytesPerSecond }),
              ...(input.schedule.uploadSampleBytes === undefined
                ? {}
                : { uploadSampleBytes: input.schedule.uploadSampleBytes }),
              ...(input.schedule.uploadSampledAt === undefined
                ? {}
                : { uploadSampledAt: input.schedule.uploadSampledAt }),
            };
            const [row] = yield* db
              .insert(workspaceCaptureDrains)
              .values({ runId: input.runId, ...columns } satisfies NewWorkspaceCaptureDrain)
              .onConflictDoUpdate({ target: workspaceCaptureDrains.runId, set: columns })
              .returning();
            if (row === undefined) {
              return yield* Effect.fail(
                new Error(
                  `Recording the preservation schedule of run ${input.runId} wrote no row.`,
                ),
              );
            }
            return row;
          }),
        ),
    } satisfies WorkspaceCaptureDrainRepoService;
  }),
);
