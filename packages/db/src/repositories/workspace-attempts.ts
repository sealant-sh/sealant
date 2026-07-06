import { and, desc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  workspaceAttempts,
  workspaceAttemptSnapshots,
  type NewWorkspaceAttempt,
  type NewWorkspaceAttemptSnapshot,
  type WorkspaceAttempt,
  type WorkspaceAttemptSnapshot,
  type WorkspaceAttemptStatus,
  type WorkspaceAttemptTriggerType,
} from "../schema.js";

export interface CreateQueuedWorkspaceAttemptInput {
  readonly id: string;
  readonly ownerUserId: string;
  readonly repositoryId?: string;
  readonly repositoryProfileRevisionId?: string;
  readonly profileRevisionId?: string;
  readonly triggerType?: WorkspaceAttemptTriggerType;
  readonly triggerRef?: string;
  readonly requestedByUserId?: string;
  readonly retryOfRunId?: string;
  readonly queuedAt?: Date;
}

export interface SetWorkspaceAttemptSnapshotInput {
  readonly runId: string;
  readonly specPayload: WorkspaceAttemptSnapshot["userSpecPayload"];
  readonly profileConfigSnapshot?: WorkspaceAttemptSnapshot["profileConfigSnapshot"];
  readonly repositoryProfileConfigSnapshot?: WorkspaceAttemptSnapshot["repositoryProfileConfigSnapshot"];
}

export interface MarkWorkspaceAttemptRunningInput {
  readonly id: string;
  readonly startedAt?: Date;
}

export interface MarkWorkspaceAttemptSucceededInput {
  readonly id: string;
  readonly finishedAt?: Date;
}

export interface MarkWorkspaceAttemptFailedInput {
  readonly id: string;
  readonly finishedAt?: Date;
}

export interface MarkWorkspaceAttemptCancelledInput {
  readonly id: string;
  readonly cancelReason: string;
  readonly finishedAt?: Date;
}

export interface ListWorkspaceAttemptsInput {
  readonly ownerUserId?: string;
  readonly repositoryId?: string;
  readonly statuses?: readonly WorkspaceAttemptStatus[];
  readonly limit?: number;
}

/** @deprecated Use WorkspaceAttemptRepo + WorkspaceAttemptRepoLive instead. */
export const createWorkspaceAttemptRepository = (): never => {
  throw new Error("createWorkspaceAttemptRepository is disabled during the Effect transition.");
};

/** @deprecated Use WorkspaceAttemptRepoService instead. */
export type WorkspaceAttemptRepository = WorkspaceAttemptRepoService;

