/**
 * Review 3 #6 against a REAL Postgres: a launch whose worker died after its capture executor
 * started. Gated on SEALANT_TEST_DATABASE_URL (a disposable database with the migrations
 * applied; it writes rows under fresh ids and leaves them).
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/stranded-launch.db.test.ts
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  LAUNCH_OWNERSHIP_LOST_MESSAGE,
  LAUNCH_RETAINED_ERROR_CODE,
  SealantDB,
  user,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  workspaceAttempts,
  workspaceRuntimeInstances,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import type { RuntimeAdapter, RuntimeAdapterInspectResult } from "../runtime/runtime-adapter.js";
import { adoptStrandedLaunchesEffect } from "./adopt-stranded-launches.js";
import { fakeCaptureDaemon } from "./capture-daemon.fixture.js";
import { databaseCaptureDrainLedger } from "./capture-drain-ledger.js";
import { reconcileRuntimeExitsEffect } from "./reconcile-runtime-exits.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const adapterReporting = (states: Record<string, RuntimeAdapterInspectResult>): RuntimeAdapter => ({
  id: "docker",
  supports: () => ({ supported: true }),
  launch: async () => {
    throw new Error("unused");
  },
  stop: async () => {
    throw new Error("a stranded capture executor must never be removed by this sweep");
  },
  inspect: async ({ resourceId }) => states[resourceId] ?? { state: "running" },
});

describe.skipIf(DATABASE_URL === undefined)("stranded launches (Postgres)", () => {
  let db: DB;
  const userId = `user_stranded_${randomUUID()}`;

  const newRun = async (): Promise<string> => {
    const runId = `run_stranded_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(workspaceAttempts).values({ id: runId, ownerUserId: userId }),
    );
    return runId;
  };

  const repos = () =>
    Layer.mergeAll(
      WorkspaceRuntimeInstanceRepoLive,
      WorkspaceCaptureDrainRepoLive,
      WorkspaceAttemptRepoLive,
    ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      WorkspaceRuntimeInstanceRepo | WorkspaceCaptureDrainRepo | WorkspaceAttemptRepo
    >,
  ) => Effect.runPromise(effect.pipe(Effect.provide(repos())));

  /** A launch's first row and its identity, written the way the launching worker writes them. */
  const startLaunch = (input: {
    readonly runId: string;
    readonly owner: string;
    readonly leaseMs: number;
    readonly resourceId: string;
    readonly deadline: Date;
  }) =>
    run(
      Effect.gen(function* () {
        const instances = yield* WorkspaceRuntimeInstanceRepo;
        yield* instances.upsertRuntimeInstance({
          runId: input.runId,
          status: "pending",
          sourceKind: "capture",
          launchOwner: input.owner,
          launchLeaseMs: input.leaseMs,
        });
        yield* instances.upsertRuntimeInstance({
          runId: input.runId,
          status: "pending",
          fenceLaunchOwner: input.owner,
          launchLeaseMs: input.leaseMs,
          adapter: "docker",
          resourceId: input.resourceId,
          reference: input.resourceId,
          runtimeDeadlineAt: input.deadline,
          sourceKind: "capture",
        });
      }),
    );

  const reconcile = (adapter: RuntimeAdapter) =>
    run(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
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

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      db.insert(user).values({ id: userId, name: "stranded", email: `${userId}@example.test` }),
    );
  });

  it("adopts a started executor whose launching worker is gone, and every sweep sees it", async () => {
    const overdue = new Date(Date.now() + 60_000);
    const lost = await newRun();
    const ended = await newRun();
    const live = await newRun();
    const legacy = await newRun();
    // Two launches whose workers died (ownership lapsed at once), one still owned and renewed.
    await startLaunch({
      runId: lost,
      owner: "dead-1",
      leaseMs: 0,
      resourceId: `c-${lost}`,
      deadline: overdue,
    });
    await startLaunch({
      runId: ended,
      owner: "dead-2",
      leaseMs: 0,
      resourceId: `c-${ended}`,
      deadline: overdue,
    });
    await startLaunch({
      runId: live,
      owner: "alive",
      leaseMs: 60_000,
      resourceId: `c-${live}`,
      deadline: overdue,
    });
    // A row a worker wrote before launch ownership existed: no owner.
    await Effect.runPromise(
      db.insert(workspaceRuntimeInstances).values({
        runId: legacy,
        status: "pending",
        adapter: "docker",
        resourceId: `c-${legacy}`,
        reference: `c-${legacy}`,
        sourceKind: "capture",
        runtimeDeadlineAt: overdue,
      }),
    );
    // Within its grace an ownerless row is left alone; past it, it is adopted like the others.
    const withinGrace = await run(
      adoptStrandedLaunchesEffect({ runtimeAdapters: [], resourceIds: [`c-${legacy}`] }),
    );
    expect(withinGrace).toEqual([]);
    const pastGrace = await run(
      adoptStrandedLaunchesEffect({
        runtimeAdapters: [],
        resourceIds: [`c-${legacy}`],
        unownedGraceMs: 0,
      }),
    );
    expect(pastGrace).toEqual([legacy]);

    await reconcile(adapterReporting({ [`c-${ended}`]: { state: "exited", exitCode: 75 } }));

    const state = await run(
      Effect.gen(function* () {
        const instances = yield* WorkspaceRuntimeInstanceRepo;
        const drains = yield* WorkspaceCaptureDrainRepo;
        return {
          rows: yield* instances.listRuntimeInstancesByRunIds([lost, ended, live, legacy]),
          retainedLaunches: (yield* instances.listRetainedLaunches()).map((row) => row.runId),
          candidates: (yield* instances.listPreservationCandidates()).map((row) => row.runId),
          recoveryDue: (yield* drains.listRetainedDue({ limit: 1000 })).map((row) => row.runId),
        };
      }),
    );
    for (const runId of [lost, ended, legacy]) {
      expect(state.rows.get(runId)).toMatchObject({
        status: "failed",
        errorCode: LAUNCH_RETAINED_ERROR_CODE,
        resourceId: `c-${runId}`,
        launchOwner: null,
        finishedAt: null,
      });
      // The retained-launch sweep drains and stops it; the deadline sweep drives it.
      expect(state.retainedLaunches).toContain(runId);
      expect(state.candidates).toContain(runId);
    }
    // The executor that already ended is retained at once: recovery restarts it.
    expect(state.recoveryDue).toContain(ended);
    expect(state.recoveryDue).not.toContain(lost);
    // The launch whose worker still renews it is its worker's, and the deadline sweep watches it.
    expect(state.rows.get(live)).toMatchObject({ status: "pending", launchOwner: "alive" });
    expect(state.candidates).toContain(live);
  });

  it("refuses the lost worker's late writes once its launch was adopted", async () => {
    const runId = await newRun();
    await startLaunch({
      runId,
      owner: "stalled",
      leaseMs: 0,
      resourceId: `c-${runId}`,
      deadline: new Date(Date.now() + 3_600_000),
    });
    await reconcile(adapterReporting({}));

    const late = await run(
      Effect.gen(function* () {
        const instances = yield* WorkspaceRuntimeInstanceRepo;
        const renewed = yield* instances.renewLaunchLease({
          runId,
          owner: "stalled",
          leaseMs: 60_000,
        });
        const ready = yield* instances
          .upsertRuntimeInstance({
            runId,
            status: "ready",
            fenceLaunchOwner: "stalled",
            releaseLaunch: true,
            adapter: "docker",
            resourceId: `c-${runId}`,
            reference: `c-${runId}`,
          })
          .pipe(Effect.flip);
        return { renewed, ready, row: yield* instances.getRuntimeInstanceByRunId(runId) };
      }),
    );
    expect(late.renewed).toBe(false);
    expect(late.ready.message).toBe(LAUNCH_OWNERSHIP_LOST_MESSAGE);
    expect(late.row).toMatchObject({ status: "failed", errorCode: LAUNCH_RETAINED_ERROR_CODE });
  });
});
