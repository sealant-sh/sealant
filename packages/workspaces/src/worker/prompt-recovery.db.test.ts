/**
 * e2e 5 (HK2) against a REAL Postgres: an executor killed mid-shipment was recorded retained 2.6 s
 * after it died, but its first recovery attempt came 55 s later (the recovery sweep ran every
 * 60 s) — by then the session's lease had expired, the control plane refused the recovery boot's
 * plan, and every later attempt, a minute or more apart, exited 75 the same way. Recording an
 * executor retained now starts a recovery sweep at once (`notifyingRetention`), the retention is
 * due the moment it is recorded, and an attempt that fails is retried after 10 s, not a minute.
 * Gated on SEALANT_TEST_DATABASE_URL (a disposable database with the migrations applied).
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/prompt-recovery.db.test.ts
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

import type { RuntimeAdapter, RuntimeAdapterInspectResult } from "../runtime/runtime-adapter.js";
import { fakeCaptureDaemon } from "./capture-daemon.fixture.js";
import { databaseCaptureDrainLedger } from "./capture-drain-ledger.js";
import { notifyingRetention } from "./capture-drain.js";
import { reconcileRuntimeExitsEffect } from "./reconcile-runtime-exits.js";
import { recoverRetainedExecutorsEffect } from "./recover-retained-executors.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const SETTINGS = {
  pollIntervalMs: 5,
  stallWindowMs: 60_000,
  unreachableWindowMs: 60_000,
  requestTimeoutMs: 1_000,
};

describe.skipIf(DATABASE_URL === undefined)(
  "prompt recovery of a retained executor (Postgres)",
  () => {
    let db: DB;
    const userId = `user_prompt_recovery_${randomUUID()}`;

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
        db.insert(user).values({ id: userId, name: "recovery", email: `${userId}@example.test` }),
      );
    });

    it("starts recovering an executor the moment it is retained, and retries a failed boot within 10 s", async () => {
      const runId = `run_prompt_recovery_${randomUUID()}`;
      const resourceId = `container-${runId}`;
      await Effect.runPromise(
        db.insert(workspaceAttempts).values({ id: runId, ownerUserId: userId }),
      );
      await run(
        Effect.gen(function* () {
          const instances = yield* WorkspaceRuntimeInstanceRepo;
          yield* instances.upsertRuntimeInstance({
            runId,
            status: "ready",
            adapter: "docker",
            resourceId,
            reference: resourceId,
            sourceKind: "capture",
            daemonRecoveryBoot: true,
          });
          yield* (yield* WorkspaceCaptureDrainRepo).storeCaptureToken({
            runId,
            sealed: "sealed:token",
          });
        }),
      );

      // Killed (137) with a shipment in flight; the recovery boot then exits 75 on a refused plan.
      let state: RuntimeAdapterInspectResult = { state: "exited", exitCode: 137 };
      const recover = vi.fn(async () => {
        state = { state: "exited", exitCode: 75 };
        throw new Error(
          "Workspace container exited during boot before its control socket was ready (status: exited, exitCode: 75)",
        );
      });
      const adapter: RuntimeAdapter = {
        id: "docker",
        supports: () => ({ supported: true }),
        launch: async () => {
          throw new Error("unused");
        },
        stop: async () => {
          throw new Error("a retained executor is never removed without evidence");
        },
        inspect: async () => state,
        recover,
      };
      const stager = {
        stage: () => Promise.reject(new Error("unused")),
        removeSecretEnv: async () => undefined,
        removeAll: async () => undefined,
        restageSecretEnv: async () => undefined,
      };
      const credentialCipher = {
        encrypt: () => Effect.die("unused"),
        decrypt: () => Effect.succeed(JSON.stringify({ SEALANT_CAPTURE_TOKEN: "capture-token" })),
      };

      // The worker's wiring: recording a retention starts a sweep at once.
      const sweeps: Array<Promise<unknown>> = [];
      const ledger = notifyingRetention(
        databaseCaptureDrainLedger({ db, owner: "db-test", leaseMs: 60_000 }),
        (retainedRunId) => {
          sweeps.push(
            run(
              recoverRetainedExecutorsEffect({
                // Exactly the executor just retained (other tests share this database).
                runIds: [retainedRunId],
                runtimeAdapters: [adapter],
                captureDrain: { ledger, settings: SETTINGS },
                credentialCipher,
                launchMaterialStager: stager,
              }).pipe(Effect.provide(fakeCaptureDaemon(["unreachable"]).layer)),
            ),
          );
        },
      );

      const before = Date.now();
      await run(
        reconcileRuntimeExitsEffect({
          runtimeAdapters: [adapter],
          resourceIds: [resourceId],
          captureDrain: { ledger, settings: SETTINGS },
        }).pipe(Effect.provide(fakeCaptureDaemon(["unreachable"]).layer)),
      );
      // The exit was recorded retained, and that alone started the first recovery attempt.
      expect(sweeps).toHaveLength(1);
      await Promise.all(sweeps);
      expect(recover).toHaveBeenCalledTimes(1);

      const row = await run(
        Effect.gen(function* () {
          return yield* (yield* WorkspaceCaptureDrainRepo).getByRunId(runId);
        }),
      );
      expect(row?.retainedAt).not.toBeNull();
      expect(row?.recoveryAttempts).toBe(1);
      const nextInMs = (row?.nextRecoveryAt?.getTime() ?? Number.POSITIVE_INFINITY) - before;
      expect(nextInMs).toBeLessThanOrEqual(11_000);
    });
  },
);
