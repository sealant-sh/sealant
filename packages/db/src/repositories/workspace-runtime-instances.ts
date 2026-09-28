import type { RuntimeAdapterId } from "@sealant/validators";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  workspaceRuntimeInstances,
  type WorkspaceLaunchCredentialInjection,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceStatus,
  type WorkspaceRuntimeInstanceStopReason,
} from "../schema.js";

export interface UpsertWorkspaceRuntimeInstanceInput {
  readonly runId: string;
  readonly status: WorkspaceRuntimeInstanceStatus;
  readonly adapter?: RuntimeAdapterId;
  readonly resourceId?: string;
  readonly reference?: string;
  readonly endpoint?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  /** Launch-time record of how each connected-account credential was injected (env vs file). */
  readonly launchCredentialInjections?: readonly WorkspaceLaunchCredentialInjection[];
  readonly launchedAt?: Date;
  readonly finishedAt?: Date;
  /** The runtime's own lifetime deadline (MicroVM max duration); omit where it has none. */
  readonly runtimeDeadlineAt?: Date;
  /** The blueprint's `sources.workspace.kind` (`capture`, `git`, …); see the column. */
  readonly sourceKind?: string;
  /**
   * Take launch ownership for this worker (`launch_owner`) for `launchLeaseMs` of database time
   * from now. Written with the launch's first `pending` row.
   */
  readonly launchOwner?: string;
  readonly launchLeaseMs?: number;
  /**
   * Write only while `fenceLaunchOwner` still owns the launch: the row is `pending` and names it.
   * A launch the stranded-launch sweep adopted (its ownership lapsed) is no longer the worker's
   * to write, and the upsert fails with `WorkspaceRuntimeInstanceRepoInvariantError`
   * (`LAUNCH_OWNERSHIP_LOST_MESSAGE`). The ownership lease is renewed by the same write.
   */
  readonly fenceLaunchOwner?: string;
  /** The terminal launch write: launch ownership ends (`launch_owner` and its lease cleared). */
  readonly releaseLaunch?: boolean;
  /** The sealantd image the executor's daemon came from; see the column. */
  readonly daemonImage?: string;
  /** Whether that daemon has sealantd's recovery boot; `null` = unknown. See the column. */
  readonly daemonRecoveryBoot?: boolean | null;
}

/** The message of the invariant error a fenced upsert fails with once its launch was adopted. */
export const LAUNCH_OWNERSHIP_LOST_MESSAGE =
  "The launch is no longer this worker's: its ownership lapsed and the stranded-launch sweep adopted the executor.";

/**
 * How long a `pending` row that names an executor but no launch owner (written before launch
 * ownership existed) must stand still before the stranded-launch sweep adopts it.
 */
export const DEFAULT_UNOWNED_LAUNCH_GRACE_MS = 15 * 60_000;

/** @deprecated Use WorkspaceRuntimeInstanceRepo + WorkspaceRuntimeInstanceRepoLive instead. */
export const createWorkspaceRuntimeInstanceRepository = (): never => {
  throw new Error(
    "createWorkspaceRuntimeInstanceRepository is disabled during the Effect transition.",
  );
};

/** @deprecated Use WorkspaceRuntimeInstanceRepoService instead. */
export type WorkspaceRuntimeInstanceRepository = WorkspaceRuntimeInstanceRepoService;

const workspaceRuntimeInstanceRepoOperationSchema = Schema.Literals([
  "getRuntimeInstanceByRunId",
  "listRuntimeInstancesByRunIds",
  "listRunningInstances",
  "listRetainedLaunches",
  "listStrandedLaunches",
  "adoptStrandedLaunch",
  "listUnidentifiedStrandedLaunches",
  "identifyStrandedLaunch",
  "failLostLaunch",
  "renewLaunchLease",
  "listPreservationCandidates",
  "markExited",
  "markStopRequested",
  "markStopped",
  "upsertRuntimeInstance",
]);

