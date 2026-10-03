/**
 * Unit tests for the shared stop path. The critical property is the latest-run guard: stopping a
 * SUPERSEDED runtime (restart's stop half, or the reaper sweeping a leftover container) must not
 * stamp "stopped" onto a workspace that is already relaunching — the reaper treats a live
 * container on a stored-"stopped" workspace as stranded and would kill the fresh runtime.
 */
import {
  ConnectedAccountRepo,
  WorkspaceAttemptRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccountRepoService,
  type Workspace,
  type WorkspaceAttemptRepoService,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Effect, Layer, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";

import { removalRefused, type RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { SealantRuntime } from "../sealantd/runtime.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import {
  EMPTY_CAPTURE_DRAIN_ENTRY,
  InMemoryCaptureDrainStore,
  inMemoryCaptureDrainLedger,
  type CaptureDrainEntry,
  type CaptureDrainLedger,
  type CaptureDrainSettings,
} from "./capture-drain.js";
import { processWorkspaceStopEffect } from "./process-workspace-stop.js";

/** A recovery ticket that holds no claim: admission answers only what excludes a recovery. */
const NO_CLAIM = { token: "no-recovery-claim" };

const runtimeInstance = (
  overrides: Partial<WorkspaceRuntimeInstance> = {},
): WorkspaceRuntimeInstance => ({
  runId: "run_old",
  status: "ready",
  adapter: "docker",
  resourceId: "container-1",
  reference: "sealant-run-old",
  endpoint: null,
  errorCode: null,
  errorMessage: null,
  stopReason: null,
  launchCredentialInjections: null,
  launchedAt: new Date("2026-07-01T00:00:00.000Z"),
  finishedAt: null,
  runtimeDeadlineAt: null,
  launchOwner: null,
  launchLeaseExpiresAt: null,
  daemonImage: null,
  daemonRecoveryBoot: null,
  // Null = a row that predates the column: the stop path reads the attempt snapshot.
  sourceKind: null,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  ...overrides,
});

const workspaceRow = (overrides: Partial<Workspace> = {}): Workspace =>
  ({
    id: "ws_1",
    name: "demo",
    ownerUserId: "user_1",
    repositoryId: null,
    repositoryProfileRevisionId: null,
    profileRevisionId: null,
    requestedByUserId: null,
    status: "queued",
    latestRunId: "run_old",
    expiresAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  }) as Workspace;

const stubAdapter = (
  stop: RuntimeAdapter["stop"],
  inspect?: NonNullable<RuntimeAdapter["inspect"]>,
): RuntimeAdapter => ({
  id: "docker",
  supports: () => ({ supported: true }),
  launch: async () => {
    throw new Error("not used in stop tests");
  },
  stop,
  ...(inspect === undefined ? {} : { inspect }),
});

interface Harness {
  readonly markStopped: ReturnType<typeof vi.fn>;
  readonly markStopRequested: ReturnType<typeof vi.fn>;
  readonly setWorkspaceStatus: ReturnType<typeof vi.fn>;
  readonly getAttemptSnapshotByRunId: ReturnType<typeof vi.fn>;
  readonly layer: Layer.Layer<
    | WorkspaceRepo
    | WorkspaceRuntimeInstanceRepo
    | WorkspaceAttemptRepo
    | ConnectedAccountRepo
    | SealantRuntime
  >;
}

const makeHarness = (input: {
  readonly workspace: Workspace | undefined;
  readonly instance: WorkspaceRuntimeInstance | undefined;
  /**
   * The run's stored blueprint names a capture source (true), or the runtime instance records a
   * non-capture source (false). Absent: nothing records the source at all.
   */
  readonly captureSourced?: boolean;
  /** The daemon the drain talks to; default = one that must never be dialled. */
  readonly daemon?: Layer.Layer<SealantRuntime>;
}): Harness => {
  const markStopped = vi.fn((request: { runId: string }) =>
    Effect.succeed(runtimeInstance({ runId: request.runId, status: "stopped" })),
  );
  const setWorkspaceStatus = vi.fn(() => Effect.succeed(input.workspace ?? null));
  const markStopRequested = vi.fn((_request: { runId: string; stopReason: string }) => Effect.void);

  const workspaceRepoLayer = Layer.succeed(WorkspaceRepo, {
    createWorkspace: () => Effect.die("unused"),
    getWorkspaceByAttemptId: () => Effect.succeed(input.workspace),
    getWorkspaceById: () => Effect.succeed(input.workspace),
    getWorkspaceByIdempotencyKey: () => Effect.succeed(undefined),
    setWorkspaceBinds: () => Effect.succeed(input.workspace ?? null),
    linkWorkspaceAttempt: () => Effect.die("unused"),
    listWorkspaces: () => Effect.succeed([]),
    listWorkspaceAttemptLinks: () => Effect.succeed([]),
    setWorkspaceName: () => Effect.die("unused"),
    setWorkspaceExpiry: () => Effect.die("unused"),
    setWorkspaceStatus,
  });

  const runtimeInstanceRepoLayer = Layer.succeed(WorkspaceRuntimeInstanceRepo, {
    upsertRuntimeInstance: () => Effect.die("unused"),
    markExited: () => Effect.die("unused"),
    markStopped,
    getRuntimeInstanceByRunId: () =>
      Effect.succeed(
        input.instance !== undefined && input.captureSourced === false
          ? { ...input.instance, sourceKind: "github" }
          : input.instance,
      ),
    listRuntimeInstancesByRunIds: () => Effect.succeed(new Map()),
    listRunningInstances: () => Effect.succeed(input.instance ? [input.instance] : []),
    listRetainedLaunches: () => Effect.succeed([]),
    listStrandedLaunches: () => Effect.succeed([]),
    adoptStrandedLaunch: () => Effect.succeed(undefined),
    listUnidentifiedStrandedLaunches: () => Effect.succeed([]),
    identifyStrandedLaunch: () => Effect.succeed(undefined),
    failLostLaunch: () => Effect.succeed(undefined),
    renewLaunchLease: () => Effect.succeed(false),
    listPreservationCandidates: () => Effect.succeed([]),
    preemptLaunch: () => Effect.succeed(undefined),
    listUnsettledCaptureExecutors: () => Effect.succeed([]),
    markStopRequested,
  });

  // The pre-teardown credential sync-back consults the attempt snapshot before the adapter stop;
  // returning undefined makes it a logged no-op without touching accounts or the exec bridge.
  const getAttemptSnapshotByRunId = vi.fn((_runId: string) =>
    Effect.succeed(
      input.captureSourced === true
        ? { blueprintPayload: { sources: { workspace: { kind: "capture" } } } }
        : undefined,
    ),
  );
  const attemptRepoLayer = Layer.succeed(WorkspaceAttemptRepo, {
    getAttemptSnapshotByRunId,
  } as unknown as WorkspaceAttemptRepoService);
  const connectedAccountRepoLayer = Layer.succeed(
    ConnectedAccountRepo,
    {} as ConnectedAccountRepoService,
  );
  const sealantRuntimeLayer =
    input.daemon ??
    Layer.succeed(SealantRuntime, {
      connect: () => Effect.die("exec bridge unused in stop tests"),
    });

  return {
    markStopped,
    markStopRequested,
    setWorkspaceStatus,
    getAttemptSnapshotByRunId,
    layer: Layer.mergeAll(
      workspaceRepoLayer,
      runtimeInstanceRepoLayer,
      attemptRepoLayer,
      connectedAccountRepoLayer,
      sealantRuntimeLayer,
    ),
  };
};

describe("processWorkspaceStopEffect", () => {
  it("removes the container, marks the instance stopped, and settles the CURRENT runtime's workspace", async () => {
    const harness = makeHarness({
      // A git-sourced run: no captures, so a plain stop removes it.
      captureSourced: false,
      workspace: workspaceRow({ latestRunId: "run_old" }),
      instance: runtimeInstance(),
    });
    const stop = vi.fn<RuntimeAdapter["stop"]>(async () => ({
      adapter: "docker" as const,
      resourceId: "container-1",
      outcome: "stopped" as const,
    }));

    await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [stubAdapter(stop)],
      }).pipe(Effect.provide(harness.layer)),
    );

    // Two phases: the executor ends, the stop is recorded, then its remains go.
    expect(stop.mock.calls.map(([input]) => input)).toEqual([
      { resourceId: "container-1", reference: "sealant-run-old", phase: "end" },
      { resourceId: "container-1", reference: "sealant-run-old", phase: "remove" },
    ]);
    expect(harness.markStopped).toHaveBeenCalledWith({ runId: "run_old", stopReason: "user" });
    expect(harness.setWorkspaceStatus).toHaveBeenCalledWith({ id: "ws_1", status: "stopped" });
    expect(harness.markStopped.mock.invocationCallOrder[0]).toBeLessThan(
      stop.mock.invocationCallOrder[1] ?? 0,
    );
  });

  it("records the stop when the executor ended but removing its remains failed (the remains sweep takes them)", async () => {
    const harness = makeHarness({
      captureSourced: false,
      workspace: workspaceRow({ latestRunId: "run_old" }),
      instance: runtimeInstance(),
    });
    const stop = vi.fn<RuntimeAdapter["stop"]>(async (input) => {
      if (input.phase === "remove") {
        throw new Error("Error response from daemon: device or resource busy");
      }
      return { adapter: "docker" as const, resourceId: "container-1", outcome: "stopped" as const };
    });

    await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [stubAdapter(stop)],
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(stop).toHaveBeenCalledTimes(2);
    expect(harness.markStopped).toHaveBeenCalledWith({ runId: "run_old", stopReason: "user" });
    expect(harness.setWorkspaceStatus).toHaveBeenCalledWith({ id: "ws_1", status: "stopped" });
  });

  it("does NOT settle the workspace row when the stopped run is SUPERSEDED (restart race)", async () => {
    const harness = makeHarness({
      // A git-sourced run: no captures, so a plain stop removes it.
      captureSourced: false,
      // The workspace has already moved on to a new attempt (restart persisted first).
      workspace: workspaceRow({ latestRunId: "run_new", status: "queued" }),
      instance: runtimeInstance({ runId: "run_old" }),
    });

    await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [
          stubAdapter(async () => ({
            adapter: "docker",
            resourceId: "container-1",
            outcome: "stopped",
          })),
        ],
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.markStopped).toHaveBeenCalledOnce();
    expect(harness.setWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("aborts the status writes when the adapter stop fails (never records a false stop)", async () => {
    const harness = makeHarness({
      // A git-sourced run: no captures, so a plain stop removes it.
      captureSourced: false,
      workspace: workspaceRow(),
      instance: runtimeInstance(),
    });

    await expect(
      Effect.runPromise(
        processWorkspaceStopEffect({
          workspaceId: "ws_1",
          runId: "run_old",
          stopReason: "user",
          runtimeAdapters: [
            stubAdapter(async () => {
              throw new Error("Cannot connect to the Docker daemon");
            }),
          ],
        }).pipe(Effect.provide(harness.layer)),
      ),
    ).rejects.toThrow(/Docker daemon/);

    expect(harness.markStopped).not.toHaveBeenCalled();
    expect(harness.setWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("keeps a runtime whose source is unknown when the stop passes no capture drain (fail closed)", async () => {
    // Follow-up to review 2: an omitted `captureDrain` used to mean "not capture-sourced", so any
    // caller that forgot it removed a capture executor without a drain or any evidence.
    for (const inspect of [
      async () => ({ state: "running" as const }),
      async () => ({ state: "exited" as const, exitCode: 75 }),
    ]) {
      const harness = makeHarness({ workspace: workspaceRow(), instance: runtimeInstance() });
      const stop = vi.fn(async () => ({
        adapter: "docker" as const,
        resourceId: "container-1",
        outcome: "stopped" as const,
      }));
      const outcome = await Effect.runPromise(
        processWorkspaceStopEffect({
          workspaceId: "ws_1",
          runId: "run_old",
          stopReason: "user",
          runtimeAdapters: [stubAdapter(stop, inspect)],
        }).pipe(Effect.provide(harness.layer)),
      );
      expect(outcome).toBe("kept");
      expect(stop).not.toHaveBeenCalled();
      expect(harness.markStopped).not.toHaveBeenCalled();
    }
  });

  it("keeps a capture-sourced runtime when the stop passes no capture drain", async () => {
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
    });
    const stop = vi.fn(async () => ({
      adapter: "docker" as const,
      resourceId: "container-1",
      outcome: "stopped" as const,
    }));
    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(stop)],
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(outcome).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
  });

  it("skips the container teardown entirely when no runtime instance exists, but still settles the row", async () => {
    const harness = makeHarness({
      workspace: workspaceRow({ latestRunId: "run_old" }),
      instance: undefined,
    });
    const stop = vi.fn(async () => ({
      adapter: "docker" as const,
      resourceId: "container-1",
      outcome: "stopped" as const,
    }));

    await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [stubAdapter(stop)],
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(stop).not.toHaveBeenCalled();
    expect(harness.markStopped).not.toHaveBeenCalled();
    expect(harness.setWorkspaceStatus).toHaveBeenCalledWith({ id: "ws_1", status: "stopped" });
  });

  it("runs the credential sync-back BEFORE the container is destroyed (docker teardown path)", async () => {
    const harness = makeHarness({
      // A git-sourced run: no captures, so a plain stop removes it.
      captureSourced: false,
      workspace: workspaceRow({ latestRunId: "run_old" }),
      instance: runtimeInstance(),
    });
    const order: string[] = [];
    harness.getAttemptSnapshotByRunId.mockImplementation((_runId: string) => {
      order.push("sync-back");
      return Effect.succeed(undefined);
    });
    const stop = vi.fn(async () => {
      order.push("adapter-stop");
      return {
        adapter: "docker" as const,
        resourceId: "container-1",
        outcome: "stopped" as const,
      };
    });

    await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [stubAdapter(stop)],
      }).pipe(Effect.provide(harness.layer)),
    );

    // Rotated session files can only be read while the container is alive.
    expect(order).toEqual(["sync-back", "adapter-stop", "adapter-stop"]);
  });

  it("skips the sync-back when the adapter reports the runtime already ended, and still tears down", async () => {
    const harness = makeHarness({
      // A git-sourced run: no captures, so a plain stop removes it.
      captureSourced: false,
      workspace: workspaceRow({ latestRunId: "run_old" }),
      instance: runtimeInstance(),
    });
    const order: string[] = [];
    harness.getAttemptSnapshotByRunId.mockImplementation((_runId: string) => {
      order.push("sync-back");
      return Effect.succeed(undefined);
    });
    const stop = vi.fn(async () => {
      order.push("adapter-stop");
      return {
        adapter: "docker" as const,
        resourceId: "container-1",
        outcome: "not-found" as const,
      };
    });
    const inspect = vi.fn(async () => ({ state: "missing" as const }));

    await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [stubAdapter(stop, inspect)],
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(inspect).toHaveBeenCalledWith({ resourceId: "container-1" });
    // Nothing to read from a runtime that is gone: straight to the (idempotent) teardown.
    expect(order).toEqual(["adapter-stop", "adapter-stop"]);
    expect(harness.markStopped).toHaveBeenCalledTimes(1);
    expect(harness.setWorkspaceStatus).toHaveBeenCalledWith({ id: "ws_1", status: "stopped" });
  });

  it("keeps the sync-back when the liveness read itself fails", async () => {
    const harness = makeHarness({
      // A git-sourced run: no captures, so a plain stop removes it.
      captureSourced: false,
      workspace: workspaceRow({ latestRunId: "run_old" }),
      instance: runtimeInstance(),
    });
    const order: string[] = [];
    harness.getAttemptSnapshotByRunId.mockImplementation((_runId: string) => {
      order.push("sync-back");
      return Effect.succeed(undefined);
    });
    const stop = vi.fn(async () => {
      order.push("adapter-stop");
      return {
        adapter: "docker" as const,
        resourceId: "container-1",
        outcome: "stopped" as const,
      };
    });
    const inspect = vi.fn(async () => {
      throw new Error("daemon unreachable");
    });

    await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [stubAdapter(stop, inspect)],
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(order).toEqual(["sync-back", "adapter-stop", "adapter-stop"]);
  });
});

