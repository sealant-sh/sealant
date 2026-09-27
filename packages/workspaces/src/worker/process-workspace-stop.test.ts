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

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { SealantRuntime } from "../sealantd/runtime.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import {
  EMPTY_CAPTURE_DRAIN_ENTRY,
  inMemoryCaptureDrainLedger,
  type CaptureDrainEntry,
  type CaptureDrainLedger,
  type CaptureDrainSettings,
} from "./capture-drain.js";
import { processWorkspaceStopEffect } from "./process-workspace-stop.js";

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
      workspace: workspaceRow({ latestRunId: "run_old" }),
      instance: runtimeInstance(),
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

    expect(stop).toHaveBeenCalledWith({ resourceId: "container-1", reference: "sealant-run-old" });
    expect(harness.markStopped).toHaveBeenCalledWith({ runId: "run_old", stopReason: "user" });
    expect(harness.setWorkspaceStatus).toHaveBeenCalledWith({ id: "ws_1", status: "stopped" });
  });

  it("does NOT settle the workspace row when the stopped run is SUPERSEDED (restart race)", async () => {
    const harness = makeHarness({
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
    expect(order).toEqual(["sync-back", "adapter-stop"]);
  });

  it("skips the sync-back when the adapter reports the runtime already ended, and still tears down", async () => {
    const harness = makeHarness({
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
    expect(order).toEqual(["adapter-stop"]);
    expect(harness.markStopped).toHaveBeenCalledTimes(1);
    expect(harness.setWorkspaceStatus).toHaveBeenCalledWith({ id: "ws_1", status: "stopped" });
  });

  it("keeps the sync-back when the liveness read itself fails", async () => {
    const harness = makeHarness({
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

    expect(order).toEqual(["sync-back", "adapter-stop"]);
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
    const stop = stopped();

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
    expect(stop).toHaveBeenCalledTimes(1);
    expect(harness.markStopped).toHaveBeenCalledWith({ runId: "run_old", stopReason: "expired" });
  });

  it("keeps a runtime whose daemon answers but whose queue stalled: no stop, no writes", async () => {
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance(),
      captureSourced: true,
      daemon: fakeCaptureDaemon([captureStatus({ pending: 7, uploadedBytes: 1 })]).layer,
    });
    const stop = stopped();

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
    const stop = stopped();

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
    const stop = stopped();
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
    const stop = stopped();
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
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps a capture-sourced runtime this worker cannot address", async () => {
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance({ adapter: "microvm", endpoint: null }),
      captureSourced: true,
    });
    const stop = stopped();
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
    const stop = stopped();

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
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("skips the drain for a runtime the adapter already reports ended", async () => {
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 9 })]);
    const harness = makeHarness({
      workspace: workspaceRow(),
      instance: runtimeInstance(),
      captureSourced: true,
      daemon: daemon.layer,
    });
    const stop = stopped();

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
    const stop = stopped();

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
    const stop = stopped();

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
    const stop = stopped();

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
    const stop = stopped();
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
    const stop = stopped();
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
    const ledger = withEntry({
      last: captureStatus({ epoch: 3, pending: 1, complete: false }),
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
    expect(stop).toHaveBeenCalledTimes(1);
    expect(ledger.store.rows.get("run_old")?.observation).toMatchObject({
      state: "stopped",
      detail: expect.stringContaining("attested a sealed final capture"),
    });
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
    expect(stop).toHaveBeenCalledTimes(1);
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
    const harness = makeHarness({ workspace: workspaceRow(), instance: runtimeInstance() });
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

    expect(order).toEqual(["stop-requested", "adapter-stop"]);
    expect(harness.markStopRequested).toHaveBeenCalledWith({
      runId: "run_old",
      stopReason: "user",
    });
  });

  it("completes a stop whose launch-material cleanup fails (a directory the container re-owned)", async () => {
    // End to end: rmdir of the secret-env staging dir failed with EPERM after the container was
    // removed, the stop threw, and the row was never recorded stopped.
    const harness = makeHarness({ workspace: workspaceRow(), instance: runtimeInstance() });
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
    const stop = stopped();

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
    });
    expect(harness.markStopped).toHaveBeenCalledWith({ runId: "run_old", stopReason: "user" });
    expect(ledger.store.rows.get("run_old")?.observation).toMatchObject({
      state: "discarded",
      detail: expect.stringContaining("by user_1"),
    });
  });
});