export class WorkspaceRuntimeInstanceRepoInvariantError extends Schema.TaggedErrorClass<WorkspaceRuntimeInstanceRepoInvariantError>()(
  "WorkspaceRuntimeInstanceRepoInvariantError",
  {
    operation: workspaceRuntimeInstanceRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class WorkspaceRuntimeInstanceRepoUnexpectedError extends Schema.TaggedErrorClass<WorkspaceRuntimeInstanceRepoUnexpectedError>()(
  "WorkspaceRuntimeInstanceRepoUnexpectedError",
  {
    operation: workspaceRuntimeInstanceRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const workspaceRuntimeInstanceRepoErrorSchema = Schema.Union([
  WorkspaceRuntimeInstanceRepoInvariantError,
  WorkspaceRuntimeInstanceRepoUnexpectedError,
]);

export type WorkspaceRuntimeInstanceRepoError = typeof workspaceRuntimeInstanceRepoErrorSchema.Type;

type WorkspaceRuntimeInstanceRepoOperation =
  typeof workspaceRuntimeInstanceRepoOperationSchema.Type;

const mapWorkspaceRuntimeInstanceRepoError = (
  operation: WorkspaceRuntimeInstanceRepoOperation,
  cause: unknown,
): WorkspaceRuntimeInstanceRepoError => {
  if (
    cause instanceof WorkspaceRuntimeInstanceRepoInvariantError ||
    cause instanceof WorkspaceRuntimeInstanceRepoUnexpectedError
  ) {
    return cause;
  }

  return new WorkspaceRuntimeInstanceRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withWorkspaceRuntimeInstanceRepoError = <A>(
  operation: WorkspaceRuntimeInstanceRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, WorkspaceRuntimeInstanceRepoError> => {
  return effect.pipe(
    Effect.mapError((cause) => mapWorkspaceRuntimeInstanceRepoError(operation, cause)),
  );
};

export interface MarkWorkspaceRuntimeInstanceStoppedInput {
  readonly runId: string;
  readonly stopReason: WorkspaceRuntimeInstanceStopReason;
  readonly finishedAt?: Date;
}

/**
 * `errorCode` of a launch whose worker was lost before any executor of it can be found: nothing
 * started (or nothing the runtime knows of), so nothing is kept. See `failLostLaunch`.
 */
export const LAUNCH_LOST_ERROR_CODE = "launch-lost";

/** `errorCode` written by `markExited`: the runtime ended without a stop request. */
export const RUNTIME_EXITED_ERROR_CODE = "runtime-exited";

/**
 * `errorCode` of a launch that failed AFTER its capture-sourced runtime became ready (a writer
 * could already have run): the runtime was kept, not removed, and its row carries the identity
 * (`adapter`, `resourceId`, `reference`, `endpoint`) the retained-launch sweep drains it through
 * before it is stopped. `markStopped` settles it like any other stop.
 */
export const LAUNCH_RETAINED_ERROR_CODE = "launch-retained";

export interface MarkWorkspaceRuntimeInstanceExitedInput {
  readonly runId: string;
  /**
   * The resource the exit was observed on. The write is fenced on it: a launch that replaced the
   * resource under the same run (a dead container cleared and re-run) must not be failed by an
   * observation of its predecessor.
   */
  readonly resourceId: string;
  readonly errorMessage: string;
  readonly finishedAt?: Date;
}

export interface WorkspaceRuntimeInstanceRepoService {
  readonly upsertRuntimeInstance: (
    input: UpsertWorkspaceRuntimeInstanceInput,
  ) => Effect.Effect<WorkspaceRuntimeInstance, WorkspaceRuntimeInstanceRepoError>;
  /**
   * Terminal write for a runtime that ended on its own: `ready` becomes `failed` with
   * `RUNTIME_EXITED_ERROR_CODE` and the observed detail. Fenced: only a `ready` instance on the
   * observed resource with no stop under way (`markStopRequested`) changes, so a stop — settled
   * or in progress — or a relaunch that replaced the resource wins, and the call returns
   * `undefined`.
   */
  readonly markExited: (
    input: MarkWorkspaceRuntimeInstanceExitedInput,
  ) => Effect.Effect<WorkspaceRuntimeInstance | undefined, WorkspaceRuntimeInstanceRepoError>;
  /**
   * A stop is under way: record its reason while the runtime is still up, before the runtime is
   * asked to go. From here an exit the runtime reports is the planned stop completing, never a
   * crash — `markExited` is fenced on it. Only a row not yet stopped and with no reason changes.
   */
  readonly markStopRequested: (input: {
    readonly runId: string;
    readonly stopReason: WorkspaceRuntimeInstanceStopReason;
  }) => Effect.Effect<void, WorkspaceRuntimeInstanceRepoError>;
  /**
   * Terminal stop write. Idempotent: an already-stopped instance is returned unchanged (the first
   * stopReason wins), so a user stop racing the TTL reaper records exactly one outcome.
   */
  readonly markStopped: (
    input: MarkWorkspaceRuntimeInstanceStoppedInput,
  ) => Effect.Effect<WorkspaceRuntimeInstance, WorkspaceRuntimeInstanceRepoError>;
  readonly getRuntimeInstanceByRunId: (
    runId: string,
  ) => Effect.Effect<WorkspaceRuntimeInstance | undefined, WorkspaceRuntimeInstanceRepoError>;
  readonly listRuntimeInstancesByRunIds: (
    runIds: readonly string[],
  ) => Effect.Effect<
    ReadonlyMap<string, WorkspaceRuntimeInstance>,
    WorkspaceRuntimeInstanceRepoError
  >;
  /**
   * All runtime instances currently `ready` (control channel accepting) on any adapter. Consumers
   * derive a transport target per row (`sealantTargetForRuntimeInstance`) and skip what they can't
   * reach.
   */
  readonly listRunningInstances: () => Effect.Effect<
    readonly WorkspaceRuntimeInstance[],
    WorkspaceRuntimeInstanceRepoError
  >;
  /**
   * Launches that failed after their capture-sourced runtime became ready and were kept
   * (`failed` with `LAUNCH_RETAINED_ERROR_CODE`): each still holds a runtime to drain and stop.
   */
  readonly listRetainedLaunches: () => Effect.Effect<
    readonly WorkspaceRuntimeInstance[],
    WorkspaceRuntimeInstanceRepoError
  >;
  /**
   * Launches whose executor started (`pending` with a `resource_id`) and whose launching worker
   * is gone: its launch ownership lapsed, or — a row written before ownership existed — it names
   * no owner and has not changed for `unownedGraceMs`. Nothing else will move them: their build
   * job already succeeded, so no job reaper or redelivery reaches them.
   */
  readonly listStrandedLaunches: (input: {
    readonly unownedGraceMs: number;
  }) => Effect.Effect<readonly WorkspaceRuntimeInstance[], WorkspaceRuntimeInstanceRepoError>;
  /**
   * Adopt one stranded launch as retained: `failed` with `LAUNCH_RETAINED_ERROR_CODE`, the
   * executor's identity kept and ownership cleared — only while it is still stranded (atomic: a
   * worker that renewed its ownership in between, or another sweep that adopted it first, wins
   * and this returns `undefined`).
   */
  readonly adoptStrandedLaunch: (input: {
    readonly runId: string;
    readonly errorMessage: string;
    readonly unownedGraceMs: number;
  }) => Effect.Effect<WorkspaceRuntimeInstance | undefined, WorkspaceRuntimeInstanceRepoError>;
  /**
   * Launches whose worker is gone (ownership lapsed, or — no owner — unchanged for
   * `unownedGraceMs`) BEFORE they recorded an executor: `pending` with no `resource_id`. The
   * executor may still have started (the worker died between creating it and recording it), so
   * the sweep asks the runtimes for it by the run (`RuntimeAdapter.locate`).
   */
  readonly listUnidentifiedStrandedLaunches: (input: {
    readonly unownedGraceMs: number;
  }) => Effect.Effect<readonly WorkspaceRuntimeInstance[], WorkspaceRuntimeInstanceRepoError>;
  /**
   * Record the executor a runtime found for an unidentified stranded launch — only while it is
   * still one (atomic; `undefined` when its worker came back and recorded it, or another sweep
   * did). The row stays `pending` with its lapsed ownership: `adoptStrandedLaunch` adopts it.
   */
  readonly identifyStrandedLaunch: (input: {
    readonly runId: string;
    readonly adapter: RuntimeAdapterId;
    readonly resourceId: string;
    readonly reference: string;
    readonly endpoint?: string;
    readonly unownedGraceMs: number;
  }) => Effect.Effect<WorkspaceRuntimeInstance | undefined, WorkspaceRuntimeInstanceRepoError>;
  /**
   * End an unidentified stranded launch no runtime knows an executor of, once its ownership has
   * been lapsed for `lostGraceMs` (a creation still in flight when the worker died has landed by
   * then): `failed` with `LAUNCH_LOST_ERROR_CODE`, ownership cleared. Atomic like the adoption.
   */
  readonly failLostLaunch: (input: {
    readonly runId: string;
    readonly errorMessage: string;
    readonly unownedGraceMs: number;
    readonly lostGraceMs: number;
  }) => Effect.Effect<WorkspaceRuntimeInstance | undefined, WorkspaceRuntimeInstanceRepoError>;
  /** Renew `owner`'s launch ownership of a `pending` row; `false` when it is no longer theirs. */
  readonly renewLaunchLease: (input: {
    readonly runId: string;
    readonly owner: string;
    readonly leaseMs: number;
  }) => Effect.Effect<boolean, WorkspaceRuntimeInstanceRepoError>;
  /**
   * Every runtime with its own lifetime deadline that may still hold work: `ready`, `pending`
   * with an executor (a launch in progress or stranded), and `failed` with an executor whose
   * deadline has not passed yet (a retained launch, or an executor whose daemon exited and was
   * retained — its machine may still be up until the deadline ends it).
   */
  readonly listPreservationCandidates: () => Effect.Effect<
    readonly WorkspaceRuntimeInstance[],
    WorkspaceRuntimeInstanceRepoError
  >;
}

/**
 * A launch whose executor started and whose launching worker is gone (see
 * `listStrandedLaunches`): `pending`, naming an executor, and its ownership lapsed — or, written
 * before ownership existed, naming no owner and unchanged for `unownedGraceMs`.
 */
/** A `pending` launch whose worker is gone: ownership lapsed, or ownerless and stale. */
const launchOwnershipLapsed = (unownedGraceMs: number, lapsedForMs = 0) =>
  or(
    and(
      isNotNull(workspaceRuntimeInstances.launchOwner),
      or(
        isNull(workspaceRuntimeInstances.launchLeaseExpiresAt),
        lte(
          workspaceRuntimeInstances.launchLeaseExpiresAt,
          sql`now() - (${Math.max(0, Math.round(lapsedForMs))} * interval '1 millisecond')`,
        ),
      ),
    ),
    and(
      isNull(workspaceRuntimeInstances.launchOwner),
      lte(
        workspaceRuntimeInstances.updatedAt,
        sql`now() - (${Math.max(0, Math.round(unownedGraceMs + lapsedForMs))} * interval '1 millisecond')`,
      ),
    ),
  );

/** A stranded launch that never recorded its executor (see `listUnidentifiedStrandedLaunches`). */
const strandedUnidentified = (unownedGraceMs: number, lapsedForMs = 0) =>
  and(
    eq(workspaceRuntimeInstances.status, "pending"),
    isNull(workspaceRuntimeInstances.resourceId),
    launchOwnershipLapsed(unownedGraceMs, lapsedForMs),
  );

const stranded = (unownedGraceMs: number) =>
  and(
    eq(workspaceRuntimeInstances.status, "pending"),
    isNotNull(workspaceRuntimeInstances.resourceId),
    or(
      and(
        isNotNull(workspaceRuntimeInstances.launchOwner),
        or(
          isNull(workspaceRuntimeInstances.launchLeaseExpiresAt),
          lte(workspaceRuntimeInstances.launchLeaseExpiresAt, sql`now()`),
        ),
      ),
      and(
        isNull(workspaceRuntimeInstances.launchOwner),
        lte(
          workspaceRuntimeInstances.updatedAt,
          sql`now() - (${Math.max(0, Math.round(unownedGraceMs))} * interval '1 millisecond')`,
        ),
      ),
    ),
  );

export class WorkspaceRuntimeInstanceRepo extends Context.Service<
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoService
>()("WorkspaceRuntimeInstanceRepo") {}

export const WorkspaceRuntimeInstanceRepoLive = Layer.effect(
  WorkspaceRuntimeInstanceRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      upsertRuntimeInstance: (input) =>
        withWorkspaceRuntimeInstanceRepoError(
          "upsertRuntimeInstance",
          Effect.gen(function* () {
            const mutableColumns = {
              status: input.status,
              ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
              ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
              ...(input.reference === undefined ? {} : { reference: input.reference }),
              ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
              ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
              ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
              ...(input.launchCredentialInjections === undefined
                ? {}
                : { launchCredentialInjections: [...input.launchCredentialInjections] }),
              ...(input.launchedAt === undefined ? {} : { launchedAt: input.launchedAt }),
              ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
              ...(input.runtimeDeadlineAt === undefined
                ? {}
                : { runtimeDeadlineAt: input.runtimeDeadlineAt }),
              ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
              ...(input.launchOwner === undefined && input.fenceLaunchOwner === undefined
                ? {}
                : {
                    launchOwner: input.launchOwner ?? input.fenceLaunchOwner,
                    launchLeaseExpiresAt: sql`now() + (${Math.max(
                      0,
                      Math.round(input.launchLeaseMs ?? 0),
                    )} * interval '1 millisecond')`,
                  }),
              ...(input.releaseLaunch === true
                ? { launchOwner: null, launchLeaseExpiresAt: null }
                : {}),
              ...(input.daemonImage === undefined ? {} : { daemonImage: input.daemonImage }),
              ...(input.daemonRecoveryBoot === undefined
                ? {}
                : { daemonRecoveryBoot: input.daemonRecoveryBoot }),
            };

            // A late "failed" upsert from a superseded/stale worker (a redelivery or reaper
            // interleaving after a newer launch already went "ready") must NOT clobber a live
            // "ready" instance — guard the conflict update so a "failed" write is skipped when ready.
            const guardAgainstReady = input.status === "failed";
            // A launch write fenced on its owner lands only while the launch is still theirs.
            const fence =
              input.fenceLaunchOwner === undefined
                ? undefined
                : and(
                    eq(workspaceRuntimeInstances.status, "pending"),
                    eq(workspaceRuntimeInstances.launchOwner, input.fenceLaunchOwner),
                  );

            if (fence !== undefined) {
              const [fenced] = yield* db
                .update(workspaceRuntimeInstances)
                .set(mutableColumns)
                .where(and(eq(workspaceRuntimeInstances.runId, input.runId), fence))
                .returning();
              if (fenced !== undefined) {
                return fenced;
              }
              return yield* new WorkspaceRuntimeInstanceRepoInvariantError({
                operation: "upsertRuntimeInstance",
                message: LAUNCH_OWNERSHIP_LOST_MESSAGE,
              });
            }

            const [runtimeInstance] = yield* db
              .insert(workspaceRuntimeInstances)
              .values({
                runId: input.runId,
                ...mutableColumns,
              })
              .onConflictDoUpdate({
                target: workspaceRuntimeInstances.runId,
                set: mutableColumns,
                ...(guardAgainstReady
                  ? { setWhere: ne(workspaceRuntimeInstances.status, "ready") }
                  : {}),
              })
              .returning();

            if (runtimeInstance !== undefined) {
              return runtimeInstance;
            }

            // No row returned: with the ready-guard this means the conflict update was skipped because
            // the existing instance is already "ready" — that row won, so return it instead of erroring.
            if (guardAgainstReady) {
              const [existing] = yield* db
                .select()
                .from(workspaceRuntimeInstances)
                .where(eq(workspaceRuntimeInstances.runId, input.runId));
              if (existing !== undefined) {
                return existing;
              }
            }

            return yield* new WorkspaceRuntimeInstanceRepoInvariantError({
              operation: "upsertRuntimeInstance",
              message: `Failed to upsert runtime instance for run ${input.runId}.`,
            });
          }),
        ),

      markExited: (input) =>
        withWorkspaceRuntimeInstanceRepoError(
          "markExited",
          Effect.gen(function* () {
            const [updated] = yield* db
              .update(workspaceRuntimeInstances)
              .set({
                status: "failed",
                errorCode: RUNTIME_EXITED_ERROR_CODE,
                errorMessage: input.errorMessage,
                finishedAt: input.finishedAt ?? new Date(),
              })
              .where(
                and(
                  eq(workspaceRuntimeInstances.runId, input.runId),
                  eq(workspaceRuntimeInstances.status, "ready"),
                  eq(workspaceRuntimeInstances.resourceId, input.resourceId),
                  // A stop under way owns the exit: it settles the row `stopped`.
                  isNull(workspaceRuntimeInstances.stopReason),
                ),
              )
              .returning();

            return updated;
          }),
        ),

      markStopRequested: (input) =>
        withWorkspaceRuntimeInstanceRepoError(
          "markStopRequested",
          db
            .update(workspaceRuntimeInstances)
            .set({ stopReason: input.stopReason })
            .where(
              and(
                eq(workspaceRuntimeInstances.runId, input.runId),
                ne(workspaceRuntimeInstances.status, "stopped"),
                isNull(workspaceRuntimeInstances.stopReason),
              ),
            )
            .pipe(Effect.asVoid),
        ),

      markStopped: (input) =>
        withWorkspaceRuntimeInstanceRepoError(
          "markStopped",
          Effect.gen(function* () {
            const [updated] = yield* db
              .update(workspaceRuntimeInstances)
              .set({
                status: "stopped",
                stopReason: input.stopReason,
                finishedAt: input.finishedAt ?? new Date(),
              })
              .where(
                and(
                  eq(workspaceRuntimeInstances.runId, input.runId),
                  ne(workspaceRuntimeInstances.status, "stopped"),
                ),
              )
              .returning();

            if (updated !== undefined) {
              return updated;
            }

            // No row updated: either the instance is already stopped (idempotent success — the
            // first stop's reason stands) or it never existed (invariant).
            const [existing] = yield* db
              .select()
              .from(workspaceRuntimeInstances)
              .where(eq(workspaceRuntimeInstances.runId, input.runId))
              .limit(1);

            if (existing !== undefined) {
              return existing;
            }

            return yield* new WorkspaceRuntimeInstanceRepoInvariantError({
              operation: "markStopped",
              message: `No runtime instance exists for run ${input.runId}.`,
            });
          }),
        ),

      getRuntimeInstanceByRunId: (runId) =>
        withWorkspaceRuntimeInstanceRepoError(
          "getRuntimeInstanceByRunId",
          Effect.gen(function* () {
            const [runtimeInstance] = yield* db
              .select()
              .from(workspaceRuntimeInstances)
              .where(eq(workspaceRuntimeInstances.runId, runId))
              .limit(1);

            return runtimeInstance;
          }),
        ),

      listRuntimeInstancesByRunIds: (runIds) =>
        withWorkspaceRuntimeInstanceRepoError(
          "listRuntimeInstancesByRunIds",
          Effect.gen(function* () {
            if (runIds.length === 0) {
              return new Map();
            }

            const rows = yield* db
              .select()
              .from(workspaceRuntimeInstances)
              .where(inArray(workspaceRuntimeInstances.runId, [...runIds]))
              .orderBy(desc(workspaceRuntimeInstances.updatedAt));

            return new Map(
              rows.map((row: WorkspaceRuntimeInstance) => {
                return [row.runId, row] as const;
              }),
            );
          }),
        ),

      listRunningInstances: () =>
        withWorkspaceRuntimeInstanceRepoError(
          "listRunningInstances",
          db
            .select()
            .from(workspaceRuntimeInstances)
            // "ready" = control channel accepting. The launch path no longer emits "running", so
            // keying on "ready" finds the instances that are actually reachable (e.g. for telemetry).
            .where(eq(workspaceRuntimeInstances.status, "ready"))
            .orderBy(desc(workspaceRuntimeInstances.updatedAt)),
        ),

      listRetainedLaunches: () =>
        withWorkspaceRuntimeInstanceRepoError(
          "listRetainedLaunches",
          db
            .select()
            .from(workspaceRuntimeInstances)
            .where(
              and(
                eq(workspaceRuntimeInstances.status, "failed"),
                eq(workspaceRuntimeInstances.errorCode, LAUNCH_RETAINED_ERROR_CODE),
              ),
            )
            .orderBy(desc(workspaceRuntimeInstances.updatedAt)),
        ),

      listStrandedLaunches: (input) =>
        withWorkspaceRuntimeInstanceRepoError(
          "listStrandedLaunches",
          db
            .select()
            .from(workspaceRuntimeInstances)
            .where(stranded(input.unownedGraceMs))
            .orderBy(desc(workspaceRuntimeInstances.updatedAt)),
        ),

      adoptStrandedLaunch: (input) =>
        withWorkspaceRuntimeInstanceRepoError(
          "adoptStrandedLaunch",
          Effect.gen(function* () {
            const [adopted] = yield* db
              .update(workspaceRuntimeInstances)
              .set({
                status: "failed",
                errorCode: LAUNCH_RETAINED_ERROR_CODE,
                errorMessage: input.errorMessage,
                launchOwner: null,
                launchLeaseExpiresAt: null,
              })
              .where(
                and(
                  eq(workspaceRuntimeInstances.runId, input.runId),
                  stranded(input.unownedGraceMs),
                ),
              )
              .returning();
            return adopted;
          }),
        ),

      listUnidentifiedStrandedLaunches: (input) =>
        withWorkspaceRuntimeInstanceRepoError(
          "listUnidentifiedStrandedLaunches",
          db
            .select()
            .from(workspaceRuntimeInstances)
            .where(strandedUnidentified(input.unownedGraceMs))
            .orderBy(desc(workspaceRuntimeInstances.updatedAt)),
        ),

      identifyStrandedLaunch: (input) =>
        withWorkspaceRuntimeInstanceRepoError(
          "identifyStrandedLaunch",
          Effect.gen(function* () {
            const [identified] = yield* db
              .update(workspaceRuntimeInstances)
              .set({
                adapter: input.adapter,
                resourceId: input.resourceId,
                reference: input.reference,
                ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
              })
              .where(
                and(
                  eq(workspaceRuntimeInstances.runId, input.runId),
                  strandedUnidentified(input.unownedGraceMs),
                ),
              )
              .returning();
            return identified;
          }),
        ),

      failLostLaunch: (input) =>
        withWorkspaceRuntimeInstanceRepoError(
          "failLostLaunch",
          Effect.gen(function* () {
            const [failed] = yield* db
              .update(workspaceRuntimeInstances)
              .set({
                status: "failed",
                errorCode: LAUNCH_LOST_ERROR_CODE,
                errorMessage: input.errorMessage,
                launchOwner: null,
                launchLeaseExpiresAt: null,
                finishedAt: new Date(),
              })
              .where(
                and(
                  eq(workspaceRuntimeInstances.runId, input.runId),
                  strandedUnidentified(input.unownedGraceMs, input.lostGraceMs),
                ),
              )
              .returning();
            return failed;
          }),
        ),

      renewLaunchLease: (input) =>
        withWorkspaceRuntimeInstanceRepoError(
          "renewLaunchLease",
          Effect.gen(function* () {
            const renewed = yield* db
              .update(workspaceRuntimeInstances)
              .set({
                launchLeaseExpiresAt: sql`now() + (${Math.max(0, Math.round(input.leaseMs))} * interval '1 millisecond')`,
              })
              .where(
                and(
                  eq(workspaceRuntimeInstances.runId, input.runId),
                  eq(workspaceRuntimeInstances.status, "pending"),
                  eq(workspaceRuntimeInstances.launchOwner, input.owner),
                ),
              )
              .returning({ runId: workspaceRuntimeInstances.runId });
            return renewed.length > 0;
          }),
        ),

      listPreservationCandidates: () =>
        withWorkspaceRuntimeInstanceRepoError(
          "listPreservationCandidates",
          db
            .select()
            .from(workspaceRuntimeInstances)
            .where(
              and(
                isNotNull(workspaceRuntimeInstances.runtimeDeadlineAt),
                isNotNull(workspaceRuntimeInstances.resourceId),
                or(
                  eq(workspaceRuntimeInstances.status, "ready"),
                  eq(workspaceRuntimeInstances.status, "pending"),
                  and(
                    eq(workspaceRuntimeInstances.status, "failed"),
                    gt(workspaceRuntimeInstances.runtimeDeadlineAt, sql`now()`),
                  ),
                ),
              ),
            )
            .orderBy(desc(workspaceRuntimeInstances.updatedAt)),
        ),
    } satisfies WorkspaceRuntimeInstanceRepoService;
  }),
);
