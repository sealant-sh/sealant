/**
 * RunRepo — data access for `runs` (one HARNESS EXECUTION; the SDK's `harness.run()`). A run owns the
 * execution record: the telemetry tables key their `run_id` FK to `runs.id`. This repo is the bottom
 * of the run-detail read path (RunRepo -> api-contracts -> apps/api -> SDK). Mirrors the
 * `WorkspaceAttemptRepo` idiom: a `Context.Service` whose methods return `Effect`s on a typed
 * `TaggedError` channel, wired with `Layer.effect`.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  runs,
  type NewRun,
  type Run,
  type RunExecCommandRecord,
  type RunFileChange,
  type RunMode,
  type RunStatus,
} from "../schema.js";

export interface CreateRunInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly harnessId: string;
  readonly mode?: RunMode;
  readonly prompt?: string;
  readonly attemptId?: string;
  /** The resolved server-side invocation, persisted so the run is self-describing. */
  readonly command?: RunExecCommandRecord;
  /** Opaque caller correlation bag, stored verbatim and echoed on reads. */
  readonly metadata?: Record<string, unknown>;
}

export interface MarkRunRunningInput {
  readonly id: string;
  readonly startedAt?: Date;
}

export interface ClaimRunForExecInput {
  readonly id: string;
  readonly startedAt?: Date;
}

/**
 * The queued→running transition as a CLAIM: exactly one caller gets `claimed`, every other
 * delivery of the same run learns what state it actually found. The queue is at-least-once —
 * without this, a redelivered run-exec job re-runs the harness against the workspace.
 */
export type RunExecClaim =
  | { readonly outcome: "claimed"; readonly run: Run }
  | { readonly outcome: "already-running"; readonly run: Run }
  | { readonly outcome: "terminal"; readonly run: Run }
  | { readonly outcome: "not-found" };

export interface MarkRunCompletedInput {
  readonly id: string;
  readonly exitCode: number;
  readonly finishedAt?: Date;
  readonly diff?: string;
  readonly changedFiles?: readonly RunFileChange[];
}

export interface MarkRunFailedInput {
  readonly id: string;
  readonly exitCode?: number;
  readonly errorMessage?: string;
  readonly finishedAt?: Date;
  readonly diff?: string;
  readonly changedFiles?: readonly RunFileChange[];
}

export interface ListRunsInput {
  readonly ownerUserId?: string;
  readonly workspaceId?: string;
  readonly statuses?: readonly RunStatus[];
  readonly limit?: number;
}

const runRepoOperationSchema = Schema.Literals([
  "createRun",
  "getRunById",
  "listRuns",
  "markRunRunning",
  "claimRunForExec",
  "markRunCompleted",
  "markRunFailed",
]);

export class RunRepoInvariantError extends Schema.TaggedErrorClass<RunRepoInvariantError>()(
  "RunRepoInvariantError",
  {
    operation: runRepoOperationSchema,
    message: Schema.String,
  },
) {}

