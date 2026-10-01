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
import { Effect, Layer, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";
import {
  SealantRuntime,
  type SealantRuntimeService,
  type SealantSession,
} from "../sealantd/runtime.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { inMemoryCaptureDrainLedger, type CaptureDrainLedger } from "./capture-drain.js";
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
  launchOwner: null,
  launchLeaseExpiresAt: null,
  daemonImage: null,
  daemonRecoveryBoot: null,
  sourceKind: "capture",
  createdAt: new Date(NOW - 60 * MIN),
  updatedAt: new Date(NOW - 60 * MIN),
});

const sweep = async (input: {
  readonly deadlineInMs: number;
  readonly daemon: ReturnType<typeof fakeCaptureDaemon>;
  readonly row?: Partial<WorkspaceCaptureDrain>;
  /** The launch is still in progress, its worker holding its lease. */
  readonly pending?: boolean;
}) => {
  const schedules: WorkspaceCaptureDrainSchedule[] = [];
  const statuses: Array<{ runId: string; status: Readonly<Record<string, unknown>> }> = [];
  const ledger = inMemoryCaptureDrainLedger();
  const drains = {
    getByRunId: () =>
      Effect.succeed(input.row === undefined ? undefined : (input.row as WorkspaceCaptureDrain)),
    recordSchedule: (request: { runId: string; schedule: WorkspaceCaptureDrainSchedule }) => {
      schedules.push(request.schedule);
      return Effect.succeed({} as WorkspaceCaptureDrain);
    },
    // Every status the sampler reads is recorded as evidence (review 5 #3).
    recordStatus: (request: { runId: string; status: Readonly<Record<string, unknown>> }) =>
      Effect.sync(() => {
        statuses.push(request);
        return true;
      }),
  } as unknown as WorkspaceCaptureDrainRepoService;
  let row: WorkspaceRuntimeInstance =
    input.pending === true
      ? {
          ...instance(input.deadlineInMs),
          status: "pending",
          launchOwner: "worker-1:job:uuid",
          launchLeaseExpiresAt: new Date(NOW + 2 * MIN),
        }
      : instance(input.deadlineInMs);
  const candidates = [row];
  const preemptLaunch = vi.fn((request: { runId: string; errorMessage: string }) =>
    Effect.sync(() => {
      if (row.status !== "pending") return undefined;
      row = {
        ...row,
        status: "failed",
        errorCode: "launch-retained",
        errorMessage: request.errorMessage,
        launchOwner: null,
        launchLeaseExpiresAt: null,
      };
      return row;
    }),
  );
  const markAttemptFailed = vi.fn(() => Effect.void);
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
      listPreservationCandidates: () => Effect.succeed(candidates),
      getRuntimeInstanceByRunId: () => Effect.sync(() => row),
      preemptLaunch,
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
      markAttemptFailed,
    } as unknown as WorkspaceAttemptRepoService),
    Layer.succeed(ConnectedAccountRepo, {} as ConnectedAccountRepoService),
    Layer.succeed(WorkspaceCaptureDrainRepo, drains),
    input.daemon.layer,
  );
  const driven = await Effect.runPromise(
    preserveBeforeDeadlineEffect({
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
      deadline: { leadMs: 15 * MIN, watchWindowMs: 60 * MIN, estimateSafetyFactor: 1.5 },
      now: () => NOW,
    }).pipe(Effect.provide(layer)),
  );
  return {
    driven,
    schedules,
    statuses,
    ledger,
    stop,
    markStopped,
    setWorkspaceStatus,
    preemptLaunch,
    markAttemptFailed,
    row: () => row,
  };
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
  const MiB = 1024 * 1024;

  it("measures the link from an interval the queue held work through, averaging with the last", () => {
    expect(
      observeUploadThroughput({
        previousRate: undefined,
        previousSample: { bytes: 1_000, atMs: 0, pendingBytes: 500 },
        sample: { bytes: 3_000, atMs: 1_000, pendingBytes: 500 },
      }),
    ).toBe(2_000);
    expect(
      observeUploadThroughput({
        previousRate: 2_000,
        previousSample: { bytes: 3_000, atMs: 1_000, pendingBytes: 500 },
        sample: { bytes: 7_000, atMs: 2_000, pendingBytes: 1 },
      }),
    ).toBe(3_000);
    // Idle, or a daemon that restarted its counters: no reading.
    expect(
      observeUploadThroughput({
        previousRate: 3_000,
        previousSample: { bytes: 7_000, atMs: 2_000, pendingBytes: 500 },
        sample: { bytes: 7_000, atMs: 3_000, pendingBytes: 500 },
      }),
    ).toBe(3_000);
    expect(
      observeUploadThroughput({
        previousRate: 3_000,
        previousSample: { bytes: 7_000, atMs: 2_000, pendingBytes: 500 },
        sample: { bytes: 10, atMs: 3_000, pendingBytes: 500 },
      }),
    ).toBe(3_000);
  });

  it("takes a reading over an interval the queue may have idled through as a lower bound only", () => {
    // Alpha 2026-10-01: 33.6 MB over a three-minute interval, the queue empty at its end.
    const trickle = observeUploadThroughput({
      previousRate: undefined,
      previousSample: { bytes: 0, atMs: 0, pendingBytes: 0 },
      sample: { bytes: 33_646_593, atMs: 235_000, pendingBytes: 0 },
    });
    expect(trickle).toBe(MiB);
    // Nor does it lower a rate measured before.
    expect(
      observeUploadThroughput({
        previousRate: 40 * MiB,
        previousSample: { bytes: 0, atMs: 0 },
        sample: { bytes: 1 * MiB, atMs: 10_000 },
      }),
    ).toBe(40 * MiB);
    // It raises one: 800 MB in ten seconds shows the link does at least 80 MB/s.
    expect(
      observeUploadThroughput({
        previousRate: MiB,
        previousSample: { bytes: 0, atMs: 0, pendingBytes: 600 * MiB },
        sample: { bytes: 800 * MiB, atMs: 10_000, pendingBytes: 0 },
      }),
    ).toBe(80 * MiB);
    // An assumed rate set lower is the floor instead.
    expect(
      observeUploadThroughput({
        previousRate: undefined,
        previousSample: { bytes: 0, atMs: 0 },
        sample: { bytes: 1_000, atMs: 1_000 },
        assumedBytesPerSecond: 100,
      }),
    ).toBe(1_000);
  });

  it("still lowers the estimate for a link measured slow while the queue held work", () => {
    expect(
      observeUploadThroughput({
        previousRate: undefined,
        previousSample: { bytes: 0, atMs: 0, pendingBytes: 500 * MiB },
        sample: { bytes: 10 * 1024 * 200, atMs: 200_000, pendingBytes: 498 * MiB },
      }),
    ).toBe(10 * 1024);
  });

  it("replays alpha: a MicroVM 3 min into its hour is not stopped on an idle interval's trickle", () => {
    const deadlineMs = 60 * 60_000;
    const nowMs = 3 * 60_000;
    const rate = observeUploadThroughput({
      previousRate: undefined,
      previousSample: { bytes: 0, atMs: 0, pendingBytes: 0 },
      sample: { bytes: 33_646_593, atMs: nowMs, pendingBytes: 0 },
    });
    const plan = planPreservationStart({
      deadlineMs,
      leadMs: 15 * 60_000,
      pendingBytes: 0,
      stagedBytes: 781_643_508,
      bulkBuilding: true,
      uploadBytesPerSecond: rate,
      safetyFactor: 1.5,
    });
    // Before: 6890 s at 140 KB/s, a start 70 min in the past. Now the assumed 1 MiB/s bounds the
    // rate: the bulk being built (781 MB) over it, times 1.5, starts the drain 26 minutes in.
    expect(Math.round(plan.estimateMs / 1000)).toBe(1118);
    expect(plan.startsAtMs).toBeGreaterThan(nowMs);
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
    // The reading is evidence about the executor: recorded (review 5 #3), under an observation
    // fence it resolved (review 6 #5).
    expect(result.ledger.store.rows.get("run_vm")?.entry).toMatchObject({
      last: expect.objectContaining({ pending: 2, uploadedBytes: 5_000 }),
    });
    expect(result.ledger.store.rows.get("run_vm")?.fences?.size).toBe(0);
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
        listPreservationCandidates: () => Effect.succeed(rows),
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
        recordStatus: () => Effect.succeed(true),
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

describe("preserveBeforeDeadlineEffect · runtimes that are not ready (review 3 #6, #7)", () => {
  const sweepRows = async (
    rows: readonly WorkspaceRuntimeInstance[],
    retained: boolean,
    recovery?: {
      readonly recover: NonNullable<RuntimeAdapter["recover"]>;
      readonly ledger: CaptureDrainLedger;
    },
  ) => {
    const requestRecovery = vi.fn((runId: string) =>
      Effect.succeed(
        retained ? ({ runId, retainedAt: new Date(NOW) } as WorkspaceCaptureDrain) : undefined,
      ),
    );
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
      inspect: async () =>
        recovery === undefined ? { state: "running" } : { state: "exited", exitCode: 75 },
      ...(recovery === undefined ? {} : { recover: recovery.recover }),
    };
    const layer = Layer.mergeAll(
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        listPreservationCandidates: () => Effect.succeed(rows),
        getRuntimeInstanceByRunId: (runId: string) =>
          Effect.succeed(rows.find((candidate) => candidate.runId === runId)),
        markStopRequested: () => Effect.void,
        markStopped: () => Effect.void,
      } as unknown as WorkspaceRuntimeInstanceRepoService),
      Layer.succeed(WorkspaceRepo, {
        getWorkspaceByAttemptId: () => Effect.succeed(undefined),
      } as unknown as WorkspaceRepoService),
      Layer.succeed(WorkspaceAttemptRepo, {
        getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
      } as unknown as WorkspaceAttemptRepoService),
      Layer.succeed(ConnectedAccountRepo, {} as ConnectedAccountRepoService),
      Layer.succeed(WorkspaceCaptureDrainRepo, {
        getByRunId: () =>
          Effect.succeed(
            retained ? ({ retainedAt: new Date(NOW - MIN) } as WorkspaceCaptureDrain) : undefined,
          ),
        recordSchedule: () => Effect.succeed({} as WorkspaceCaptureDrain),
        recordStatus: () => Effect.succeed(true),
        requestRecovery,
        listRetainedDue: (request: { readonly runIds?: readonly string[] }) =>
          Effect.succeed(
            (request.runIds ?? []).map(
              (runId) =>
                ({
                  runId,
                  retainedAt: new Date(NOW - MIN),
                  recoveryAttempts: 0,
                  captureTokenSealed: "sealed",
                }) as WorkspaceCaptureDrain,
            ),
          ),
        recordRecoveryAttempt: () => Effect.void,
      } as unknown as WorkspaceCaptureDrainRepoService),
      fakeCaptureDaemon(["unreachable"]).layer,
    );
    const driven = await Effect.runPromise(
      preserveBeforeDeadlineEffect({
        runtimeAdapters: [adapter],
        credentialCipher: {
          encrypt: () => Effect.die("unused"),
          decrypt: () => Effect.succeed(JSON.stringify({ SEALANT_CAPTURE_TOKEN: "token" })),
        },
        captureDrain: {
          ledger: recovery?.ledger ?? inMemoryCaptureDrainLedger(),
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
    return { driven, requestRecovery, stop };
  };

  it("makes a retained executor's recovery due before its deadline (its daemon exited on a live VM)", async () => {
    // Review 3 #7: the exit reconciler marked the exit-75 VM `failed`, which took it out of the
    // pre-deadline sweep; the platform cap then destroyed its disk with the staging on it.
    const exited: WorkspaceRuntimeInstance = {
      ...instance(5 * MIN),
      status: "failed",
      errorCode: "runtime-exited",
      finishedAt: new Date(NOW - MIN),
    };
    const { driven, requestRecovery, stop } = await sweepRows([exited], true);
    expect(driven).toBe(1);
    expect(requestRecovery).toHaveBeenCalledWith("run_vm");
    expect(stop).not.toHaveBeenCalled();
  });

  // Review 9 #8: making the recovery due left it behind a recovery sweep that may be busy with
  // another executor until after this one's cap. The deadline path starts it itself, under the
  // executor's recovery claim.
  it("starts the retained executor's recovery itself, under its recovery claim (review 9 #8)", async () => {
    const exited: WorkspaceRuntimeInstance = {
      ...instance(5 * MIN),
      status: "failed",
      errorCode: "runtime-exited",
      finishedAt: new Date(NOW - MIN),
      daemonRecoveryBoot: true,
    };
    const ledger = inMemoryCaptureDrainLedger({ now: () => NOW });
    Effect.runSync(ledger.markRetained("run_vm", "executor exited · exit 75"));
    const recover = vi.fn(async () => ({ outcome: "unsupported" as const, detail: "kept" }));
    const { driven, requestRecovery } = await sweepRows([exited], true, { recover, ledger });
    expect(driven).toBe(1);
    expect(requestRecovery).toHaveBeenCalledWith("run_vm");
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    // Its claim was released once the attempt ended.
    await vi.waitFor(async () =>
      expect(await Effect.runPromise(ledger.claimRecovery("run_vm", 1_000))).toBeDefined(),
    );
  });

  it("leaves an ended executor that nothing retains alone", async () => {
    const exited: WorkspaceRuntimeInstance = {
      ...instance(5 * MIN),
      status: "failed",
      errorCode: "runtime-exited",
      finishedAt: new Date(NOW - MIN),
    };
    const { driven, requestRecovery } = await sweepRows([exited], false);
    expect(driven).toBe(0);
    expect(requestRecovery).not.toHaveBeenCalled();
  });
});

describe("preserveBeforeDeadlineEffect · a launch still in progress at its preservation start (review 4 #6)", () => {
  it("takes the launch from its worker and sends its executor FINAL, even with its deadline passed", async () => {
    // Review 4 #6: the sweep sampled a `pending` executor holding 2 GB and returned without a
    // FINAL, however close (or past) its deadline; everything then hung on the platform's
    // at-most-60-second terminate hook.
    for (const deadlineInMs of [120_000, 1_000, -1_000]) {
      const daemon = fakeCaptureDaemon([
        captureStatus({ pending: 2, pendingBytes: 2_000_000_000, complete: false }),
        savedStatus(),
      ]);
      const result = await sweep({ deadlineInMs, daemon, pending: true });
      expect(result.preemptLaunch).toHaveBeenCalledTimes(1);
      expect(result.row()).toMatchObject({ status: "failed", errorCode: "launch-retained" });
      expect(result.markAttemptFailed).toHaveBeenCalledTimes(1);
      expect(daemon.flushRequests[0]).toMatchObject({ kind: "final" });
      expect(result.driven).toBe(1);
      expect(result.stop).toHaveBeenCalledTimes(1);
    }
  });

  it("leaves a launch whose preservation start has not come yet to its worker", async () => {
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 0, pendingBytes: 0 })]);
    const result = await sweep({ deadlineInMs: 30 * MIN, daemon, pending: true });
    expect(result.preemptLaunch).not.toHaveBeenCalled();
    expect(daemon.flushRequests).toEqual([]);
    expect(result.driven).toBe(0);
  });
});

