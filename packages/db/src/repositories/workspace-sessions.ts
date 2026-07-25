/**
 * WorkspaceSessionRepo — data access for `workspace_sessions` (durable rows for interactive PTY
 * sessions). The daemon owns the live PTY; this row is the control plane's cross-process handle:
 * any API instance can resolve a session id to its workspace, daemon ids, run, and lifecycle.
 * Mirrors the `RunRepo` idiom: a `Context.Service` whose methods return `Effect`s on a typed
 * `TaggedError` channel, wired with `Layer.effect`.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  workspaceSessions,
  type NewWorkspaceSession,
  type WorkspaceSession,
  type WorkspaceSessionStatus,
} from "../schema.js";

export interface CreateWorkspaceSessionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly ownerUserId: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly cols: number;
  readonly rows: number;
  readonly metadata?: Record<string, unknown>;
}

export interface MarkSessionRunningInput {
  readonly id: string;
  readonly daemonSessionId: string;
  readonly daemonProcessId: string;
}

export interface MarkSessionEndedInput {
  readonly id: string;
  readonly status: Extract<WorkspaceSessionStatus, "exited" | "failed">;
  readonly exitCode?: number;
  readonly exitSignal?: number;
  readonly errorMessage?: string;
}

export interface UpdateSessionSizeInput {
  readonly id: string;
  readonly cols: number;
  readonly rows: number;
}

export interface ListWorkspaceSessionsInput {
  readonly workspaceId?: string;
  readonly ownerUserId?: string;
  readonly statuses?: readonly WorkspaceSessionStatus[];
  readonly limit?: number;
}

const workspaceSessionRepoOperationSchema = Schema.Literals([
  "createSession",
  "getSessionById",
  "listSessions",
  "markSessionRunning",
  "markSessionEnded",
  "updateSessionSize",
]);

type WorkspaceSessionRepoOperation = typeof workspaceSessionRepoOperationSchema.Type;

export class WorkspaceSessionRepoInvariantError extends Schema.TaggedErrorClass<WorkspaceSessionRepoInvariantError>()(
  "WorkspaceSessionRepoInvariantError",
  {
    operation: workspaceSessionRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class WorkspaceSessionRepoUnexpectedError extends Schema.TaggedErrorClass<WorkspaceSessionRepoUnexpectedError>()(
  "WorkspaceSessionRepoUnexpectedError",
  {
    operation: workspaceSessionRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const workspaceSessionRepoErrorSchema = Schema.Union([
  WorkspaceSessionRepoInvariantError,
  WorkspaceSessionRepoUnexpectedError,
]);

export type WorkspaceSessionRepoError = typeof workspaceSessionRepoErrorSchema.Type;

const withRepoError = <A>(
  operation: WorkspaceSessionRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, WorkspaceSessionRepoError> => {
  return effect.pipe(
    Effect.mapError((cause) => {
      if (
        cause instanceof WorkspaceSessionRepoInvariantError ||
        cause instanceof WorkspaceSessionRepoUnexpectedError
      ) {
        return cause;
      }
      return new WorkspaceSessionRepoUnexpectedError({
        operation,
        message: cause instanceof Error ? cause.message : `${operation} failed.`,
        cause,
      });
    }),
  );
};

export interface WorkspaceSessionRepoService {
  readonly createSession: (
    input: CreateWorkspaceSessionInput,
  ) => Effect.Effect<WorkspaceSession, WorkspaceSessionRepoError>;
  readonly getSessionById: (
    id: string,
  ) => Effect.Effect<WorkspaceSession | undefined, WorkspaceSessionRepoError>;
  readonly listSessions: (
    input?: ListWorkspaceSessionsInput,
  ) => Effect.Effect<readonly WorkspaceSession[], WorkspaceSessionRepoError>;
  readonly markSessionRunning: (
    input: MarkSessionRunningInput,
  ) => Effect.Effect<WorkspaceSession | null, WorkspaceSessionRepoError>;
  readonly markSessionEnded: (
    input: MarkSessionEndedInput,
  ) => Effect.Effect<WorkspaceSession | null, WorkspaceSessionRepoError>;
  readonly updateSessionSize: (
    input: UpdateSessionSizeInput,
  ) => Effect.Effect<WorkspaceSession | null, WorkspaceSessionRepoError>;
}

export class WorkspaceSessionRepo extends Context.Service<
  WorkspaceSessionRepo,
  WorkspaceSessionRepoService
>()("WorkspaceSessionRepo") {}

export const WorkspaceSessionRepoLive = Layer.effect(
  WorkspaceSessionRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      createSession: (input) =>
        withRepoError(
          "createSession",
          Effect.gen(function* () {
            const [session] = yield* db
              .insert(workspaceSessions)
              .values({
                id: input.id,
                workspaceId: input.workspaceId,
                runId: input.runId,
                ownerUserId: input.ownerUserId,
                argv: input.argv,
                ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                cols: input.cols,
                rows: input.rows,
                ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
              } satisfies NewWorkspaceSession)
              .returning();

            if (session === undefined) {
              return yield* new WorkspaceSessionRepoInvariantError({
                operation: "createSession",
                message: "Failed to create workspace session.",
              });
            }
            return session;
          }),
        ),

      getSessionById: (id) =>
        withRepoError(
          "getSessionById",
          Effect.gen(function* () {
            const [session] = yield* db
              .select()
              .from(workspaceSessions)
              .where(eq(workspaceSessions.id, id))
              .limit(1);
            return session;
          }),
        ),

      listSessions: (input = {}) =>
        withRepoError(
          "listSessions",
          Effect.gen(function* () {
            const whereClauses = [
              ...(input.workspaceId === undefined
                ? []
                : [eq(workspaceSessions.workspaceId, input.workspaceId)]),
              ...(input.ownerUserId === undefined
                ? []
                : [eq(workspaceSessions.ownerUserId, input.ownerUserId)]),
              ...(input.statuses === undefined || input.statuses.length === 0
                ? []
                : [inArray(workspaceSessions.status, [...input.statuses])]),
            ];

            const query = db.select().from(workspaceSessions);
            const filtered = whereClauses.length === 0 ? query : query.where(and(...whereClauses));
            return yield* filtered
              .orderBy(desc(workspaceSessions.createdAt))
              .limit(input.limit ?? 100);
          }),
        ),

      markSessionRunning: (input) =>
        withRepoError(
          "markSessionRunning",
          Effect.gen(function* () {
            const [session] = yield* db
              .update(workspaceSessions)
              .set({
                status: "running",
                daemonSessionId: input.daemonSessionId,
                daemonProcessId: input.daemonProcessId,
              })
              .where(eq(workspaceSessions.id, input.id))
              .returning();
            return session ?? null;
          }),
        ),

      markSessionEnded: (input) =>
        withRepoError(
          "markSessionEnded",
          Effect.gen(function* () {
            const [session] = yield* db
              .update(workspaceSessions)
              .set({
                status: input.status,
                ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
                ...(input.exitSignal === undefined ? {} : { exitSignal: input.exitSignal }),
                ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
                endedAt: new Date(),
              })
              .where(eq(workspaceSessions.id, input.id))
              .returning();
            return session ?? null;
          }),
        ),

      updateSessionSize: (input) =>
        withRepoError(
          "updateSessionSize",
          Effect.gen(function* () {
            const [session] = yield* db
              .update(workspaceSessions)
              .set({ cols: input.cols, rows: input.rows })
              .where(eq(workspaceSessions.id, input.id))
              .returning();
            return session ?? null;
          }),
        ),
    } satisfies WorkspaceSessionRepoService;
  }),
);
