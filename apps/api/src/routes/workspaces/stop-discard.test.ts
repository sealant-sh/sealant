/**
 * `stop({ discardUnsaved: true })`: the owner's explicit, audited way to end a workspace whose
 * unsaved captures a drain would otherwise keep forever. The request is recorded (who, when)
 * before the stop is enqueued, and it is accepted on a workspace whose stop was already recorded
 * (the kept one). A plain stop of such a workspace stays a no-op.
 */
import type { CaptureExecutorOrigin } from "@sealant/api-contracts";
import {
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceCaptureDrainRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type Workspace,
  type WorkspaceAttempt,
  type WorkspaceAttemptRepoService,
  type WorkspaceBuildJob,
  type WorkspaceBuildJobRepoService,
  type WorkspaceCaptureDrain,
  type WorkspaceCaptureDrainRepoService,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { Effect, Layer, Logger } from "effect";
import { describe, expect, it } from "vitest";

import { WorkspaceLifecyclePublisherService } from "../../services/control-plane-capabilities.js";
import { mapWorkspaceCaptureDrain, recoverWorkspace, stopWorkspace } from "./workspaces.module.js";

const now = new Date("2026-09-27T12:00:00.000Z");

const harness = (
  status: Workspace["status"],
  options: {
    readonly observedEpoch?: number;
    /** More of Core's last observation than its epoch (`last_status`), and when it was read. */
    readonly observedStatus?: Record<string, unknown>;
    readonly observedAt?: Date;
    readonly retained?: boolean;
    /** The launch identity the create named (recorded on the attempt). */
    readonly launchId?: string;
    /** No runtime yet: the launch's build job is in this state. */
    readonly launching?: WorkspaceBuildJob["status"];
  } = {},
) => {
  const cancelledJobs: string[] = [];
  const cancelledAttempts: Array<{ id: string; cancelReason: string }> = [];
  const discards: Array<{ runId: string; requestedBy: string }> = [];
  const attestations: Array<{
    runId: string;
    executorId: string;
    epoch: number;
    launchId?: string;
  }> = [];
  const recoveries: string[] = [];
  const stops: string[] = [];
  const statuses: string[] = [];
  const workspace = {
    id: "ws_1",
    ownerUserId: "user_owner",
    status,
    latestRunId: "run_1",
  } as Workspace;
  const layer = Layer.mergeAll(
    Layer.succeed(WorkspaceAttemptRepo, {
      getAttemptById: (id: string) =>
        Effect.succeed({ id, launchId: options.launchId ?? null } as WorkspaceAttempt),
      markAttemptCancelled: (input: { id: string; cancelReason: string }) => {
        cancelledAttempts.push(input);
        return Effect.succeed(null);
      },
    } as unknown as WorkspaceAttemptRepoService),
    Layer.succeed(WorkspaceBuildJobRepo, {
      getLatestJobByRunId: () =>
        Effect.succeed(
          options.launching === undefined
            ? undefined
            : ({ id: "job_1", status: options.launching } as WorkspaceBuildJob),
        ),
      cancelUnbuiltJob: (input: { id: string }) => {
        cancelledJobs.push(input.id);
        return Effect.succeed({ id: input.id, status: "failed" } as WorkspaceBuildJob);
      },
    } as unknown as WorkspaceBuildJobRepoService),
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: () => Effect.succeed(workspace),
      setWorkspaceStatus: (input: { status: string }) => {
        statuses.push(input.status);
        return Effect.succeed(workspace);
      },
    } as unknown as WorkspaceRepoService),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: () =>
        Effect.succeed(
          options.launching !== undefined
            ? undefined
            : ({
                runId: "run_1",
                status: "ready",
                adapter: "docker",
                resourceId: "container-1",
                reference: "sealant-run-1",
              } as WorkspaceRuntimeInstance),
        ),
    } as unknown as WorkspaceRuntimeInstanceRepoService),
    Layer.succeed(WorkspaceCaptureDrainRepo, {
      requestDiscard: (input: { runId: string; requestedBy: string }) => {
        discards.push(input);
        return Effect.succeed({} as WorkspaceCaptureDrain);
      },
      getByRunId: () =>
        Effect.succeed(
          options.observedEpoch === undefined
            ? undefined
            : ({
                runId: "run_1",
                lastStatus: { epoch: options.observedEpoch, ...options.observedStatus },
                lastStatusAt: options.observedAt ?? null,
              } as unknown as WorkspaceCaptureDrain),
        ),
      attestCompletion: (input: { runId: string; executorId: string; epoch: number }) => {
        attestations.push(input);
        return Effect.succeed({} as WorkspaceCaptureDrain);
      },
      requestRecovery: (runId: string) => {
        recoveries.push(runId);
        return Effect.succeed(
          options.retained === true ? ({ runId } as WorkspaceCaptureDrain) : undefined,
        );
      },
    } as unknown as WorkspaceCaptureDrainRepoService),
    Layer.succeed(WorkspaceLifecyclePublisherService, {
      publishStopRequested: ({ runId }) => {
        stops.push(runId);
        return Promise.resolve();
      },
    }),
  );
  const stop = (
    payload: {
      ownerUserId: string;
      discardUnsaved?: boolean;
      completion?: {
        captureN: number;
        epoch: number;
        executorId: string;
        launchId?: string;
        sealedAt?: string;
        origin?: CaptureExecutorOrigin;
      };
    },
    logger: Layer.Layer<never> = Layer.empty,
  ) =>
    Effect.runPromise(
      stopWorkspace({ workspaceId: "ws_1", payload }).pipe(
        Effect.provide(layer),
        Effect.provide(logger),
      ),
    );
  const recover = () =>
    Effect.runPromise(
      recoverWorkspace({ workspaceId: "ws_1", payload: { ownerUserId: "user_owner" } }).pipe(
        Effect.provide(layer),
      ),
    );
  return {
    stop,
    recover,
    discards,
    attestations,
    recoveries,
    stops,
    statuses,
    cancelledJobs,
    cancelledAttempts,
  };
};

