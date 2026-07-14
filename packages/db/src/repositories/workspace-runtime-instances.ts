import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  workspaceRuntimeInstances,
  type NewWorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceStatus,
  type WorkspaceRuntimeInstanceStopReason,
} from "../schema.js";

export interface UpsertWorkspaceRuntimeInstanceInput {
  readonly runId: string;
  readonly status: WorkspaceRuntimeInstanceStatus;
  readonly adapter?: "docker" | "k8s" | "k3s";
  readonly resourceId?: string;
  readonly reference?: string;
  readonly endpoint?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly launchedAt?: Date;
  readonly finishedAt?: Date;
}

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
  "listRunningDockerInstances",
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

export interface WorkspaceRuntimeInstanceRepoService {
  readonly upsertRuntimeInstance: (
    input: UpsertWorkspaceRuntimeInstanceInput,
  ) => Effect.Effect<WorkspaceRuntimeInstance, WorkspaceRuntimeInstanceRepoError>;
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
  /** All runtime instances currently `running` on the docker adapter (reachable by the telemetry ingester). */
  readonly listRunningDockerInstances: () => Effect.Effect<
    readonly WorkspaceRuntimeInstance[],
    WorkspaceRuntimeInstanceRepoError
  >;
}

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
              ...(input.launchedAt === undefined ? {} : { launchedAt: input.launchedAt }),
              ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
            };

            // A late "failed" upsert from a superseded/stale worker (a redelivery or reaper
            // interleaving after a newer launch already went "ready") must NOT clobber a live
            // "ready" instance — guard the conflict update so a "failed" write is skipped when ready.
            const guardAgainstReady = input.status === "failed";

            const [runtimeInstance] = yield* db
              .insert(workspaceRuntimeInstances)
              .values({
                runId: input.runId,
                ...mutableColumns,
              } satisfies NewWorkspaceRuntimeInstance)
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

      listRunningDockerInstances: () =>
        withWorkspaceRuntimeInstanceRepoError(
          "listRunningDockerInstances",
          db
            .select()
            .from(workspaceRuntimeInstances)
            .where(
              and(
                // "ready" = control socket accepting. The launch path no longer emits "running", so
                // keying on "ready" finds the instances that are actually reachable (e.g. for telemetry).
                eq(workspaceRuntimeInstances.status, "ready"),
                eq(workspaceRuntimeInstances.adapter, "docker"),
              ),
            )
            .orderBy(desc(workspaceRuntimeInstances.updatedAt)),
        ),
    } satisfies WorkspaceRuntimeInstanceRepoService;
  }),
);
