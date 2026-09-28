/**
 * Preservation before a runtime's own deadline: nothing used to schedule a drain before a
 * MicroVM's maximum duration, so the platform ended it with whatever its capture queue held.
 * The sweep plans the start from the deadline, the configured lead, and an upload estimate from
 * observed throughput and `pendingBytes`; persists the plan; and from then on drives a FINAL
 * drain and a planned stop.
 */
import {
  ConnectedAccountRepo,
  WorkspaceAttemptRepo,
  WorkspaceCaptureDrainRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccountRepoService,
  type Workspace,
  type WorkspaceAttemptRepoService,
  type WorkspaceCaptureDrain,
  type WorkspaceCaptureDrainRepoService,
  type WorkspaceCaptureDrainSchedule,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { inMemoryCaptureDrainLedger } from "./capture-drain.js";
import {
  observeUploadThroughput,
  planPreservationStart,
  preserveBeforeDeadlineEffect,
} from "./preserve-before-deadline.js";

const MIN = 60_000;
const NOW = Date.parse("2026-09-27T12:00:00.000Z");

const instance = (deadlineInMs: number): WorkspaceRuntimeInstance => ({
  runId: "run_vm",
  status: "ready",
  adapter: "docker",
  resourceId: "container-vm",
  reference: "sealant-vm",
  endpoint: null,
  errorCode: null,
  errorMessage: null,
  stopReason: null,
  launchCredentialInjections: null,
  launchedAt: new Date(NOW - 60 * MIN),
  finishedAt: null,
  runtimeDeadlineAt: new Date(NOW + deadlineInMs),
  sourceKind: "capture",
  createdAt: new Date(NOW - 60 * MIN),
  updatedAt: new Date(NOW - 60 * MIN),
});

const sweep = async (input: {
  readonly deadlineInMs: number;
  readonly daemon: ReturnType<typeof fakeCaptureDaemon>;
  readonly row?: Partial<WorkspaceCaptureDrain>;
}) => {
  const schedules: WorkspaceCaptureDrainSchedule[] = [];
  const drains = {
    getByRunId: () =>
      Effect.succeed(input.row === undefined ? undefined : (input.row as WorkspaceCaptureDrain)),
    recordSchedule: (request: { runId: string; schedule: WorkspaceCaptureDrainSchedule }) => {
      schedules.push(request.schedule);
      return Effect.succeed({} as WorkspaceCaptureDrain);
    },
  } as unknown as WorkspaceCaptureDrainRepoService;
  const row = instance(input.deadlineInMs);
  const markStopped = vi.fn(() => Effect.succeed({ ...row, status: "stopped" as const }));
  const setWorkspaceStatus = vi.fn(() => Effect.succeed(null));
  const stop = vi.fn(async () => ({
    adapter: "docker" as const,
    resourceId: "container-vm",
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
  const workspace = { id: "ws_vm", latestRunId: "run_vm" } as Workspace;
  const layer = Layer.mergeAll(
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      listRunningInstances: () => Effect.succeed([row]),
      getRuntimeInstanceByRunId: () => Effect.succeed(row),
      markStopped,
      markStopRequested: () => Effect.void,
    } as unknown as WorkspaceRuntimeInstanceRepoService),
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceByAttemptId: () => Effect.succeed(workspace),
      getWorkspaceById: () => Effect.succeed(workspace),
      setWorkspaceStatus,
    } as unknown as WorkspaceRepoService),
    Layer.succeed(WorkspaceAttemptRepo, {
      getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
    } as unknown as WorkspaceAttemptRepoService),
    Layer.succeed(ConnectedAccountRepo, {} as ConnectedAccountRepoService),
    Layer.succeed(WorkspaceCaptureDrainRepo, drains),
    input.daemon.layer,
  );
  const driven = await Effect.runPromise(
    preserveBeforeDeadlineEffect({
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
      deadline: { leadMs: 15 * MIN, watchWindowMs: 60 * MIN, estimateSafetyFactor: 1.5 },
      now: () => NOW,
    }).pipe(Effect.provide(layer)),
  );
  return { driven, schedules, stop, markStopped, setWorkspaceStatus };
};

describe("planPreservationStart", () => {
  it("starts at the configured lead when nothing says how much is left to upload", () => {
    expect(
      planPreservationStart({
        deadlineMs: NOW,
        leadMs: 15 * MIN,
        pendingBytes: undefined,
        uploadBytesPerSecond: 1_000,
        safetyFactor: 1.5,
      }),
    ).toEqual({ startsAtMs: NOW - 15 * MIN, estimateMs: 0 });
  });

  it("adds the upload estimate from pending bytes and observed throughput", () => {
    // 600 MB at 1 MB/s = 600 s, times 1.5 = 900 s ahead of the lead.
    expect(
      planPreservationStart({
        deadlineMs: NOW,
        leadMs: 15 * MIN,
        pendingBytes: 600_000_000,
        uploadBytesPerSecond: 1_000_000,
        safetyFactor: 1.5,
      }),
    ).toEqual({ startsAtMs: NOW - 15 * MIN - 900_000, estimateMs: 900_000 });
  });
});

