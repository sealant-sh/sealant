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
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { SealantRuntime } from "../sealantd/runtime.js";
import { captureStatus, fakeCaptureDaemon } from "./capture-daemon.fixture.js";
import { CaptureDrainTracker, type CaptureDrainSettings } from "./capture-drain.js";
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
  /** The run's stored blueprint names a capture source. */
  readonly captureSourced?: boolean;
  /** The daemon the drain talks to; default = one that must never be dialled. */
  readonly daemon?: Layer.Layer<SealantRuntime>;
}): Harness => {
  const markStopped = vi.fn((request: { runId: string }) =>
    Effect.succeed(runtimeInstance({ runId: request.runId, status: "stopped" })),
  );
  const setWorkspaceStatus = vi.fn(() => Effect.succeed(input.workspace ?? null));

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
    getRuntimeInstanceByRunId: () => Effect.succeed(input.instance),
    listRuntimeInstancesByRunIds: () => Effect.succeed(new Map()),
    listRunningInstances: () => Effect.succeed(input.instance ? [input.instance] : []),
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

describe("processWorkspaceStopEffect · drain before stop", () => {
  const FAST: CaptureDrainSettings = {
    pollIntervalMs: 1,
    stallWindowMs: 30,
    unreachableWindowMs: 30,
    requestTimeoutMs: 1_000,
  };
  const drainOptions = (tracker = new CaptureDrainTracker()) => ({
    captureDrain: { tracker, settings: FAST, budgetMs: 1_000, label: "test reaper" },
  });

  it("drains a capture-sourced runtime to an empty queue, then stops it", async () => {
    const daemon = fakeCaptureDaemon([
      captureStatus({ pending: 2, uploadedBytes: 5 }),
      captureStatus({ pending: 0, uploadedBytes: 9 }),
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
          tracker: new CaptureDrainTracker(),
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
});
