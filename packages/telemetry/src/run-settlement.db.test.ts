/**
 * A run's failure is written only while the run has not settled: a completed run whose completion
 * answer was lost stays completed when its recorder then writes the run off as failed. Against a
 * real Postgres, gated on SEALANT_TEST_DATABASE_URL (or DATABASE_URL) like the other db suites.
 */
import {
  makeSealantDBLayer,
  RunRepo,
  RunRepoLive,
  runs,
  SealantDB,
  user,
  workspaces,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const TAG = "it_run_settlement";
const userId = `user_${TAG}`;
const workspaceId = `ws_${TAG}`;
const completedRunId = `run_completed_${TAG}`;
const runningRunId = `run_running_${TAG}`;

describe.skipIf(DATABASE_URL === undefined)("a run's failure write (real Postgres)", () => {
  const db = makeSealantDBLayer(DATABASE_URL ?? "");
  const layer = Layer.mergeAll(db, RunRepoLive.pipe(Layer.provide(db)));

  const cleanup = Effect.gen(function* () {
    const handle = yield* SealantDB;
    // Constant test ids only.
    yield* handle.execute(`DELETE FROM "workspaces" WHERE "id" = '${workspaceId}'`); // cascades
    yield* handle.execute(`DELETE FROM "user" WHERE "id" = '${userId}'`);
  });

  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* cleanup;
        const handle = yield* SealantDB;
        const now = new Date();
        yield* handle.insert(user).values({
          id: userId,
          name: TAG,
          email: `${userId}@example.test`,
          createdAt: now,
          updatedAt: now,
        });
        yield* handle
          .insert(workspaces)
          .values({ id: workspaceId, ownerUserId: userId, createdAt: now, updatedAt: now });
        yield* handle.insert(runs).values(
          [completedRunId, runningRunId].map((id) => ({
            id,
            workspaceId,
            ownerUserId: userId,
            harnessId: "exec",
            createdAt: now,
            updatedAt: now,
          })),
        );
      }).pipe(Effect.provide(db)),
    );
  });

  afterAll(async () => {
    await Effect.runPromise(cleanup.pipe(Effect.provide(db)));
  });

  it("leaves a completed run completed, and fails a running one", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* RunRepo;
        yield* repo.claimRunForExec({ id: completedRunId });
        yield* repo.markRunCompleted({ id: completedRunId, exitCode: 0 });
        const overwritten = yield* repo.markRunFailed({
          id: completedRunId,
          errorMessage: "Run execution failed before completion.",
        });
        yield* repo.claimRunForExec({ id: runningRunId });
        const failed = yield* repo.markRunFailed({
          id: runningRunId,
          errorMessage: "Run execution failed before completion.",
        });
        return {
          overwritten,
          completed: yield* repo.getRunById(completedRunId),
          failed,
        };
      }).pipe(Effect.provide(layer)),
    );
    expect(outcome.overwritten).toBeNull();
    expect(outcome.completed).toMatchObject({
      status: "completed",
      exitCode: 0,
      errorMessage: null,
    });
    expect(outcome.failed).toMatchObject({
      status: "failed",
      errorMessage: "Run execution failed before completion.",
    });
  });
});
