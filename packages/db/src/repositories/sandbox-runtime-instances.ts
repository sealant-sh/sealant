import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  sandboxRuntimeInstances,
  type NewSandboxRuntimeInstance,
  type SandboxRuntimeInstance,
  type SandboxRuntimeInstanceStatus,
} from "../schema.js";

export interface UpsertSandboxRuntimeInstanceInput {
  readonly runId: string;
  readonly status: SandboxRuntimeInstanceStatus;
  readonly adapter?: "docker" | "k8s" | "k3s";
  readonly resourceId?: string;
  readonly reference?: string;
  readonly endpoint?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly launchedAt?: Date;
  readonly finishedAt?: Date;
}

/** @deprecated Use SandboxRuntimeInstanceRepo + SandboxRuntimeInstanceRepoLive instead. */
export const createSandboxRuntimeInstanceRepository = (): never => {
  throw new Error(
    "createSandboxRuntimeInstanceRepository is disabled during the Effect transition.",
  );
};

/** @deprecated Use SandboxRuntimeInstanceRepoService instead. */
export type SandboxRuntimeInstanceRepository = SandboxRuntimeInstanceRepoService;

const sandboxRuntimeInstanceRepoOperationSchema = Schema.Literals([
  "getRuntimeInstanceByRunId",
  "listRuntimeInstancesByRunIds",
  "listRunningDockerInstances",
  "upsertRuntimeInstance",
]);

export class SandboxRuntimeInstanceRepoInvariantError extends Schema.TaggedErrorClass<SandboxRuntimeInstanceRepoInvariantError>()(
  "SandboxRuntimeInstanceRepoInvariantError",
  {
    operation: sandboxRuntimeInstanceRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class SandboxRuntimeInstanceRepoUnexpectedError extends Schema.TaggedErrorClass<SandboxRuntimeInstanceRepoUnexpectedError>()(
  "SandboxRuntimeInstanceRepoUnexpectedError",
  {
    operation: sandboxRuntimeInstanceRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const sandboxRuntimeInstanceRepoErrorSchema = Schema.Union([
  SandboxRuntimeInstanceRepoInvariantError,
  SandboxRuntimeInstanceRepoUnexpectedError,
]);

export type SandboxRuntimeInstanceRepoError = typeof sandboxRuntimeInstanceRepoErrorSchema.Type;

type SandboxRuntimeInstanceRepoOperation = typeof sandboxRuntimeInstanceRepoOperationSchema.Type;

const mapSandboxRuntimeInstanceRepoError = (
  operation: SandboxRuntimeInstanceRepoOperation,
  cause: unknown,
): SandboxRuntimeInstanceRepoError => {
  if (
    cause instanceof SandboxRuntimeInstanceRepoInvariantError ||
    cause instanceof SandboxRuntimeInstanceRepoUnexpectedError
  ) {
    return cause;
  }

  return new SandboxRuntimeInstanceRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withSandboxRuntimeInstanceRepoError = <A>(
  operation: SandboxRuntimeInstanceRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, SandboxRuntimeInstanceRepoError> => {
  return effect.pipe(
    Effect.mapError((cause) => mapSandboxRuntimeInstanceRepoError(operation, cause)),
  );
};

export interface SandboxRuntimeInstanceRepoService {
  readonly upsertRuntimeInstance: (
    input: UpsertSandboxRuntimeInstanceInput,
  ) => Effect.Effect<SandboxRuntimeInstance, SandboxRuntimeInstanceRepoError>;
  readonly getRuntimeInstanceByRunId: (
    runId: string,
  ) => Effect.Effect<SandboxRuntimeInstance | undefined, SandboxRuntimeInstanceRepoError>;
  readonly listRuntimeInstancesByRunIds: (
    runIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, SandboxRuntimeInstance>, SandboxRuntimeInstanceRepoError>;
  /** All runtime instances currently `running` on the docker adapter (reachable by the telemetry ingester). */
  readonly listRunningDockerInstances: () => Effect.Effect<
    readonly SandboxRuntimeInstance[],
    SandboxRuntimeInstanceRepoError
  >;
}

export class SandboxRuntimeInstanceRepo extends Context.Service<
  SandboxRuntimeInstanceRepo,
  SandboxRuntimeInstanceRepoService
>()("SandboxRuntimeInstanceRepo") {}

export const SandboxRuntimeInstanceRepoLive = Layer.effect(
  SandboxRuntimeInstanceRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      upsertRuntimeInstance: (input) =>
        withSandboxRuntimeInstanceRepoError(
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
              .insert(sandboxRuntimeInstances)
              .values({ runId: input.runId, ...mutableColumns } satisfies NewSandboxRuntimeInstance)
              .onConflictDoUpdate({
                target: sandboxRuntimeInstances.runId,
                set: mutableColumns,
                ...(guardAgainstReady
                  ? { setWhere: ne(sandboxRuntimeInstances.status, "ready") }
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
                .from(sandboxRuntimeInstances)
                .where(eq(sandboxRuntimeInstances.runId, input.runId));
              if (existing !== undefined) {
                return existing;
              }
            }

            return yield* new SandboxRuntimeInstanceRepoInvariantError({
              operation: "upsertRuntimeInstance",
              message: `Failed to upsert runtime instance for run ${input.runId}.`,
            });
          }),
        ),

      getRuntimeInstanceByRunId: (runId) =>
        withSandboxRuntimeInstanceRepoError(
          "getRuntimeInstanceByRunId",
          Effect.gen(function* () {
            const [runtimeInstance] = yield* db
              .select()
              .from(sandboxRuntimeInstances)
              .where(eq(sandboxRuntimeInstances.runId, runId))
              .limit(1);

            return runtimeInstance;
          }),
        ),

      listRuntimeInstancesByRunIds: (runIds) =>
        withSandboxRuntimeInstanceRepoError(
          "listRuntimeInstancesByRunIds",
          Effect.gen(function* () {
            if (runIds.length === 0) {
              return new Map();
            }

            const rows = yield* db
              .select()
              .from(sandboxRuntimeInstances)
              .where(inArray(sandboxRuntimeInstances.runId, [...runIds]))
              .orderBy(desc(sandboxRuntimeInstances.updatedAt));

            return new Map(
              rows.map((row: SandboxRuntimeInstance) => {
                return [row.runId, row] as const;
              }),
            );
          }),
        ),

      listRunningDockerInstances: () =>
        withSandboxRuntimeInstanceRepoError(
          "listRunningDockerInstances",
          db
            .select()
            .from(sandboxRuntimeInstances)
            .where(
              and(
                // "ready" = control socket accepting. The launch path no longer emits "running", so
                // keying on "ready" finds the instances that are actually reachable (e.g. for telemetry).
                eq(sandboxRuntimeInstances.status, "ready"),
                eq(sandboxRuntimeInstances.adapter, "docker"),
              ),
            )
            .orderBy(desc(sandboxRuntimeInstances.updatedAt)),
        ),
    } satisfies SandboxRuntimeInstanceRepoService;
  }),
);