describe("planPreservationStart · what the estimate must not ignore", () => {
  it("assumes a conservative rate when no throughput has been observed yet, never an instant upload", () => {
    // 600 MB at the assumed 1 MB/s = 600 s, times 1.5 = 900 s ahead of the lead.
    expect(
      planPreservationStart({
        deadlineMs: NOW,
        leadMs: 15 * MIN,
        pendingBytes: 600_000_000,
        uploadBytesPerSecond: undefined,
        safetyFactor: 1.5,
        assumedBytesPerSecond: 1_000_000,
      }),
    ).toEqual({ startsAtMs: NOW - 15 * MIN - 900_000, estimateMs: 900_000 });
  });

  it("counts a bulk snapshot still being built, which pending bytes do not include yet", () => {
    // Nothing staged is pending, but bulk is being built: at least the staged size again (or the
    // allowance, whichever is larger) will have to ship. 300 MB at 1 MB/s × 1.5 = 450 s.
    expect(
      planPreservationStart({
        deadlineMs: NOW,
        leadMs: 15 * MIN,
        pendingBytes: 0,
        stagedBytes: 300_000_000,
        bulkBuilding: true,
        uploadBytesPerSecond: 1_000_000,
        safetyFactor: 1.5,
        bulkBuildingAllowanceBytes: 100_000_000,
      }).estimateMs,
    ).toBe(450_000);
  });
});

describe("observeUploadThroughput", () => {
  it("reads a rate only from an interval in which bytes moved, averaging with the last", () => {
    expect(
      observeUploadThroughput({
        previousRate: undefined,
        previousSample: { bytes: 1_000, atMs: 0 },
        sample: { bytes: 3_000, atMs: 1_000 },
      }),
    ).toBe(2_000);
    expect(
      observeUploadThroughput({
        previousRate: 2_000,
        previousSample: { bytes: 3_000, atMs: 1_000 },
        sample: { bytes: 7_000, atMs: 2_000 },
      }),
    ).toBe(3_000);
    // Idle, or a daemon that restarted its counters: no reading.
    expect(
      observeUploadThroughput({
        previousRate: 3_000,
        previousSample: { bytes: 7_000, atMs: 2_000 },
        sample: { bytes: 7_000, atMs: 3_000 },
      }),
    ).toBe(3_000);
    expect(
      observeUploadThroughput({
        previousRate: 3_000,
        previousSample: { bytes: 7_000, atMs: 2_000 },
        sample: { bytes: 10, atMs: 3_000 },
      }),
    ).toBe(3_000);
  });
});

describe("preserveBeforeDeadlineEffect", () => {
  it("leaves a runtime alone while its deadline is beyond the lead and the watch window", async () => {
    const daemon = fakeCaptureDaemon([savedStatus()]);
    const result = await sweep({ deadlineInMs: 3 * 60 * MIN, daemon });
    expect(result.driven).toBe(0);
    expect(daemon.connect).not.toHaveBeenCalled();
    expect(result.schedules).toEqual([]);
  });

  it("samples and records the schedule inside the watch window, without stopping yet", async () => {
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 2, uploadedBytes: 5_000 })]);
    const result = await sweep({ deadlineInMs: 45 * MIN, daemon });

    expect(result.driven).toBe(0);
    expect(result.stop).not.toHaveBeenCalled();
    expect(result.schedules).toEqual([
      expect.objectContaining({
        preservationStartsAt: new Date(NOW + 30 * MIN),
        uploadSampleBytes: 5_000,
      }),
    ]);
  });

  it("drives a FINAL drain and a planned stop once the lead is reached", async () => {
    const daemon = fakeCaptureDaemon([
      captureStatus({ pending: 1, uploadedBytes: 5_000 }),
      savedStatus(),
    ]);
    const result = await sweep({ deadlineInMs: 10 * MIN, daemon });

    expect(result.driven).toBe(1);
    expect(daemon.flushRequests).toContainEqual(expect.objectContaining({ kind: "final" }));
    expect(result.stop).toHaveBeenCalledTimes(1);
    expect(result.markStopped).toHaveBeenCalledWith({ runId: "run_vm", stopReason: "expired" });
    expect(result.setWorkspaceStatus).toHaveBeenCalledWith({ id: "ws_vm", status: "stopped" });
  });

  it("starts earlier than the lead when observed throughput cannot ship what is pending in time", async () => {
    // 25 min to the deadline, 15 min lead: on the lead alone nothing starts for 10 more minutes.
    // But 1.2 GB is pending and the executor was seen uploading 1 MB/s: 1200 s × 1.5 = 30 min of
    // estimate, so the drain starts now.
    const daemon = fakeCaptureDaemon([
      captureStatus({ pending: 3, uploadedBytes: 61_000_000, pendingBytes: 1_200_000_000 }),
      savedStatus(),
    ]);
    const result = await sweep({
      deadlineInMs: 25 * MIN,
      daemon,
      row: {
        runId: "run_vm",
        uploadBytesPerSecond: 1_000_000,
        uploadSampleBytes: 1_000_000,
        uploadSampledAt: new Date(NOW - MIN),
        preservationStartsAt: null,
      },
    });

    expect(result.driven).toBe(1);
    expect(result.stop).toHaveBeenCalledTimes(1);
    expect(result.schedules[0]?.preservationStartsAt?.getTime()).toBeLessThanOrEqual(NOW);
  });

  it("keeps the runtime when the drain cannot confirm its work saved", async () => {
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 0 })]);
    const result = await sweep({ deadlineInMs: 5 * MIN, daemon });
    expect(result.stop).not.toHaveBeenCalled();
    expect(result.markStopped).not.toHaveBeenCalled();
  });
});

