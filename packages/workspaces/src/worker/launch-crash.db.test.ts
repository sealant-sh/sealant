/**
 * e2e 5, case 4 (RD) against a REAL Postgres: the worker launching a capture workspace was
 * SIGKILLed 3 s after `docker run` (its build job already `succeeded`, pg-boss retry limit 0), and
 * the executor — running, with the session writing into it — sat outside every sweep for good.
 * Review 3's launch ownership covers an executor the launch recorded (`onStarted`); this pins the
 * whole sequence, and the window before that record: a worker lost between creating the executor
 * and recording it. Gated on SEALANT_TEST_DATABASE_URL (a disposable database with the migrations
 * applied; it writes rows under fresh ids and leaves them).
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/launch-crash.db.test.ts
 */
import { randomUUID } from "node:crypto";

import {
  ConnectedAccountRepoLive,
  createSealantDB,
  LAUNCH_LOST_ERROR_CODE,
  LAUNCH_RETAINED_ERROR_CODE,
  SealantDB,
  user,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRepoLive,
  workspaceAttempts,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { executorIsRetained, resolveWorkspaceStatus } from "../api/workspace.js";
import type { RuntimeLaunchIdentity } from "../runtime/launch-retention.js";
import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { SealantRuntime } from "../sealantd/runtime.js";
import { adoptStrandedLaunchesEffect } from "./adopt-stranded-launches.js";
import { fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { databaseCaptureDrainLedger } from "./capture-drain-ledger.js";
import { processWorkspaceStopEffect } from "./process-workspace-stop.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const SETTINGS = {
  pollIntervalMs: 5,
  stallWindowMs: 60_000,
  unreachableWindowMs: 60_000,
  requestTimeoutMs: 1_000,
};

/** Every sweep here looks at this test's runs only: other tests share the database. */
const adapterFor = (
  mine: ReadonlySet<string>,
  located: ReadonlyMap<string, RuntimeLaunchIdentity>,
): RuntimeAdapter => ({
  id: "docker",
  supports: () => ({ supported: true }),
  launch: async () => {
    throw new Error("unused");
  },
  stop: vi.fn(async ({ resourceId }: { resourceId: string }) => ({
    adapter: "docker" as const,
    resourceId,
    outcome: "stopped" as const,
  })),
  inspect: async () => ({ state: "running" }),
  locate: async ({ runId }) => {
    if (!mine.has(runId)) {
      throw new Error("not this test's run");
    }
    return located.get(runId);
  },
});

describe.skipIf(DATABASE_URL === undefined)("a worker lost mid-launch (Postgres)", () => {
  let db: DB;
  const userId = `user_launch_crash_${randomUUID()}`;

  const repos = () =>
    Layer.mergeAll(
      WorkspaceRuntimeInstanceRepoLive,
      WorkspaceCaptureDrainRepoLive,
      WorkspaceAttemptRepoLive,
      WorkspaceRepoLive,
      ConnectedAccountRepoLive,
    ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));

  const run = <A, E, R>(effect: Effect.Effect<A, E, R>, daemon?: Layer.Layer<SealantRuntime>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(Layer.mergeAll(repos(), daemon ?? fakeCaptureDaemon(["unreachable"]).layer)),
      ) as Effect.Effect<A, E>,
    );

  const newRun = async (): Promise<string> => {
    const runId = `run_launch_crash_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(workspaceAttempts).values({ id: runId, ownerUserId: userId }),
    );
    return runId;
  };

  /** The launch's first write, as the launching worker makes it (before `docker run`). */
  const firstLaunchWrite = (runId: string, owner: string, leaseMs: number) =>
    run(
      Effect.gen(function* () {
        yield* (yield* WorkspaceRuntimeInstanceRepo).upsertRuntimeInstance({
          runId,
          status: "pending",
          sourceKind: "capture",
          launchOwner: owner,
          launchLeaseMs: leaseMs,
          daemonRecoveryBoot: true,
        });
      }),
    );

  const rowOf = (runId: string) =>
    run(
      Effect.gen(function* () {
        return yield* (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(runId);
      }),
    );

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      db.insert(user).values({ id: userId, name: "crash", email: `${userId}@example.test` }),
    );
  });

  it("a launch that recorded its executor: retained once its worker is gone, then drained and stopped", async () => {
    const runId = await newRun();
    const resourceId = `container-${runId}`;
    // The worker's writes: its first row, then `onStarted` right after `docker run`. Then the
    // worker is SIGKILLed: no renewal, no terminal write, and its build job already succeeded.
    await firstLaunchWrite(runId, "worker-a", 200);
    await run(
      Effect.gen(function* () {
        yield* (yield* WorkspaceRuntimeInstanceRepo).upsertRuntimeInstance({
          runId,
          status: "pending",
          fenceLaunchOwner: "worker-a",
          launchLeaseMs: 200,
          adapter: "docker",
          resourceId,
          reference: `sealant-${runId}`,
          sourceKind: "capture",
        });
      }),
    );
    const adapter = adapterFor(new Set([runId]), new Map());

    // The restarted worker's boot sweep, inside the dead worker's lease: nothing is taken over.
    const early = await run(
      adoptStrandedLaunchesEffect({ runtimeAdapters: [adapter], resourceIds: [resourceId] }),
    );
    expect(early).toEqual([]);
    expect(await rowOf(runId)).toMatchObject({ status: "pending", launchOwner: "worker-a" });

    // Past it, the executor is adopted as a retained launch — and reads `retained`, never dead.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const adopted = await run(
      adoptStrandedLaunchesEffect({ runtimeAdapters: [adapter], resourceIds: [resourceId] }),
    );
    expect(adopted).toEqual([runId]);
    const row = await rowOf(runId);
    expect(row).toMatchObject({ status: "failed", errorCode: LAUNCH_RETAINED_ERROR_CODE });
    expect(
      resolveWorkspaceStatus({
        attempt: { status: "failed" },
        ...(row === undefined ? {} : { runtimeInstance: row }),
        retained: executorIsRetained({ runtimeInstance: row }),
      }),
    ).toBe("retained");

    // The retained-launch sweep drains it (FINAL flush, confirmed complete) and only then stops it.
    const daemon = fakeCaptureDaemon([savedStatus()]);
    const outcome = await run(
      processWorkspaceStopEffect({
        runId,
        stopReason: "failed",
        runtimeAdapters: [adapter],
        captureDrain: {
          ledger: databaseCaptureDrainLedger({ db, owner: "db-test", leaseMs: 60_000 }),
          settings: SETTINGS,
          budgetMs: 1_000,
          label: "retained launch",
        },
      }),
      daemon.layer,
    );
    expect(outcome).toBe("stopped");
    expect(daemon.flushRequests).toContainEqual(expect.objectContaining({ kind: "final" }));
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(await rowOf(runId)).toMatchObject({ status: "stopped" });
  });

  it("finds an executor its lost worker created but never recorded, and adopts it", async () => {
    const runId = await newRun();
    // Killed between `docker run` and `onStarted`: the row names no executor.
    await firstLaunchWrite(runId, "worker-b", 0);
    const identity: RuntimeLaunchIdentity = {
      adapter: "docker",
      resourceId: `container-${runId}`,
      reference: `sealant-${runId}`,
    };
    const adapter = adapterFor(new Set([runId]), new Map([[runId, identity]]));

    const adopted = await run(adoptStrandedLaunchesEffect({ runtimeAdapters: [adapter] }));

    expect(adopted).toContain(runId);
    expect(await rowOf(runId)).toMatchObject({
      status: "failed",
      errorCode: LAUNCH_RETAINED_ERROR_CODE,
      adapter: "docker",
      resourceId: `container-${runId}`,
      reference: `sealant-${runId}`,
      launchOwner: null,
    });
  });

  it("ends a lost launch no runtime knows an executor of, only after the grace", async () => {
    const runId = await newRun();
    await firstLaunchWrite(runId, "worker-c", 0);
    const adapter = adapterFor(new Set([runId]), new Map());

    // Within the grace a creation still in flight may yet land: left alone.
    await run(
      adoptStrandedLaunchesEffect({ runtimeAdapters: [adapter], lostLaunchGraceMs: 60_000 }),
    );
    expect(await rowOf(runId)).toMatchObject({ status: "pending" });

    // A runtime that cannot look (no `locate`) never lets it be called lost.
    const { locate: _cannotLook, ...withoutLocate } = adapter;
    const blind: RuntimeAdapter = { ...withoutLocate, id: "k8s" };
    await run(
      adoptStrandedLaunchesEffect({ runtimeAdapters: [adapter, blind], lostLaunchGraceMs: 0 }),
    );
    expect(await rowOf(runId)).toMatchObject({ status: "pending" });

    await run(adoptStrandedLaunchesEffect({ runtimeAdapters: [adapter], lostLaunchGraceMs: 0 }));
    expect(await rowOf(runId)).toMatchObject({
      status: "failed",
      errorCode: LAUNCH_LOST_ERROR_CODE,
      launchOwner: null,
    });
    const attempt = await run(
      Effect.gen(function* () {
        return yield* (yield* WorkspaceAttemptRepo).getAttemptById(runId);
      }),
    );
    expect(attempt?.status).toBe("failed");
    // Nothing of it is retained: there is no executor to keep.
    const drain = await run(
      Effect.gen(function* () {
        return yield* (yield* WorkspaceCaptureDrainRepo).getByRunId(runId);
      }),
    );
    expect(drain?.retainedAt ?? null).toBeNull();
  });
});