// Review 6 #11: the sweep used to sample every candidate's status (concurrency 16, 15 s each)
// before driving any due FINAL, so slow or silent daemons delayed urgent executors past their
// own cap. Each runtime is driven as soon as its own plan is due.
describe("no all-plans barrier before a due FINAL (review 6 #11)", () => {
  // The stop path removes launch material on the real filesystem: virtual time is advanced in
  // small steps while real I/O completes between them.
  const realSetTimeout = globalThis.setTimeout;
  const advanceUntil = async (done: () => boolean, virtualMs: number) => {
    for (let elapsed = 0; elapsed < virtualMs && !done(); elapsed += 10) {
      await vi.advanceTimersByTimeAsync(10);
      await new Promise((resolve) => realSetTimeout(resolve, 5));
    }
  };
  const sweepMany = async (
    rows: readonly WorkspaceRuntimeInstance[],
    run: (finalAt: number[], result: Promise<number>) => Promise<void>,
  ) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const finalAt: number[] = [];
    const daemon: Pick<SealantSession, "captureStatus" | "captureFlush"> = {
      // Every status read hangs (a slow or silent daemon); a FINAL answers complete at once.
      captureStatus: () => Effect.never,
      captureFlush: () =>
        Effect.sync(() => {
          finalAt.push(Date.now() - NOW);
          return savedStatus();
        }),
    };
    const layer = Layer.mergeAll(
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        listPreservationCandidates: () => Effect.succeed(rows),
        getRuntimeInstanceByRunId: (runId: string) =>
          Effect.succeed(rows.find((row) => row.runId === runId)),
        markStopRequested: () => Effect.void,
        markStopped: () => Effect.void,
      } as unknown as WorkspaceRuntimeInstanceRepoService),
      Layer.succeed(WorkspaceRepo, {
        getWorkspaceByAttemptId: () => Effect.succeed(undefined),
      } as unknown as WorkspaceRepoService),
      Layer.succeed(WorkspaceAttemptRepo, {
        getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
      } as unknown as WorkspaceAttemptRepoService),
      Layer.succeed(ConnectedAccountRepo, {} as ConnectedAccountRepoService),
      Layer.succeed(WorkspaceCaptureDrainRepo, {
        getByRunId: () => Effect.succeed(undefined),
        recordSchedule: () => Effect.succeed({} as WorkspaceCaptureDrain),
        recordStatus: () => Effect.succeed(true),
      } as unknown as WorkspaceCaptureDrainRepoService),
      Layer.succeed(SealantRuntime, {
        connect: () => Effect.succeed(daemon as SealantSession),
      } as unknown as SealantRuntimeService),
    );
    const adapter: RuntimeAdapter = {
      id: "docker",
      supports: () => ({ supported: true }),
      launch: async () => {
        throw new Error("unused");
      },
      inspect: async () => ({ state: "running" }),
      stop: async ({ resourceId }) => ({ adapter: "docker", resourceId, outcome: "stopped" }),
    };
    try {
      const result = Effect.runPromise(
        preserveBeforeDeadlineEffect({
          runtimeAdapters: [adapter],
          captureDrain: {
            ledger: inMemoryCaptureDrainLedger(),
            settings: {
              pollIntervalMs: 1,
              stallWindowMs: 1_000,
              unreachableWindowMs: 1_000,
              requestTimeoutMs: 1_000,
            },
            budgetMs: 100,
          },
          deadline: { leadMs: 15 * MIN, watchWindowMs: 60 * MIN },
          now: () => Date.now(),
        }).pipe(Effect.provide(layer)),
      );
      await run(finalAt, result);
    } finally {
      vi.useRealTimers();
    }
  };
  const vm = (index: number, deadlineInMs: number): WorkspaceRuntimeInstance => ({
    ...instance(deadlineInMs),
    runId: `run_due_${String(index)}`,
    resourceId: `container_due_${String(index)}`,
    endpoint: `unix:///tmp/review6-due-${String(index)}.sock`,
  });

  it("sends every due FINAL at once when every status read hangs", async () => {
    // 17 runtimes ending in 20 s: every one is past its latest start (deadline less the lead).
    const rows = Array.from({ length: 17 }, (_, index) => vm(index, 20_000));
    await sweepMany(rows, async (finalAt, result) => {
      await advanceUntil(() => finalAt.length === 17, 900);
      expect(finalAt.length).toBe(17);
      expect(Math.max(...finalAt)).toBeLessThan(1_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await result).toBe(17);
    });
  });

  it("drives a due runtime while samples of runtimes not yet due hang", async () => {
    // Sixteen runtimes still before their start, whose daemons never answer a status, fill the
    // sampling slots; the one due runtime — listed last — is not held behind them.
    const rows = [
      ...Array.from({ length: 16 }, (_, index) => vm(index, 15 * MIN + 10 * MIN)),
      vm(16, 20_000),
    ];
    await sweepMany(rows, async (finalAt, result) => {
      await advanceUntil(() => finalAt.length === 1, 900);
      expect(finalAt).toHaveLength(1);
      expect(finalAt[0]).toBeLessThan(1_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toBe(1);
    });
  });
});

