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

  // Review 6 #3: the release is decided on the evidence as it stands after the parking, not on
  // what was read before it: a failure recorded meanwhile revokes the attestation.
  it("does not release on an attestation revoked while what runs beside it was parked", async () => {
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
    h.parkRetained.mockImplementation(async () => {
      await Effect.runPromise(
        h.ledger.recordStatus(
          "run_1",
          captureStatus({
            epoch: 2,
            headN: 17,
            complete: false,
            incompleteReason: "snapshot-failed",
          }),
          NOW,
        ),
      );
      return { stopped: [] };
    });

    expect((await h.run()).get("run_1")).not.toBe("released");
    expect(h.stop).not.toHaveBeenCalled();
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

  it("removes an executor whose recovery boot found nothing to save, and records why (e2e 6)", async () => {
    // e2e 6: an executor that died at its first plan request never materialized; every recovery
    // boot refused it ("not this executor's continuation", exit 75) and it was kept forever.
    // sealantd now says so (exit 76): nothing ran on it, so nothing is lost by removing it.
    const said = "sealantd boot: nothing to save: never materialized (/workspace/repo)";
    const h = harness({
      inspect: { state: "exited", exitCode: 1 },
      recover: async () => ({ outcome: "nothing-to-save", detail: said }),
    });
    expect((await h.run()).get("run_1")).toBe("released");
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.ledger.store.rows.get("run_1")?.observation).toEqual({
      state: "stopped",
      detail: expect.stringContaining(said),
    });
    expect(h.ledger.store.rows.get("run_1")?.observation?.detail).toContain(
      "never materialized a capture, so no user code ran on it",
    );
    expect(h.ledger.store.rows.get("run_1")?.entry.retained).toBeUndefined();
  });

  it("keeps an executor whose recovery boot exits 75: not saved", async () => {
    const h = harness({
      inspect: { state: "exited", exitCode: 75 },
      recover: async () => {
        throw new Error(
          "Workspace container 'sealant-run-1' exited during boot before its control socket was ready (status: exited, exitCode: 75).",
        );
      },
    });
    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("says loudly when a retained executor is gone, and ends the retention", async () => {
    const h = harness({ inspect: { state: "missing" } });

    expect((await h.run()).get("run_1")).toBe("lost");
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.ledger.store.rows.get("run_1")?.observation?.state).toBe("gone");
    expect(h.ledger.store.rows.get("run_1")?.entry.retained).toBeUndefined();
  });
});

