/**
 * The logins Core wrote into each home of a running instance (docs/connected-accounts-design.md
 * §6c). One row per (instance, home), naming the one person the home holds and the accounts whose
 * copies are there. The row is also the lock: every write into a home (a put, a release, a refresh
 * push) runs inside {@link WorkspaceCredentialHomeRepoService.withLockedHome}, which holds the row
 * `FOR UPDATE` across the caller's control-channel write, so writes into one home never interleave
 * and each one decides on what the row says at that moment.
 */
import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlError } from "effect/unstable/sql/SqlError";

import { SealantDB } from "../client.js";
import {
  workspaceCredentialHomes,
  workspaceRuntimeInstances,
  type WorkspaceCredentialHome,
  type WorkspaceCredentialHomeAccount,
  type WorkspaceRuntimeInstance,
} from "../schema/workspace-build-jobs.js";

export class WorkspaceCredentialHomeRepoError extends Schema.TaggedErrorClass<WorkspaceCredentialHomeRepoError>()(
  "WorkspaceCredentialHomeRepoError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

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
   * Run `use` while holding the (instance, home) row `FOR UPDATE`, in one transaction, then apply
   * the outcome it returns. `use` sees the row as it is under the lock (`undefined` when the home
   * holds nothing), and may take as long as its write takes: a concurrent put, release or push for
   * the same home waits for it. A failure of `use` rolls back and is returned as it is.
   */
  readonly withLockedHome: <A, E, R>(
    input: { readonly runId: string; readonly home: string },
    use: (
      held: WorkspaceCredentialHome | undefined,
    ) => Effect.Effect<
      { readonly result: A; readonly outcome: WorkspaceCredentialHomeOutcome },
      E,
      R
    >,
  ) => Effect.Effect<A, E | WorkspaceCredentialHomeRepoError, R>;
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

export const WorkspaceCredentialHomeRepoLive: Layer.Layer<
  WorkspaceCredentialHomeRepo,
  never,
  SealantDB
> = Layer.effect(
  WorkspaceCredentialHomeRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    function withLockedHome<A, E, R>(
      input: { readonly runId: string; readonly home: string },
      use: (
        held: WorkspaceCredentialHome | undefined,
      ) => Effect.Effect<
        { readonly result: A; readonly outcome: WorkspaceCredentialHomeOutcome },
        E,
        R
      >,
    ): Effect.Effect<A, E | WorkspaceCredentialHomeRepoError, R> {
      return db
        .transaction((tx) =>
          Effect.gen(function* () {
            // A writer waits at most this long for another's write into the home (each is bounded
            // by its own exec timeout), never indefinitely while holding a connection.
            yield* withRepoError("withLockedHome", tx.execute(sql`set local lock_timeout = '40s'`));
            // A home that holds nothing has no row to lock: serialise on the key instead, for the
            // rest of this transaction, so two first puts into one home take turns too.
            yield* withRepoError(
              "withLockedHome",
              tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${`${input.runId} ${input.home}`}, 0))`,
              ),
            );
            const [held] = yield* withRepoError(
              "withLockedHome",
              tx.select().from(workspaceCredentialHomes).where(homeKey(input)).for("update"),
            );
            const { result, outcome } = yield* use(held);
            if (outcome.kind === "release") {
              yield* withRepoError(
                "withLockedHome",
                tx.delete(workspaceCredentialHomes).where(homeKey(input)),
              );
            } else if (outcome.kind === "hold") {
              yield* withRepoError(
                "withLockedHome",
                tx
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
                      updatedAt: new Date(),
                    },
                  }),
              );
            }
            return result;
          }),
        )
        .pipe(
          // Only the transaction's own failure (begin, commit) is translated; the caller's errors
          // pass through as they are.
          Effect.mapError((error) =>
            error instanceof SqlError ? toRepoError("withLockedHome", error) : error,
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
