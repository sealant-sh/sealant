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
  DatabaseTransaction,
  DatabaseTransactionLive,
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
        | WorkspaceRuntimeInstanceRepo
        | WorkspaceCaptureDrainRepo
        | WorkspaceAttemptRepo
        | DatabaseTransaction
      >,
    ) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.mergeAll(
              WorkspaceRuntimeInstanceRepoLive,
              WorkspaceCaptureDrainRepoLive,
              WorkspaceAttemptRepoLive,
              DatabaseTransactionLive,
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

    /**
     * Review 4 #5: an executor exits 75 with unsaved work and the one write that records its
     * retention fails. It must not also be recorded `failed` (every later sweep keys on `ready`, a
     * retained launch or a retention, so it would drop out of recovery for good): the runtime
     * stays `ready`, and the next sweep records the retention and the exit together.
     */
    describe("a failed retention or exit write (review 4 #5)", () => {
      const exitedExecutor = async () => {
        const runId = `run_failed_retention_${randomUUID()}`;
        const resourceId = `container-${runId}`;
        await Effect.runPromise(
          db.insert(workspaceAttempts).values({ id: runId, ownerUserId: userId }),
        );
        await run(
          Effect.gen(function* () {
            yield* (yield* WorkspaceRuntimeInstanceRepo).upsertRuntimeInstance({
              runId,
              status: "ready",
              adapter: "docker",
              resourceId,
              reference: resourceId,
              sourceKind: "capture",
            });
            yield* (yield* WorkspaceCaptureDrainRepo).storeCaptureToken({
              runId,
              sealed: "sealed-capture-token",
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
          inspect: async () => ({ state: "exited", exitCode: 75 }),
        };
        const sweep = () =>
          run(
            reconcileRuntimeExitsEffect({
              runtimeAdapters: [adapter],
              resourceIds: [resourceId],
              captureDrain: {
                ledger: databaseCaptureDrainLedger({ db, owner: "failure-test", leaseMs: 60_000 }),
                settings: {
                  pollIntervalMs: 5,
                  stallWindowMs: 60_000,
                  unreachableWindowMs: 60_000,
                  requestTimeoutMs: 1_000,
                },
              },
            }).pipe(Effect.provide(fakeCaptureDaemon(["unreachable"]).layer)),
          );
        const state = () =>
          run(
            Effect.gen(function* () {
              const instances = yield* WorkspaceRuntimeInstanceRepo;
              const drains = yield* WorkspaceCaptureDrainRepo;
              return {
                instance: yield* instances.getRuntimeInstanceByRunId(runId),
                drain: yield* drains.getByRunId(runId),
                due: yield* drains.listRetainedDue({ limit: 1000, runIds: [runId] }),
              };
            }),
          );
        return { runId, stop, sweep, state };
      };

      /** A trigger that refuses one run's writes to `table` while `when` holds, then is dropped. */
      const refusing = async <A>(
        table: "workspace_capture_drains" | "workspace_runtime_instances",
        runId: string,
        when: string,
        body: () => Promise<A>,
      ): Promise<A> => {
        const name = `refuse_${randomUUID().replaceAll("-", "")}`;
        await Effect.runPromise(
          db.execute(
            `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${runId}' AND ${when} THEN RAISE EXCEPTION 'injected write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}();`,
          ),
        );
        try {
          return await body();
        } finally {
          await Effect.runPromise(
            db.execute(`DROP TRIGGER ${name} ON ${table}; DROP FUNCTION ${name}();`),
          );
        }
      };

      it("leaves the runtime ready when its retention cannot be recorded, and records both next sweep", async () => {
        const executor = await exitedExecutor();
        const first = await refusing(
          "workspace_capture_drains",
          executor.runId,
          "NEW.retained_at IS NOT NULL",
          executor.sweep,
        );
        expect(first).toBe(0);
        const during = await executor.state();
        expect(during.instance?.status).toBe("ready");
        expect(during.drain?.retainedAt ?? null).toBeNull();

        expect(await executor.sweep()).toBe(1);
        const after = await executor.state();
        expect(after.instance).toMatchObject({ status: "failed", errorCode: "runtime-exited" });
        expect(after.drain?.retainedAt).toBeInstanceOf(Date);
        expect(after.drain?.captureTokenSealed).toBe("sealed-capture-token");
        expect(after.due.map((row) => row.runId)).toEqual([executor.runId]);
        expect(executor.stop).not.toHaveBeenCalled();
      });

      it("rolls the retention back with an exit write that failed: both land or neither", async () => {
        const executor = await exitedExecutor();
        await refusing(
          "workspace_runtime_instances",
          executor.runId,
          "NEW.status = 'failed'",
          executor.sweep,
        );
        const during = await executor.state();
        expect(during.instance?.status).toBe("ready");
        expect(during.drain?.retainedAt ?? null).toBeNull();

        expect(await executor.sweep()).toBe(1);
        const after = await executor.state();
        expect(after.instance?.status).toBe("failed");
        expect(after.drain?.retainedAt).toBeInstanceOf(Date);
        expect(executor.stop).not.toHaveBeenCalled();
      });

      it("records a retention for an ended capture executor nothing settled, whatever its status", async () => {
        // The state the unfixed reconciler left behind: `failed`, no retention, disk present.
        const executor = await exitedExecutor();
        await run(
          Effect.gen(function* () {
            const instances = yield* WorkspaceRuntimeInstanceRepo;
            const row = yield* instances.getRuntimeInstanceByRunId(executor.runId);
            yield* instances.markExited({
              runId: executor.runId,
              resourceId: row?.resourceId ?? "",
              errorMessage: "exited 75 (retention write lost)",
            });
          }),
        );
        expect((await executor.state()).drain?.retainedAt ?? null).toBeNull();

        await executor.sweep();
        const after = await executor.state();
        expect(after.instance?.status).toBe("failed");
        expect(after.drain?.retainedAt).toBeInstanceOf(Date);
        expect(after.due.map((row) => row.runId)).toEqual([executor.runId]);
        expect(executor.stop).not.toHaveBeenCalled();
      });
    });
  },
);