export class RunRepoUnexpectedError extends Schema.TaggedErrorClass<RunRepoUnexpectedError>()(
  "RunRepoUnexpectedError",
  {
    operation: runRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const runRepoErrorSchema = Schema.Union([RunRepoInvariantError, RunRepoUnexpectedError]);

export type RunRepoError = typeof runRepoErrorSchema.Type;

type RunRepoOperation = typeof runRepoOperationSchema.Type;

const mapRunRepoError = (operation: RunRepoOperation, cause: unknown): RunRepoError => {
  if (cause instanceof RunRepoInvariantError || cause instanceof RunRepoUnexpectedError) {
    return cause;
  }

  return new RunRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withRunRepoError = <A>(
  operation: RunRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, RunRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapRunRepoError(operation, cause)));
};

export interface RunRepoService {
  readonly createRun: (input: CreateRunInput) => Effect.Effect<Run, RunRepoError>;
  readonly getRunById: (id: string) => Effect.Effect<Run | undefined, RunRepoError>;
  readonly listRuns: (input?: ListRunsInput) => Effect.Effect<readonly Run[], RunRepoError>;
  readonly markRunRunning: (input: MarkRunRunningInput) => Effect.Effect<Run | null, RunRepoError>;
  readonly claimRunForExec: (
    input: ClaimRunForExecInput,
  ) => Effect.Effect<RunExecClaim, RunRepoError>;
  readonly markRunCompleted: (
    input: MarkRunCompletedInput,
  ) => Effect.Effect<Run | null, RunRepoError>;
  readonly markRunFailed: (input: MarkRunFailedInput) => Effect.Effect<Run | null, RunRepoError>;
}

export class RunRepo extends Context.Service<RunRepo, RunRepoService>()("RunRepo") {}

export const RunRepoLive = Layer.effect(
  RunRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      createRun: (input) =>
        withRunRepoError(
          "createRun",
          Effect.gen(function* () {
            const [run] = yield* db
              .insert(runs)
              .values({
                id: input.id,
                workspaceId: input.workspaceId,
                ownerUserId: input.ownerUserId,
                harnessId: input.harnessId,
                ...(input.mode === undefined ? {} : { mode: input.mode }),
                ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
                ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
                ...(input.command === undefined ? {} : { command: input.command }),
                ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
              } satisfies NewRun)
              .returning();

            if (run === undefined) {
              return yield* new RunRepoInvariantError({
                operation: "createRun",
                message: "Failed to create run.",
              });
            }

            return run;
          }),
        ),

      getRunById: (id) =>
        withRunRepoError(
          "getRunById",
          Effect.gen(function* () {
            const [run] = yield* db.select().from(runs).where(eq(runs.id, id)).limit(1);
            return run;
          }),
        ),

      listRuns: (input = {}) =>
        withRunRepoError(
          "listRuns",
          Effect.gen(function* () {
            const whereClauses = [
              ...(input.ownerUserId === undefined ? [] : [eq(runs.ownerUserId, input.ownerUserId)]),
              ...(input.workspaceId === undefined ? [] : [eq(runs.workspaceId, input.workspaceId)]),
              ...(input.statuses === undefined || input.statuses.length === 0
                ? []
                : [inArray(runs.status, [...input.statuses])]),
            ];

            if (whereClauses.length === 0) {
              return yield* db
                .select()
                .from(runs)
                .orderBy(desc(runs.createdAt))
                .limit(input.limit ?? 100);
            }

            return yield* db
              .select()
              .from(runs)
              .where(and(...whereClauses))
              .orderBy(desc(runs.createdAt))
              .limit(input.limit ?? 100);
          }),
        ),

      markRunRunning: (input) =>
        withRunRepoError(
          "markRunRunning",
          Effect.gen(function* () {
            const [run] = yield* db
              .update(runs)
              .set({ status: "running", startedAt: input.startedAt ?? new Date() })
              .where(eq(runs.id, input.id))
              .returning();
            return run ?? null;
          }),
        ),

      claimRunForExec: (input) =>
        withRunRepoError(
          "claimRunForExec",
          Effect.gen(function* () {
            // The status guard in the WHERE is the claim: a redelivery (or a racing consumer)
            // updates zero rows instead of stomping a run that already started or finished.
            const [claimed] = yield* db
              .update(runs)
              .set({ status: "running", startedAt: input.startedAt ?? new Date() })
              .where(and(eq(runs.id, input.id), eq(runs.status, "queued")))
              .returning();
            if (claimed !== undefined) {
              return { outcome: "claimed", run: claimed } as const;
            }
            const [existing] = yield* db.select().from(runs).where(eq(runs.id, input.id)).limit(1);
            if (existing === undefined) {
              return { outcome: "not-found" } as const;
            }
            // Anything non-terminal maps to already-running: whatever state lost us the claim,
            // the fail-safe answer is "someone else owns this run", never a second execution.
            return existing.status === "completed" ||
              existing.status === "failed" ||
              existing.status === "cancelled"
              ? ({ outcome: "terminal", run: existing } as const)
              : ({ outcome: "already-running", run: existing } as const);
          }),
        ),

      markRunCompleted: (input) =>
        withRunRepoError(
          "markRunCompleted",
          Effect.gen(function* () {
            const [run] = yield* db
              .update(runs)
              .set({
                status: "completed",
                exitCode: input.exitCode,
                finishedAt: input.finishedAt ?? new Date(),
                ...(input.diff === undefined ? {} : { diff: input.diff }),
                ...(input.changedFiles === undefined
                  ? {}
                  : { changedFiles: [...input.changedFiles] }),
              })
              .where(eq(runs.id, input.id))
              .returning();
            return run ?? null;
          }),
        ),

      markRunFailed: (input) =>
        withRunRepoError(
          "markRunFailed",
          Effect.gen(function* () {
            const [run] = yield* db
              .update(runs)
              .set({
                status: "failed",
                ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
                ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
                finishedAt: input.finishedAt ?? new Date(),
                ...(input.diff === undefined ? {} : { diff: input.diff }),
                ...(input.changedFiles === undefined
                  ? {}
                  : { changedFiles: [...input.changedFiles] }),
              })
              .where(eq(runs.id, input.id))
              .returning();
            return run ?? null;
          }),
        ),
    } satisfies RunRepoService;
  }),
);
