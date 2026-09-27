/**
 * `stop({ discardUnsaved: true })`: the owner's explicit, audited way to end a workspace whose
 * unsaved captures a drain would otherwise keep forever. The request is recorded (who, when)
 * before the stop is enqueued, and it is accepted on a workspace whose stop was already recorded
 * (the kept one). A plain stop of such a workspace stays a no-op.
 */
import {
  WorkspaceCaptureDrainRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type Workspace,
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
  options: { readonly observedEpoch?: number; readonly retained?: boolean } = {},
) => {
  const discards: Array<{ runId: string; requestedBy: string }> = [];
  const attestations: Array<{ runId: string; executorId: string; epoch: number }> = [];
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
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: () => Effect.succeed(workspace),
      setWorkspaceStatus: (input: { status: string }) => {
        statuses.push(input.status);
        return Effect.succeed(workspace);
      },
    } as unknown as WorkspaceRepoService),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: () =>
        Effect.succeed({
          runId: "run_1",
          status: "ready",
          adapter: "docker",
          resourceId: "container-1",
          reference: "sealant-run-1",
        } as WorkspaceRuntimeInstance),
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
                lastStatus: { epoch: options.observedEpoch },
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
      completion?: { captureN: number; epoch: number; executorId: string };
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
  return { stop, recover, discards, attestations, recoveries, stops, statuses };
};

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

describe("stopWorkspace · completion attestation", () => {
  it("records an attestation that names the current executor, and enqueues the stop", async () => {
    const h = harness("ready", { observedEpoch: 3 });
    const response = await h.stop({
      ownerUserId: "user_owner",
      completion: { captureN: 41, epoch: 3, executorId: "container-1" },
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
        "k8s",
      ),
    ).toMatchObject({
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