const stopped = () =>
  vi.fn(async () => ({
    adapter: "docker" as const,
    resourceId: "container-1",
    outcome: "stopped" as const,
  }));

/** A ledger whose record of run_old holds `entry`. */
const withEntry = (entry: Partial<CaptureDrainEntry>) => {
  const ledger = inMemoryCaptureDrainLedger();
  ledger.store.rows.set("run_old", {
    entry: { ...EMPTY_CAPTURE_DRAIN_ENTRY, ...entry },
    observation: undefined,
    owner: undefined,
    expiresAt: undefined,
  });
  return ledger;
};

describe("processWorkspaceStopEffect · drain before stop", () => {
  const FAST: CaptureDrainSettings = {
    pollIntervalMs: 1,
    stallWindowMs: 30,
    unreachableWindowMs: 30,
    requestTimeoutMs: 1_000,
  };
  const drainOptions = (ledger = inMemoryCaptureDrainLedger()) => ({
    captureDrain: { ledger, settings: FAST, budgetMs: 1_000, label: "test reaper" },
  });

  it("drains a capture-sourced runtime until its final flush is complete, then stops it", async () => {
    const daemon = fakeCaptureDaemon([
      captureStatus({ pending: 2, uploadedBytes: 5 }),
      savedStatus({ uploadedBytes: 9 }),
    ]);
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance(),
      captureSourced: true,
      daemon: daemon.layer,
    });
    const stop = removedStop();

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(stop)],
        ...drainOptions(),
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("stopped");
    expect(daemon.calls.slice(0, 2)).toEqual(["flush", "status"]);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(harness.markStopped).toHaveBeenCalledWith({ runId: "run_old", stopReason: "expired" });
  });

  it("leaves a run to the stop in flight: the stranded reaper neither drains nor removes it (e2e 5)", async () => {
    // e2e 5: the lifecycle stop's drain saw the final flush complete and was removing the
    // container (`docker stop` waits the grace); the stranded reaper saw the workspace `stopped`
    // and the runtime still up, drained it again, and retried the daemon — shut down by then —
    // 12 times over 55 s after the container was gone.
    const daemon = fakeCaptureDaemon([savedStatus(), "unreachable"]);
    const harness = makeHarness({
      workspace: workspaceRow({ status: "stopped" }),
      instance: runtimeInstance(),
      captureSourced: true,
      daemon: daemon.layer,
    });
    const store = new InMemoryCaptureDrainStore();
    const removalStarted = Promise.withResolvers<void>();
    const removalDone = Promise.withResolvers<void>();
    const lifecycleStop = vi.fn(async () => {
      removalStarted.resolve();
      await removalDone.promise;
      return { adapter: "docker" as const, resourceId: "container-1", outcome: "stopped" as const };
    });
    const inspect = vi.fn(async () => ({ state: "running" as const }));
    const stopWith = (label: string, stop: RuntimeAdapter["stop"]) =>
      Effect.runPromise(
        processWorkspaceStopEffect({
          workspaceId: "ws_1",
          runId: "run_old",
          stopReason: "user",
          runtimeAdapters: [stubAdapter(stop, inspect)],
          captureDrain: {
            ledger: inMemoryCaptureDrainLedger({ store }),
            settings: { ...FAST, unreachableWindowMs: 60_000, pollIntervalMs: 5 },
            budgetMs: 300,
            label,
          },
        }).pipe(Effect.provide(harness.layer)),
      );

    const lifecycle = stopWith("lifecycle stop", lifecycleStop);
    await removalStarted.promise;
    const reaperStop = stopped();
    const reaper = await stopWith("stranded reaper", reaperStop);

    expect(reaper).toBe("busy");
    expect(reaperStop).not.toHaveBeenCalled();
    // Only the lifecycle stop's FINAL reached the daemon.
    expect(daemon.connect).toHaveBeenCalledTimes(1);

    removalDone.resolve();
    expect(await lifecycle).toBe("stopped");
    // Released: a later sweep may take the run again.
    expect(store.rows.get("run_old")?.owner).toBeUndefined();
  });

  it("keeps a runtime whose daemon answers but whose queue stalled: no stop, no writes", async () => {
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance(),
      captureSourced: true,
      daemon: fakeCaptureDaemon([captureStatus({ pending: 7, uploadedBytes: 1 })]).layer,
    });
    const stop = removedStop();

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(stop)],
        ...drainOptions(),
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
    expect(harness.markStopped).not.toHaveBeenCalled();
    expect(harness.setWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("defers the stop while the queue is still moving and the budget is spent", async () => {
    let uploaded = 0;
    const moving = Array.from({ length: 100 }, () => {
      uploaded += 1;
      return captureStatus({ pending: 3, uploadedBytes: uploaded });
    });
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance(),
      captureSourced: true,
      daemon: fakeCaptureDaemon(moving).layer,
    });
    const stop = removedStop();

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [stubAdapter(stop)],
        captureDrain: {
          ledger: inMemoryCaptureDrainLedger(),
          settings: FAST,
          budgetMs: 3,
          label: "lifecycle stop",
        },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("draining");
    expect(stop).not.toHaveBeenCalled();
    expect(harness.markStopped).not.toHaveBeenCalled();
  });

  it("keeps a runtime whose daemon is silent while the runtime reports it running", async () => {
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance(),
      captureSourced: true,
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const stop = removedStop();
    const inspect = vi.fn(async () => ({ state: "running" as const }));

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(stop, inspect)],
        ...drainOptions(),
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
    expect(harness.markStopped).not.toHaveBeenCalled();
  });

  it("stops once the daemon is silent and the runtime reports the executor gone", async () => {
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance(),
      captureSourced: true,
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const stop = removedStop();
    // Running when the stop starts; gone by the time the silence is judged.
    const inspect = vi
      .fn<NonNullable<RuntimeAdapter["inspect"]>>()
      .mockResolvedValueOnce({ state: "running" })
      .mockResolvedValue({ state: "missing" });

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(stop, inspect)],
        ...drainOptions(),
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("stopped");
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("keeps a capture-sourced runtime this worker cannot address", async () => {
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ adapter: "microvm", endpoint: null }),
      captureSourced: true,
    });
    const stop = removedStop();
    const adapter = { ...stubAdapter(stop), id: "microvm" as const };

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [adapter],
        ...drainOptions(),
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
  });

  it("never dials the daemon for a workspace that is not capture-sourced", async () => {
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 9 })]);
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance(),
      captureSourced: false,
      daemon: daemon.layer,
    });
    const stop = removedStop();

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(stop)],
        ...drainOptions(),
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("stopped");
    expect(daemon.calls).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("skips the drain for a runtime the adapter already reports ended", async () => {
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 9 })]);
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance(),
      captureSourced: true,
      daemon: daemon.layer,
    });
    const stop = removedStop();

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(stop, async () => ({ state: "missing" as const }))],
        ...drainOptions(),
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("stopped");
    expect(daemon.calls).toEqual([]);
  });

  it("keeps a runtime whose queue is empty but whose daemon never confirmed the flush complete", async () => {
    // sealantd 0.18.2 (the pinned daemon) answers an empty queue without `complete`: bulk it never
    // snapshotted can still sit on the executor's disk. Not saved, so not stopped.
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 0, registered: 3 })]);
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance(),
      captureSourced: true,
      daemon: daemon.layer,
    });
    const stop = removedStop();

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(stop)],
        ...drainOptions(),
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
    expect(harness.markStopped).not.toHaveBeenCalled();
    expect(harness.setWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("drains a run whose source nothing records (no source kind, no attempt snapshot): fail closed", async () => {
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 4, uploadedBytes: 1 })]);
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: null }),
      daemon: daemon.layer,
    });
    const stop = removedStop();

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(stop)],
        ...drainOptions(),
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(daemon.calls[0]).toBe("flush");
    expect(outcome).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
    expect(harness.markStopped).not.toHaveBeenCalled();
  });

  it("drains a run the runtime instance records as capture-sourced even without a snapshot", async () => {
    const daemon = fakeCaptureDaemon([savedStatus()]);
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: daemon.layer,
    });
    const stop = removedStop();

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(stop)],
        ...drainOptions(),
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("stopped");
    expect(daemon.calls).toEqual(["flush"]);
  });

  it("reads credentials back BEFORE the final flush (the daemon refuses exec after it), once", async () => {
    const order: string[] = [];
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 2, uploadedBytes: 1 })]);
    const connect = daemon.connect.getMockImplementation();
    daemon.connect.mockImplementation((...args: Parameters<NonNullable<typeof connect>>) => {
      order.push("daemon");
      return connect?.(...args) ?? Effect.die("no implementation");
    });
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: daemon.layer,
    });
    harness.getAttemptSnapshotByRunId.mockImplementation((_runId: string) =>
      Effect.sync(() => {
        order.push("sync-back");
        return undefined;
      }),
    );
    const ledger = inMemoryCaptureDrainLedger();
    const run = () =>
      Effect.runPromise(
        processWorkspaceStopEffect({
          workspaceId: "ws_1",
          runId: "run_old",
          stopReason: "expired",
          runtimeAdapters: [stubAdapter(stopped())],
          captureDrain: { ledger, settings: FAST, budgetMs: 2, label: "test reaper" },
        }).pipe(Effect.provide(harness.layer)),
      );

    expect(await run()).toBe("draining");
    expect(order[0]).toBe("sync-back");
    expect(order.indexOf("sync-back")).toBeLessThan(order.indexOf("daemon"));

    // The next sweep continues the drain; the daemon already had its FINAL flush, so no exec.
    order.length = 0;
    await run();
    expect(order).not.toContain("sync-back");
  });

  it("keeps an executor that exited after a final flush it never confirmed complete", async () => {
    // First sweep: the daemon answers the FINAL flush but reports it incomplete.
    const ledger = inMemoryCaptureDrainLedger();
    const first = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: fakeCaptureDaemon([
        captureStatus({ pending: 0, complete: false, incompleteReason: "ship-failed" }),
      ]).layer,
    });
    const firstStop = stopped();
    expect(
      await Effect.runPromise(
        processWorkspaceStopEffect({
          workspaceId: "ws_1",
          runId: "run_old",
          stopReason: "expired",
          runtimeAdapters: [stubAdapter(firstStop, async () => ({ state: "running" as const }))],
          captureDrain: { ledger, settings: FAST, budgetMs: 1_000, label: "test reaper" },
        }).pipe(Effect.provide(first.layer)),
      ),
    ).toBe("kept");

    // The daemon then exited (75) with its staging on disk; the container is exited, not gone.
    const second = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const secondStop = stopped();
    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(secondStop, async () => ({ state: "exited" as const }))],
        captureDrain: { ledger, settings: FAST, budgetMs: 1_000, label: "test reaper" },
      }).pipe(Effect.provide(second.layer)),
    );

    expect(outcome).toBe("kept");
    expect(secondStop).not.toHaveBeenCalled();
    expect(second.markStopped).not.toHaveBeenCalled();
  });

  it("keeps an exited capture executor that no drain ever reached (sealantd exited 75 on its own)", async () => {
    // Review 2 #2: a plain `docker stop`, or sealantd's own shutdown FINAL failing its uploads,
    // exits 75 with the only copy of the staged captures on the container's disk. No Core drain
    // ran, so the ledger is empty: nothing proves the work saved, and the executor is kept.
    const daemon = fakeCaptureDaemon(["unreachable"]);
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      captureSourced: true,
      daemon: daemon.layer,
    });
    const stop = removedStop();
    const ledger = inMemoryCaptureDrainLedger();

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [
          stubAdapter(stop, async () => ({ state: "exited" as const, exitCode: 75 })),
        ],
        captureDrain: { ledger, settings: FAST, budgetMs: 1, label: "test reaper" },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
    expect(harness.markStopped).not.toHaveBeenCalled();
    expect(ledger.store.rows.get("run_old")?.observation).toMatchObject({
      state: "kept",
      detail: expect.stringContaining("executor exited"),
    });
  });

  const exitedStop = async (ledger: CaptureDrainLedger) => {
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const stop = removedStop();
    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [
          stubAdapter(stop, async () => ({ state: "exited" as const, exitCode: 75 })),
        ],
        captureDrain: { ledger, settings: FAST, budgetMs: 1, label: "lifecycle stop" },
      }).pipe(Effect.provide(harness.layer)),
    );
    return { outcome, stop, harness };
  };

  it("removes an exited capture executor the control plane attested complete for THIS executor", async () => {
    // Core's last observation was made while the head was still short of the sealed capture:
    // the seal came after it (a FINAL whose answer was lost).
    const ledger = withEntry({
      last: captureStatus({ epoch: 3, headN: 40, pending: 1, complete: false }),
      completionAttested: {
        executorId: "container-1",
        epoch: 3,
        captureN: 41,
        atMs: Date.now(),
        by: "user_1",
      },
    });
    const { outcome, stop } = await exitedStop(ledger);
    expect(outcome).toBe("stopped");
    expect(stop).toHaveBeenCalledTimes(2);
    expect(ledger.store.rows.get("run_old")?.observation).toMatchObject({
      state: "stopped",
      detail: expect.stringContaining("attested a sealed final capture"),
    });
  });

  it("keeps an exited executor whose seal Core's own later observation contradicts (review 4 #1)", async () => {
    // Capture 41 was sealed; later the disk changed and the FINAL could not snapshot it
    // (`snapshot-failed`, no newer capture registered: the head is still 41). Core read that
    // failed answer after the seal: a received failure is not overridden by an older seal.
    const sealedAtMs = Date.now() - 120_000;
    for (const variant of [
      { headN: 41, lastAtMs: sealedAtMs + 30_000, sealedAtMs },
      // No seal time: the seal cannot be shown to follow an incomplete observation at its head.
      { headN: 41, lastAtMs: sealedAtMs - 600_000, sealedAtMs: undefined },
      // A later capture than the sealed one exists: the seal does not cover it.
      { headN: 42, lastAtMs: sealedAtMs - 600_000, sealedAtMs },
    ]) {
      const ledger = withEntry({
        last: captureStatus({
          epoch: 3,
          headN: variant.headN,
          complete: false,
          incompleteReason: "snapshot-failed",
          unreadable: 1,
        }),
        lastAtMs: variant.lastAtMs,
        completionAttested: {
          executorId: "container-1",
          epoch: 3,
          captureN: 41,
          ...(variant.sealedAtMs === undefined ? {} : { sealedAtMs: variant.sealedAtMs }),
          atMs: Date.now(),
          by: "user_1",
        },
      });
      const { outcome, stop } = await exitedStop(ledger);
      expect(outcome).toBe("kept");
      expect(stop).not.toHaveBeenCalled();
    }
  });

  it("keeps an exited executor whose attestation names another executor or an older epoch", async () => {
    for (const attested of [
      { executorId: "container-OTHER", epoch: 3 },
      { executorId: "container-1", epoch: 2 },
    ]) {
      const ledger = withEntry({
        last: captureStatus({ epoch: 3, pending: 1, complete: false }),
        completionAttested: { ...attested, captureN: 41, atMs: Date.now(), by: "user_1" },
      });
      const { outcome, stop } = await exitedStop(ledger);
      expect(outcome).toBe("kept");
      expect(stop).not.toHaveBeenCalled();
    }
  });

  it("removes an exited capture executor whose final flush Core itself observed complete", async () => {
    const { outcome, stop } = await exitedStop(withEntry({ last: savedStatus() }));
    expect(outcome).toBe("stopped");
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("keeps an exited capture executor when its drain record cannot be read", async () => {
    const readable = inMemoryCaptureDrainLedger();
    const unreadable: CaptureDrainLedger = {
      ...readable,
      read: () => Effect.succeed({ readable: false as const }),
    };
    const { outcome, stop } = await exitedStop(unreadable);
    expect(outcome).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
  });

  it("logs a discard as requested before it terminates, and never as done when the stop fails", async () => {
    // Review 2 #15: the log said "terminated without a drain" before the adapter was asked.
    const ledger = inMemoryCaptureDrainLedger();
    ledger.store.rows.set("run_old", {
      entry: {
        lastProgressAt: undefined,
        last: undefined,
        unreachableSince: undefined,
        keptLogged: false,
        silentLogged: false,
        discardRequested: { atMs: Date.parse("2026-09-27T12:00:00.000Z"), by: "user_1" },
      },
      observation: undefined,
      owner: undefined,
      expiresAt: undefined,
    });
    const harness = makeHarness({
      workspace: workspaceRow({ status: "stopped" }),
      instance: runtimeInstance({ sourceKind: "capture" }),
    });
    const lines: string[] = [];
    const recorder = Logger.make(({ message }) => {
      lines.push(Array.isArray(message) ? message.join(" ") : String(message));
    });

    await expect(
      Effect.runPromise(
        processWorkspaceStopEffect({
          workspaceId: "ws_1",
          runId: "run_old",
          stopReason: "user",
          runtimeAdapters: [
            stubAdapter(async () => {
              throw new Error("docker daemon unreachable");
            }),
          ],
          captureDrain: { ledger, settings: FAST, budgetMs: 1_000, label: "lifecycle stop" },
        }).pipe(Effect.provide(harness.layer), Effect.provide(Logger.layer([recorder]))),
      ),
    ).rejects.toThrow(/unreachable/);

    expect(lines.some((line) => line.includes("discard requested"))).toBe(true);
    expect(lines.some((line) => /terminated without a drain|was terminated/.test(line))).toBe(
      false,
    );
    expect(ledger.store.rows.get("run_old")?.observation?.state).not.toBe("discarded");
  });

  it("records the stop under way before the runtime is asked to go", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      // A git-sourced run: no captures, so a plain stop removes it.
      captureSourced: false,
      workspace: workspaceRow(),
      instance: runtimeInstance(),
    });
    harness.markStopRequested.mockImplementation(() =>
      Effect.sync(() => {
        order.push("stop-requested");
      }),
    );
    const stop = vi.fn(async () => {
      order.push("adapter-stop");
      return { adapter: "docker" as const, resourceId: "container-1", outcome: "stopped" as const };
    });

    await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [stubAdapter(stop)],
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(order).toEqual(["stop-requested", "adapter-stop", "adapter-stop"]);
    expect(harness.markStopRequested).toHaveBeenCalledWith({
      runId: "run_old",
      stopReason: "user",
    });
  });

  it("completes a stop whose launch-material cleanup fails (a directory the container re-owned)", async () => {
    // End to end: rmdir of the secret-env staging dir failed with EPERM after the container was
    // removed, the stop threw, and the row was never recorded stopped.
    const harness = makeHarness({
      // A git-sourced run: no captures, so a plain stop removes it.
      captureSourced: false,
      workspace: workspaceRow(),
      instance: runtimeInstance(),
    });
    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [stubAdapter(stopped())],
        launchMaterialStager: {
          stage: async () => ({}),
          removeSecretEnv: async () => undefined,
          removeAll: async () => {
            throw Object.assign(new Error("EPERM: operation not permitted, rmdir"), {
              code: "EPERM",
            });
          },
        },
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(outcome).toBe("stopped");
    expect(harness.markStopped).toHaveBeenCalledWith({ runId: "run_old", stopReason: "user" });
    expect(harness.setWorkspaceStatus).toHaveBeenCalledWith({ id: "ws_1", status: "stopped" });
  });

  it("records a failed stop on the drain, and the retry that succeeds replaces it", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: fakeCaptureDaemon([savedStatus()]).layer,
    });
    const run = (stop: RuntimeAdapter["stop"]) =>
      Effect.runPromise(
        processWorkspaceStopEffect({
          workspaceId: "ws_1",
          runId: "run_old",
          stopReason: "user",
          runtimeAdapters: [stubAdapter(stop)],
          captureDrain: { ledger, settings: FAST, budgetMs: 1_000, label: "lifecycle stop" },
        }).pipe(Effect.provide(harness.layer)),
      );

    await expect(
      run(async () => {
        throw new Error("removal of container is already in progress");
      }),
    ).rejects.toThrow(/already in progress/);
    expect(ledger.store.rows.get("run_old")?.observation).toMatchObject({
      state: "stop-failed",
      detail: expect.stringMatching(/already in progress.*retries/),
    });
    expect(harness.markStopped).not.toHaveBeenCalled();

    expect(await run(stopped())).toBe("stopped");
    expect(ledger.store.rows.get("run_old")?.observation?.state).toBe("stopped");
  });

  it("terminates a run whose owner discarded its unsaved captures, without a drain, and records it", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    ledger.store.rows.set("run_old", {
      entry: {
        lastProgressAt: undefined,
        last: undefined,
        unreachableSince: undefined,
        keptLogged: false,
        silentLogged: false,
        discardRequested: { atMs: Date.parse("2026-09-27T12:00:00.000Z"), by: "user_1" },
      },
      observation: { state: "kept", detail: "not saved · not confirmed" },
      owner: undefined,
      expiresAt: undefined,
    });
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 5 })]);
    const harness = makeHarness({
      workspace: workspaceRow({ status: "stopped" }),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: daemon.layer,
    });
    const stop = removedStop();

    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [stubAdapter(stop)],
        captureDrain: { ledger, settings: FAST, budgetMs: 1_000, label: "stranded reaper" },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(outcome).toBe("stopped");
    expect(daemon.connect).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith({
      resourceId: "container-1",
      reference: "sealant-run-old",
      fence: true,
      phase: "end",
    });
    expect(harness.markStopped).toHaveBeenCalledWith({ runId: "run_old", stopReason: "user" });
    expect(ledger.store.rows.get("run_old")?.observation).toMatchObject({
      state: "discarded",
      detail: expect.stringContaining("by user_1"),
    });
  });
});

