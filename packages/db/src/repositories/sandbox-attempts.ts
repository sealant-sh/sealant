import { and, desc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  sandboxAttempts,
  sandboxAttemptSnapshots,
  type NewSandboxAttempt,
  type NewSandboxAttemptSnapshot,
  type SandboxAttempt,
  type SandboxAttemptSnapshot,
  type SandboxAttemptStatus,
  type SandboxAttemptTriggerType,
} from "../schema.js";

export interface CreateQueuedSandboxAttemptInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly repositoryId?: string;
  readonly repositoryProfileRevisionId?: string;
  readonly profileRevisionId?: string;
  readonly triggerType?: SandboxAttemptTriggerType;
  readonly triggerRef?: string;
  readonly requestedByUserId?: string;
  readonly retryOfRunId?: string;
  readonly queuedAt?: Date;
}

export interface SetSandboxAttemptSnapshotInput {
  readonly runId: string;
  readonly specPayload: SandboxAttemptSnapshot["userSpecPayload"];
  readonly profileConfigSnapshot?: SandboxAttemptSnapshot["profileConfigSnapshot"];
  readonly repositoryProfileConfigSnapshot?: SandboxAttemptSnapshot["repositoryProfileConfigSnapshot"];
}

export interface MarkSandboxAttemptRunningInput {
  readonly id: string;
  readonly startedAt?: Date;
}

export interface MarkSandboxAttemptSucceededInput {
  readonly id: string;
  readonly finishedAt?: Date;
}

export interface MarkSandboxAttemptFailedInput {
  readonly id: string;
  readonly finishedAt?: Date;
}

export interface MarkSandboxAttemptCancelledInput {
  readonly id: string;
  readonly cancelReason: string;
  readonly finishedAt?: Date;
}

export interface ListSandboxAttemptsInput {
  readonly ownerUserId?: string;
  readonly repositoryId?: string;
  readonly statuses?: readonly SandboxAttemptStatus[];
  readonly limit?: number;
}

/** @deprecated Use SandboxAttemptRepo + SandboxAttemptRepoLive instead. */
export const createSandboxAttemptRepository = (): never => {
  throw new Error("createSandboxAttemptRepository is disabled during the Effect transition.");
};

/** @deprecated Use SandboxAttemptRepoService instead. */
export type SandboxAttemptRepository = SandboxAttemptRepoService;

const sandboxAttemptRepoOperationSchema = Schema.Literals([
  "createQueuedAttempt",
  "getAttemptById",
  "getAttemptSnapshotByRunId",
  "listAttempts",
  "markAttemptCancelled",
  "markAttemptFailed",
  "markAttemptRunning",
  "markAttemptSucceeded",
  "setAttemptSnapshot",
]);

