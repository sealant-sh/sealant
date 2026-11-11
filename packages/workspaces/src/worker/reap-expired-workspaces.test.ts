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

import { removalPending, type RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { inMemoryCaptureDrainLedger } from "./capture-drain.js";
import { reapExpiredWorkspacesEffect } from "./reap-expired-workspaces.js";

const retainedRow: WorkspaceRuntimeInstance = {
  imageScope: null,
  publication: null,
  publicationId: null,
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
  daemonImage: null,
  daemonRecoveryBoot: null,
  removedAt: null,
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
      markRemoved: () => Effect.void,
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

// The reaper is sequential and serves every runtime: a removal its runtime accepted and has not
// finished (a Boat deletion stuck in `processing`) must neither fail the sweep nor keep the
// executors after it waiting.
describe("reapExpiredWorkspaces · a removal the runtime has not finished", () => {
  it("defers that executor without an error and goes on to the next one in the same tick", async () => {
    const rows = [
      { ...retainedRow, runId: "run_stuck", resourceId: "container-stuck" },
      { ...retainedRow, runId: "run_next", resourceId: "container-next" },
    ];
    const markStopped = vi.fn((input: { runId: string; stopReason: string }) =>
      Effect.succeed({ ...retainedRow, status: "stopped" as const, runId: input.runId }),
    );
    const stop = vi.fn<RuntimeAdapter["stop"]>(async (input) => {
      if (input.resourceId === "container-stuck")
        throw removalPending(new Error("the provider is still deleting it"));
      return { adapter: "docker", resourceId: input.resourceId, outcome: "stopped" };
    });
    const adapter: RuntimeAdapter = {
      id: "docker",
      supports: () => ({ supported: true }),
      launch: async () => {
        throw new Error("unused");
      },
      stop,
      inspect: async () => ({ state: "running" }),
    };
    const ledger = inMemoryCaptureDrainLedger();
    const layer = Layer.mergeAll(
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        listRunningInstances: () => Effect.succeed([]),
        listRetainedLaunches: () => Effect.succeed(rows),
        getRuntimeInstanceByRunId: (runId: string) =>
          Effect.succeed(rows.find((row) => row.runId === runId)),
        markStopped,
        markRemoved: () => Effect.void,
        markStopRequested: () => Effect.void,
      } as unknown as WorkspaceRuntimeInstanceRepoService),
      Layer.succeed(WorkspaceRepo, {
        setWorkspaceStatus: () => Effect.succeed(null),
      } as unknown as WorkspaceRepoService),
      Layer.succeed(WorkspaceAttemptRepo, {
        getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
      } as unknown as WorkspaceAttemptRepoService),
      Layer.succeed(ConnectedAccountRepo, {} as ConnectedAccountRepoService),
      fakeCaptureDaemon([savedStatus()]).layer,
    );
    const reaped = await Effect.runPromise(
      reapExpiredWorkspacesEffect({
        runtimeAdapters: [adapter],
        captureDrain: {
          ledger,
          settings: {
            pollIntervalMs: 1,
            stallWindowMs: 30,
            unreachableWindowMs: 30,
            requestTimeoutMs: 1_000,
          },
        },
      }).pipe(Effect.provide(layer)),
    );
    // Both were worked on: one deferred, one stopped.
    expect(reaped).toBe(2);
    expect(stop.mock.calls.map(([input]) => input.resourceId)).toEqual([
      "container-stuck",
      "container-next",
    ]);
    expect(markStopped.mock.calls.map(([input]) => input.runId)).toEqual(["run_next"]);
    expect(ledger.store.rows.get("run_stuck")?.deletion?.state).toBe("deleting-issued");
    expect(ledger.store.rows.get("run_stuck")?.observation?.state).toBe("stop-failed");
    expect(ledger.store.rows.get("run_next")?.observation?.state).toBe("stopped");
  });
});
