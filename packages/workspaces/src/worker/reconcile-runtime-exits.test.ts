/**
 * Unit tests for the runtime exit reconciler. The properties that matter: an exited or vanished
 * runtime is recorded through the fenced `markExited` write with the exit code in the message,
 * its remains are removed and its staged launch material dropped; a fenced-out write (a stop got
 * there first, or a relaunch replaced the resource) touches nothing; adapters without `inspect`
 * and running instances are left alone; an exit event reconciles only the named resource, and
 * only after the grace window.
 */
import {
  WorkspaceAttemptRepo,
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceAttemptRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { Effect, Layer, Logger } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LaunchMaterialStager } from "../runtime/launch-material.js";
import type {
  RuntimeAdapter,
  RuntimeAdapterExitWatchInput,
  RuntimeAdapterInspectResult,
} from "../runtime/runtime-adapter.js";
import { SealantRuntime } from "../sealantd/runtime.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { inMemoryCaptureDrainLedger } from "./capture-drain.js";
import {
  reconcileRuntimeExits,
  reconcileRuntimeExitsEffect,
  watchRuntimeExits,
} from "./reconcile-runtime-exits.js";

// `reconcileRuntimeExits` (the Promise entry the worker and the watch use) builds the live repo
// layer from the db handle; the mock swaps that layer for the harness's, keyed on a module-level
// slot each test fills.
const liveRepo: { current: WorkspaceRuntimeInstanceRepoService | undefined } = {
  current: undefined,
};

vi.mock("@sealant/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sealant/db")>();
  // The factory is hoisted above the module's imports, so it loads effect itself.
  const effect = await import("effect");
  return {
    ...actual,
    WorkspaceRuntimeInstanceRepoLive: effect.Layer.effect(
      actual.WorkspaceRuntimeInstanceRepo,
      effect.Effect.sync(() => {
        if (liveRepo.current === undefined) {
          throw new Error("test did not install a runtime instance repo");
        }
        return liveRepo.current;
      }),
    ),
  };
});

const runtimeInstance = (
  overrides: Partial<WorkspaceRuntimeInstance> = {},
): WorkspaceRuntimeInstance => ({
  runId: "run_1",
  status: "ready",
  adapter: "docker",
  resourceId: "container-1",
  reference: "sealant-run-1",
  endpoint: null,
  errorCode: null,
  errorMessage: null,
  stopReason: null,
  launchCredentialInjections: null,
  launchedAt: new Date("2026-09-01T00:00:00.000Z"),
  finishedAt: null,
  runtimeDeadlineAt: null,
  launchOwner: null,
  launchLeaseExpiresAt: null,
  daemonImage: null,
  daemonRecoveryBoot: null,
  sourceKind: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  ...overrides,
});

interface Harness {
  readonly repo: WorkspaceRuntimeInstanceRepoService;
  readonly markExited: ReturnType<typeof vi.fn>;
  readonly markStopped: ReturnType<typeof vi.fn>;
  readonly layer: Layer.Layer<WorkspaceRuntimeInstanceRepo | WorkspaceAttemptRepo | SealantRuntime>;
}

