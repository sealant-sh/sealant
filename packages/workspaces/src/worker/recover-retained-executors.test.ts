/**
 * Recovery of retained executors (review 2, decision 3): a capture executor kept because its disk
 * holds unsaved work is brought back on its own disk where the runtime can (Docker), drained with
 * a FINAL flush and only then removed; where it cannot (Kubernetes, MicroVM) it is reported and
 * stays retained; evidence that arrived since (an attestation) releases it without recovery.
 */
import {
  WorkspaceCaptureDrainRepo,
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceCaptureDrain,
  type WorkspaceCaptureDrainRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeAdapter,
  RuntimeAdapterInspectResult,
  RuntimeAdapterRecoverResult,
} from "../runtime/runtime-adapter.js";
import type { SealantTargetDerivationOptions } from "../sealantd/target.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { EMPTY_CAPTURE_DRAIN_ENTRY, inMemoryCaptureDrainLedger } from "./capture-drain.js";
import {
  nextRecoveryDelayMs,
  recoverRetainedExecutorsEffect,
} from "./recover-retained-executors.js";

const NOW = Date.parse("2026-09-28T00:00:00.000Z");

const instance = (overrides: Partial<WorkspaceRuntimeInstance> = {}): WorkspaceRuntimeInstance => ({
  runId: "run_1",
  status: "failed",
  adapter: "docker",
  resourceId: "container-1",
  reference: "sealant-run-1",
  // `docker-exec://` needs no client TLS: the drain can reach it.
  endpoint: "docker-exec://container-1/run/sealant/control.sock",
  errorCode: "runtime-exited",
  errorMessage: "exited 75",
  stopReason: null,
  launchCredentialInjections: null,
  launchedAt: new Date(NOW - 60_000),
  finishedAt: null,
  runtimeDeadlineAt: null,
  launchOwner: null,
  launchLeaseExpiresAt: null,
  daemonImage: "ghcr.io/sealant-sh/sealantd:0.19.0",
  daemonRecoveryBoot: true,
  sourceKind: "capture",
  createdAt: new Date(NOW - 60_000),
  updatedAt: new Date(NOW - 60_000),
  ...overrides,
});

const harness = (input: {
  readonly adapterId?: RuntimeAdapter["id"];
  readonly inspect: RuntimeAdapterInspectResult;
  readonly recover?: () => Promise<RuntimeAdapterRecoverResult>;
  readonly daemon?: ReturnType<typeof fakeCaptureDaemon>;
  readonly attempts?: number;
  /** The sealed capture token kept at launch; `null` = none was kept. Default: one was. */
  readonly captureTokenSealed?: string | null;
  /** What the launch recorded of the executor (its daemon build). */
  readonly instance?: Partial<WorkspaceRuntimeInstance>;
  readonly targetOptions?: SealantTargetDerivationOptions;
}) => {
  const order: string[] = [];
  const ledger = inMemoryCaptureDrainLedger({ now: () => NOW });
  Effect.runSync(ledger.markRetained("run_1", "executor exited · exit 75"));
  const attempts: Array<{ runId: string; error: string | null; nextRecoveryAt: Date }> = [];
  const row = {
    runId: "run_1",
    retainedAt: new Date(NOW - 1_000),
    recoveryAttempts: input.attempts ?? 0,
    captureTokenSealed:
      input.captureTokenSealed === undefined ? "sealed:token" : input.captureTokenSealed,
  } as WorkspaceCaptureDrain;
  const drains = {
    listRetainedDue: () => Effect.succeed([row]),
    recordRecoveryAttempt: (request: {
      runId: string;
      error: string | null;
      nextRecoveryAt: Date;
    }) =>
      Effect.sync(() => {
        attempts.push(request);
      }),
  } as unknown as WorkspaceCaptureDrainRepoService;
  const markStopped = vi.fn((request: { runId: string; stopReason: string }) =>
    Effect.succeed(instance({ runId: request.runId, status: "stopped" })),
  );
  const instances = {
    getRuntimeInstanceByRunId: () =>
      Effect.succeed(instance({ adapter: input.adapterId ?? "docker", ...input.instance })),
    markStopped,
  } as unknown as WorkspaceRuntimeInstanceRepoService;
  const stop = vi.fn(async (request: { resourceId: string }) => ({
    adapter: input.adapterId ?? ("docker" as const),
    resourceId: request.resourceId,
    outcome: "stopped" as const,
  }));
  const parkRetained = vi.fn(async () => {
    order.push("park");
    return { stopped: ["sealant-run-1-docker"] };
  });
  const recover = vi.fn(async () => {
    order.push("recover");
    return (input.recover ?? (async () => ({ outcome: "restarted" as const })))();
  });
  const staged: Array<{ runId: string; secretEnv: Readonly<Record<string, string>> }> = [];
  const stager = {
    stage: () => Promise.reject(new Error("unused")),
    removeSecretEnv: vi.fn(async () => {
      order.push("remove-secret-env");
    }),
    removeAll: async () => undefined,
    restageSecretEnv: vi.fn(async (runId: string, secretEnv: Readonly<Record<string, string>>) => {
      order.push("restage");
      staged.push({ runId, secretEnv });
    }),
  };
  const credentialCipher = {
    encrypt: () => Effect.die("unused"),
    decrypt: (sealed: string) =>
      sealed === "sealed:token"
        ? Effect.succeed(JSON.stringify({ SEALANT_CAPTURE_TOKEN: "mend-capture-token" }))
        : Effect.die("cannot unseal"),
  };
  const adapter: RuntimeAdapter = {
    id: input.adapterId ?? "docker",
    supports: () => ({ supported: true }),
    launch: async () => {
      throw new Error("unused");
    },
    stop,
    inspect: async () => input.inspect,
    recover,
    parkRetained,
  };
  const daemon = input.daemon ?? fakeCaptureDaemon(["unreachable"]);
  const run = () =>
    Effect.runPromise(
      recoverRetainedExecutorsEffect({
        runtimeAdapters: [adapter],
        captureDrain: {
          ledger,
          settings: {
            pollIntervalMs: 1,
            stallWindowMs: 1_000,
            unreachableWindowMs: 1_000,
            requestTimeoutMs: 1_000,
          },
          budgetMs: 200,
        },
        backoff: { baseMs: 60_000, maxMs: 3_600_000 },
        now: () => NOW,
        credentialCipher,
        launchMaterialStager: stager,
        ...(input.targetOptions === undefined ? {} : { targetOptions: input.targetOptions }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(WorkspaceCaptureDrainRepo, drains),
            Layer.succeed(WorkspaceRuntimeInstanceRepo, instances),
            daemon.layer,
          ),
        ),
      ),
    );
  return {
    run,
    ledger,
    attempts,
    stop,
    recover,
    parkRetained,
    markStopped,
    daemon,
    staged,
    order,
  };
};

