import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
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
  "recordObservation",
  "requestDiscard",
  "attestCompletion",
  "markRetained",
  "listRetainedDue",
  "recordRecoveryAttempt",
  "requestRecovery",
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
  /**
   * Record an observation outside a drain (the stop that followed it failed or finished, or a
   * discard ended the runtime); the lease is untouched.
   */
  readonly recordObservation: (input: {
    readonly runId: string;
    readonly state: WorkspaceCaptureDrainState;
    readonly detail: string | null;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  /**
   * Record the owner's request to discard the run's unsaved captures (the audit): the first
   * request's instant and requester stand. Returns the row.
   */
  readonly requestDiscard: (input: {
    readonly runId: string;
    readonly requestedBy: string;
  }) => Effect.Effect<WorkspaceCaptureDrain, WorkspaceCaptureDrainRepoError>;
  /**
   * Record the control plane's attestation that its store holds a sealed FINAL of the run's
   * executor (the latest stands). Returns the row.
   */
  readonly attestCompletion: (input: {
    readonly runId: string;
    readonly executorId: string;
    readonly epoch: number;
    readonly captureN: number;
    readonly attestedBy: string;
  }) => Effect.Effect<WorkspaceCaptureDrain, WorkspaceCaptureDrainRepoError>;
  /**
   * Record that the run's executor is retained (its disk holds work not confirmed saved): the
   * first instant stands, the reason is the latest, and recovery is due at once if not scheduled.
   * The observation reads `kept` with the reason.
   */
  readonly markRetained: (input: {
    readonly runId: string;
    readonly reason: string;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  /** Retained executors whose next recovery attempt is due, the most overdue first. */
  readonly listRetainedDue: (input: {
    readonly limit: number;
  }) => Effect.Effect<readonly WorkspaceCaptureDrain[], WorkspaceCaptureDrainRepoError>;
  /** One recovery attempt happened: count it, keep its error (or clear it), schedule the next. */
  readonly recordRecoveryAttempt: (input: {
    readonly runId: string;
    readonly error: string | null;
    readonly nextRecoveryAt: Date;
  }) => Effect.Effect<void, WorkspaceCaptureDrainRepoError>;
  /**
   * Make a retained executor's recovery due now (the owner asked). Returns the row, or
   * `undefined` when the run's executor is not retained.
   */
  readonly requestRecovery: (
    runId: string,
  ) => Effect.Effect<WorkspaceCaptureDrain | undefined, WorkspaceCaptureDrainRepoError>;
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

      recordObservation: (input) =>
        withRepoError(
          "recordObservation",
          Effect.gen(function* () {
            // The executor was removed (or found gone): nothing is retained any more.
            const endsRetention =
              input.state === "stopped" || input.state === "discarded" || input.state === "gone";
            const set = {
              state: input.state,
              detail: input.detail,
              observedAt: new Date(),
              ...(endsRetention ? { retainedAt: null, nextRecoveryAt: null } : {}),
            };
            yield* db
              .insert(workspaceCaptureDrains)
              .values({ runId: input.runId, ...set } satisfies NewWorkspaceCaptureDrain)
              .onConflictDoUpdate({ target: workspaceCaptureDrains.runId, set });
          }),
        ),

      attestCompletion: (input) =>
        withRepoError(
          "attestCompletion",
          Effect.gen(function* () {
            const columns = {
              completionExecutorId: input.executorId,
              completionEpoch: input.epoch,
              completionCaptureN: input.captureN,
              completionAttestedAt: new Date(),
              completionAttestedBy: input.attestedBy,
            };
            const [row] = yield* db
              .insert(workspaceCaptureDrains)
              .values({ runId: input.runId, ...columns } satisfies NewWorkspaceCaptureDrain)
              .onConflictDoUpdate({ target: workspaceCaptureDrains.runId, set: columns })
              .returning();
            if (row === undefined) {
              return yield* Effect.fail(
                new Error(
                  `Recording the completion attestation of run ${input.runId} wrote no row.`,
                ),
              );
            }
            return row;
          }),
        ),

      markRetained: (input) =>
        withRepoError(
          "markRetained",
          Effect.gen(function* () {
            const detail = `not saved · retained · ${input.reason}`;
            yield* db
              .insert(workspaceCaptureDrains)
              .values({
                runId: input.runId,
                retainedAt: new Date(),
                retainedReason: input.reason,
                nextRecoveryAt: new Date(),
                state: "kept",
                detail,
                observedAt: new Date(),
              } satisfies NewWorkspaceCaptureDrain)
              .onConflictDoUpdate({
                target: workspaceCaptureDrains.runId,
                set: {
                  retainedAt: sql`coalesce(${workspaceCaptureDrains.retainedAt}, now())`,
                  retainedReason: input.reason,
                  nextRecoveryAt: sql`coalesce(${workspaceCaptureDrains.nextRecoveryAt}, now())`,
                  state: "kept",
                  detail,
                  observedAt: new Date(),
                },
              });
          }),
        ),

      listRetainedDue: (input) =>
        withRepoError(
          "listRetainedDue",
          db
            .select()
            .from(workspaceCaptureDrains)
            .where(
              and(
                isNotNull(workspaceCaptureDrains.retainedAt),
                or(
                  isNull(workspaceCaptureDrains.nextRecoveryAt),
                  lte(workspaceCaptureDrains.nextRecoveryAt, sql`now()`),
                ),
              ),
            )
            .orderBy(asc(workspaceCaptureDrains.nextRecoveryAt))
            .limit(Math.max(1, Math.round(input.limit))),
        ),

      recordRecoveryAttempt: (input) =>
        withRepoError(
          "recordRecoveryAttempt",
          db
            .update(workspaceCaptureDrains)
            .set({
              recoveryAttempts: sql`${workspaceCaptureDrains.recoveryAttempts} + 1`,
              lastRecoveryError: input.error,
              nextRecoveryAt: input.nextRecoveryAt,
            })
            .where(
              and(
                eq(workspaceCaptureDrains.runId, input.runId),
                isNotNull(workspaceCaptureDrains.retainedAt),
              ),
            )
            .pipe(Effect.asVoid),
        ),

      requestRecovery: (runId) =>
        withRepoError(
          "requestRecovery",
          Effect.gen(function* () {
            const [row] = yield* db
              .update(workspaceCaptureDrains)
              .set({ nextRecoveryAt: sql`now()` })
              .where(
                and(
                  eq(workspaceCaptureDrains.runId, runId),
                  isNotNull(workspaceCaptureDrains.retainedAt),
                ),
              )
              .returning();
            return row;
          }),
        ),

      requestDiscard: (input) =>
        withRepoError(
          "requestDiscard",
          Effect.gen(function* () {
            yield* db
              .insert(workspaceCaptureDrains)
              .values({
                runId: input.runId,
                discardRequestedAt: new Date(),
                discardRequestedBy: input.requestedBy,
              } satisfies NewWorkspaceCaptureDrain)
              .onConflictDoUpdate({
                target: workspaceCaptureDrains.runId,
                // The first request stands: the audit never moves.
                set: {
                  discardRequestedAt: sql`coalesce(${workspaceCaptureDrains.discardRequestedAt}, now())`,
                  discardRequestedBy: sql`coalesce(${workspaceCaptureDrains.discardRequestedBy}, ${input.requestedBy})`,
                },
              });
            const [row] = yield* db
              .select()
              .from(workspaceCaptureDrains)
              .where(eq(workspaceCaptureDrains.runId, input.runId))
              .limit(1);
            if (row === undefined) {
              return yield* Effect.fail(
                new Error(`Recording the discard of run ${input.runId} wrote no row.`),
              );
            }
            return row;
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