/** The socket a daemon target names: one executor per socket in these sweeps. */
const socketOf = (target: unknown): string =>
  typeof target === "object" && target !== null && "socketPath" in target
    ? String(target.socketPath)
    : "unknown";

// Review 7 #6: each drive held one of four permits for its whole drain (a 60 s budget), and a
// runtime's first FINAL waited for a permit with no bound: with 68 runtimes due together at the
// default 15 min lead, eight got their first FINAL at or after their platform cap. Every due
// FINAL is now sent first under its own permits, polling is bounded separately and ends with the
// sweep, and the FINAL round trips queued ahead of a runtime move its start earlier.
describe("every due runtime gets its first FINAL before its cap (review 7 #6)", () => {
  const CAP_MS = 15 * MIN;
  const vm = (index: number, deadlineInMs: number): WorkspaceRuntimeInstance => ({
    ...instance(deadlineInMs),
    runId: `run_cap_${String(index)}`,
    resourceId: `container_cap_${String(index)}`,
    endpoint: `unix:///tmp/review7-cap-${String(index)}.sock`,
  });

  const sweepAtCap = async (input: {
    readonly rows: readonly WorkspaceRuntimeInstance[];
    /** How long each FINAL round trip takes before it answers (virtual). */
    readonly flushTakesMs: number;
    /**
     * Each FINAL answers complete and removing the runtime takes this long (virtual); absent,
     * every queue stays pending and nothing is removed.
     */
    readonly stopTakesMs?: number;
    /** How long virtual time runs on after the sweep returned (a removal still in flight). */
    readonly thenAdvanceMs?: number;
    readonly initiateConcurrency?: number;
    readonly schedules?: Array<{ runId: string; startsAtMs: number | undefined }>;
    /**
     * Review 9 #9: once the drain read complete, a newer not-saved observation is recorded and
     * the evidence read that decides the removal takes this long (virtual).
     */
    readonly revokeAndDelayDecisionMs?: number;
    /**
     * Review 9 #9: the daemon is unreachable and the executor exited 75; the stop's inspection
     * after its drain takes this long (virtual).
     */
    readonly silentFollowupInspectMs?: number;
  }) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const baseLedger = inMemoryCaptureDrainLedger();
    let delayedDecision = false;
    let completeReads = 0;
    const ledger: CaptureDrainLedger = {
      ...baseLedger,
      read: (runId: string) =>
        Effect.gen(function* () {
          if (baseLedger.store.rows.get(runId)?.entry.last?.complete === true) {
            completeReads += 1;
          }
          if (
            input.revokeAndDelayDecisionMs !== undefined &&
            !delayedDecision &&
            completeReads === 2
          ) {
            delayedDecision = true;
            yield* baseLedger.recordStatus(
              runId,
              captureStatus({ complete: false, incompleteReason: "changed", headN: 999 }),
              Date.now(),
            );
            yield* Effect.sleep(input.revokeAndDelayDecisionMs);
          }
          return yield* baseLedger.read(runId);
        }),
    };
    // Every FINAL each executor was sent, at the virtual instant it was sent.
    const finals = new Map<string, number[]>();
    // Every runtime removed, at the virtual instant its removal finished.
    const removed = new Map<string, number>();
    const logs: string[] = [];
    const layer = Layer.mergeAll(
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        listPreservationCandidates: () => Effect.succeed(input.rows),
        getRuntimeInstanceByRunId: (runId: string) =>
          Effect.succeed(input.rows.find((row) => row.runId === runId)),
        markStopRequested: () => Effect.void,
        markStopped: () => Effect.void,
      } as unknown as WorkspaceRuntimeInstanceRepoService),
      Layer.succeed(WorkspaceRepo, {
        getWorkspaceByAttemptId: () => Effect.succeed(undefined),
      } as unknown as WorkspaceRepoService),
      Layer.succeed(WorkspaceAttemptRepo, {
        getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
      } as unknown as WorkspaceAttemptRepoService),
      Layer.succeed(ConnectedAccountRepo, {} as ConnectedAccountRepoService),
      Layer.succeed(WorkspaceCaptureDrainRepo, {
        getByRunId: () => Effect.succeed(undefined),
        recordSchedule: (request: { runId: string; schedule: WorkspaceCaptureDrainSchedule }) =>
          Effect.sync(() => {
            input.schedules?.push({
              runId: request.runId,
              startsAtMs: request.schedule.preservationStartsAt?.getTime(),
            });
            return {} as WorkspaceCaptureDrain;
          }),
        recordStatus: () => Effect.succeed(true),
      } as unknown as WorkspaceCaptureDrainRepoService),
      Layer.succeed(SealantRuntime, {
        connect: (target: unknown) =>
          Effect.succeed({
            // A queue that never empties: every drain stays pending, as in the reproduction.
            captureStatus: () => Effect.succeed(captureStatus({ pending: 1, complete: false })),
            captureFlush: () =>
              Effect.gen(function* () {
                const socket = socketOf(target);
                finals.set(socket, [...(finals.get(socket) ?? []), Date.now() - NOW]);
                yield* Effect.sleep(input.flushTakesMs);
                return input.stopTakesMs === undefined
                  ? captureStatus({ pending: 1, complete: false })
                  : savedStatus();
              }),
          } as unknown as SealantSession),
      } as unknown as SealantRuntimeService),
      Logger.layer([
        Logger.make(({ message }) => {
          logs.push(Array.isArray(message) ? message.join(" ") : String(message));
        }),
      ]),
    );
    let inspections = 0;
    const adapter: RuntimeAdapter = {
      id: "docker",
      supports: () => ({ supported: true }),
      launch: async () => {
        throw new Error("unused");
      },
      inspect: async () => {
        inspections += 1;
        if (input.silentFollowupInspectMs === undefined || inspections === 1) {
          return { state: "running" };
        }
        if (inspections === 3) {
          await new Promise((resolve) => setTimeout(resolve, input.silentFollowupInspectMs));
        }
        return { state: "exited", exitCode: 75 };
      },
      stop: async (request) => {
        const takesMs = input.stopTakesMs;
        if (takesMs === undefined) {
          throw new Error("a pending queue is never stopped");
        }
        await new Promise((resolve) => setTimeout(resolve, takesMs));
        removed.set(request.resourceId, Date.now() - NOW);
        return { adapter: "docker", resourceId: request.resourceId, outcome: "stopped" };
      },
    };
    try {
      const result: { doneAtMs: number | undefined; driven: number } = {
        doneAtMs: undefined,
        driven: -1,
      };
      void Effect.runPromise(
        preserveBeforeDeadlineEffect({
          runtimeAdapters: [adapter],
          captureDrain: {
            ledger,
            // The worker's defaults: 1 s polls, 60 s round trips, the default budget.
            settings: {
              pollIntervalMs: 1_000,
              stallWindowMs: 60 * MIN,
              unreachableWindowMs: 60 * MIN,
              requestTimeoutMs: 60_000,
            },
          },
          deadline: { leadMs: 15 * MIN, watchWindowMs: 60 * MIN },
          ...(input.initiateConcurrency === undefined
            ? {}
            : { initiateConcurrency: input.initiateConcurrency }),
          now: () => Date.now(),
        }).pipe(
          Effect.provide(
            input.silentFollowupInspectMs === undefined
              ? layer
              : Layer.merge(layer, fakeCaptureDaemon(["unreachable"]).layer),
          ),
        ),
      ).then((count) => {
        result.driven = count;
        result.doneAtMs = Date.now() - NOW;
        return count;
      });
      // Virtual time in 1 s steps until the sweep returns (or 20 min: past every cap here).
      for (let elapsed = 0; elapsed < 20 * MIN; elapsed += 1_000) {
        if (result.doneAtMs !== undefined) {
          break;
        }
        await vi.advanceTimersByTimeAsync(1_000);
      }
      for (let elapsed = 0; elapsed < (input.thenAdvanceMs ?? 0); elapsed += 1_000) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      return { finals, removed, logs, doneAtMs: result.doneAtMs, driven: result.driven };
    } finally {
      vi.useRealTimers();
    }
  };

  // Review 8 #6: the FINAL permit was held through the whole stop, removal included. Executors
  // that answered complete at once then held all 32 permits through a 16-minute removal (within
  // Docker's capture stop grace): the 33rd never got its FINAL before its cap, the sweep (and so
  // every later sweep) waited out the removals, and each complete executor was reported at the cap
  // as one whose "final flush could not be sent" — not saved — though its complete answer had come.
  it("releases a FINAL permit once the FINAL is answered, never holding it through a removal", async () => {
    const rows = Array.from({ length: 33 }, (_, index) => vm(index, CAP_MS));
    const { finals, removed, logs, doneAtMs, driven } = await sweepAtCap({
      rows,
      flushTakesMs: 0,
      stopTakesMs: 16 * MIN,
      thenAdvanceMs: 17 * MIN,
    });
    const firsts = [...finals.values()].map((sent) => sent[0] ?? Number.POSITIVE_INFINITY);
    expect(firsts).toHaveLength(33);
    expect(Math.max(...firsts)).toBeLessThan(1_000);
    // The sweep ends with its budget; the removals go on without it.
    expect(doneAtMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2 * MIN + 1_000);
    expect(driven).toBe(33);
    // Every removal still finishes, once, after the sweep returned.
    expect(removed.size).toBe(33);
    expect(Math.min(...removed.values())).toBeGreaterThanOrEqual(16 * MIN);
    // No complete executor is reported as one whose FINAL could not be sent.
    expect(logs.filter((line) => line.includes("could not be sent"))).toEqual([]);
    expect(logs.filter((line) => line.includes("not saved"))).toEqual([]);
    expect(
      logs.filter((line) => line.includes("answered complete") && line.includes("removal")),
    ).toHaveLength(33);
  }, 60_000);

  // Review 9 #9 (decision 28): "removal under way" only once the removal was issued. A silent
  // daemon on an executor that exited never lets it go, whatever the stop does after its drain.
  it("never reports a removal under way for a silent, unsaved executor (review 9 #9)", async () => {
    const { removed, logs, doneAtMs } = await sweepAtCap({
      rows: [vm(0, CAP_MS)],
      flushTakesMs: 0,
      silentFollowupInspectMs: 3 * MIN,
      thenAdvanceMs: 4 * MIN,
    });
    expect(doneAtMs).toBeLessThan(3 * MIN);
    expect(removed.size).toBe(0);
    expect(logs.some((line) => line.includes("not saved · executor exited"))).toBe(true);
    expect(logs.filter((line) => line.includes("lets it go"))).toEqual([]);
    expect(logs.filter((line) => line.includes("asked to remove"))).toEqual([]);
    expect(
      logs.some(
        (line) => line.includes("its drain ended silent") && line.includes("nothing removed"),
      ),
    ).toBe(true);
  });

  it("reports the removal still being weighed, not under way, while newer evidence may veto it (review 9 #9)", async () => {
    const { finals, removed, logs, doneAtMs } = await sweepAtCap({
      rows: [vm(0, CAP_MS)],
      flushTakesMs: 0,
      stopTakesMs: 0,
      revokeAndDelayDecisionMs: 3 * MIN,
      thenAdvanceMs: 4 * MIN,
    });
    expect(finals.size).toBe(1);
    expect(doneAtMs).toBeLessThan(3 * MIN);
    // The newer observation vetoed the removal.
    expect(removed.size).toBe(0);
    expect(logs.some((line) => line.includes("asked to remove"))).toBe(false);
    expect(logs.some((line) => line.includes("under way"))).toBe(false);
    expect(
      logs.some(
        (line) => line.includes("still being weighed") && line.includes("nothing removed yet"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("nothing lets the executor go"))).toBe(true);
  });

  it("sends all 68 first FINALs at once when 68 runtimes reach their start together", async () => {
    const rows = Array.from({ length: 68 }, (_, index) => vm(index, CAP_MS));
    const { finals, doneAtMs, driven } = await sweepAtCap({ rows, flushTakesMs: 0 });
    const firsts = [...finals.values()].map((sent) => sent[0] ?? Number.POSITIVE_INFINITY);
    expect(firsts).toHaveLength(68);
    expect(Math.max(...firsts)).toBeLessThan(CAP_MS);
    expect(firsts.filter((at) => at >= CAP_MS)).toHaveLength(0);
    expect(Math.max(...firsts)).toBeLessThan(1_000);
    // A started drain is polled, never sent a second FINAL while its queue moves.
    expect([...finals.values()].every((sent) => sent.length === 1)).toBe(true);
    // The sweep ends with its budget (plus the round trip a poll may be in): the next tick is
    // never held back for minutes.
    expect(driven).toBe(68);
    expect(doneAtMs).toBeDefined();
    expect(doneAtMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2 * MIN + 1_000);
  }, 60_000);

  it("sends every first FINAL before its cap when each FINAL round trip takes 55 s", async () => {
    const rows = Array.from({ length: 68 }, (_, index) => vm(index, CAP_MS));
    const { finals, doneAtMs } = await sweepAtCap({ rows, flushTakesMs: 55_000 });
    const firsts = [...finals.values()].map((sent) => sent[0] ?? Number.POSITIVE_INFINITY);
    expect(firsts).toHaveLength(68);
    // 32 at a time: three waves of 55 s.
    expect(Math.max(...firsts)).toBeLessThanOrEqual(2 * 55_000 + 1_000);
    expect(doneAtMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(5 * MIN);
  }, 60_000);

  it("starts a runtime earlier by the FINAL round trips queued ahead of it", async () => {
    // Twelve runtimes whose lead alone starts them in 90 s; four FINAL permits and 60 s round
    // trips put two waves (120 s) ahead of the last four, which are due now.
    const rows = Array.from({ length: 12 }, (_, index) => vm(index, CAP_MS + 90_000));
    const schedules: Array<{ runId: string; startsAtMs: number | undefined }> = [];
    const { finals } = await sweepAtCap({
      rows,
      flushTakesMs: 0,
      initiateConcurrency: 4,
      schedules,
    });
    expect(finals.size).toBe(4);
    expect(
      [...finals.values()].every((sent) => (sent[0] ?? Number.POSITIVE_INFINITY) < 1_000),
    ).toBe(true);
    const starts = new Map(schedules.map((entry) => [entry.runId, entry.startsAtMs]));
    expect(starts.get("run_cap_0")).toBe(NOW + 90_000);
    expect(starts.get("run_cap_4")).toBe(NOW + 30_000);
    expect(starts.get("run_cap_11")).toBe(NOW - 30_000);
  }, 60_000);
});
