/**
 * The workspace idempotency key against real Postgres: unique per owner (another owner may use
 * the same key), found by owner and key, and a racing insert fails in a way the create path
 * recognises as a unique violation (SQLSTATE 23505) so it answers with the winner's workspace.
 * Gated on SEALANT_TEST_DATABASE_URL (a disposable, migrated database).
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  DatabaseTransaction,
  DatabaseTransactionLive,
  SealantDB,
  user,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceCreateReservationRepo,
  WorkspaceCreateReservationRepoLive,
  WorkspaceRepo,
  WorkspaceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer, Result } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { isUniqueConstraintError } from "./workspaces.module.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

describe.skipIf(DATABASE_URL === undefined)("workspace idempotency key (Postgres)", () => {
  let db: DB;
  const owner = `user_idem_${randomUUID()}`;
  const other = `user_idem_${randomUUID()}`;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    for (const id of [owner, other]) {
      await Effect.runPromise(
        db.insert(user).values({ id, name: "idem", email: `${id}@example.test` }),
      );
    }
  });

  const run = <A, E>(effect: Effect.Effect<A, E, WorkspaceRepo>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(WorkspaceRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db)))),
      ),
    );

  it("is unique per owner, found by owner and key, and a racing insert reads as a unique violation", async () => {
    const key = `key_${randomUUID()}`;
    const create = (ownerUserId: string) =>
      Effect.gen(function* () {
        return yield* (yield* WorkspaceRepo).createWorkspace({
          id: randomUUID(),
          name: "idem",
          ownerUserId,
          idempotencyKey: key,
        });
      });

    const first = await run(create(owner));
    const second = await run(Effect.result(create(owner)));
    expect(Result.isFailure(second)).toBe(true);
    if (Result.isFailure(second)) {
      expect(isUniqueConstraintError(second.failure)).toBe(true);
    }
    // Another owner's workspace with the same key is its own.
    const others = await run(create(other));
    expect(others.id).not.toBe(first.id);

    const found = await run(
      Effect.gen(function* () {
        return yield* (yield* WorkspaceRepo).getWorkspaceByIdempotencyKey({
          ownerUserId: owner,
          idempotencyKey: key,
        });
      }),
    );
    expect(found?.id).toBe(first.id);
  });

  const runAll = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      WorkspaceRepo | WorkspaceAttemptRepo | WorkspaceCreateReservationRepo | DatabaseTransaction
    >,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            WorkspaceRepoLive,
            WorkspaceAttemptRepoLive,
            WorkspaceCreateReservationRepoLive,
            DatabaseTransactionLive,
          ).pipe(Layer.provide(Layer.succeed(SealantDB, db))),
        ),
      ),
    );

  it("commits a create's writes together, or none of them (review 3 #19)", async () => {
    const key = `key_${randomUUID()}`;
    const workspaceId = `ws_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const writes = Effect.gen(function* () {
      const workspace = yield* (yield* WorkspaceRepo).createWorkspace({
        id: workspaceId,
        name: "atomic",
        ownerUserId: owner,
        idempotencyKey: key,
      });
      yield* (yield* WorkspaceAttemptRepo).createQueuedAttempt({
        id: runId,
        ownerUserId: owner,
        launchId: key,
      });
      yield* (yield* WorkspaceRepo).linkWorkspaceAttempt({
        workspaceId: workspace.id,
        attemptId: runId,
      });
      // The process dies (or a write fails) before the launch job is written.
      return yield* Effect.fail(new Error("insert into oci_image_build_jobs failed"));
    });
    const failed = await runAll(
      Effect.result(
        Effect.gen(function* () {
          return yield* (yield* DatabaseTransaction).run(writes);
        }),
      ),
    );
    expect(Result.isFailure(failed)).toBe(true);
    const left = await runAll(
      Effect.gen(function* () {
        return {
          byKey: yield* (yield* WorkspaceRepo).getWorkspaceByIdempotencyKey({
            ownerUserId: owner,
            idempotencyKey: key,
          }),
          attempt: yield* (yield* WorkspaceAttemptRepo).getAttemptById(runId),
        };
      }),
    );
    // Nothing of the half-made create is left: no workspace to replay forever.
    expect(left).toEqual({ byKey: undefined, attempt: undefined });
  });

  it("lets exactly one of a create's commit and a cancel win (review 3 #21)", async () => {
    const results = await runAll(
      Effect.gen(function* () {
        const reservations = yield* WorkspaceCreateReservationRepo;
        const at = (idempotencyKey: string) => ({ ownerUserId: owner, idempotencyKey });
        const cancelledFirst = `key_${randomUUID()}`;
        const committedFirst = `key_${randomUUID()}`;
        const neverSeen = `key_${randomUUID()}`;

        // Cancel lands while the create is pending: the create can no longer commit.
        const pending = yield* reservations.reserve({ ...at(cancelledFirst), launchId: "l1" });
        const cancelled = yield* reservations.cancel(at(cancelledFirst));
        const lateCommit = yield* reservations.markCreated({
          ...at(cancelledFirst),
          workspaceId: "ws_late",
        });

        // The create commits first: a cancel leaves it created.
        yield* reservations.reserve(at(committedFirst));
        const commit = yield* reservations.markCreated({
          ...at(committedFirst),
          workspaceId: "ws_committed",
        });
        const cancelAfterCommit = yield* reservations.cancel(at(committedFirst));

        // A key cancelled before any create reached this control plane: a delayed original
        // request reserves it and finds it cancelled.
        yield* reservations.cancel(at(neverSeen));
        const delayed = yield* reservations.reserve(at(neverSeen));
        return { pending, cancelled, lateCommit, commit, cancelAfterCommit, delayed };
      }),
    );
    expect(results.pending).toMatchObject({ state: "pending", launchId: "l1" });
    expect(results.cancelled.state).toBe("cancelled");
    expect(results.lateCommit).toBe(false);
    expect(results.commit).toBe(true);
    expect(results.cancelAfterCommit).toMatchObject({
      state: "created",
      workspaceId: "ws_committed",
    });
    expect(results.delayed.state).toBe("cancelled");
  });
});
