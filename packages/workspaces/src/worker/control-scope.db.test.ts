/**
 * An executor's control scope (SLNT-1332) against a REAL Postgres: the scope a create names is held
 * by its attempt for all time, so no two executors ever mount one directory, and the scope the
 * runtime mounted is on the run's row for every read. Gated on SEALANT_TEST_DATABASE_URL (a
 * disposable database with the migrations applied; it writes rows under fresh ids and leaves them).
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/control-scope.db.test.ts
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  SealantDB,
  user,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceControlScopeTakenError,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer, Result } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

describe.skipIf(DATABASE_URL === undefined)("executor control scopes (Postgres)", () => {
  let db: DB;
  const userId = `user_control_scope_${randomUUID()}`;

  const run = <A, E>(
    effect: Effect.Effect<A, E, WorkspaceAttemptRepo | WorkspaceRuntimeInstanceRepo>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(WorkspaceAttemptRepoLive, WorkspaceRuntimeInstanceRepoLive).pipe(
            Layer.provide(Layer.succeed(SealantDB, db)),
          ),
        ),
      ),
    );
  const attempt = (controlScope?: string) =>
    WorkspaceAttemptRepo.use((attempts) =>
      attempts.createQueuedAttempt({
        id: `run_control_scope_${randomUUID()}`,
        ownerUserId: userId,
        ...(controlScope === undefined ? {} : { controlScope }),
      }),
    );

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      db.insert(user).values({ id: userId, name: "scope", email: `${userId}@example.test` }),
    );
  });

  it("lets no second executor take a scope another holds, and any number name none", async () => {
    const scope = `mend-${randomUUID()}`;
    const first = await run(attempt(scope));
    expect(first.controlScope).toBe(scope);

    const second = await run(Effect.result(attempt(scope)));
    expect(Result.isFailure(second)).toBe(true);
    if (Result.isFailure(second)) {
      expect(second.failure).toBeInstanceOf(WorkspaceControlScopeTakenError);
    }

    // Executors in their container name's scope record none on the attempt: never a conflict.
    await run(attempt());
    await run(attempt());
  });

  it("keeps the scope the runtime mounted on the run's row", async () => {
    const created = await run(attempt());
    const row = await run(
      WorkspaceRuntimeInstanceRepo.use((instances) =>
        instances
          .upsertRuntimeInstance({
            runId: created.id,
            status: "ready",
            adapter: "docker",
            resourceId: "container-1",
            reference: "sealant-run-1",
            controlScope: "sealant-run-1",
          })
          .pipe(Effect.andThen(instances.getRuntimeInstanceByRunId(created.id))),
      ),
    );
    expect(row?.controlScope).toBe("sealant-run-1");
  });
});