const makeHarness = (input: {
  readonly instances: readonly WorkspaceRuntimeInstance[];
  /** What `markExited` answers; default = the updated row (the fence let the write through). */
  readonly exitedRow?: (runId: string) => WorkspaceRuntimeInstance | undefined;
  /** The runs' stored blueprints name a capture source (default: a git source). */
  readonly captureSourced?: boolean;
  /** No attempt snapshot at all (and the rows record no source kind). */
  readonly snapshotMissing?: boolean;
  /** The daemon the drain dials; default = one that must never be dialled. */
  readonly daemon?: Layer.Layer<SealantRuntime>;
  /** Ended capture executors nothing settled (`listUnsettledCaptureExecutors`). */
  readonly unsettled?: readonly WorkspaceRuntimeInstance[];
}): Harness => {
  const markExited = vi.fn((request: { runId: string; resourceId: string; errorMessage: string }) =>
    Effect.succeed(
      input.exitedRow === undefined
        ? runtimeInstance({ runId: request.runId, status: "failed" })
        : input.exitedRow(request.runId),
    ),
  );
  const markStopped = vi.fn((request: { runId: string; stopReason: string }) =>
    Effect.succeed(runtimeInstance({ runId: request.runId, status: "stopped" })),
  );
  const repo: WorkspaceRuntimeInstanceRepoService = {
    upsertRuntimeInstance: () => Effect.die("unused"),
    markExited,
    markStopped,
    getRuntimeInstanceByRunId: () => Effect.die("unused"),
    listRuntimeInstancesByRunIds: () => Effect.die("unused"),
    listRunningInstances: () => Effect.succeed(input.instances),
    listRetainedLaunches: () => Effect.succeed([]),
    listStrandedLaunches: () => Effect.succeed([]),
    adoptStrandedLaunch: () => Effect.succeed(undefined),
    listUnidentifiedStrandedLaunches: () => Effect.succeed([]),
    identifyStrandedLaunch: () => Effect.succeed(undefined),
    failLostLaunch: () => Effect.succeed(undefined),
    renewLaunchLease: () => Effect.succeed(false),
    listPreservationCandidates: () => Effect.succeed([]),
    preemptLaunch: () => Effect.succeed(undefined),
    listUnsettledCaptureExecutors: () => Effect.succeed(input.unsettled ?? []),
    markStopRequested: () => Effect.void,
  };
  const attempts = {
    getAttemptSnapshotByRunId: () =>
      Effect.succeed(
        input.snapshotMissing === true
          ? undefined
          : {
              blueprintPayload: {
                sources: {
                  workspace: { kind: input.captureSourced === true ? "capture" : "github" },
                },
              },
            },
      ),
  } as unknown as WorkspaceAttemptRepoService;
  return {
    repo,
    markExited,
    markStopped,
    layer: Layer.mergeAll(
      Layer.succeed(WorkspaceRuntimeInstanceRepo, repo),
      Layer.succeed(WorkspaceAttemptRepo, attempts),
      input.daemon ??
        Layer.succeed(SealantRuntime, { connect: () => Effect.die("daemon must not be dialled") }),
    ),
  };
};

const stubAdapter = (input: {
  readonly id?: RuntimeAdapter["id"];
  readonly inspections?: ReadonlyMap<string, RuntimeAdapterInspectResult>;
  readonly watch?: (handlers: RuntimeAdapterExitWatchInput) => void;
}) => {
  const inspect = vi.fn(async (request: { resourceId: string }) => {
    const inspection = input.inspections?.get(request.resourceId);
    if (inspection === undefined) {
      throw new Error(`no inspection scripted for ${request.resourceId}`);
    }
    return inspection;
  });
  const stop = vi.fn(async (request: { resourceId: string }) => ({
    adapter: input.id ?? ("docker" as const),
    resourceId: request.resourceId,
    outcome: "stopped" as const,
  }));
  const close = vi.fn();
  const adapter: RuntimeAdapter = {
    id: input.id ?? "docker",
    supports: () => ({ supported: true }),
    launch: async () => {
      throw new Error("not used");
    },
    stop,
    ...(input.inspections === undefined ? {} : { inspect }),
    ...(input.watch === undefined
      ? {}
      : {
          watchExits: (handlers: RuntimeAdapterExitWatchInput) => {
            input.watch?.(handlers);
            return { close };
          },
        }),
  };
  return { adapter, inspect, stop, close };
};

const fakeStager = () => {
  const removeAll = vi.fn(async () => undefined);
  const stager: LaunchMaterialStager = {
    stage: () => Promise.reject(new Error("unused")),
    removeSecretEnv: async () => undefined,
    removeAll,
  };
  return { stager, removeAll };
};

