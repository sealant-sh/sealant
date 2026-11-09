import type { WorkspacePreservation } from "@sealant/api-contracts";
/**
 * e2e 5: an executor Core KEEPS for recovery read as a plain `failed` (or `stopped`) workspace, so
 * its session's control plane took it for dead and revoked the lease and capture token the
 * recovery boot needs — every recovery then exited 75 on `plan.get`. A retained executor reads
 * `retained` (workspace status and runtime status) on every read the control plane uses, from the
 * moment it is recorded retained until the retention ends.
 */
import {
  LAUNCH_RETAINED_ERROR_CODE,
  RUNTIME_EXITED_ERROR_CODE,
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
import type { BoatExecutionTarget } from "@sealant/validators";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { getWorkspace, listWorkspaceAttempts, listWorkspaces } from "./workspaces.module.js";

const now = new Date("2026-09-28T01:00:00.000Z");

const harness = (input: {
  readonly canonicalState?: WorkspacePreservation["state"];
  readonly runtime: Partial<WorkspaceRuntimeInstance>;
  readonly retainedAt: Date | null;
  readonly attemptStatus?: WorkspaceAttempt["status"];
}) => {
  const workspace = {
    id: "ws_1",
    name: "retained",
    ownerUserId: "user_owner",
    status: "stopped",
    latestRunId: "run_1",
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  } as Workspace;
  const attempt = {
    id: "run_1",
    status: input.attemptStatus ?? "succeeded",
    triggerType: "api",
    triggerRef: null,
    launchId: "launch-1",
    queuedAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    durationMs: null,
  } as unknown as WorkspaceAttempt;
  const job = {
    publication: null,
    publicationId: null,
    imageScope: null,
    id: "job_1",
    runId: "run_1",
    status: "succeeded",
    registryId: "local",
    repository: "sealant/workspaces/capture",
    tag: "session",
    publishedReference: null,
    publishedDigestReference: null,
    publishedDigest: null,
    errorCode: null,
    errorMessage: null,
    requestPayload: {},
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: now,
  } as unknown as WorkspaceBuildJob;
  const runtime = {
    runId: "run_1",
    status: "failed",
    adapter: "docker",
    resourceId: "container-1",
    reference: "sealant-run-1",
    endpoint: null,
    errorCode: RUNTIME_EXITED_ERROR_CODE,
    errorMessage: "exited with 75",
    stopReason: null,
    runtimeDeadlineAt: null,
    launchedAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...input.runtime,
  } as WorkspaceRuntimeInstance;
  const drain = {
    runId: "run_1",
    custodyContract: input.canonicalState === undefined ? null : 3,
    state: "kept",
    detail: "not saved · retained · executor exited",
    observedAt: now,
    preservationStartsAt: null,
    discardRequestedAt: null,
    discardRequestedBy: null,
    retainedAt: input.retainedAt,
    retainedReason: input.retainedAt === null ? null : "executor exited",
    recoveryAttempts: 0,
    nextRecoveryAt: input.retainedAt,
    lastRecoveryError: null,
    completionExecutorId: null,
    completionEpoch: null,
    completionCaptureN: null,
    completionAttestedAt: null,
    completionLaunchId: null,
  } as unknown as WorkspaceCaptureDrain;
  const current: BoatExecutionTarget = {
    deploymentId: "local",
    workspaceId: "ws_1",
    runId: "run_1",
    runtimeInstanceId: "child_1",
    launchAttemptId: "child_op",
    sourceId: "publication",
    sandboxId: "bx_3456789a",
    diskLineage: "child_disk",
    bootId: "00000000-0000-4000-8000-000000000001",
    manifestDigest: "a".repeat(64),
  };
  const preservation: WorkspacePreservation = {
    version: 1,
    runId: "run_1",
    revision: 1,
    desired: "preserve",
    state: input.canonicalState ?? "retained",
    snapshotOnly: input.canonicalState === "parked",
    retainedSince: now.toISOString(),
    parkingEligibleAt: now.toISOString(),
    parkingDelaySeconds: 3600,
    policyRevision: "policy",
    currentIncarnationId: "child",
    vms: [],
    snapshots: [],
    operations: [],
    allowance: { state: "unknown", reason: "not-observed" },
    blockers: [],
  };
  return Layer.mergeAll(
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: () => Effect.succeed(workspace),
      listWorkspaces: () => Effect.succeed([workspace]),
      listWorkspaceAttemptLinks: () =>
        Effect.succeed([
          { workspaceId: "ws_1", runId: "run_1", relation: "launch", linkedAt: now },
        ]),
    } as unknown as WorkspaceRepoService),
    Layer.succeed(WorkspaceAttemptRepo, {
      getAttemptById: () => Effect.succeed(attempt),
      getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
    } as unknown as WorkspaceAttemptRepoService),
    Layer.succeed(WorkspaceBuildJobRepo, {
      getLatestJobByRunId: () => Effect.succeed(job),
      listLatestJobsByRunIds: () => Effect.succeed(new Map([["run_1", job]])),
    } as unknown as WorkspaceBuildJobRepoService),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: () => Effect.succeed(runtime),
      listRuntimeInstancesByRunIds: () => Effect.succeed(new Map([["run_1", runtime]])),
    } as unknown as WorkspaceRuntimeInstanceRepoService),
    Layer.succeed(WorkspaceCaptureDrainRepo, {
      getByRunId: () => Effect.succeed(drain),
      listByRunIds: () => Effect.succeed(new Map([["run_1", drain]])),
      preservation: Effect.succeed({
        read: () => Effect.succeed(preservation),
        resolveExecution: () =>
          Effect.succeed(input.canonicalState === "active" ? current : undefined),
      }),
    } as unknown as WorkspaceCaptureDrainRepoService),
  );
};

