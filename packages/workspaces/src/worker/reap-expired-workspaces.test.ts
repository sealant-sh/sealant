/**
 * The retained-launch sweep: a capture-sourced launch that failed after its executor became
 * ready was kept (`LAUNCH_RETAINED_ERROR_CODE`). The reaper drains it through the shared stop
 * path and stops it only once the daemon confirms its final flush complete.
 */
import {
  ConnectedAccountRepo,
  LAUNCH_RETAINED_ERROR_CODE,
  WorkspaceAttemptRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccountRepoService,
  type WorkspaceAttemptRepoService,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { inMemoryCaptureDrainLedger } from "./capture-drain.js";
import { reapExpiredWorkspacesEffect } from "./reap-expired-workspaces.js";

const retainedRow: WorkspaceRuntimeInstance = {
  runId: "run_retained",
  status: "failed",
  adapter: "docker",
  resourceId: "container-retained",
  reference: "sealant-retained",
  endpoint: null,
  errorCode: LAUNCH_RETAINED_ERROR_CODE,
  errorMessage: "credential file write failed",
  stopReason: null,
  launchCredentialInjections: null,
  launchedAt: null,
  finishedAt: null,
  runtimeDeadlineAt: null,
  launchOwner: null,
  launchLeaseExpiresAt: null,
  sourceKind: "capture",
  createdAt: new Date("2026-09-27T00:00:00.000Z"),
  updatedAt: new Date("2026-09-27T00:00:00.000Z"),
};

const sweep = async (daemon: ReturnType<typeof fakeCaptureDaemon>) => {
  const markStopped = vi.fn((input: { runId: string; stopReason: string }) =>
    Effect.succeed({
      ...retainedRow,
      status: "stopped" as const,
      stopReason: "failed" as const,
      runId: input.runId,
    }),
  );
  const setWorkspaceStatus = vi.fn(() => Effect.succeed(null));
  const stop = vi.fn(async () => ({
    adapter: "docker" as const,
    resourceId: "container-retained",
    outcome: "stopped" as const,
  }));
  const adapter: RuntimeAdapter = {
    id: "docker",
    supports: () => ({ supported: true }),
    launch: async () => {
      throw new Error("unused");
    },
    stop,
    inspect: async () => ({ state: "running" }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      listRunningInstances: () => Effect.succeed([]),
      listRetainedLaunches: () => Effect.succeed([retainedRow]),
      getRuntimeInstanceByRunId: () => Effect.succeed(retainedRow),
      markStopped,
      markStopRequested: () => Effect.void,
    } as unknown as WorkspaceRuntimeInstanceRepoService),
    Layer.succeed(WorkspaceRepo, { setWorkspaceStatus } as unknown as WorkspaceRepoService),
    Layer.succeed(WorkspaceAttemptRepo, {
      getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
    } as unknown as WorkspaceAttemptRepoService),
    Layer.succeed(ConnectedAccountRepo, {} as ConnectedAccountRepoService),
    daemon.layer,
  );
  const reaped = await Effect.runPromise(
    reapExpiredWorkspacesEffect({
      runtimeAdapters: [adapter],
      captureDrain: {
        ledger: inMemoryCaptureDrainLedger(),
        settings: {
          pollIntervalMs: 1,
          stallWindowMs: 30,
          unreachableWindowMs: 30,
          requestTimeoutMs: 1_000,
        },
      },
    }).pipe(Effect.provide(layer)),
  );
  return { reaped, stop, markStopped, setWorkspaceStatus };
};

describe("reapExpiredWorkspaces · retained launches", () => {
  it("drains a retained launch and stops it once the final flush is complete", async () => {
    const daemon = fakeCaptureDaemon([
      captureStatus({ pending: 1, uploadedBytes: 1 }),
      savedStatus(),
    ]);
    const result = await sweep(daemon);

    expect(daemon.flushRequests[0]).toMatchObject({ kind: "final" });
    expect(result.stop).toHaveBeenCalledTimes(1);
    expect(result.markStopped).toHaveBeenCalledWith({
      runId: "run_retained",
      stopReason: "failed",
    });
    // The launch failed: the workspace's stored status (the API's intent anchor) is left alone.
    expect(result.setWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("keeps a retained launch whose daemon cannot confirm its work saved", async () => {
    const result = await sweep(fakeCaptureDaemon([captureStatus({ pending: 0 })]));
    expect(result.stop).not.toHaveBeenCalled();
    expect(result.markStopped).not.toHaveBeenCalled();
  });
});