describe("recoverRetainedExecutorsEffect", () => {
  it("restarts a retained Docker executor on its own disk, drains it with FINAL, then removes it", async () => {
    const daemon = fakeCaptureDaemon([
      captureStatus({ pending: 3, uploadedBytes: 1 }),
      savedStatus(),
    ]);
    const h = harness({ inspect: { state: "exited", exitCode: 75 }, daemon });

    const outcomes = await h.run();

    expect(outcomes.get("run_1")).toBe("released");
    expect(h.recover).toHaveBeenCalledWith({
      resourceId: "container-1",
      reference: "sealant-run-1",
    });
    expect(daemon.flushRequests).toContainEqual(expect.objectContaining({ kind: "final" }));
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.markStopped).toHaveBeenCalledWith({ runId: "run_1", stopReason: "failed" });
    expect(h.ledger.store.rows.get("run_1")?.entry.retained).toBeUndefined();
    expect(h.ledger.store.rows.get("run_1")?.observation).toMatchObject({
      state: "stopped",
      detail: expect.stringContaining("final flush complete"),
    });
  });

  it("stops what runs beside an ended retained executor before anything else (e2e 5)", async () => {
    // e2e 5: a kept executor's Docker sidecar was still up 28 minutes later.
    const h = harness({
      inspect: { state: "exited", exitCode: 75 },
      recover: async () => ({ outcome: "unsupported", detail: "cannot restart" }),
    });

    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.parkRetained).toHaveBeenCalledWith({
      resourceId: "container-1",
      reference: "sealant-run-1",
    });
    expect(h.order[0]).toBe("park");
    // Its disk is kept: nothing removed it.
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("parks nothing beside an executor that is still running", async () => {
    const h = harness({
      inspect: { state: "running" },
      daemon: fakeCaptureDaemon([savedStatus()]),
    });
    await h.run();
    expect(h.parkRetained).not.toHaveBeenCalled();
  });

  it("stages the launch's capture token again before the restart, and removes it after", async () => {
    const h = harness({
      inspect: { state: "exited", exitCode: 75 },
      daemon: fakeCaptureDaemon([savedStatus()]),
    });
    expect((await h.run()).get("run_1")).toBe("released");
    expect(h.staged).toEqual([
      { runId: "run_1", secretEnv: { SEALANT_CAPTURE_TOKEN: "mend-capture-token" } },
    ]);
    expect(h.order).toEqual(["park", "restage", "recover", "remove-secret-env"]);
  });

  it("never starts an executor whose capture token was not kept: not recoverable · no capture token", async () => {
    // A restart boots with the environment it was created with; the token's file was removed
    // once it was ready. A boot without the token would exit, not save: it is not started.
    const h = harness({ inspect: { state: "exited", exitCode: 75 }, captureTokenSealed: null });
    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.attempts[0]?.error).toMatch(/^not recoverable · no capture token/);
  });

  it("never starts an executor whose kept capture token cannot be unsealed", async () => {
    const h = harness({
      inspect: { state: "exited", exitCode: 75 },
      captureTokenSealed: "sealed:under-another-key",
    });
    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.attempts[0]?.error).toContain("cannot be unsealed");
  });

  it("keeps a recovered executor whose final flush is still shipping and comes back soon", async () => {
    let uploaded = 0;
    const daemon = fakeCaptureDaemon(
      Array.from({ length: 400 }, () => {
        uploaded += 1;
        return captureStatus({ pending: 2, uploadedBytes: uploaded });
      }),
    );
    const h = harness({ inspect: { state: "exited", exitCode: 75 }, daemon, attempts: 4 });

    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.stop).not.toHaveBeenCalled();
    // Moving: the next attempt follows the base delay, not the long backoff.
    expect(h.attempts[0]?.nextRecoveryAt.getTime()).toBe(NOW + 60_000);
  });

  it("reports a Pod it cannot restart, keeps it, and backs off", async () => {
    const h = harness({
      adapterId: "k8s",
      inspect: { state: "exited", exitCode: 75 },
      recover: async () => ({ outcome: "unsupported", detail: "a Pod cannot be restarted" }),
      attempts: 2,
    });

    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.attempts).toEqual([
      {
        runId: "run_1",
        error: "a Pod cannot be restarted",
        nextRecoveryAt: new Date(
          NOW + nextRecoveryDelayMs(2, { baseMs: 60_000, maxMs: 3_600_000 }),
        ),
      },
    ]);
    expect(h.ledger.store.rows.get("run_1")?.entry.retained).toBeDefined();
  });

  it("keeps an executor whose restart failed, and backs off", async () => {
    const h = harness({
      inspect: { state: "exited", exitCode: 75 },
      recover: () => Promise.reject(new Error("docker start: no space left on device")),
    });

    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.attempts[0]?.error).toContain("no space left on device");
  });

  it("releases a retained executor the control plane attested complete, without restarting it", async () => {
    const h = harness({ inspect: { state: "exited", exitCode: 75 } });
    const row = h.ledger.store.rows.get("run_1");
    if (row === undefined) throw new Error("no row");
    row.entry = {
      ...row.entry,
      completionAttested: {
        executorId: "container-1",
        epoch: 2,
        captureN: 17,
        atMs: NOW,
        by: "user_1",
      },
    };

    expect((await h.run()).get("run_1")).toBe("released");
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it("does not release on an attestation about another executor", async () => {
    const h = harness({
      inspect: { state: "exited", exitCode: 75 },
      recover: async () => ({ outcome: "unsupported", detail: "test" }),
    });
    const row = h.ledger.store.rows.get("run_1");
    if (row === undefined) throw new Error("no row");
    row.entry = {
      ...EMPTY_CAPTURE_DRAIN_ENTRY,
      retained: row.entry.retained,
      completionAttested: {
        executorId: "container-OTHER",
        epoch: 2,
        captureN: 17,
        atMs: NOW,
        by: "user_1",
      },
    };

    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("never removes a RUNNING retained executor on recorded evidence: it drains it first (review 4 #1)", async () => {
    // A seal of capture 41 is on record; Core's newer observation says the FINAL failed to
    // snapshot. The executor still runs: the stale seal must not delete it without a drain.
    const failed = captureStatus({
      epoch: 3,
      headN: 41,
      complete: false,
      incompleteReason: "snapshot-failed",
      unreadable: 1,
    });
    const h = harness({
      inspect: { state: "running" },
      recover: async () => ({ outcome: "running" }),
      daemon: fakeCaptureDaemon([failed]),
    });
    const row = h.ledger.store.rows.get("run_1");
    if (row === undefined) throw new Error("no row");
    row.entry = {
      ...row.entry,
      last: failed,
      lastAtMs: NOW,
      completionAttested: {
        executorId: "container-1",
        epoch: 3,
        captureN: 41,
        sealedAtMs: NOW - 3_600_000,
        atMs: NOW,
        by: "user_1",
      },
    };

    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.daemon.connect).toHaveBeenCalled();
    expect(h.daemon.flushRequests[0]).toMatchObject({ kind: "final" });
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("removes a running retained executor once a drain of it reads the final flush complete", async () => {
    const h = harness({
      inspect: { state: "running" },
      recover: async () => ({ outcome: "running" }),
      daemon: fakeCaptureDaemon([savedStatus({ epoch: 3, headN: 42 })]),
    });
    const row = h.ledger.store.rows.get("run_1");
    if (row === undefined) throw new Error("no row");
    // Even an attestation that would cover it is not what lets a running executor go.
    row.entry = {
      ...row.entry,
      completionAttested: {
        executorId: "container-1",
        epoch: 3,
        captureN: 41,
        atMs: NOW,
        by: "user_1",
      },
    };

    expect((await h.run()).get("run_1")).toBe("released");
    expect(h.daemon.flushRequests[0]).toMatchObject({ kind: "final" });
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it("says loudly when a retained executor is gone, and ends the retention", async () => {
    const h = harness({ inspect: { state: "missing" } });

    expect((await h.run()).get("run_1")).toBe("lost");
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.ledger.store.rows.get("run_1")?.observation?.state).toBe("gone");
    expect(h.ledger.store.rows.get("run_1")?.entry.retained).toBeUndefined();
  });
});

describe("nextRecoveryDelayMs", () => {
  it("doubles from the base and stops at the maximum", () => {
    const backoff = { baseMs: 60_000, maxMs: 3_600_000 };
    expect(nextRecoveryDelayMs(0, backoff)).toBe(60_000);
    expect(nextRecoveryDelayMs(3, backoff)).toBe(480_000);
    expect(nextRecoveryDelayMs(50, backoff)).toBe(3_600_000);
  });
});

describe("recoverRetainedExecutorsEffect · a daemon without the recovery boot (review 3 #8)", () => {
  it.each([
    {
      name: "predates it",
      recorded: { daemonImage: "ghcr.io/sealant-sh/sealantd:0.18.2", daemonRecoveryBoot: false },
      reason: "predates sealantd's recovery boot",
    },
    {
      name: "is of an unknown build",
      recorded: { daemonImage: null, daemonRecoveryBoot: null },
      reason: "Core cannot tell whether its daemon",
    },
  ])("keeps an ended executor whose daemon $name, and never starts it", async (scenario) => {
    // Review 3 #8: recovery copied the marker in and ran `docker start` whatever the image; a
    // daemon without the recovery boot ran its ordinary boot over the unsaved work.
    const h = harness({ inspect: { state: "exited", exitCode: 75 }, instance: scenario.recorded });

    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.staged).toEqual([]);
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.attempts).toEqual([
      expect.objectContaining({
        runId: "run_1",
        error: expect.stringContaining(scenario.reason),
      }),
    ]);
  });

  it("still drains a daemon that runs, whatever its build (nothing is restarted)", async () => {
    const h = harness({
      inspect: { state: "running" },
      recover: async () => ({ outcome: "running" }),
      daemon: fakeCaptureDaemon([savedStatus()]),
      instance: { daemonImage: null, daemonRecoveryBoot: null },
    });
    expect((await h.run()).get("run_1")).toBe("released");
  });
});

describe("recoverRetainedExecutorsEffect · a MicroVM whose daemon exited on a live VM (review 3 #7)", () => {
  it("hands the agent the kept capture token, restarts the daemon on its disk and drains it", async () => {
    // Review 3 #7: MicroVM recovery was `unsupported`, so the retained VM waited out its cap.
    const daemon = fakeCaptureDaemon([savedStatus()]);
    const h = harness({
      adapterId: "microvm",
      inspect: { state: "exited", exitCode: 75 },
      daemon,
      instance: { endpoint: "wss://abc.lambda-microvm.eu-central-1.on.aws/sealant/control" },
      targetOptions: {
        controlBearerToken: "control-token",
        microvmConnectMaterial: () => async () => ({}),
      },
    });

    expect((await h.run()).get("run_1")).toBe("released");
    expect(h.recover).toHaveBeenCalledWith({
      resourceId: "container-1",
      reference: "sealant-run-1",
      runId: "run_1",
      secretEnv: { SEALANT_CAPTURE_TOKEN: "mend-capture-token" },
    });
    // Nothing is staged on the worker's host for a VM: the token went with the request.
    expect(h.staged).toEqual([]);
    expect(daemon.flushRequests).toContainEqual(expect.objectContaining({ kind: "final" }));
  });

  it("keeps a VM whose daemon lacks the recovery boot, and never asks its agent", async () => {
    const h = harness({
      adapterId: "microvm",
      inspect: { state: "exited", exitCode: 75 },
      instance: { daemonImage: "ghcr.io/sealant-sh/sealantd:0.18.2", daemonRecoveryBoot: false },
    });
    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.recover).not.toHaveBeenCalled();
  });
});
