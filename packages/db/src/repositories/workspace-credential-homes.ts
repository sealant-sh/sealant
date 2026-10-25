/**
 * The logins Core wrote into each home of a running instance (docs/connected-accounts-design.md
 * §6c). One row per (instance, home), naming the one person the home holds. Every write into a home
 * (a put, a release, a refresh push, the sweep) runs inside
 * {@link WorkspaceCredentialHomeRepoService.withLockedHome}, which holds the home's lock across the
 * caller's control-channel write, so writes into one home never interleave and each one decides on
 * what the row says at that moment. No transaction stays open across that write: what the caller
 * records before it is committed before the executor runs it.
 */
import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlError } from "effect/sql/SqlError";

import { SealantDB } from "../client.js";
import {
  workspaceCredentialHomes,
  workspaceRuntimeInstances,
  type WorkspaceCredentialHome,
  type WorkspaceCredentialHomeAccount,
  type WorkspaceRuntimeInstance,
} from "../schema/workspace-build-jobs.js";

export class WorkspaceCredentialHomeRepoError extends Schema.TaggedError<WorkspaceCredentialHomeRepoError>()(
  "WorkspaceCredentialHomeRepoError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/**
 * Another write into the same home held it past the wait (`lock_timeout`): nothing was done, and
 * trying again is safe.
 */
export class WorkspaceCredentialHomeBusyError extends Schema.TaggedError<WorkspaceCredentialHomeBusyError>()(
  "WorkspaceCredentialHomeBusyError",
  {
    message: Schema.String,
  },
) {}

/**
 * Whether a database failure is Postgres's lock timeout (55P03), anywhere in its causes: drizzle
 * wraps the driver's error in an Effect `Cause` (`SqlError/LockTimeoutError`), which is matched by
 * its rendering.
 */
const isLockTimeout = (cause: unknown, depth = 0): boolean => {
  if (depth > 6 || typeof cause !== "object" || cause === null) return false;
  if ("code" in cause && cause.code === "55P03") return true;
  if (/LockTimeoutError|lock timeout/.test(String(cause))) return true;
  return "cause" in cause ? isLockTimeout(cause.cause, depth + 1) : false;
};

/** What a locked write leaves in the row once its effect succeeds. */
export type WorkspaceCredentialHomeOutcome =
  /** Nothing changes (a refusal, or a push that wrote over what is recorded). */
  | { readonly kind: "keep" }
  /** The home holds `onBehalfOfUserId`'s `accounts` (inserted when the home held nothing). */
  | {
      readonly kind: "hold";
      readonly onBehalfOfUserId: string;
      readonly accounts: readonly WorkspaceCredentialHomeAccount[];
      /** The hold's generation: new when the home held nothing, the held one otherwise. */
      readonly generation: string;
    }
  /** The home is released: the row is deleted. */
  | { readonly kind: "release" };

/** A home and the instance it is in, as a refresh push lists them. */
export interface WorkspaceCredentialHomeTarget {
  readonly home: WorkspaceCredentialHome;
  readonly instance: WorkspaceRuntimeInstance;
}

export interface WorkspaceCredentialHomeRepoService {
  /**
   * Run `use` while holding the (instance, home) lock, then apply the outcome it returns. `use`
   * sees the row as it is under the lock (`undefined` when the home holds nothing), and may take as
   * long as its write takes: a concurrent put, release or push for the same home waits for it. A
   * failure of `use` applies no outcome and is returned as it is.
   */
  readonly withLockedHome: <A, E, R>(
    input: { readonly runId: string; readonly home: string },
    use: (
      held: WorkspaceCredentialHome | undefined,
      /** A fresh fencing token, issued under the lock: every exec into the home presents one. */
      nextFence: Effect.Effect<string, WorkspaceCredentialHomeRepoError>,
    ) => Effect.Effect<
      { readonly result: A; readonly outcome: WorkspaceCredentialHomeOutcome },
      E,
      R
    >,
  ) => Effect.Effect<A, E | WorkspaceCredentialHomeRepoError | WorkspaceCredentialHomeBusyError, R>;
  /** Every home of one instance, oldest first. */
  readonly listByRunId: (
    runId: string,
  ) => Effect.Effect<readonly WorkspaceCredentialHome[], WorkspaceCredentialHomeRepoError>;
  /** The homes of `ready` instances that hold `connectedAccountId`, with their instance. */
  readonly listReadyHoldingAccount: (
    connectedAccountId: string,
  ) => Effect.Effect<readonly WorkspaceCredentialHomeTarget[], WorkspaceCredentialHomeRepoError>;
}

export class WorkspaceCredentialHomeRepo extends Context.Service<
  WorkspaceCredentialHomeRepo,
  WorkspaceCredentialHomeRepoService
>()("WorkspaceCredentialHomeRepo") {}

const toRepoError = (operation: string, cause: unknown) =>
  new WorkspaceCredentialHomeRepoError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });

const withRepoError = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
  effect.pipe(Effect.mapError((cause) => toRepoError(operation, cause)));

const homeKey = (input: { readonly runId: string; readonly home: string }) =>
  and(
    eq(workspaceCredentialHomes.runId, input.runId),
    eq(workspaceCredentialHomes.home, input.home),
  );

/**
 * The repository over a lock wait: a writer waits at most this long for another's write into the
 * same home (each bounded by its own exec timeout), never indefinitely while holding a connection.
 */