/** An adapter stop that removes the runtime. */
const removedStop = () =>
  vi.fn(async () => ({
    adapter: "docker" as const,
    resourceId: "container-1",
    outcome: "stopped" as const,
  }));

// Review 6 #3: the stop read a complete on record, then awaited the runtime's inspection; meanwhile
// another path (the public status route) recorded a newer failure from the same executor. The
// removal is decided on the evidence as it stands after the inspection, and authorized against
// it: the ended executor is retained, not removed on the stale complete.
describe("an ended executor's removal is decided on current evidence (review 6 #3)", () => {
  const settings = {
    pollIntervalMs: 1,
    stallWindowMs: 100,
    unreachableWindowMs: 100,
    requestTimeoutMs: 100,
  };
  const stager = {
    stage: async () => ({}),
    removeSecretEnv: async () => undefined,
    removeAll: async () => undefined,
  };

  it("retains it when a newer failure is recorded while its runtime is inspected", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    await Effect.runPromise(
      ledger.recordStatus("run_old", savedStatus({ epoch: 3, headN: 7 }), Date.now() - 1_000),
    );
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const stop = removedStop();
    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [
          stubAdapter(stop, async () => {
            // Received by another Core path while the stop waits on the runtime.
            await Effect.runPromise(
              ledger.recordStatus(
                "run_old",
                captureStatus({
                  epoch: 3,
                  headN: 8,
                  complete: false,
                  incompleteReason: "snapshot-failed",
                  unreadable: 1,
                }),
                Date.now(),
              ),
            );
            return { state: "exited" as const, exitCode: 75 };
          }),
        ],
        captureDrain: { ledger, settings, budgetMs: 1, label: "review 6 #3" },
        launchMaterialStager: stager,
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(outcome).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
    expect(ledger.store.rows.get("run_old")?.entry.retained).toBeDefined();
  });

  it("retains it while an observation of it is in flight, and removes it once none is", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    await Effect.runPromise(
      ledger.recordStatus("run_old", savedStatus({ epoch: 3, headN: 7 }), Date.now() - 1_000),
    );
    // Another path asked the daemon and has not recorded (or could not record) the answer.
    const fence = await Effect.runPromise(ledger.openObservation("run_old", 60_000));
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const stop = removedStop();
    const run = () =>
      Effect.runPromise(
        processWorkspaceStopEffect({
          workspaceId: "ws_1",
          runId: "run_old",
          stopReason: "user",
          runtimeAdapters: [
            stubAdapter(stop, async () => ({ state: "exited" as const, exitCode: 0 })),
          ],
          captureDrain: { ledger, settings, budgetMs: 1, label: "review 6 #5" },
          launchMaterialStager: stager,
        }).pipe(Effect.provide(harness.layer)),
      );
    expect(await run()).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
    // The observation received nothing: resolved, the recorded complete stands.
    if (fence !== undefined) {
      await Effect.runPromise(ledger.closeObservation("run_old", fence));
    }
    expect(await run()).toBe("stopped");
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("waits for an observation in flight to be recorded, then decides on what it said", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    await Effect.runPromise(
      ledger.recordStatus("run_old", savedStatus({ epoch: 3, headN: 7 }), Date.now() - 1_000),
    );
    // A status poll is in flight when the stop decides; its answer — the same complete — is
    // recorded a moment later.
    const fence = await Effect.runPromise(ledger.openObservation("run_old", 60_000));
    setTimeout(() => {
      void Effect.runPromise(
        ledger.recordStatus("run_old", savedStatus({ epoch: 3, headN: 7 }), Date.now(), fence),
      );
    }, 50);
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const stop = removedStop();
    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [
          stubAdapter(stop, async () => ({ state: "exited" as const, exitCode: 0 })),
        ],
        captureDrain: { ledger, settings, budgetMs: 1, label: "review 6 #5" },
        launchMaterialStager: stager,
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(outcome).toBe("stopped");
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

/** A newer failure from the same executor, after the complete at head 7. */
const newerFailure = () =>
  captureStatus({
    epoch: 3,
    headN: 8,
    complete: false,
    incompleteReason: "snapshot-failed",
    unreadable: 1,
  });

/** A ledger holding the executor's complete at head 7. */
const seededWithComplete = async () => {
  const ledger = inMemoryCaptureDrainLedger();
  await Effect.runPromise(
    ledger.recordStatus("run_old", savedStatus({ epoch: 3, headN: 7 }), Date.now() - 1_000),
  );
  return ledger;
};

// Review 7 #5 (decision 21): authorizing the removal returned a reusable boolean and committed;
// an observation opened after it — while the stop awaited `markStopRequested` — recorded a newer
// failure, and the stop removed the executor on the complete it had decided on. The removal is
// now an owned durable transition: from its authorization no observation is admitted, a status
// recorded anyway voids it, the stop re-checks it right before the runtime call (deciding again
// when it was voided) and records it `deleted` after.
describe("an ended executor's removal is an owned transition (review 7 #5)", () => {
  const settings = {
    pollIntervalMs: 1,
    stallWindowMs: 100,
    unreachableWindowMs: 100,
    requestTimeoutMs: 100,
  };
  const stager = {
    stage: async () => ({}),
    removeSecretEnv: async () => undefined,
    removeAll: async () => undefined,
  };
  const stopWith = (
    ledger: ReturnType<typeof inMemoryCaptureDrainLedger>,
    harness: ReturnType<typeof makeHarness>,
    stop: RuntimeAdapter["stop"],
  ) =>
    Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "user",
        runtimeAdapters: [
          stubAdapter(stop, async () => ({ state: "exited" as const, exitCode: 75 })),
        ],
        captureDrain: { ledger, settings, budgetMs: 1, label: "review 7 #5" },
        launchMaterialStager: stager,
      }).pipe(Effect.provide(harness.layer)),
    );

  it("keeps it when a failure arrives after authorization, while markStopRequested is awaited", async () => {
    const ledger = await seededWithComplete();
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const admitted: boolean[] = [];
    // The reviewer's interleaving: another path opens an observation after the removal was
    // authorized and records what it received, while the stop awaits its own write.
    harness.markStopRequested.mockImplementation(() =>
      Effect.gen(function* () {
        const fence = yield* ledger.openObservation("run_old", 1_000);
        admitted.push(fence !== undefined);
        yield* ledger.recordStatus("run_old", newerFailure(), Date.now(), fence);
      }),
    );
    const stop = removedStop();
    const outcome = await stopWith(ledger, harness, stop);
    expect(outcome).toBe("kept");
    expect(stop).not.toHaveBeenCalled();
    expect(admitted).toEqual([false]);
    const row = ledger.store.rows.get("run_old");
    expect(row?.entry.last).toMatchObject({ complete: false, headN: 8 });
    expect(row?.entry.retained).toBeDefined();
    expect(row?.deletion).toBeUndefined();
  });

  // Review 9 #9 (decision 28): the stop tells its caller "removing" only once the removal was
  // re-checked and issued, never before a step that could still veto it.
  it("tells its caller the removal began only once it was issued (review 9 #9)", async () => {
    const phasesOf = async (veto: boolean) => {
      const ledger = await seededWithComplete();
      const harness = makeHarness({
        workspace: workspaceRow(),
        instance: runtimeInstance({ sourceKind: "capture" }),
        daemon: fakeCaptureDaemon(["unreachable"]).layer,
      });
      if (veto) {
        harness.markStopRequested.mockImplementation(() =>
          ledger.recordStatus("run_old", newerFailure(), Date.now()).pipe(Effect.asVoid),
        );
      }
      const phases: string[] = [];
      const stop = removedStop();
      const outcome = await Effect.runPromise(
        processWorkspaceStopEffect({
          workspaceId: "ws_1",
          runId: "run_old",
          stopReason: "user",
          runtimeAdapters: [
            stubAdapter(stop, async () => ({ state: "exited" as const, exitCode: 75 })),
          ],
          captureDrain: {
            ledger,
            settings,
            budgetMs: 1,
            label: "review 9 #9",
            onPhase: (phase) =>
              Effect.sync(() => {
                phases.push(
                  phase.kind === "drain-ended" ? `drain-ended:${phase.drain}` : phase.kind,
                );
              }),
          },
          launchMaterialStager: stager,
        }).pipe(Effect.provide(harness.layer)),
      );
      return { outcome, phases, stopped: stop.mock.calls.length };
    };
    const vetoed = await phasesOf(true);
    expect(vetoed.outcome).toBe("kept");
    expect(vetoed.stopped).toBe(0);
    expect(vetoed.phases).not.toContain("removing");
    const removed = await phasesOf(false);
    expect(removed.outcome).toBe("stopped");
    expect(removed.phases.at(-1)).toBe("removing");
  });

  it("admits no observation while it removes the runtime, and none once it was removed", async () => {
    const ledger = await seededWithComplete();
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const admittedDuringRemoval: boolean[] = [];
    const stop = vi.fn(async () => {
      const fence = await Effect.runPromise(ledger.openObservation("run_old", 1_000));
      admittedDuringRemoval.push(fence !== undefined);
      return { adapter: "docker" as const, resourceId: "container-1", outcome: "stopped" as const };
    });
    expect(await stopWith(ledger, harness, stop)).toBe("stopped");
    expect(stop).toHaveBeenCalledTimes(2);
    expect(admittedDuringRemoval).toEqual([false, false]);
    expect(ledger.store.rows.get("run_old")?.deletion?.state).toBe("deleted");
    expect(await Effect.runPromise(ledger.openObservation("run_old", 1_000))).toBeUndefined();
    expect(await Effect.runPromise(ledger.admitRecovery("run_old", NO_CLAIM))).toBe("deleted");
  });

  it("gives the removal up when the runtime refused it, so observations resume", async () => {
    const ledger = await seededWithComplete();
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const stop = vi.fn(async (): Promise<never> => {
      throw removalRefused(new Error("docker rm failed: Error response from daemon"));
    });
    await expect(stopWith(ledger, harness, stop)).rejects.toThrow("docker rm failed");
    expect(ledger.store.rows.get("run_old")?.deletion).toBeUndefined();
    expect(await Effect.runPromise(ledger.openObservation("run_old", 1_000))).toBeDefined();
  });

  // Review 9 #5 (decision 27): a failure that is not the runtime's refusal (a lost reply) may
  // have been acted on: the removal stays issued, and nothing is observed or recovered.
  it("keeps the removal issued when the runtime call fails with an outcome nobody knows (review 9 #5)", async () => {
    const ledger = await seededWithComplete();
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ sourceKind: "capture" }),
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const stop = vi.fn(async (): Promise<never> => {
      throw new Error("TerminateMicrovm: socket hang up");
    });
    await expect(stopWith(ledger, harness, stop)).rejects.toThrow("socket hang up");
    expect(ledger.store.rows.get("run_old")?.deletion?.state).toBe("deleting-issued");
    expect(await Effect.runPromise(ledger.openObservation("run_old", 1_000))).toBeUndefined();
    expect(await Effect.runPromise(ledger.admitRecovery("run_old", NO_CLAIM))).toBe("deleting");
  });
});