export class SandboxAttemptRepoInvariantError extends Schema.TaggedErrorClass<SandboxAttemptRepoInvariantError>()(
  "SandboxAttemptRepoInvariantError",
  {
    operation: sandboxAttemptRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class SandboxAttemptRepoUnexpectedError extends Schema.TaggedErrorClass<SandboxAttemptRepoUnexpectedError>()(
  "SandboxAttemptRepoUnexpectedError",
  {
    operation: sandboxAttemptRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const sandboxAttemptRepoErrorSchema = Schema.Union([
  SandboxAttemptRepoInvariantError,
  SandboxAttemptRepoUnexpectedError,
]);

export type SandboxAttemptRepoError = typeof sandboxAttemptRepoErrorSchema.Type;

type SandboxAttemptRepoOperation = typeof sandboxAttemptRepoOperationSchema.Type;

const mapSandboxAttemptRepoError = (
  operation: SandboxAttemptRepoOperation,
  cause: unknown,
): SandboxAttemptRepoError => {
  if (
    cause instanceof SandboxAttemptRepoInvariantError ||
    cause instanceof SandboxAttemptRepoUnexpectedError
  ) {
    return cause;
  }

  return new SandboxAttemptRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withSandboxAttemptRepoError = <A>(
  operation: SandboxAttemptRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, SandboxAttemptRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapSandboxAttemptRepoError(operation, cause)));
};

export interface SandboxAttemptRepoService {
  readonly createQueuedAttempt: (
    input: CreateQueuedSandboxAttemptInput,
  ) => Effect.Effect<SandboxAttempt, SandboxAttemptRepoError>;
  readonly getAttemptById: (
    id: string,
  ) => Effect.Effect<SandboxAttempt | undefined, SandboxAttemptRepoError>;
  readonly getAttemptSnapshotByRunId: (
    runId: string,
  ) => Effect.Effect<SandboxAttemptSnapshot | undefined, SandboxAttemptRepoError>;
  readonly setAttemptSnapshot: (
    input: SetSandboxAttemptSnapshotInput,
  ) => Effect.Effect<SandboxAttemptSnapshot, SandboxAttemptRepoError>;
  readonly markAttemptRunning: (
    input: MarkSandboxAttemptRunningInput,
  ) => Effect.Effect<SandboxAttempt | null, SandboxAttemptRepoError>;
  readonly markAttemptSucceeded: (
    input: MarkSandboxAttemptSucceededInput,
  ) => Effect.Effect<SandboxAttempt | null, SandboxAttemptRepoError>;
  readonly markAttemptFailed: (
    input: MarkSandboxAttemptFailedInput,
  ) => Effect.Effect<SandboxAttempt | null, SandboxAttemptRepoError>;
  readonly markAttemptCancelled: (
    input: MarkSandboxAttemptCancelledInput,
  ) => Effect.Effect<SandboxAttempt | null, SandboxAttemptRepoError>;
  readonly listAttempts: (
    input?: ListSandboxAttemptsInput,
  ) => Effect.Effect<readonly SandboxAttempt[], SandboxAttemptRepoError>;
}

export class SandboxAttemptRepo extends Context.Service<
  SandboxAttemptRepo,
  SandboxAttemptRepoService
>()("SandboxAttemptRepo") {}

export const SandboxAttemptRepoLive = Layer.effect(
  SandboxAttemptRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    const finalizeAttempt = (
      id: string,
      status: SandboxAttemptStatus,
      finishedAt: Date,
      extra: Partial<Pick<SandboxAttempt, "cancelReason">> = {},
    ): Effect.Effect<SandboxAttempt | null, unknown> => {
      return db.transaction((tx) =>
        Effect.gen(function* () {
          const [existing] = yield* tx
            .select()
            .from(sandboxAttempts)
            .where(eq(sandboxAttempts.id, id))
            .limit(1);

          if (existing === undefined) {
            return null;
          }

          const durationMs =
            existing.startedAt === null
              ? null
              : Math.max(0, finishedAt.getTime() - existing.startedAt.getTime());

          const [updated] = yield* tx
            .update(sandboxAttempts)
            .set({
              status,
              finishedAt,
              durationMs,
              ...extra,
            })
            .where(eq(sandboxAttempts.id, id))
            .returning();

          return updated ?? null;
        }),
      );
    };

    return {
      createQueuedAttempt: (input) =>
        withSandboxAttemptRepoError(
          "createQueuedAttempt",
          Effect.gen(function* () {
            const [attempt] = yield* db
              .insert(sandboxAttempts)
              .values({
                id: input.id,
                ownerUserId: input.ownerUserId,
                ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
                ...(input.repositoryProfileRevisionId === undefined
                  ? {}
                  : { repositoryProfileRevisionId: input.repositoryProfileRevisionId }),
                ...(input.profileRevisionId === undefined
                  ? {}
                  : { profileRevisionId: input.profileRevisionId }),
                ...(input.triggerType === undefined ? {} : { triggerType: input.triggerType }),
                ...(input.triggerRef === undefined ? {} : { triggerRef: input.triggerRef }),
                ...(input.requestedByUserId === undefined
                  ? {}
                  : { requestedByUserId: input.requestedByUserId }),
                ...(input.retryOfRunId === undefined ? {} : { retryOfRunId: input.retryOfRunId }),
                ...(input.queuedAt === undefined ? {} : { queuedAt: input.queuedAt }),
              } satisfies NewSandboxAttempt)
              .returning();

            if (attempt === undefined) {
              return yield* new SandboxAttemptRepoInvariantError({
                operation: "createQueuedAttempt",
                message: "Failed to create queued sandbox attempt.",
              });
            }

            return attempt;
          }),
        ),

      getAttemptById: (id) =>
        withSandboxAttemptRepoError(
          "getAttemptById",
          Effect.gen(function* () {
            const [attempt] = yield* db
              .select()
              .from(sandboxAttempts)
              .where(eq(sandboxAttempts.id, id))
              .limit(1);

            return attempt;
          }),
        ),

      getAttemptSnapshotByRunId: (runId) =>
        withSandboxAttemptRepoError(
          "getAttemptSnapshotByRunId",
          Effect.gen(function* () {
            const [snapshot] = yield* db
              .select()
              .from(sandboxAttemptSnapshots)
              .where(eq(sandboxAttemptSnapshots.runId, runId))
              .limit(1);

            return snapshot;
          }),
        ),

      setAttemptSnapshot: (input) =>
        withSandboxAttemptRepoError(
          "setAttemptSnapshot",
          Effect.gen(function* () {
            const [snapshot] = yield* db
              .insert(sandboxAttemptSnapshots)
              .values({
                runId: input.runId,
                userSpecPayload: input.specPayload,
                resolvedSpecPayload: input.specPayload,
                blueprintPayload: input.specPayload,
                ...(input.profileConfigSnapshot === undefined
                  ? {}
                  : { profileConfigSnapshot: input.profileConfigSnapshot }),
                ...(input.repositoryProfileConfigSnapshot === undefined
                  ? {}
                  : { repositoryProfileConfigSnapshot: input.repositoryProfileConfigSnapshot }),
              } satisfies NewSandboxAttemptSnapshot)
              .onConflictDoUpdate({
                target: sandboxAttemptSnapshots.runId,
                set: {
                  userSpecPayload: input.specPayload,
                  resolvedSpecPayload: input.specPayload,
                  blueprintPayload: input.specPayload,
                  ...(input.profileConfigSnapshot === undefined
                    ? {}
                    : { profileConfigSnapshot: input.profileConfigSnapshot }),
                  ...(input.repositoryProfileConfigSnapshot === undefined
                    ? {}
                    : { repositoryProfileConfigSnapshot: input.repositoryProfileConfigSnapshot }),
                },
              })
              .returning();

            if (snapshot === undefined) {
              return yield* new SandboxAttemptRepoInvariantError({
                operation: "setAttemptSnapshot",
                message: `Failed to set attempt snapshot for ${input.runId}.`,
              });
            }

            return snapshot;
          }),
        ),

      markAttemptRunning: (input) =>
        withSandboxAttemptRepoError(
          "markAttemptRunning",
          Effect.gen(function* () {
            const startedAt = input.startedAt ?? new Date();
            const [attempt] = yield* db
              .update(sandboxAttempts)
              .set({
                status: "running",
                startedAt,
              })
              .where(eq(sandboxAttempts.id, input.id))
              .returning();

            return attempt ?? null;
          }),
        ),

      markAttemptSucceeded: (input) =>
        withSandboxAttemptRepoError(
          "markAttemptSucceeded",
          finalizeAttempt(input.id, "succeeded", input.finishedAt ?? new Date()),
        ),

      markAttemptFailed: (input) =>
        withSandboxAttemptRepoError(
          "markAttemptFailed",
          finalizeAttempt(input.id, "failed", input.finishedAt ?? new Date()),
        ),

      markAttemptCancelled: (input) =>
        withSandboxAttemptRepoError(
          "markAttemptCancelled",
          finalizeAttempt(input.id, "cancelled", input.finishedAt ?? new Date(), {
            cancelReason: input.cancelReason,
          }),
        ),

      listAttempts: (input = {}) =>
        withSandboxAttemptRepoError(
          "listAttempts",
          Effect.gen(function* () {
            const whereClauses = [
              ...(input.ownerUserId === undefined
                ? []
                : [eq(sandboxAttempts.ownerUserId, input.ownerUserId)]),
              ...(input.repositoryId === undefined
                ? []
                : [eq(sandboxAttempts.repositoryId, input.repositoryId)]),
              ...(input.statuses === undefined || input.statuses.length === 0
                ? []
                : [inArray(sandboxAttempts.status, [...input.statuses])]),
            ];

            if (whereClauses.length === 0) {
              return yield* db
                .select()
                .from(sandboxAttempts)
                .orderBy(desc(sandboxAttempts.createdAt))
                .limit(input.limit ?? 100);
            }

            return yield* db
              .select()
              .from(sandboxAttempts)
              .where(and(...whereClauses))
              .orderBy(desc(sandboxAttempts.createdAt))
              .limit(input.limit ?? 100);
          }),
        ),
    } satisfies SandboxAttemptRepoService;
  }),
);