describe("stopWorkspace · before the image is built", () => {
  it("cancels a launch still building its image: nothing launches, and the run ends cancelled", async () => {
    for (const launching of ["queued", "running"] as const) {
      const h = harness("running", { launching });
      await expect(h.stop({ ownerUserId: "user_owner" })).resolves.toEqual({
        workspaceId: "ws_1",
        status: "cancelled",
      });
      expect(h.cancelledJobs).toEqual(["job_1"]);
      expect(h.cancelledAttempts).toEqual([
        { id: "run_1", cancelReason: "stopped before its image was built" },
      ]);
      // There is no runtime to tear down: no stop is enqueued.
      expect(h.stops).toEqual([]);
    }
  });

  it("still refuses between the build and the runtime's first record", async () => {
    const h = harness("running", { launching: "succeeded" });
    await expect(h.stop({ ownerUserId: "user_owner" })).rejects.toMatchObject({
      message: expect.stringContaining("still launching"),
    });
    expect(h.cancelledJobs).toEqual([]);
  });
});

describe("stopWorkspace · discardUnsaved", () => {
  it("records who discarded the unsaved captures, then enqueues the stop", async () => {
    const h = harness("ready");
    await h.stop({ ownerUserId: "user_owner", discardUnsaved: true });
    expect(h.discards).toEqual([{ runId: "run_1", requestedBy: "user_owner" }]);
    expect(h.stops).toEqual(["run_1"]);
  });

  it("ends a workspace whose stop was already recorded and a drain kept running", async () => {
    const h = harness("stopped");
    await h.stop({ ownerUserId: "user_owner" });
    expect(h.stops).toEqual([]);
    await h.stop({ ownerUserId: "user_owner", discardUnsaved: true });
    expect(h.discards).toHaveLength(1);
    expect(h.stops).toEqual(["run_1"]);
  });

  it("logs the discard as requested, never as a termination that has not happened", async () => {
    // Review 2 #15: the API logged "the runtime is terminated without a drain" before it even
    // recorded the stop intent or enqueued it; a queue failure left the runtime alive.
    const h = harness("ready");
    const lines: string[] = [];
    const recorder = Logger.make(({ message }) => {
      lines.push(Array.isArray(message) ? message.join(" ") : String(message));
    });
    await h.stop({ ownerUserId: "user_owner", discardUnsaved: true }, Logger.layer([recorder]));
    expect(lines.some((line) => line.includes("discard requested"))).toBe(true);
    expect(lines.some((line) => /terminated/.test(line))).toBe(false);
  });

  it("refuses anyone but the owner", async () => {
    const h = harness("stopped");
    await expect(h.stop({ ownerUserId: "someone_else", discardUnsaved: true })).rejects.toThrow(
      /not found/,
    );
    expect(h.discards).toEqual([]);
  });

  it("reports the audit on the workspace's captureDrain", () => {
    expect(
      mapWorkspaceCaptureDrain({
        runId: "run_1",
        state: "discarded",
        detail: "unsaved captures discarded",
        observedAt: now,
        preservationStartsAt: null,
        discardRequestedAt: now,
        discardRequestedBy: "user_owner",
      } as WorkspaceCaptureDrain),
    ).toEqual({
      state: "discarded",
      detail: "unsaved captures discarded",
      observedAt: now.toISOString(),
      discard: { requestedBy: "user_owner", requestedAt: now.toISOString() },
    });
  });
});