describe("reconcileRuntimeExitsEffect", () => {
  it("records an exited runtime as failed with its exit code, then removes its remains and staged material", async () => {
    const harness = makeHarness({ instances: [runtimeInstance()] });
    const { adapter, stop } = stubAdapter({
      inspections: new Map([
        [
          "container-1",
          { state: "exited", exitCode: 137, detail: "status: exited, exitCode: 137\nLogs:\nbye" },
        ],
      ]),
    });
    const { stager, removeAll } = fakeStager();

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: stager,
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(1);
    expect(harness.markExited).toHaveBeenCalledWith({
      runId: "run_1",
      resourceId: "container-1",
      errorMessage:
        "Workspace runtime 'sealant-run-1' exited on its own (exitCode: 137). status: exited, exitCode: 137\nLogs:\nbye",
    });
    expect(stop).toHaveBeenCalledWith({ resourceId: "container-1", reference: "sealant-run-1" });
    expect(removeAll).toHaveBeenCalledWith("run_1");
  });

  it("removes the remains of ended executors on a full poll, never on the check of one resource", async () => {
    const harness = makeHarness({ instances: [] });
    const { adapter } = stubAdapter({});
    const reapRemains = vi.fn(async () => 2);
    const reaping: RuntimeAdapter = { ...adapter, reapRemains };

    await Effect.runPromise(
      reconcileRuntimeExitsEffect({ runtimeAdapters: [reaping] }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    expect(reapRemains).toHaveBeenCalledWith({ olderThanMs: 5 * 60_000 });

    reapRemains.mockClear();
    await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [reaping],
        resourceIds: ["container-1"],
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(reapRemains).not.toHaveBeenCalled();
  });

  it("records a runtime the daemon no longer knows as gone", async () => {
    const harness = makeHarness({ instances: [runtimeInstance()] });
    const { adapter, stop } = stubAdapter({
      inspections: new Map([["container-1", { state: "missing" }]]),
    });

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: fakeStager().stager,
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(1);
    expect(harness.markExited.mock.calls[0]?.[0]).toMatchObject({
      runId: "run_1",
      errorMessage: expect.stringMatching(/^Workspace runtime 'sealant-run-1' is gone/),
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves running instances alone and skips adapters that cannot inspect", async () => {
    const harness = makeHarness({
      instances: [
        runtimeInstance({ runId: "run_docker", resourceId: "container-1" }),
        runtimeInstance({ runId: "run_cf", adapter: "cloudflare", resourceId: "cf-1" }),
      ],
    });
    const docker = stubAdapter({
      inspections: new Map([["container-1", { state: "running" }]]),
    });
    const cloudflare = stubAdapter({ id: "cloudflare" });

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [docker.adapter, cloudflare.adapter],
        launchMaterialStager: fakeStager().stager,
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(0);
    expect(docker.inspect).toHaveBeenCalledWith({ resourceId: "container-1" });
    expect(harness.markExited).not.toHaveBeenCalled();
    expect(docker.stop).not.toHaveBeenCalled();
    expect(cloudflare.stop).not.toHaveBeenCalled();
  });

  it("touches nothing when the fenced write is refused (a stop or relaunch got there first)", async () => {
    const harness = makeHarness({
      instances: [runtimeInstance()],
      exitedRow: () => undefined,
    });
    const { adapter, stop } = stubAdapter({
      inspections: new Map([["container-1", { state: "exited", exitCode: 0, detail: "done" }]]),
    });
    const { stager, removeAll } = fakeStager();

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: stager,
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(0);
    expect(harness.markExited).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(removeAll).not.toHaveBeenCalled();
  });

  it("inspects only the named resources when an exit event narrows the sweep", async () => {
    const harness = makeHarness({
      instances: [
        // Git-sourced: this reconciler has no capture drain (a capture source is left alone).
        runtimeInstance({ runId: "run_1", resourceId: "container-1", sourceKind: "git" }),
        runtimeInstance({ runId: "run_2", resourceId: "container-2", sourceKind: "git" }),
      ],
    });
    const { adapter, inspect } = stubAdapter({
      inspections: new Map([
        ["container-1", { state: "running" }],
        ["container-2", { state: "exited", exitCode: 9, detail: "killed" }],
      ]),
    });

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        resourceIds: ["container-2"],
        launchMaterialStager: fakeStager().stager,
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(1);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith({ resourceId: "container-2" });
    expect(harness.markExited.mock.calls.map(([input]) => input.runId)).toEqual(["run_2"]);
  });

  it("keeps sweeping when one inspect fails", async () => {
    const harness = makeHarness({
      instances: [
        runtimeInstance({ runId: "run_k8s", adapter: "k8s", resourceId: "pod-1" }),
        runtimeInstance({ runId: "run_docker", adapter: "docker", resourceId: "container-1" }),
      ],
    });
    // No inspection scripted for pod-1: the stub rejects, as an unreachable apiserver would.
    const k8s = stubAdapter({ id: "k8s", inspections: new Map() });
    const docker = stubAdapter({
      inspections: new Map([["container-1", { state: "exited", exitCode: 2, detail: "x" }]]),
    });

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [k8s.adapter, docker.adapter],
        launchMaterialStager: fakeStager().stager,
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(1);
    expect(harness.markExited.mock.calls.map(([input]) => input.runId)).toEqual(["run_docker"]);
  });
});

describe("reconcileRuntimeExitsEffect · drain before removal", () => {
  const settings = {
    pollIntervalMs: 1,
    stallWindowMs: 30,
    unreachableWindowMs: 30,
    requestTimeoutMs: 1_000,
  };
  const exited = new Map<string, RuntimeAdapterInspectResult>([
    ["container-1", { state: "exited", exitCode: 1, detail: "reported dead" }],
  ]);

  it("records a capture-sourced exit whose daemon does not answer, and keeps its remains", async () => {
    // Review 2 #2: sealantd exited 75 on its own (a plain `docker stop`, its own shutdown FINAL
    // failing its uploads) before any drain reached it. The exit is recorded; nothing proves the
    // staged captures on its disk saved, so the remains are kept.
    const daemon = fakeCaptureDaemon(["unreachable"]);
    const harness = makeHarness({
      instances: [runtimeInstance()],
      captureSourced: true,
      daemon: daemon.layer,
    });
    const { adapter, stop } = stubAdapter({
      inspections: new Map([["container-1", { state: "exited", exitCode: 75 }]]),
    });
    const { stager, removeAll } = fakeStager();
    const ledger = inMemoryCaptureDrainLedger();

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: stager,
        captureDrain: { ledger, settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(1);
    expect(daemon.connect).toHaveBeenCalledTimes(1);
    expect(harness.markExited).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(removeAll).not.toHaveBeenCalled();
  });

  it("removes the remains of a capture-sourced exit the daemon confirmed saved before it ended", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    ledger.store.rows.set("run_1", {
      entry: {
        lastProgressAt: Date.now() - 1_000,
        last: captureStatus({ pending: 0, complete: true }),
        unreachableSince: undefined,
        keptLogged: false,
        silentLogged: false,
      },
      observation: { state: "saved", detail: "final flush complete" },
      owner: undefined,
      expiresAt: undefined,
    });
    const harness = makeHarness({
      instances: [runtimeInstance()],
      captureSourced: true,
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const { adapter, stop } = stubAdapter({ inspections: exited });

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: fakeStager().stager,
        captureDrain: { ledger, settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("drains a runtime reported ended whose daemon still answers, then records and removes it", async () => {
    const daemon = fakeCaptureDaemon([
      captureStatus({ pending: 2 }),
      captureStatus({ pending: 2 }),
      savedStatus({ uploadedBytes: 4 }),
    ]);
    const harness = makeHarness({
      instances: [runtimeInstance()],
      captureSourced: true,
      daemon: daemon.layer,
    });
    const { adapter, stop } = stubAdapter({ inspections: exited });

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: fakeStager().stager,
        captureDrain: { ledger: inMemoryCaptureDrainLedger(), settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(1);
    expect(daemon.calls).toEqual(["status", "flush", "status"]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("records what its probe of the daemon read as evidence about the executor (review 5 #3)", async () => {
    const probed = captureStatus({ pending: 4, complete: false, incompleteReason: "changed" });
    const harness = makeHarness({
      instances: [runtimeInstance()],
      captureSourced: true,
      daemon: fakeCaptureDaemon([probed, "unreachable"]).layer,
    });
    const { adapter, stop } = stubAdapter({ inspections: exited });
    const ledger = inMemoryCaptureDrainLedger();

    await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: fakeStager().stager,
        captureDrain: { ledger, settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(ledger.store.rows.get("run_1")?.entry.last).toEqual(probed);
    expect(stop).not.toHaveBeenCalled();
  });

  it("leaves a runtime whose daemon answers but whose queue stalled untouched", async () => {
    const harness = makeHarness({
      instances: [runtimeInstance()],
      captureSourced: true,
      daemon: fakeCaptureDaemon([captureStatus({ pending: 5 })]).layer,
    });
    const { adapter, stop } = stubAdapter({ inspections: exited });
    const { stager, removeAll } = fakeStager();

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: stager,
        captureDrain: { ledger: inMemoryCaptureDrainLedger(), settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(0);
    expect(harness.markExited).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(removeAll).not.toHaveBeenCalled();
  });

  it("drains a runtime whose source nothing records before recording its exit (fail closed)", async () => {
    // No source kind on the row and no attempt snapshot: the daemon still answers, so the runtime
    // is not dead. Unknown is treated as capture-sourced — drained, and left alone while the
    // queue cannot be confirmed saved.
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 3 })]);
    const harness = makeHarness({
      instances: [runtimeInstance()],
      snapshotMissing: true,
      daemon: daemon.layer,
    });
    const { adapter, stop } = stubAdapter({ inspections: exited });

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: fakeStager().stager,
        captureDrain: { ledger: inMemoryCaptureDrainLedger(), settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(daemon.calls[0]).toBe("status");
    expect(daemon.calls).toContain("flush");
    expect(recorded).toBe(0);
    expect(harness.markExited).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("records a planned stop's exit as stopped, never failed", async () => {
    // End to end: a lifecycle stop drained (saved), asked Docker to stop, and the exit event
    // reached the reconciler first — which recorded the planned stop `failed`.
    const ledger = inMemoryCaptureDrainLedger();
    ledger.store.rows.set("run_1", {
      entry: {
        lastProgressAt: Date.now() - 1_000,
        last: captureStatus({ pending: 0, complete: true }),
        unreachableSince: undefined,
        keptLogged: false,
        silentLogged: false,
      },
      observation: { state: "saved", detail: "final flush complete" },
      owner: undefined,
      expiresAt: undefined,
    });
    const harness = makeHarness({
      instances: [runtimeInstance({ stopReason: "user" })],
      captureSourced: true,
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const { adapter } = stubAdapter({ inspections: exited });

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: fakeStager().stager,
        captureDrain: { ledger, settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(1);
    expect(harness.markExited).not.toHaveBeenCalled();
    expect(harness.markStopped).toHaveBeenCalledWith({ runId: "run_1", stopReason: "user" });
  });

  it("records the exit but keeps the remains of an executor that ended after an unconfirmed final flush", async () => {
    // A drain reached the daemon (FINAL flush answered, not complete); the daemon then exited
    // (75) with its staging on disk. The container exited; its disk is the only copy.
    const ledger = inMemoryCaptureDrainLedger();
    ledger.store.rows.set("run_1", {
      entry: {
        lastProgressAt: Date.now() - 1_000,
        last: captureStatus({ pending: 1, complete: false, incompleteReason: "ship-failed" }),
        unreachableSince: undefined,
        keptLogged: true,
        silentLogged: false,
      },
      observation: { state: "kept", detail: "not saved · not confirmed" },
      owner: undefined,
      expiresAt: undefined,
    });
    const harness = makeHarness({
      instances: [runtimeInstance()],
      captureSourced: true,
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const { adapter, stop } = stubAdapter({ inspections: exited });
    const { stager, removeAll } = fakeStager();

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: stager,
        captureDrain: { ledger, settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(1);
    expect(harness.markExited).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(removeAll).not.toHaveBeenCalled();
  });

  it("reports a running runtime with a failed guest service and never removes it", async () => {
    const harness = makeHarness({ instances: [runtimeInstance({ adapter: "microvm" })] });
    const { adapter, stop } = stubAdapter({
      id: "microvm",
      inspections: new Map([
        [
          "container-1",
          { state: "running", detail: "Guest-local Docker failed in the MicroVM (exited)." },
        ],
      ]),
    });

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: fakeStager().stager,
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(0);
    expect(harness.markExited).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});

/** A ledger whose retention write fails (the database refused it), as the DB ledger reports. */
const failingRetention = () => {
  const ledger = inMemoryCaptureDrainLedger();
  const markRetained = vi.fn(() => Effect.succeed(false));
  return { ledger: { ...ledger, markRetained }, markRetained };
};

describe("reconcileRuntimeExitsEffect · without a capture drain (review 5 #12)", () => {
  it("leaves a capture-sourced exit untouched: an omitted option is no evidence its disk was saved", async () => {
    const harness = makeHarness({
      instances: [runtimeInstance({ sourceKind: "capture" })],
      captureSourced: true,
    });
    const { adapter, stop } = stubAdapter({
      inspections: new Map([["container-1", { state: "exited", exitCode: 75 }]]),
    });
    const { stager, removeAll } = fakeStager();

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: stager,
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(0);
    expect(harness.markExited).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(removeAll).not.toHaveBeenCalled();
  });

  it("leaves an exit whose source nothing records", async () => {
    const harness = makeHarness({ instances: [runtimeInstance()], snapshotMissing: true });
    const { adapter, stop } = stubAdapter({
      inspections: new Map([["container-1", { state: "exited", exitCode: 1 }]]),
    });
    const { stager } = fakeStager();
    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: stager,
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(recorded).toBe(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it("still records and removes a git-sourced exit", async () => {
    const harness = makeHarness({ instances: [runtimeInstance({ sourceKind: "git" })] });
    const { adapter, stop } = stubAdapter({
      inspections: new Map([["container-1", { state: "exited", exitCode: 1 }]]),
    });
    const { stager } = fakeStager();
    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: stager,
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(recorded).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileRuntimeExitsEffect · an ended executor near its deadline is reported as observed (review 5 #7)", () => {
  const settings = {
    pollIntervalMs: 1,
    stallWindowMs: 1_000,
    unreachableWindowMs: 1_000,
    requestTimeoutMs: 100,
  };
  const reconcileLogging = async (
    deadline: Date,
    inspection: RuntimeAdapterInspectResult,
  ): Promise<{ readonly lines: readonly string[]; readonly stopped: boolean }> => {
    const lines: string[] = [];
    const logger = Logger.layer([
      Logger.make(({ message }) => {
        lines.push(Array.isArray(message) ? message.map(String).join(" ") : String(message));
      }),
    ]);
    const harness = makeHarness({
      instances: [
        runtimeInstance({ adapter: "microvm", sourceKind: "capture", runtimeDeadlineAt: deadline }),
      ],
      captureSourced: true,
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const { adapter, stop } = stubAdapter({
      id: "microvm",
      inspections: new Map([["container-1", inspection]]),
    });
    await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        captureDrain: { ledger: inMemoryCaptureDrainLedger(), settings },
      }).pipe(Effect.provide(harness.layer), Effect.provide(logger)),
    );
    return { lines, stopped: stop.mock.calls.length > 0 };
  };

  it("does not claim the platform ended a VM whose daemon exited while the VM runs on", async () => {
    const { lines, stopped } = await reconcileLogging(new Date(Date.now() + 10_000), {
      state: "exited",
      exitCode: 75,
      detail: "sealantd exited 75",
      platformEnded: false,
      platformState: "RUNNING",
    });
    expect(stopped).toBe(false);
    const report = lines.find((line) => line.includes("deadline")) ?? "";
    expect(report).toContain("daemon exited with 75");
    expect(report).toContain("platform still reports the machine RUNNING · disk present");
    expect(report).toMatch(/\d+ s left/);
    expect(report).toContain("Nothing observed says the platform ended it");
    expect(
      lines.some((line) => /ended by the platform|lifetime cap|is lost|not recoverable/.test(line)),
    ).toBe(false);
  });

  it("does not claim destruction when the runtime does not say what the platform did", async () => {
    const { lines } = await reconcileLogging(new Date(Date.now() + 10_000), {
      state: "exited",
      exitCode: 75,
    });
    expect(lines.some((line) => line.includes("platform state not observed"))).toBe(true);
    expect(lines.some((line) => /ended by the platform|lifetime cap|is lost/.test(line))).toBe(
      false,
    );
  });

  it("reports the platform ending the VM at its cap only on the platform's word, past the deadline", async () => {
    const { lines } = await reconcileLogging(new Date(Date.now() - 5_000), {
      state: "exited",
      detail: "TERMINATED: maximum duration reached",
      platformEnded: true,
      platformState: "TERMINATED",
    });
    const report = lines.find((line) => line.includes("ended by the platform")) ?? "";
    expect(report).toContain("platform TERMINATED");
    expect(report).toContain("at or past its lifetime cap");
    expect(report).toMatch(/passed \d+ s ago/);
  });
});

describe("reconcileRuntimeExitsEffect · retention is recorded with the exit (review 4 #5)", () => {
  const settings = {
    pollIntervalMs: 1,
    stallWindowMs: 30,
    unreachableWindowMs: 30,
    requestTimeoutMs: 1_000,
  };

  it("leaves an exited executor `ready` when its retention cannot be recorded, so the next sweep records both", async () => {
    // Review 4 #5: the retention write failed and the reconciler committed `failed` anyway; every
    // later sweep keys on `ready`, `launch-retained` or a retention, so the disk dropped out of
    // recovery for good. The exit is not recorded unless its retention is.
    const harness = makeHarness({
      instances: [runtimeInstance()],
      captureSourced: true,
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const { adapter, stop } = stubAdapter({
      inspections: new Map([["container-1", { state: "exited", exitCode: 75 }]]),
    });
    const { ledger, markRetained } = failingRetention();

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: fakeStager().stager,
        captureDrain: { ledger, settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(markRetained).toHaveBeenCalledTimes(1);
    expect(recorded).toBe(0);
    expect(harness.markExited).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not record a planned stop's exit as stopped when its retention cannot be recorded", async () => {
    const harness = makeHarness({
      instances: [runtimeInstance({ stopReason: "user" })],
      captureSourced: true,
      daemon: fakeCaptureDaemon(["unreachable"]).layer,
    });
    const { adapter, stop } = stubAdapter({
      inspections: new Map([["container-1", { state: "exited", exitCode: 75 }]]),
    });
    const { ledger } = failingRetention();

    const recorded = await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: fakeStager().stager,
        captureDrain: { ledger, settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(recorded).toBe(0);
    expect(harness.markStopped).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("records every ended capture executor nothing settled: retained when its disk remains or it runs, gone when nothing is left", async () => {
    // Whatever brought a row to `failed`/`stopped` without a retention (a retention write that
    // failed before this fix, a row from before retention existed), the sweep looks again.
    const harness = makeHarness({
      instances: [],
      // Rows from before the source kind was recorded: their snapshots name a capture source.
      captureSourced: true,
      unsettled: [
        runtimeInstance({ runId: "run_exited", resourceId: "c-exited", status: "failed" }),
        runtimeInstance({ runId: "run_running", resourceId: "c-running", status: "stopped" }),
        runtimeInstance({ runId: "run_gone", resourceId: "c-gone", status: "failed" }),
      ],
    });
    const { adapter, stop } = stubAdapter({
      inspections: new Map<string, RuntimeAdapterInspectResult>([
        ["c-exited", { state: "exited", exitCode: 75 }],
        ["c-running", { state: "running" }],
        ["c-gone", { state: "missing" }],
      ]),
    });
    const ledger = inMemoryCaptureDrainLedger();
    // The running one carries an old attestation: recorded evidence never lets a RUNNING
    // executor go; only a drain can.
    ledger.store.rows.set("run_running", {
      entry: {
        lastProgressAt: undefined,
        last: undefined,
        unreachableSince: undefined,
        keptLogged: false,
        silentLogged: false,
        completionAttested: {
          executorId: "c-running",
          epoch: 1,
          captureN: 4,
          atMs: 0,
          by: "user_1",
        },
      },
      observation: undefined,
      owner: undefined,
      expiresAt: undefined,
    });

    await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: fakeStager().stager,
        captureDrain: { ledger, settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(ledger.store.rows.get("run_exited")?.entry.retained).toBeDefined();
    expect(ledger.store.rows.get("run_running")?.entry.retained).toBeDefined();
    expect(ledger.store.rows.get("run_gone")?.observation?.state).toBe("gone");
    expect(stop).not.toHaveBeenCalled();
  });

  it("leaves an ended executor whose snapshot names no capture source alone", async () => {
    const harness = makeHarness({
      instances: [],
      unsettled: [runtimeInstance({ runId: "run_git", resourceId: "c-git", status: "failed" })],
    });
    const { adapter, inspect } = stubAdapter({
      inspections: new Map<string, RuntimeAdapterInspectResult>([
        ["c-git", { state: "exited", exitCode: 0 }],
      ]),
    });
    const ledger = inMemoryCaptureDrainLedger();

    await Effect.runPromise(
      reconcileRuntimeExitsEffect({
        runtimeAdapters: [adapter],
        launchMaterialStager: fakeStager().stager,
        captureDrain: { ledger, settings },
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(inspect).not.toHaveBeenCalled();
    expect(ledger.store.rows.get("run_git")).toBeUndefined();
  });
});

describe("watchRuntimeExits", () => {
  afterEach(() => {
    vi.useRealTimers();
    liveRepo.current = undefined;
  });

  it("reconciles the resource an exit event names after the grace window, and closes every watch", async () => {
    vi.useFakeTimers();
    const harness = makeHarness({
      instances: [
        // Git-sourced: this reconciler has no capture drain (a capture source is left alone).
        runtimeInstance({ runId: "run_1", resourceId: "container-1", sourceKind: "git" }),
        runtimeInstance({ runId: "run_2", resourceId: "container-2", sourceKind: "git" }),
      ],
    });
    liveRepo.current = harness.repo;
    let handlers: RuntimeAdapterExitWatchInput | undefined;
    const { adapter, inspect, close } = stubAdapter({
      inspections: new Map([
        ["container-1", { state: "exited", exitCode: 137, detail: "killed" }],
        ["container-2", { state: "exited", exitCode: 137, detail: "killed" }],
      ]),
      watch: (h) => {
        handlers = h;
      },
    });
    const noInspect = stubAdapter({ id: "cloudflare" });

    const watch = watchRuntimeExits({
      db: {} as never,
      runtimeAdapters: [adapter, noInspect.adapter],
      launchMaterialStager: fakeStager().stager,
      exitGraceMs: 2_000,
    });

    expect(handlers).toBeDefined();
    // The worker's watch is process-wide: no id list, the sweep filters to rows it owns.
    expect(handlers?.resourceIds).toBeUndefined();
    handlers?.onExit({ resourceId: "container-1", result: { state: "exited", exitCode: 137 } });
    expect(inspect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(inspect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith({ resourceId: "container-1" });
    expect(harness.markExited.mock.calls.map(([input]) => input.runId)).toEqual(["run_1"]);

    watch.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("runs the Promise entry against the live repo layer", async () => {
    const harness = makeHarness({ instances: [runtimeInstance({ sourceKind: "git" })] });
    liveRepo.current = harness.repo;
    const { adapter } = stubAdapter({
      inspections: new Map([["container-1", { state: "missing" }]]),
    });

    const recorded = await reconcileRuntimeExits({
      db: {} as never,
      runtimeAdapters: [adapter],
      launchMaterialStager: fakeStager().stager,
    });

    expect(recorded).toBe(1);
  });
});
