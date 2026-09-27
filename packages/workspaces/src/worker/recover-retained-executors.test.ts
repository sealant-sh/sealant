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
}) => {
  const ledger = inMemoryCaptureDrainLedger({ now: () => NOW });
  Effect.runSync(ledger.markRetained("run_1", "executor exited · exit 75"));
  const attempts: Array<{ runId: string; error: string | null; nextRecoveryAt: Date }> = [];
  const row = {
    runId: "run_1",
    retainedAt: new Date(NOW - 1_000),
    recoveryAttempts: input.attempts ?? 0,
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
      Effect.succeed(instance({ adapter: input.adapterId ?? "docker" })),
    markStopped,
  } as unknown as WorkspaceRuntimeInstanceRepoService;
  const stop = vi.fn(async (request: { resourceId: string }) => ({
    adapter: input.adapterId ?? ("docker" as const),
    resourceId: request.resourceId,
    outcome: "stopped" as const,
  }));
  const recover = vi.fn(input.recover ?? (async () => ({ outcome: "restarted" as const })));
  const adapter: RuntimeAdapter = {
    id: input.adapterId ?? "docker",
    supports: () => ({ supported: true }),
    launch: async () => {
      throw new Error("unused");
    },
    stop,
    inspect: async () => input.inspect,
    recover,
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
  return { run, ledger, attempts, stop, recover, markStopped, daemon };
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