/** A position in the executor's own history (sealantd's stamp). */
const position = (observation: number) => ({
  epoch: 3,
  launch: "launch-1",
  bootId: "boot-1",
  bootGeneration: 1,
  observation,
  headN: 41,
});

describe("stopWorkspace · completion attestation", () => {
  it("records an attestation that names the current executor, and enqueues the stop", async () => {
    // Core last read the daemon mid-flush, before the seal by the executor's own order.
    const h = harness("ready", {
      observedEpoch: 3,
      observedStatus: {
        headN: 41,
        pending: 2,
        complete: false,
        incompleteReason: "in-progress",
        origin: position(40),
      },
      observedAt: new Date(now.getTime() - 10 * 60_000),
    });
    const response = await h.stop({
      ownerUserId: "user_owner",
      completion: {
        captureN: 41,
        epoch: 3,
        executorId: "container-1",
        sealedAt: now.toISOString(),
        origin: position(41),
      },
    });
    expect(response.completion).toEqual({ outcome: "accepted" });
    expect(h.attestations).toEqual([
      expect.objectContaining({
        runId: "run_1",
        executorId: "container-1",
        epoch: 3,
        captureN: 41,
      }),
    ]);
    expect(h.stops).toEqual(["run_1"]);
  });

  // Review 6 #6: clocks order nothing. The same mid-flush observation, ten minutes before the
  // seal's time, cannot be placed before a seal that carries no position.
  it("ignores an attestation whose seal no position orders after an observation of its capture", async () => {
    const h = harness("ready", {
      observedEpoch: 3,
      observedStatus: { headN: 41, pending: 2, complete: false, incompleteReason: "in-progress" },
      observedAt: new Date(now.getTime() - 10 * 60_000),
    });
    const response = await h.stop({
      ownerUserId: "user_owner",
      completion: {
        captureN: 41,
        epoch: 3,
        executorId: "container-1",
        sealedAt: now.toISOString(),
      },
    });
    expect(response.completion).toMatchObject({ outcome: "ignored" });
    expect(h.attestations).toEqual([]);
  });

  it("ignores an attestation about another executor or an older epoch, and still stops", async () => {
    const other = harness("ready");
    const response = await other.stop({
      ownerUserId: "user_owner",
      completion: { captureN: 41, epoch: 3, executorId: "container-OTHER" },
    });
    expect(response.completion).toMatchObject({
      outcome: "ignored",
      detail: expect.stringContaining("container-OTHER"),
    });
    expect(other.attestations).toEqual([]);
    expect(other.stops).toEqual(["run_1"]);

    const stale = harness("ready", { observedEpoch: 4 });
    expect(
      (
        await stale.stop({
          ownerUserId: "user_owner",
          completion: { captureN: 41, epoch: 3, executorId: "run_1" },
        })
      ).completion,
    ).toMatchObject({ outcome: "ignored", detail: expect.stringContaining("older") });
    expect(stale.attestations).toEqual([]);
  });

  it("ignores a seal that Core's own later observation contradicts (review 4 #1)", async () => {
    // Capture 41 was sealed; then the disk changed and the FINAL could not snapshot it. Core
    // read that failed answer after the seal: the older seal does not override it.
    const failed = {
      headN: 41,
      complete: false,
      incompleteReason: "snapshot-failed",
      unreadable: 1,
    };
    const sealedAt = new Date(now.getTime() - 10 * 60_000).toISOString();
    for (const [observedStatus, completion] of [
      // Read after the seal.
      [failed, { captureN: 41, epoch: 3, executorId: "container-1", sealedAt }],
      // No seal time: nothing shows the seal came after the failed answer.
      [failed, { captureN: 41, epoch: 3, executorId: "container-1" }],
      // A capture past the sealed one exists.
      [
        { ...failed, headN: 42 },
        { captureN: 41, epoch: 3, executorId: "container-1", sealedAt },
      ],
    ] as const) {
      const h = harness("ready", { observedEpoch: 3, observedStatus, observedAt: now });
      const answer = await h.stop({ ownerUserId: "user_owner", completion });
      expect(answer.completion).toMatchObject({ outcome: "ignored" });
      expect(h.attestations).toEqual([]);
    }
  });

  it("records the seal's time with an accepted attestation, and refuses one that is not a time", async () => {
    const h = harness("ready");
    await h.stop({
      ownerUserId: "user_owner",
      completion: {
        captureN: 41,
        epoch: 3,
        executorId: "container-1",
        sealedAt: "2026-09-27T11:59:00.000Z",
      },
    });
    expect(h.attestations).toEqual([
      expect.objectContaining({ sealedAt: new Date("2026-09-27T11:59:00.000Z") }),
    ]);
    const bad = harness("ready");
    expect(
      (
        await bad.stop({
          ownerUserId: "user_owner",
          completion: { captureN: 41, epoch: 3, executorId: "container-1", sealedAt: "soon" },
        })
      ).completion,
    ).toMatchObject({ outcome: "ignored" });
    expect(bad.attestations).toEqual([]);
  });

  it("accepts an attestation for a workspace already stopped whose executor was kept", async () => {
    const h = harness("stopped");
    await h.stop({
      ownerUserId: "user_owner",
      completion: { captureN: 7, epoch: 1, executorId: "sealant-run-1" },
    });
    expect(h.attestations).toHaveLength(1);
    expect(h.stops).toEqual(["run_1"]);
  });
});

