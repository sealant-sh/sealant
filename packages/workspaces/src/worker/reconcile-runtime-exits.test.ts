/**
 * Unit tests for the runtime exit reconciler. The properties that matter: an exited or vanished
 * runtime is recorded through the fenced `markExited` write with the exit code in the message,
 * its remains are removed and its staged launch material dropped; a fenced-out write (a stop got
 * there first, or a relaunch replaced the resource) touches nothing; adapters without `inspect`
 * and running instances are left alone; an exit event reconciles only the named resource, and
 * only after the grace window.
 */
import {
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LaunchMaterialStager } from "../runtime/launch-material.js";
import type {
  RuntimeAdapter,
  RuntimeAdapterInspection,
  RuntimeExitHandlers,
} from "../runtime/runtime-adapter.js";
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
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  ...overrides,
});

interface Harness {
  readonly repo: WorkspaceRuntimeInstanceRepoService;
  readonly markExited: ReturnType<typeof vi.fn>;
  readonly layer: Layer.Layer<WorkspaceRuntimeInstanceRepo>;
}

const makeHarness = (input: {
  readonly instances: readonly WorkspaceRuntimeInstance[];
  /** What `markExited` answers; default = the updated row (the fence let the write through). */
  readonly exitedRow?: (runId: string) => WorkspaceRuntimeInstance | undefined;
}): Harness => {
  const markExited = vi.fn((request: { runId: string; resourceId: string; errorMessage: string }) =>
    Effect.succeed(
      input.exitedRow === undefined
        ? runtimeInstance({ runId: request.runId, status: "failed" })
        : input.exitedRow(request.runId),
    ),
  );
  const repo: WorkspaceRuntimeInstanceRepoService = {
    upsertRuntimeInstance: () => Effect.die("unused"),
    markExited,
    markStopped: () => Effect.die("unused"),
    getRuntimeInstanceByRunId: () => Effect.die("unused"),
    listRuntimeInstancesByRunIds: () => Effect.die("unused"),
    listRunningInstances: () => Effect.succeed(input.instances),
  };
  return { repo, markExited, layer: Layer.succeed(WorkspaceRuntimeInstanceRepo, repo) };
};

const stubAdapter = (input: {
  readonly id?: RuntimeAdapter["id"];
  readonly inspections?: ReadonlyMap<string, RuntimeAdapterInspection>;
  readonly watch?: (handlers: RuntimeExitHandlers) => void;
}) => {
  const inspect = vi.fn(async (resourceIds: readonly string[]) => {
    const out = new Map<string, RuntimeAdapterInspection>();
    for (const id of resourceIds) {
      const inspection = input.inspections?.get(id);
      if (inspection !== undefined) out.set(id, inspection);
    }
    return out;
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
          watchExits: (handlers: RuntimeExitHandlers) => {
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
    expect(docker.inspect).toHaveBeenCalledWith(["container-1"]);
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
        runtimeInstance({ runId: "run_1", resourceId: "container-1" }),
        runtimeInstance({ runId: "run_2", resourceId: "container-2" }),
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
    expect(inspect).toHaveBeenCalledWith(["container-2"]);
    expect(harness.markExited.mock.calls.map(([input]) => input.runId)).toEqual(["run_2"]);
  });

  it("keeps sweeping when one adapter's inspect fails", async () => {
    const harness = makeHarness({
      instances: [
        runtimeInstance({ runId: "run_k8s", adapter: "k8s", resourceId: "pod-1" }),
        runtimeInstance({ runId: "run_docker", adapter: "docker", resourceId: "container-1" }),
      ],
    });
    const k8s = stubAdapter({ id: "k8s", inspections: new Map() });
    k8s.inspect.mockRejectedValueOnce(new Error("apiserver unavailable"));
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

describe("watchRuntimeExits", () => {
  afterEach(() => {
    vi.useRealTimers();
    liveRepo.current = undefined;
  });

  it("reconciles the resource an exit event names after the grace window, and closes every watch", async () => {
    vi.useFakeTimers();
    const harness = makeHarness({
      instances: [
        runtimeInstance({ runId: "run_1", resourceId: "container-1" }),
        runtimeInstance({ runId: "run_2", resourceId: "container-2" }),
      ],
    });
    liveRepo.current = harness.repo;
    let handlers: RuntimeExitHandlers | undefined;
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
    handlers?.onExit({ resourceId: "container-1", exitCode: 137 });
    expect(inspect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(inspect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(inspect).toHaveBeenCalledWith(["container-1"]);
    expect(harness.markExited.mock.calls.map(([input]) => input.runId)).toEqual(["run_1"]);

    watch.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("runs the Promise entry against the live repo layer", async () => {
    const harness = makeHarness({ instances: [runtimeInstance()] });
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
