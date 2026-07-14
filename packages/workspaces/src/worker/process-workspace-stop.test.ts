/**
 * Unit tests for the shared stop path. The critical property is the latest-run guard: stopping a
 * SUPERSEDED runtime (restart's stop half, or the reaper sweeping a leftover container) must not
 * stamp "stopped" onto a workspace that is already relaunching — the reaper treats a live
 * container on a stored-"stopped" workspace as stranded and would kill the fresh runtime.
 */
import {
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type Workspace,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
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
  launchedAt: new Date("2026-07-01T00:00:00.000Z"),
  finishedAt: null,
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

const stubAdapter = (stop: RuntimeAdapter["stop"]): RuntimeAdapter => ({
  id: "docker",
  supports: () => ({ supported: true }),
  launch: async () => {
    throw new Error("not used in stop tests");
  },
  stop,
});

interface Harness {
  readonly markStopped: ReturnType<typeof vi.fn>;
  readonly setWorkspaceStatus: ReturnType<typeof vi.fn>;
  readonly layer: Layer.Layer<WorkspaceRepo | WorkspaceRuntimeInstanceRepo>;
}

const makeHarness = (input: {
  readonly workspace: Workspace | undefined;
  readonly instance: WorkspaceRuntimeInstance | undefined;
}): Harness => {
  const markStopped = vi.fn((request: { runId: string }) =>
    Effect.succeed(runtimeInstance({ runId: request.runId, status: "stopped" })),
  );
  const setWorkspaceStatus = vi.fn(() => Effect.succeed(input.workspace ?? null));

  const workspaceRepoLayer = Layer.succeed(WorkspaceRepo, {
    createWorkspace: () => Effect.die("unused"),
    getWorkspaceByAttemptId: () => Effect.succeed(input.workspace),
    getWorkspaceById: () => Effect.succeed(input.workspace),
    linkWorkspaceAttempt: () => Effect.die("unused"),
    listWorkspaces: () => Effect.succeed([]),
    listWorkspaceAttemptLinks: () => Effect.succeed([]),
    setWorkspaceName: () => Effect.die("unused"),
    setWorkspaceExpiry: () => Effect.die("unused"),
    setWorkspaceStatus,
  });

  const runtimeInstanceRepoLayer = Layer.succeed(WorkspaceRuntimeInstanceRepo, {
    upsertRuntimeInstance: () => Effect.die("unused"),
    markStopped,
    getRuntimeInstanceByRunId: () => Effect.succeed(input.instance),
    listRuntimeInstancesByRunIds: () => Effect.succeed(new Map()),
    listRunningDockerInstances: () => Effect.succeed(input.instance ? [input.instance] : []),
  });

  return {
    markStopped,
    setWorkspaceStatus,
    layer: Layer.mergeAll(workspaceRepoLayer, runtimeInstanceRepoLayer),
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
});