describe("recoverWorkspace", () => {
  it("makes a retained executor's recovery due now and says whether its runtime can restart it", async () => {
    const h = harness("stopped", { retained: true });
    expect(await h.recover()).toEqual({
      workspaceId: "ws_1",
      state: "requested",
      recoverable: true,
    });
    expect(h.recoveries).toEqual(["run_1"]);
  });

  it("does nothing for a workspace with no retained executor", async () => {
    const h = harness("stopped");
    expect(await h.recover()).toEqual({ workspaceId: "ws_1", state: "not-retained" });
  });

  it("reports retention and an accepted attestation on the workspace's captureDrain", () => {
    expect(
      mapWorkspaceCaptureDrain(
        {
          runId: "run_1",
          state: "kept",
          detail: "not saved · retained · executor exited",
          observedAt: now,
          preservationStartsAt: null,
          discardRequestedAt: null,
          discardRequestedBy: null,
          retainedAt: now,
          retainedReason: "executor exited",
          recoveryAttempts: 2,
          nextRecoveryAt: now,
          lastRecoveryError: "docker start failed",
          completionExecutorId: "container-1",
          completionEpoch: 3,
          completionCaptureN: 41,
          completionAttestedAt: now,
        } as WorkspaceCaptureDrain,
        { runId: "run_1", adapter: "k8s", resourceId: "ws-run-1", reference: "ws-run-1" },
      ),
    ).toMatchObject({
      executor: { runId: "run_1", adapter: "k8s", resourceId: "ws-run-1", reference: "ws-run-1" },
      retained: {
        since: now.toISOString(),
        reason: "executor exited",
        recoverable: false,
        recoveryAttempts: 2,
        nextRecoveryAt: now.toISOString(),
        lastRecoveryError: "docker start failed",
      },
      completion: { executorId: "container-1", epoch: 3, captureN: 41 },
    });
  });
});

describe("stopWorkspace · completion names the launch (decision 5, review 3)", () => {
  const completion = { captureN: 41, epoch: 3, executorId: "container-1" };

  it("records an attestation that names this executor's launch", async () => {
    const h = harness("ready", { launchId: "launch_a" });
    const answer = await h.stop({
      ownerUserId: "user_owner",
      completion: { ...completion, launchId: "launch_a" },
    });
    expect(answer.completion).toEqual({ outcome: "accepted" });
    expect(h.attestations).toEqual([
      expect.objectContaining({ runId: "run_1", executorId: "container-1", launchId: "launch_a" }),
    ]);
  });

  it("ignores a seal of another launch, even on the same resource", async () => {
    // A seal never transfers to another physical executor.
    const h = harness("ready", { launchId: "launch_b" });
    const answer = await h.stop({
      ownerUserId: "user_owner",
      completion: { ...completion, launchId: "launch_a" },
    });
    expect(answer.completion).toMatchObject({
      outcome: "ignored",
      detail: expect.stringContaining("not this executor's launch launch_b"),
    });
    expect(h.attestations).toEqual([]);
  });

  it("ignores an attestation that names no launch when the create named one", async () => {
    const h = harness("ready", { launchId: "launch_b" });
    const answer = await h.stop({ ownerUserId: "user_owner", completion });
    expect(answer.completion).toMatchObject({
      outcome: "ignored",
      detail: expect.stringContaining("names no launch"),
    });
    expect(h.attestations).toEqual([]);
  });

  it("ignores a launch it cannot match: the create named none", async () => {
    const h = harness("ready");
    const answer = await h.stop({
      ownerUserId: "user_owner",
      completion: { ...completion, launchId: "launch_a" },
    });
    expect(answer.completion).toMatchObject({ outcome: "ignored" });
    expect(h.attestations).toEqual([]);
  });
});