export const makeWorkspaceCredentialHomeRepoLayer = (options: {
  readonly lockTimeoutMs: number;
}): Layer.Layer<WorkspaceCredentialHomeRepo, never, SealantDB> =>
  Layer.effect(
    WorkspaceCredentialHomeRepo,
    Effect.gen(function* () {
      const db = yield* SealantDB;

      function withLockedHome<A, E, R>(
        input: { readonly runId: string; readonly home: string },
        use: (
          held: WorkspaceCredentialHome | undefined,
          nextFence: Effect.Effect<string, WorkspaceCredentialHomeRepoError>,
        ) => Effect.Effect<
          { readonly result: A; readonly outcome: WorkspaceCredentialHomeOutcome },
          E,
          R
        >,
      ): Effect.Effect<
        A,
        E | WorkspaceCredentialHomeRepoError | WorkspaceCredentialHomeBusyError,
        R
      > {
        const lockKey = `${input.runId} ${input.home}`;
        return Effect.scoped(
          Effect.gen(function* () {
            // One pooled connection holds the home's session lock across the caller's executor
            // write, while the caller's placement transactions commit on it before and after.
            const connection = yield* db.$client.reserve;
            const execute = (statement: string, params: readonly unknown[] = []) =>
              withRepoError("withLockedHome", connection.execute(statement, params, undefined));
            // The connection goes back to the pool without the wait, even when the lock timed out.
            yield* Effect.addFinalizer(() => execute("set lock_timeout = 0").pipe(Effect.orDie));
            yield* Effect.acquireRelease(
              // A writer waits at most this long for another's write into the home (each is
              // bounded by its own exec timeout), never indefinitely while holding a connection.
              execute(
                `set lock_timeout = '${Math.max(1, Math.round(options.lockTimeoutMs))}ms'`,
              ).pipe(
                Effect.andThen(
                  execute("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey]),
                ),
              ),
              () =>
                execute("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).pipe(
                  Effect.orDie,
                ),
            );
            return yield* Effect.gen(function* () {
              const [held] = yield* withRepoError(
                "withLockedHome",
                db.select().from(workspaceCredentialHomes).where(homeKey(input)),
              );
              const nextFence = withRepoError(
                "nextFence",
                db.execute<{ readonly fence: string }>(
                  sql`select nextval(${"workspace_credential_home_fences"}::regclass)::text as fence`,
                  "objects",
                ),
              ).pipe(
                Effect.flatMap(([row]) =>
                  row === undefined
                    ? Effect.fail(
                        toRepoError("nextFence", new Error("No fencing token was issued.")),
                      )
                    : Effect.succeed(row.fence),
                ),
              );
              const { result, outcome } = yield* use(held, nextFence);
              if (outcome.kind === "release") {
                yield* withRepoError(
                  "withLockedHome",
                  db.delete(workspaceCredentialHomes).where(homeKey(input)),
                );
              } else if (outcome.kind === "hold") {
                yield* withRepoError(
                  "withLockedHome",
                  db
                    .insert(workspaceCredentialHomes)
                    .values({
                      runId: input.runId,
                      home: input.home,
                      onBehalfOfUserId: outcome.onBehalfOfUserId,
                      accounts: [...outcome.accounts],
                      generation: outcome.generation,
                    })
                    .onConflictDoUpdate({
                      target: [workspaceCredentialHomes.runId, workspaceCredentialHomes.home],
                      set: {
                        onBehalfOfUserId: outcome.onBehalfOfUserId,
                        accounts: [...outcome.accounts],
                        generation: outcome.generation,
                        releasing: false,
                        updatedAt: new Date(),
                      },
                    }),
                );
              }
              return result;
              // An idle reserved connection has depth -1: queries run on it directly, and each
              // transaction opened on it begins and commits on its own.
            }).pipe(Effect.provideService(db.$client.transactionService, [connection, -1]));
          }),
        ).pipe(
          // Only the database's failures are translated (a lock timeout as busy); the caller's
          // errors pass through as they are.
          Effect.mapError((error) =>
            (error instanceof SqlError || error instanceof WorkspaceCredentialHomeRepoError) &&
            isLockTimeout(error)
              ? new WorkspaceCredentialHomeBusyError({
                  message: "Another write into the home held it past the wait; try again.",
                })
              : error instanceof SqlError
                ? toRepoError("withLockedHome", error)
                : error,
          ),
        );
      }

      return {
        withLockedHome,

        listByRunId: (runId) =>
          withRepoError(
            "listByRunId",
            db
              .select()
              .from(workspaceCredentialHomes)
              .where(eq(workspaceCredentialHomes.runId, runId))
              .orderBy(workspaceCredentialHomes.createdAt, workspaceCredentialHomes.home),
          ),

        listReadyHoldingAccount: (connectedAccountId) =>
          withRepoError(
            "listReadyHoldingAccount",
            db
              .select({ home: workspaceCredentialHomes, instance: workspaceRuntimeInstances })
              .from(workspaceCredentialHomes)
              .innerJoin(
                workspaceRuntimeInstances,
                eq(workspaceRuntimeInstances.runId, workspaceCredentialHomes.runId),
              )
              .where(
                and(
                  eq(workspaceRuntimeInstances.status, "ready"),
                  sql`${workspaceCredentialHomes.accounts} @> ${JSON.stringify([{ connectedAccountId }])}::jsonb`,
                ),
              ),
          ),
      } satisfies WorkspaceCredentialHomeRepoService;
    }),
  );

export const WorkspaceCredentialHomeRepoLive: Layer.Layer<
  WorkspaceCredentialHomeRepo,
  never,
  SealantDB
> = makeWorkspaceCredentialHomeRepoLayer({ lockTimeoutMs: 20_000 });
