/**
 * An exec run in its request (`execWorkspaceInRequest`): after `execWorkspace`'s admission the run
 * is created, claimed and recorded inside the request, never queued, and the settled run comes
 * back. One budget covers the whole request: past it no further command is sent and the run
 * fails. Driven against the telemetry package's scripted workspace and typed repositories. A
 * service key is configured before the dynamic import because runtime-env parses process.env at
 * module load.
 */
import {
  type Workspace,
  WorkspaceRepo,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { fakeExecWorld, type FakeExecWorldOptions } from "@sealant/telemetry/testing";
import { Duration, Effect, Layer, Result } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_SERVICE_KEYS"] = "svc-test";

let workspacesModule: typeof import("./workspaces.module.js");

beforeAll(async () => {
  workspacesModule = await import("./workspaces.module.js");
});

const OWNER = "usr_alice";
const workspace: Workspace = {
  id: "wks_1",
  name: "",
  ownerUserId: OWNER,
  repositoryId: null,
  repositoryProfileRevisionId: null,
  profileRevisionId: null,
  requestedByUserId: null,
  status: "ready",
  latestRunId: "run_launch",
  expiresAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  archivedAt: null,
  binds: [],
  idempotencyKey: null,
  sshUser: null,
};
const instance: WorkspaceRuntimeInstance = {
  runId: "run_launch",
  status: "ready",
  adapter: "docker",
  resourceId: "container-1",
  launchCredentialInjections: [],
  reference: "container-1",
  endpoint: null,
  errorCode: null,
  errorMessage: null,
  stopReason: null,
  launchedAt: null,
  finishedAt: null,
  removedAt: null,
  runtimeDeadlineAt: null,
  sourceKind: null,
  launchOwner: null,
  launchLeaseExpiresAt: null,
  daemonImage: null,
  daemonRecoveryBoot: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const unscripted = (call: string) => () => Effect.die(`unscripted call ${call}`);

const workspaces: WorkspaceRepoService = {
  createWorkspace: unscripted("createWorkspace"),
  getWorkspaceByAttemptId: unscripted("getWorkspaceByAttemptId"),
  getWorkspaceById: (id) => Effect.succeed(id === workspace.id ? workspace : undefined),
  getWorkspaceByIdempotencyKey: unscripted("getWorkspaceByIdempotencyKey"),
  linkWorkspaceAttempt: unscripted("linkWorkspaceAttempt"),
  listWorkspaces: unscripted("listWorkspaces"),
  listWorkspaceAttemptLinks: unscripted("listWorkspaceAttemptLinks"),
  setWorkspaceName: unscripted("setWorkspaceName"),
  setWorkspaceBinds: unscripted("setWorkspaceBinds"),
  setWorkspaceSshUser: unscripted("setWorkspaceSshUser"),
  setWorkspaceExpiry: unscripted("setWorkspaceExpiry"),
  setWorkspaceStatus: unscripted("setWorkspaceStatus"),
};

const instances: WorkspaceRuntimeInstanceRepoService = {
  upsertRuntimeInstance: unscripted("upsertRuntimeInstance"),
  markExited: unscripted("markExited"),
  markStopRequested: unscripted("markStopRequested"),
  markStopped: unscripted("markStopped"),
  markRemoved: unscripted("markRemoved"),
  getRuntimeInstanceByRunId: () => Effect.succeed(instance),
  listRuntimeInstancesByRunIds: unscripted("listRuntimeInstancesByRunIds"),
  listRunningInstances: unscripted("listRunningInstances"),
  listRetainedLaunches: unscripted("listRetainedLaunches"),
  listStrandedLaunches: unscripted("listStrandedLaunches"),
  adoptStrandedLaunch: unscripted("adoptStrandedLaunch"),
  listUnidentifiedStrandedLaunches: unscripted("listUnidentifiedStrandedLaunches"),
  identifyStrandedLaunch: unscripted("identifyStrandedLaunch"),
  failLostLaunch: unscripted("failLostLaunch"),
  preemptLaunch: unscripted("preemptLaunch"),
  renewLaunchLease: unscripted("renewLaunchLease"),
  listPreservationCandidates: unscripted("listPreservationCandidates"),
  listUnsettledCaptureExecutors: unscripted("listUnsettledCaptureExecutors"),
  listStoppedWithRemains: unscripted("listStoppedWithRemains"),
};

const world = (options: FakeExecWorldOptions = {}) => {
  const exec = fakeExecWorld(options);
  const layer = Layer.mergeAll(
    exec.layer,
    Layer.succeed(WorkspaceRepo, workspaces),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, instances),
  );
  const run = (args: readonly string[], budget?: Duration.Input) =>
    Effect.runPromise(
      Effect.result(
        workspacesModule
          .execWorkspaceInRequest({
            workspaceId: workspace.id,
            payload: {
              ownerUserId: OWNER,
              commands: args.map((arg) => ({ executable: "check", args: [arg] })),
            },
            ...(budget === undefined ? {} : { budget }),
          })
          .pipe(Effect.provide(layer)),
      ),
    );
  return { ...exec, run };
};

describe("an exec run in its request", () => {
  it("answers with the settled run, its commands run in order and nothing queued", async () => {
    const w = world();
    const answered = await w.run(["3", "0"]);
    if (!Result.isSuccess(answered)) throw new Error("expected the settled run");
    expect(answered.success).toMatchObject({ status: "completed", exitCode: 0 });
    const runId = answered.success.runId;
    expect(w.sent.filter((exec) => exec.executionId === runId).map((exec) => exec.args)).toEqual([
      ["3"],
      ["0"],
    ]);
  });

  it("past its budget sends no further command, and the run fails", async () => {
    const w = world();
    const answered = await w.run(["hang", "0"], "50 millis");
    if (!Result.isFailure(answered)) throw new Error("expected the budget to run out");
    const runId = w.row()?.id ?? "";
    expect(answered.failure).toMatchObject({
      _tag: "WorkspaceBadGatewayError",
      message: `Exec run ${runId} ran past its budget and failed; a command it started may still be running.`,
    });
    expect(w.sent.map((exec) => exec.args)).toEqual([["hang"]]);
    expect(w.row()).toMatchObject({
      status: "failed",
      errorMessage: `Run ${runId} was interrupted before it completed: no further command was sent, and one already started may still be running.`,
    });
  });
});