const workspaceAttemptRepoOperationSchema = Schema.Literals([
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

export class WorkspaceAttemptRepoInvariantError extends Schema.TaggedErrorClass<WorkspaceAttemptRepoInvariantError>()(
  "WorkspaceAttemptRepoInvariantError",
  {
    operation: workspaceAttemptRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class WorkspaceAttemptRepoUnexpectedError extends Schema.TaggedErrorClass<WorkspaceAttemptRepoUnexpectedError>()(
  "WorkspaceAttemptRepoUnexpectedError",
  {
    operation: workspaceAttemptRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const workspaceAttemptRepoErrorSchema = Schema.Union([
  WorkspaceAttemptRepoInvariantError,
  WorkspaceAttemptRepoUnexpectedError,
]);

export type WorkspaceAttemptRepoError = typeof workspaceAttemptRepoErrorSchema.Type;

type WorkspaceAttemptRepoOperation = typeof workspaceAttemptRepoOperationSchema.Type;

const mapWorkspaceAttemptRepoError = (
  operation: WorkspaceAttemptRepoOperation,
  cause: unknown,
): WorkspaceAttemptRepoError => {
  if (
    cause instanceof WorkspaceAttemptRepoInvariantError ||
    cause instanceof WorkspaceAttemptRepoUnexpectedError
  ) {
    return cause;
  }

  return new WorkspaceAttemptRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withWorkspaceAttemptRepoError = <A>(
  operation: WorkspaceAttemptRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, WorkspaceAttemptRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapWorkspaceAttemptRepoError(operation, cause)));
};

export interface WorkspaceAttemptRepoService {
  readonly createQueuedAttempt: (
    input: CreateQueuedWorkspaceAttemptInput,
  ) => Effect.Effect<WorkspaceAttempt, WorkspaceAttemptRepoError>;
  readonly getAttemptById: (
    id: string,
  ) => Effect.Effect<WorkspaceAttempt | undefined, WorkspaceAttemptRepoError>;
  readonly getAttemptSnapshotByRunId: (
    runId: string,
  ) => Effect.Effect<WorkspaceAttemptSnapshot | undefined, WorkspaceAttemptRepoError>;
  readonly setAttemptSnapshot: (
    input: SetWorkspaceAttemptSnapshotInput,
  ) => Effect.Effect<WorkspaceAttemptSnapshot, WorkspaceAttemptRepoError>;
  readonly markAttemptRunning: (
    input: MarkWorkspaceAttemptRunningInput,
  ) => Effect.Effect<WorkspaceAttempt | null, WorkspaceAttemptRepoError>;
  readonly markAttemptSucceeded: (
    input: MarkWorkspaceAttemptSucceededInput,
  ) => Effect.Effect<WorkspaceAttempt | null, WorkspaceAttemptRepoError>;
  readonly markAttemptFailed: (
    input: MarkWorkspaceAttemptFailedInput,
  ) => Effect.Effect<WorkspaceAttempt | null, WorkspaceAttemptRepoError>;
  readonly markAttemptCancelled: (
    input: MarkWorkspaceAttemptCancelledInput,
  ) => Effect.Effect<WorkspaceAttempt | null, WorkspaceAttemptRepoError>;
  readonly listAttempts: (
    input?: ListWorkspaceAttemptsInput,
  ) => Effect.Effect<readonly WorkspaceAttempt[], WorkspaceAttemptRepoError>;
}

export class WorkspaceAttemptRepo extends Context.Service<
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoService
>()("WorkspaceAttemptRepo") {}

export const WorkspaceAttemptRepoLive = Layer.effect(
  WorkspaceAttemptRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    const finalizeAttempt = (
      id: string,
      status: WorkspaceAttemptStatus,
      finishedAt: Date,
      extra: Partial<Pick<WorkspaceAttempt, "cancelReason">> = {},
    ): Effect.Effect<WorkspaceAttempt | null, unknown> => {
      return db.transaction((tx) =>
        Effect.gen(function* () {
          const [existing] = yield* tx
            .select()
            .from(workspaceAttempts)
            .where(eq(workspaceAttempts.id, id))
            .limit(1);

          if (existing === undefined) {
            return null;
          }

          const durationMs =
            existing.startedAt === null
              ? null
              : Math.max(0, finishedAt.getTime() - existing.startedAt.getTime());

          const [updated] = yield* tx
            .update(workspaceAttempts)
            .set({
              status,
              finishedAt,
              durationMs,
              ...extra,
            })
            .where(eq(workspaceAttempts.id, id))
            .returning();

          return updated ?? null;
        }),
      );
    };

    return {
      createQueuedAttempt: (input) =>
        withWorkspaceAttemptRepoError(
          "createQueuedAttempt",
          Effect.gen(function* () {
            const [attempt] = yield* db
              .insert(workspaceAttempts)
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
              } satisfies NewWorkspaceAttempt)
              .returning();

            if (attempt === undefined) {
              return yield* new WorkspaceAttemptRepoInvariantError({
                operation: "createQueuedAttempt",
                message: "Failed to create queued workspace attempt.",
              });
            }

            return attempt;
          }),
        ),

      getAttemptById: (id) =>
        withWorkspaceAttemptRepoError(
          "getAttemptById",
          Effect.gen(function* () {
            const [attempt] = yield* db
              .select()
              .from(workspaceAttempts)
              .where(eq(workspaceAttempts.id, id))
              .limit(1);

            return attempt;
          }),
        ),

      getAttemptSnapshotByRunId: (runId) =>
        withWorkspaceAttemptRepoError(
          "getAttemptSnapshotByRunId",
          Effect.gen(function* () {
            const [snapshot] = yield* db
              .select()
              .from(workspaceAttemptSnapshots)
              .where(eq(workspaceAttemptSnapshots.runId, runId))
              .limit(1);

            return snapshot;
          }),
        ),

      setAttemptSnapshot: (input) =>
        withWorkspaceAttemptRepoError(
          "setAttemptSnapshot",
          Effect.gen(function* () {
            const [snapshot] = yield* db
              .insert(workspaceAttemptSnapshots)
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
              } satisfies NewWorkspaceAttemptSnapshot)
              .onConflictDoUpdate({
                target: workspaceAttemptSnapshots.runId,
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
              return yield* new WorkspaceAttemptRepoInvariantError({
                operation: "setAttemptSnapshot",
                message: `Failed to set attempt snapshot for ${input.runId}.`,
              });
            }

            return snapshot;
          }),
        ),

      markAttemptRunning: (input) =>
        withWorkspaceAttemptRepoError(
          "markAttemptRunning",
          Effect.gen(function* () {
            const startedAt = input.startedAt ?? new Date();
            const [attempt] = yield* db
              .update(workspaceAttempts)
              .set({
                status: "running",
                startedAt,
              })
              .where(eq(workspaceAttempts.id, input.id))
              .returning();

            return attempt ?? null;
          }),
        ),

      markAttemptSucceeded: (input) =>
        withWorkspaceAttemptRepoError(
          "markAttemptSucceeded",
          finalizeAttempt(input.id, "succeeded", input.finishedAt ?? new Date()),
        ),

      markAttemptFailed: (input) =>
        withWorkspaceAttemptRepoError(
          "markAttemptFailed",
          finalizeAttempt(input.id, "failed", input.finishedAt ?? new Date()),
        ),

      markAttemptCancelled: (input) =>
        withWorkspaceAttemptRepoError(
          "markAttemptCancelled",
          finalizeAttempt(input.id, "cancelled", input.finishedAt ?? new Date(), {
            cancelReason: input.cancelReason,
          }),
        ),

      listAttempts: (input = {}) =>
        withWorkspaceAttemptRepoError(
          "listAttempts",
          Effect.gen(function* () {
            const whereClauses = [
              ...(input.ownerUserId === undefined
                ? []
                : [eq(workspaceAttempts.ownerUserId, input.ownerUserId)]),
              ...(input.repositoryId === undefined
                ? []
                : [eq(workspaceAttempts.repositoryId, input.repositoryId)]),
              ...(input.statuses === undefined || input.statuses.length === 0
                ? []
                : [inArray(workspaceAttempts.status, [...input.statuses])]),
            ];

            if (whereClauses.length === 0) {
              return yield* db
                .select()
                .from(workspaceAttempts)
                .orderBy(desc(workspaceAttempts.createdAt))
                .limit(input.limit ?? 100);
            }

            return yield* db
              .select()
              .from(workspaceAttempts)
              .where(and(...whereClauses))
              .orderBy(desc(workspaceAttempts.createdAt))
              .limit(input.limit ?? 100);
          }),
        ),
    } satisfies WorkspaceAttemptRepoService;
  }),
);