// Review 7 #5 (decision 21): recovery admission honours a removal another path holds or made.
describe("recoverRetainedExecutorsEffect · an executor whose removal is held (review 7 #5)", () => {
  it("never starts an executor whose removal another path holds, and comes back soon", async () => {
    const h = harness({ inspect: { state: "exited", exitCode: 75 } });
    const row = h.ledger.store.rows.get("run_1");
    if (row === undefined) throw new Error("no row");
    row.deletion = {
      state: "deleting",
      token: "another-deleter",
      evidenceVersion: row.entry.evidenceVersion ?? 0,
      expiresAtMs: NOW + 60_000,
    };

    expect((await h.run()).get("run_1")).toBe("retained");
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.attempts.at(-1)).toMatchObject({
      error: "another path is removing the executor right now",
      nextRecoveryAt: new Date(NOW + 60_000),
    });
  });

  it("never starts an executor another path removed, and ends its retention", async () => {
    const h = harness({ inspect: { state: "exited", exitCode: 75 } });
    const row = h.ledger.store.rows.get("run_1");
    if (row === undefined) throw new Error("no row");
    row.deletion = {
      state: "deleted",
      token: "another-deleter",
      evidenceVersion: row.entry.evidenceVersion ?? 0,
      expiresAtMs: Number.POSITIVE_INFINITY,
    };

    expect((await h.run()).get("run_1")).toBe("released");
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.ledger.store.rows.get("run_1")?.entry.retained).toBeUndefined();
  });

  it("starts an executor whose removal's hold lapsed (its deleter died), voiding it", async () => {
    const h = harness({
      inspect: { state: "exited", exitCode: 75 },
      recover: async () => ({ outcome: "unsupported", detail: "cannot restart" }),
    });
    const row = h.ledger.store.rows.get("run_1");
    if (row === undefined) throw new Error("no row");
    row.deletion = {
      state: "deleting",
      token: "a-dead-deleter",
      evidenceVersion: row.entry.evidenceVersion ?? 0,
      expiresAtMs: NOW - 1,
    };

    await h.run();
    expect(h.recover).toHaveBeenCalledOnce();
    expect(h.ledger.store.rows.get("run_1")?.deletion).toBeUndefined();
  });

  it("removes a released executor under its own ticket and records it deleted", async () => {
    const h = harness({ inspect: { state: "exited", exitCode: 75 } });
    const row = h.ledger.store.rows.get("run_1");
    if (row === undefined) throw new Error("no row");
    row.entry = {
      ...row.entry,
      completionAttested: { executorId: "container-1", epoch: 2, captureN: 17, atMs: NOW, by: "u" },
    };

    expect((await h.run()).get("run_1")).toBe("released");
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.ledger.store.rows.get("run_1")?.deletion?.state).toBe("deleted");
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

// Review 9 #8: retained recovery was serial, ordered by backoff, and unbounded per operation. An
// older executor's recovery RPC that took 120 s kept a MicroVM with 60 s left from ever being asked
// before the platform ended it.
describe("recovery attempts are independent, bounded and ordered by deadline (review 9 #8)", () => {
  const settings = {
    pollIntervalMs: 1_000,
    stallWindowMs: 60_000,
    unreachableWindowMs: 60_000,
    requestTimeoutMs: 60_000,
  };
  const cipher = {
    encrypt: () => Effect.die("unused"),
    decrypt: () => Effect.succeed(JSON.stringify({ SEALANT_CAPTURE_TOKEN: "token" })),
  };
  const retainedRows = (ledger: ReturnType<typeof inMemoryCaptureDrainLedger>, ids: string[]) =>
    ids.map((runId) => {
      Effect.runSync(ledger.markRetained(runId, "exit 75"));
      return {
        runId,
        retainedAt: new Date(NOW - 1_000),
        recoveryAttempts: 0,
        captureTokenSealed: "sealed",
      } as WorkspaceCaptureDrain;
    });
  const layerFor = (rows: readonly WorkspaceCaptureDrain[], deadlines: Record<string, number>) => {
    const attempts: Array<{ runId: string; error: string | null }> = [];
    const layer = Layer.mergeAll(
      Layer.succeed(WorkspaceCaptureDrainRepo, {
        listRetainedDue: () => Effect.succeed(rows),
        recordRecoveryAttempt: (request: { runId: string; error: string | null }) =>
          Effect.sync(() => {
            attempts.push({ runId: request.runId, error: request.error });
          }),
      } as unknown as WorkspaceCaptureDrainRepoService),
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        getRuntimeInstanceByRunId: (runId: string) =>
          Effect.succeed(
            instance({
              runId,
              resourceId: runId,
              adapter: "microvm",
              runtimeDeadlineAt: new Date(NOW + (deadlines[runId] ?? 3_600_000)),
            }),
          ),
        markStopped: () => Effect.void,
      } as unknown as WorkspaceRuntimeInstanceRepoService),
      fakeCaptureDaemon([savedStatus()]).layer,
    );
    return { layer, attempts };
  };

  it("asks a capped VM to recover at once, though an older executor's recovery stalls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const ledger = inMemoryCaptureDrainLedger();
      const asked: Array<{ id: string; at: number }> = [];
      // Listed most overdue first, as the backoff orders them: the older one ahead.
      const rows = retainedRows(ledger, ["older", "urgent"]);
      const adapter: RuntimeAdapter = {
        id: "microvm",
        supports: () => ({ supported: true }),
        launch: async () => {
          throw new Error("unused");
        },
        stop: async () => {
          throw new Error("never saved");
        },
        inspect: async ({ resourceId }) =>
          resourceId === "urgent" && Date.now() >= NOW + 60_000
            ? { state: "missing" }
            : { state: "exited", exitCode: 75 },
        recover: async ({ resourceId }) => {
          asked.push({ id: resourceId, at: Date.now() - NOW });
          if (resourceId === "older") {
            await new Promise((resolve) => setTimeout(resolve, 120_000));
          }
          return { outcome: "unsupported", detail: "delayed agent refusal" };
        },
      };
      const { layer } = layerFor(rows, { older: 3_600_000, urgent: 60_000 });
      let result: ReadonlyMap<string, string> | undefined;
      const promise = Effect.runPromise(
        recoverRetainedExecutorsEffect({
          runtimeAdapters: [adapter],
          captureDrain: { ledger, settings },
          credentialCipher: cipher,
          now: Date.now,
        }).pipe(Effect.provide(layer)),
      ).then((outcomes) => {
        result = outcomes;
        return outcomes;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      // The capped VM is asked first and at once; the older one alongside it.
      expect(asked.map((entry) => entry.id)).toEqual(["urgent", "older"]);
      expect(asked.every((entry) => entry.at < 1_000)).toBe(true);
      await vi.advanceTimersByTimeAsync(121_000);
      await promise;
      expect(result?.get("urgent")).toBe("retained");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a runtime's recovery request: a stalled one fails its attempt, never the sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const ledger = inMemoryCaptureDrainLedger();
      const rows = retainedRows(ledger, ["stalled"]);
      const adapter: RuntimeAdapter = {
        id: "microvm",
        supports: () => ({ supported: true }),
        launch: async () => {
          throw new Error("unused");
        },
        stop: async () => {
          throw new Error("never saved");
        },
        inspect: async () => ({ state: "exited", exitCode: 75 }),
        // The agent never answers.
        recover: () => new Promise(() => undefined),
      };
      const { layer, attempts } = layerFor(rows, {});
      let result: ReadonlyMap<string, string> | undefined;
      void Effect.runPromise(
        recoverRetainedExecutorsEffect({
          runtimeAdapters: [adapter],
          captureDrain: { ledger, settings },
          credentialCipher: cipher,
          bounds: { recoverMs: 30_000 },
          now: Date.now,
        }).pipe(Effect.provide(layer)),
      ).then((outcomes) => {
        result = outcomes;
        return outcomes;
      });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(result?.get("stalled")).toBe("retained");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.error).toContain("did not answer within");
      // Its claim was released with the attempt: the next one may start.
      expect(await Effect.runPromise(ledger.claimRecovery("stalled", 1_000))).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs one attempt per executor at a time, whichever sweep or path asks", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    const rows = retainedRows(ledger, ["run_once"]);
    let release!: () => void;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recover = vi.fn(async () => {
      await answered;
      return { outcome: "unsupported" as const, detail: "kept" };
    });
    const adapter: RuntimeAdapter = {
      id: "microvm",
      supports: () => ({ supported: true }),
      launch: async () => {
        throw new Error("unused");
      },
      stop: async () => {
        throw new Error("never saved");
      },
      inspect: async () => ({ state: "exited", exitCode: 75 }),
      recover,
    };
    const { layer } = layerFor(rows, {});
    const sweep = () =>
      Effect.runPromise(
        recoverRetainedExecutorsEffect({
          runtimeAdapters: [adapter],
          captureDrain: { ledger, settings },
          credentialCipher: cipher,
        }).pipe(Effect.provide(layer)),
      );
    const first = sweep();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    // A second sweep (another worker, the deadline path) finds it claimed and leaves it.
    expect((await sweep()).get("run_once")).toBe("retained");
    expect(recover).toHaveBeenCalledOnce();
    release();
    await first;
  });
});