// Review 8 #7: a removal the runtime was asked to make whose issuer died (its hold lapsed, no
// outcome recorded) stays exclusionary — no FINAL may be asked of the executor under it — and the
// next stop settles it from the runtime before anything else: the executor is still there and the
// evidence the removal was authorized on still stands, so the removal is issued again.
describe("processWorkspaceStopEffect · an issued removal with no recorded outcome (review 8 #7)", () => {
  it("issues it again on the evidence it was authorized on, without asking the daemon anything", async () => {
    let clock = 0;
    const ledger = inMemoryCaptureDrainLedger({ now: () => clock });
    await Effect.runPromise(ledger.recordStatus("run_old", savedStatus({ headN: 7 }), clock));
    const read = await Effect.runPromise(ledger.read("run_old"));
    const authorized = await Effect.runPromise(
      ledger.authorizeDeletion("run_old", read.readable ? (read.entry?.evidenceVersion ?? 0) : -1),
    );
    if (authorized.kind !== "authorized") {
      throw new Error(authorized.kind);
    }
    expect(await Effect.runPromise(ledger.issueDeletion("run_old", authorized.ticket))).toBe(true);
    // Its issuer died mid-call: the hold lapses with nothing recorded.
    clock += 121_000;
    const daemon = fakeCaptureDaemon([savedStatus({ headN: 9 })]);
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance(),
      captureSourced: true,
      daemon: daemon.layer,
    });
    const stop = removedStop();
    const outcome = await Effect.runPromise(
      processWorkspaceStopEffect({
        workspaceId: "ws_1",
        runId: "run_old",
        stopReason: "expired",
        runtimeAdapters: [stubAdapter(stop, async () => ({ state: "running" }))],
        captureDrain: {
          ledger,
          settings: {
            pollIntervalMs: 1,
            stallWindowMs: 30,
            unreachableWindowMs: 30,
            requestTimeoutMs: 1_000,
          },
          budgetMs: 1_000,
          label: "test reaper",
        },
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(outcome).toBe("stopped");
    expect(stop).toHaveBeenCalledTimes(2);
    expect(daemon.calls).toEqual([]);
    expect(ledger.store.rows.get("run_old")?.deletion?.state).toBe("deleted");
    expect(ledger.store.rows.get("run_old")?.entry.last?.headN).toBe(7);
  });
});
