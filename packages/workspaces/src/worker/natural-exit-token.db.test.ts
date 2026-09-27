/**
 * Review 3 #23 against a REAL Postgres: an executor that ended on its own and was removed by the
 * exit reconciler with evidence its work was saved must not leave the sealed recovery token (or
 * its retention) behind. Gated on SEALANT_TEST_DATABASE_URL (a disposable database with the
 * migrations applied; it writes rows under fresh ids and leaves them).
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/natural-exit-token.db.test.ts
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  SealantDB,
  user,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  workspaceAttempts,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { fakeCaptureDaemon } from "./capture-daemon.fixture.js";
import { databaseCaptureDrainLedger } from "./capture-drain-ledger.js";
import { reconcileRuntimeExitsEffect } from "./reconcile-runtime-exits.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

describe.skipIf(DATABASE_URL === undefined)(
  "natural exit and the recovery token (Postgres)",
  () => {
    let db: DB;
    const userId = `user_exit_token_${randomUUID()}`;

    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        WorkspaceRuntimeInstanceRepo | WorkspaceCaptureDrainRepo | WorkspaceAttemptRepo
      >,
    ) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.mergeAll(
              WorkspaceRuntimeInstanceRepoLive,
              WorkspaceCaptureDrainRepoLive,
              WorkspaceAttemptRepoLive,
            ).pipe(Layer.provide(Layer.succeed(SealantDB, db))),
          ),
        ),
      );

    beforeAll(async () => {
      db = await createSealantDB(DATABASE_URL ?? "");
      await Effect.runPromise(
        db.insert(user).values({ id: userId, name: "exit", email: `${userId}@example.test` }),
      );
    });

    it("clears the sealed capture token when the exit reconciler removes an attested executor", async () => {
      const runId = `run_exit_token_${randomUUID()}`;
      const resourceId = `container-${runId}`;
      await Effect.runPromise(
        db.insert(workspaceAttempts).values({ id: runId, ownerUserId: userId }),
      );
      await run(
        Effect.gen(function* () {
          const instances = yield* WorkspaceRuntimeInstanceRepo;
          const drains = yield* WorkspaceCaptureDrainRepo;
          yield* instances.upsertRuntimeInstance({
            runId,
            status: "ready",
            adapter: "docker",
            resourceId,
            reference: resourceId,
            sourceKind: "capture",
          });
          yield* drains.storeCaptureToken({ runId, sealed: "sealed-capture-token" });
          yield* drains.markRetained({ runId, reason: "executor exited · exit 75" });
          // The control plane attested a sealed final capture of THIS executor.
          yield* drains.attestCompletion({
            runId,
            executorId: resourceId,
            epoch: 3,
            captureN: 41,
            attestedBy: userId,
          });
        }),
      );
      const stop = vi.fn(async () => ({
        adapter: "docker" as const,
        resourceId,
        outcome: "stopped" as const,
      }));
      const adapter: RuntimeAdapter = {
        id: "docker",
        supports: () => ({ supported: true }),
        launch: async () => {
          throw new Error("unused");
        },
        stop,
        inspect: async () => ({ state: "exited", exitCode: 0 }),
      };

      await run(
        reconcileRuntimeExitsEffect({
          runtimeAdapters: [adapter],
          resourceIds: [resourceId],
          captureDrain: {
            ledger: databaseCaptureDrainLedger({ db, owner: "db-test", leaseMs: 60_000 }),
            settings: {
              pollIntervalMs: 5,
              stallWindowMs: 60_000,
              unreachableWindowMs: 60_000,
              requestTimeoutMs: 1_000,
            },
          },
        }).pipe(Effect.provide(fakeCaptureDaemon(["unreachable"]).layer)),
      );

      expect(stop).toHaveBeenCalledTimes(1);
      const row = await run(
        Effect.gen(function* () {
          return yield* (yield* WorkspaceCaptureDrainRepo).getByRunId(runId);
        }),
      );
      expect(row).toMatchObject({
        state: "stopped",
        captureTokenSealed: null,
        retainedAt: null,
        nextRecoveryAt: null,
      });
      const due = await run(
        Effect.gen(function* () {
          return yield* (yield* WorkspaceCaptureDrainRepo).listRetainedDue({ limit: 1000 });
        }),
      );
      expect(due.map((entry) => entry.runId)).not.toContain(runId);
    });
  },
);
