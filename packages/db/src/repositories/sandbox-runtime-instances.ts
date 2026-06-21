import { desc, eq, inArray } from "drizzle-orm";
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
  "upsertRuntimeInstance",
]);

export class SandboxRuntimeInstanceRepoInvariantError extends Schema.TaggedErrorClass<SandboxRuntimeInstanceRepoInvariantError>()("SandboxRuntimeInstanceRepoInvariantError", {
  operation: sandboxRuntimeInstanceRepoOperationSchema,
  message: Schema.String,
}) {}

export class SandboxRuntimeInstanceRepoUnexpectedError extends Schema.TaggedErrorClass<SandboxRuntimeInstanceRepoUnexpectedError>()("SandboxRuntimeInstanceRepoUnexpectedError", {
  operation: sandboxRuntimeInstanceRepoOperationSchema,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

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
            const [runtimeInstance] = yield* db
              .insert(sandboxRuntimeInstances)
              .values({
                runId: input.runId,
                status: input.status,
                ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
                ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
                ...(input.reference === undefined ? {} : { reference: input.reference }),
                ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
                ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
                ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
                ...(input.launchedAt === undefined ? {} : { launchedAt: input.launchedAt }),
                ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
              } satisfies NewSandboxRuntimeInstance)
              .onConflictDoUpdate({
                target: sandboxRuntimeInstances.runId,
                set: {
                  status: input.status,
                  ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
                  ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
                  ...(input.reference === undefined ? {} : { reference: input.reference }),
                  ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
                  ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
                  ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
                  ...(input.launchedAt === undefined ? {} : { launchedAt: input.launchedAt }),
                  ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
                },
              })
              .returning();

            if (runtimeInstance === undefined) {
              return yield* new SandboxRuntimeInstanceRepoInvariantError({
                operation: "upsertRuntimeInstance",
                message: `Failed to upsert runtime instance for run ${input.runId}.`,
              });
            }

            return runtimeInstance;
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
    } satisfies SandboxRuntimeInstanceRepoService;
  }),
);