const read = (layer: ReturnType<typeof harness>) =>
  Effect.runPromise(
    Effect.all({
      details: getWorkspace("ws_1", "user_owner"),
      list: listWorkspaces({ ownerUserId: "user_owner" }),
      attempts: listWorkspaceAttempts({
        workspaceId: "ws_1",
        query: { ownerUserId: "user_owner" },
      }),
    }).pipe(Effect.provide(layer)),
  );

describe("a retained executor reads `retained`", () => {
  it("reads the canonical current child after resume while the historical row still names its removed source", async () => {
    const { details, list, attempts } = await read(
      harness({
        runtime: { adapter: "boat", resourceId: "bx_23456789", reference: "bx_23456789" },
        retainedAt: now,
        canonicalState: "active",
      }),
    );
    expect(details.status).toBe("ready");
    expect(details.runtime?.resourceId).toBe("bx_3456789a");
    expect(details.captureDrain?.executor?.resourceId).toBe("bx_3456789a");
    expect(list.items[0]?.status).toBe("ready");
    expect(list.items[0]?.runtime?.resourceId).toBe("bx_3456789a");
    expect(attempts.items[0]?.runtime?.resourceId).toBe("bx_3456789a");
  });
  it("reports saved custody without exposing a removed source as an interactive runtime", async () => {
    const { details, list } = await read(
      harness({
        runtime: { adapter: "boat", resourceId: "bx_23456789", reference: "bx_23456789" },
        retainedAt: now,
        canonicalState: "parked",
      }),
    );
    expect(details.status).toBe("retained");
    expect(details.runtime).toBeUndefined();
    expect(details.captureDrain?.executor).toBeUndefined();
    expect(details.captureDrain?.preservation?.snapshotOnly).toBe(true);
    expect(list.items[0]?.status).toBe("retained");
    expect(list.items[0]?.runtime).toBeUndefined();
  });
  it("an exited executor kept for recovery: details, list and attempts", async () => {
    const { details, list, attempts } = await read(harness({ runtime: {}, retainedAt: now }));
    expect(details.status).toBe("retained");
    expect(details.runtime?.status).toBe("retained");
    expect(details.captureDrain?.retained).toMatchObject({ reason: "executor exited" });
    // The executor the retention is about, with the launch identity the create named.
    expect(details.captureDrain?.executor).toEqual({
      runId: "run_1",
      adapter: "docker",
      resourceId: "container-1",
      reference: "sealant-run-1",
      launchId: "launch-1",
    });
    expect(list.items[0]?.status).toBe("retained");
    expect(list.items[0]?.runtime?.status).toBe("retained");
    expect(attempts.items[0]?.status).toBe("retained");
  });

  it("a planned stop that ended incomplete (runtime recorded stopped) is retained, not stopped", async () => {
    const { details } = await read(
      harness({ runtime: { status: "stopped", stopReason: "user" }, retainedAt: now }),
    );
    expect(details.status).toBe("retained");
    expect(details.runtime?.status).toBe("retained");
  });

  it("a capture launch that failed after its executor started is retained", async () => {
    const { details } = await read(
      harness({
        runtime: { errorCode: LAUNCH_RETAINED_ERROR_CODE },
        retainedAt: null,
        attemptStatus: "failed",
      }),
    );
    expect(details.status).toBe("retained");
  });

  it("a Boat VM observed absent reads stopped, keeping its launch error as history", async () => {
    const { details, list, attempts } = await read(
      harness({
        runtime: {
          adapter: "boat",
          resourceId: "bx_23456789",
          reference: "run_1",
          status: "stopped",
          stopReason: "user",
          errorCode: LAUNCH_RETAINED_ERROR_CODE,
          removedAt: now,
        },
        retainedAt: null,
        attemptStatus: "failed",
      }),
    );
    expect(details.status).toBe("stopped");
    expect(details.runtime?.status).toBe("stopped");
    expect(list.items[0]?.status).toBe("stopped");
    expect(attempts.items[0]?.status).toBe("stopped");
  });

  it("a Boat VM observed absent is not resurrected as retained by a stale retention", async () => {
    const { details } = await read(
      harness({
        runtime: {
          adapter: "boat",
          resourceId: "bx_23456789",
          reference: "run_1",
          status: "stopped",
          stopReason: "user",
          errorCode: null,
          removedAt: now,
        },
        retainedAt: now,
      }),
    );
    expect(details.status).toBe("stopped");
    expect(details.runtime?.status).toBe("stopped");
  });

  it("a Boat launch that failed with its VM still present stays retained", async () => {
    const { details } = await read(
      harness({
        runtime: {
          adapter: "boat",
          resourceId: "bx_23456789",
          reference: "run_1",
          errorCode: LAUNCH_RETAINED_ERROR_CODE,
          removedAt: null,
        },
        retainedAt: null,
        attemptStatus: "failed",
      }),
    );
    expect(details.status).toBe("retained");
  });

  it("reads failed again once the retention ended (removed, discarded or lost)", async () => {
    const { details, list } = await read(harness({ runtime: {}, retainedAt: null }));
    expect(details.status).toBe("failed");
    expect(details.runtime?.status).toBe("failed");
    expect(list.items[0]?.status).toBe("failed");
  });
});