describe("preserveBeforeDeadlineEffect · every due runtime makes progress", () => {
  it("samples and drives all six due runtimes every sweep, earliest deadline first", async () => {
    // Review 2 #6: five runtimes whose drains stay pending took every tick; the sixth was never
    // sampled nor finalised before its cap. Deadlines here: run0 latest … run5 earliest.
    const rows = Array.from({ length: 6 }, (_, i) => ({
      ...instance(60_000 - i * 1_000),
      runId: `run${String(i)}`,
      resourceId: `container${String(i)}`,
    }));
    const sampled: string[] = [];
    const inspected: string[] = [];
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 1, complete: false })]);
    const layer = Layer.mergeAll(
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        listRunningInstances: () => Effect.succeed(rows),
        getRuntimeInstanceByRunId: (runId: string) =>
          Effect.succeed(rows.find((candidate) => candidate.runId === runId)),
        markStopRequested: () => Effect.void,
      } as unknown as WorkspaceRuntimeInstanceRepoService),
      Layer.succeed(WorkspaceRepo, {
        getWorkspaceByAttemptId: () => Effect.succeed(undefined),
      } as unknown as WorkspaceRepoService),
      Layer.succeed(WorkspaceAttemptRepo, {
        getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
      } as unknown as WorkspaceAttemptRepoService),
      Layer.succeed(ConnectedAccountRepo, {} as ConnectedAccountRepoService),
      Layer.succeed(WorkspaceCaptureDrainRepo, {
        getByRunId: (runId: string) =>
          Effect.sync(() => {
            sampled.push(runId);
            return undefined;
          }),
        recordSchedule: () => Effect.succeed({} as WorkspaceCaptureDrain),
      } as unknown as WorkspaceCaptureDrainRepoService),
      daemon.layer,
    );
    const adapter: RuntimeAdapter = {
      id: "docker",
      supports: () => ({ supported: true }),
      launch: async () => {
        throw new Error("unused");
      },
      inspect: async ({ resourceId }) => {
        inspected.push(resourceId);
        return { state: "running" };
      },
      stop: async () => {
        throw new Error("a pending drain never permits a stop");
      },
    };
    const ledger = inMemoryCaptureDrainLedger();
    for (let sweepIndex = 0; sweepIndex < 3; sweepIndex += 1) {
      await Effect.runPromise(
        preserveBeforeDeadlineEffect({
          runtimeAdapters: [adapter],
          captureDrain: {
            ledger,
            settings: {
              pollIntervalMs: 2,
              stallWindowMs: 10_000,
              unreachableWindowMs: 10_000,
              requestTimeoutMs: 1_000,
            },
            budgetMs: 1,
          },
          deadline: { leadMs: 15 * MIN, watchWindowMs: 60 * MIN },
          now: () => NOW,
        }).pipe(Effect.provide(layer)),
      );
    }

    for (let i = 0; i < 6; i += 1) {
      expect(sampled.filter((runId) => runId === `run${String(i)}`)).toHaveLength(3);
      // Each due runtime's stop path ran every sweep (its inspect opens the stop).
      expect(
        inspected.filter((resourceId) => resourceId === `container${String(i)}`).length,
      ).toBeGreaterThanOrEqual(3);
    }
    // Earliest deadline first: run5's stop path opens each sweep.
    expect(inspected[0]).toBe("container5");
  });
});
