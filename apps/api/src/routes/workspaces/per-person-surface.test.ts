/**
 * Mend ADR 0016's surface on create, exec and sessions: a `credentialsHome` follows the home rules;
 * a process asked to run as a Linux user runs as them only for a person in Mend's range on an
 * executor whose sealantd reports `exec.user`, is refused (`user-unsupported`, worded by reason)
 * before anything starts otherwise, and is recorded on its run; the control plane reports its
 * features; and an image's per-person capability is readable before create. A service key is
 * configured before the dynamic imports because runtime-env parses process.env at module load.
 */
import {
  AccessTokenRepo,
  ConnectedAccountRepo,
  RunRepo,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceSessionRepo,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceRepo,
  type ConnectedAccountRepoService,
  type Run,
  type RunRepoService,
  type Workspace,
  type WorkspaceAttemptRepoService,
  type WorkspaceBuildJob,
  type WorkspaceBuildJobRepoService,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { TelemetryQuery } from "@sealant/telemetry";
import { newWorkspaceSchema } from "@sealant/validators";
import {
  planWorkspaceImageBuild,
  SealantRuntime,
  type ProcessUserChannel,
  type ProcessUserCheck,
} from "@sealant/workspaces";
import { Effect, Layer, Result } from "effect";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env["SEALANT_SERVICE_KEYS"] = "svc-test";

let workspacesModule: typeof import("./workspaces.module.js");
let sessionsModule: typeof import("../sessions/sessions.module.js");
let capabilities: typeof import("../../services/control-plane-capabilities.js");
let processUser: typeof import("../process-user.js");
let systemModule: typeof import("../system/system.module.js");

beforeAll(async () => {
  workspacesModule = await import("./workspaces.module.js");
  sessionsModule = await import("../sessions/sessions.module.js");
  capabilities = await import("../../services/control-plane-capabilities.js");
  processUser = await import("../process-user.js");
  systemModule = await import("../system/system.module.js");
});

const OWNER = "usr_alice";
const workspace = { id: "wks_1", ownerUserId: OWNER, latestRunId: "run_1" } as Workspace;

const spec = {
  sources: { workspace: { url: "https://github.com/example/repo.git" } },
  harness: { id: "opencode" },
};

const failureOf = <A, E>(result: Result.Result<A, E>): E => {
  if (!Result.isFailure(result)) throw new Error("expected a refusal");
  return result.failure;
};

describe("credentialsHome at create", () => {
  it("takes a home outside /workspace and refuses anything else", async () => {
    const parse = (credentialsHome: unknown) =>
      Effect.runPromise(
        Effect.result(
          workspacesModule.parseWorkspaceSpec({ ...spec, runtime: { credentialsHome } }),
        ),
      );
    const taken = await parse({ path: "/home/m4lice000", uid: 40001, gid: 40000 });
    expect(Result.isSuccess(taken)).toBe(true);
    for (const path of ["/workspace/harness-home", "home/x", "/home/../root"]) {
      expect(failureOf(await parse({ path, uid: 40001, gid: 40000 }))).toMatchObject({
        _tag: "WorkspaceBadRequestError",
      });
    }
    expect(failureOf(await parse({ path: "/home/x", uid: -1, gid: 40000 }))).toMatchObject({
      _tag: "WorkspaceBadRequestError",
    });
    // Not on a runtime that writes logins at $HOME only.
    const onCloudflare = await Effect.runPromise(
      Effect.result(
        workspacesModule.parseWorkspaceSpec({
          ...spec,
          target: { runtime: { family: "cloudflare" } },
          runtime: { credentialsHome: { path: "/home/m4lice000", uid: 40001, gid: 40000 } },
        }),
      ),
    );
    expect(failureOf(onCloudflare)).toMatchObject({ _tag: "WorkspaceBadRequestError" });
  });
});

const captureSource = (extra: Record<string, unknown> = {}) => ({
  kind: "capture",
  endpoint: "https://mend.example.com/session/s1",
  worktreeId: "wt_1",
  ...extra,
});

const parseSpec = (input: unknown) =>
  Effect.runPromise(Effect.result(workspacesModule.parseWorkspaceSpec(input)));

describe("a capture source's owner map at create", () => {
  const ownerMap = { gid: 40000, worktreeUid: 40012, people: [{ id: "acct_a", uid: 40012 }] };

  it("takes a valid map, and answers 400 with the reason for a bad one", async () => {
    expect(
      Result.isSuccess(
        await parseSpec({ ...spec, sources: { workspace: captureSource({ ownerMap }) } }),
      ),
    ).toBe(true);
    for (const [bad, reason] of [
      [{ ...ownerMap, gid: 0 }, /gid must be 40000/],
      [{ ...ownerMap, people: [{ id: "acct_a", uid: 0 }] }, /uid 0/],
      [
        {
          ...ownerMap,
          people: [
            { id: "acct_a", uid: 40012 },
            { id: "acct_b", uid: 40012 },
          ],
        },
        /the same uid/,
      ],
    ] as const) {
      const refused = failureOf(
        await parseSpec({ ...spec, sources: { workspace: captureSource({ ownerMap: bad }) } }),
      );
      expect(refused).toMatchObject({ _tag: "WorkspaceBadRequestError" });
      expect(String(refused.message)).toMatch(reason);
    }
  });

  it("is refused on Kubernetes, saying why", async () => {
    for (const family of ["k8s", "k3s"]) {
      const refused = failureOf(
        await parseSpec({
          ...spec,
          sources: { workspace: captureSource({ ownerMap }) },
          target: { runtime: { family } },
        }),
      );
      expect(refused).toMatchObject({ _tag: "WorkspaceBadRequestError" });
      expect(String(refused.message)).toContain("allowPrivilegeEscalation: false");
    }
  });

  it("is refused on Cloudflare, and never through runtime.env", async () => {
    const onCloudflare = failureOf(
      await parseSpec({
        ...spec,
        sources: { workspace: captureSource({ ownerMap }) },
        target: { runtime: { family: "cloudflare" } },
      }),
    );
    expect(onCloudflare).toMatchObject({ _tag: "WorkspaceBadRequestError" });
    const smuggled = failureOf(
      await parseSpec({
        ...spec,
        sources: { workspace: captureSource() },
        runtime: { env: { SEALANT_CAPTURE_OWNER_MAP: '{"gid":40000,"worktree":40001}' } },
      }),
    );
    expect(smuggled).toMatchObject({ _tag: "WorkspaceBadRequestError" });
    expect(String(smuggled.message)).toContain("SEALANT_CAPTURE_OWNER_MAP");
    // The review's payload: the name and an `=` inside the key, which Docker would split.
    const split = failureOf(
      await parseSpec({
        ...spec,
        sources: { workspace: captureSource({ ownerMap }) },
        runtime: {
          env: {
            'SEALANT_CAPTURE_OWNER_MAP={"gid":40000,"worktree":1000,"people":{"x': '":1000}}',
          },
        },
      }),
    );
    expect(split).toMatchObject({ _tag: "WorkspaceBadRequestError" });
    expect(String(split.message)).toMatch(/runtime\.env names must match/);
    // Every other caller lane already refuses the platform prefix.
    const throughUserEnv = failureOf(
      await parseSpec({
        ...spec,
        runtime: { userEnv: { SEALANT_CAPTURE_OWNER_MAP: "{}" } },
      }),
    );
    expect(String(throughUserEnv.message)).toMatch(/reserved/);
  });
});

describe("a process as a Linux user", () => {
  const instance = {
    runId: "run_1",
    status: "ready",
    adapter: "docker",
    resourceId: "container-1",
    reference: "container-1",
    endpoint: null,
  } as unknown as WorkspaceRuntimeInstance;

  const runRow = (input: { id: string; processUser?: string }): Run => ({
    id: input.id,
    workspaceId: workspace.id,
    attemptId: null,
    ownerUserId: OWNER,
    harnessId: "exec",
    mode: "one-shot",
    status: "queued",
    prompt: null,
    command: null,
    metadata: null,
    processUser: input.processUser ?? null,
    exitCode: null,
    errorMessage: null,
    diff: null,
    changedFiles: null,
    changesReadFailedAt: null,
    recordDeletedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  /** A world with a ready executor, a channel that answers `answer`, and what was asked of it. */
  const world = (
    answer: ProcessUserCheck | "fails",
    options: { readonly adapter?: string; readonly ready?: boolean } = {},
  ) => {
    const checked: string[] = [];
    const created: Array<{ processUser?: string }> = [];
    const published: Array<{ user?: string; checkedExecutorRunId?: string }> = [];
    const opened: unknown[] = [];
    const channel: ProcessUserChannel = {
      check: (_target, user) => {
        checked.push(user);
        return answer === "fails"
          ? Effect.fail(new Error("bridge closed"))
          : Effect.succeed(answer);
      },
    };
    const layer = Layer.mergeAll(
      Layer.succeed(WorkspaceRepo, {
        getWorkspaceById: (id: string) =>
          Effect.succeed(id === workspace.id ? workspace : undefined),
      } as unknown as WorkspaceRepoService),
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        getRuntimeInstanceByRunId: () =>
          Effect.succeed(
            options.ready === false
              ? undefined
              : { ...instance, adapter: options.adapter ?? instance.adapter },
          ),
      } as unknown as WorkspaceRuntimeInstanceRepoService),
      Layer.succeed(RunRepo, {
        createRun: (input: { id: string; processUser?: string }) => {
          created.push(input.processUser === undefined ? {} : { processUser: input.processUser });
          return Effect.succeed(runRow(input));
        },
      } as unknown as RunRepoService),
      Layer.succeed(capabilities.RunExecPublisherService, {
        publishRequested: (input: { user?: string; checkedExecutorRunId?: string }) => {
          published.push(
            input.user === undefined
              ? {}
              : { user: input.user, checkedExecutorRunId: input.checkedExecutorRunId ?? "" },
          );
          return Promise.resolve();
        },
      }),
      Layer.succeed(ConnectedAccountRepo, {} as unknown as ConnectedAccountRepoService),
      Layer.succeed(AccessTokenRepo, {} as never),
      Layer.succeed(SealantRuntime, {
        connect: () => Effect.die("only the channel reaches the daemon here"),
      } as never),
      Layer.succeed(TelemetryQuery, {} as never),
      Layer.succeed(WorkspaceAttemptRepo, {
        getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
      } as never),
      Layer.succeed(WorkspaceSessionRepo, {
        createSession: (input: unknown) => {
          opened.push(input);
          return Effect.die("stop once the session row is made");
        },
      } as never),
    );
    const exec = (user: string | undefined, asUser = true) =>
      Effect.runPromise(
        Effect.result(
          workspacesModule
            .execWorkspace({
              workspaceId: workspace.id,
              payload: {
                ownerUserId: OWNER,
                ...(user === undefined ? {} : { user }),
                commands: [{ executable: "id", args: [] }],
              },
              processUserChannel: channel,
              asUser,
            })
            .pipe(Effect.provide(layer)),
        ),
      );
    const session = (user: string, asUser = true) =>
      Effect.runPromiseExit(
        sessionsModule
          .createSession({
            headers: { authorization: "Bearer svc-test" },
            payload: { workspaceId: workspace.id, ownerUserId: OWNER, argv: ["bash"], user },
            processUserChannel: channel,
            asUser,
          })
          .pipe(Effect.provide(layer)),
      );
    return { exec, session, checked, created, published, opened };
  };

  const allowed: ProcessUserCheck = { supported: true, exitCode: 0 };
  const noCapability: ProcessUserCheck = { supported: false, exitCode: undefined };

  beforeEach(() => processUser.forgetProcessUserAnswers());

  it("refuses root and a uid outside the range before the executor is asked", async () => {
    for (const user of ["root", "0", "1000", "50000"]) {
      const w = world(allowed);
      const refused = failureOf(await w.exec(user));
      expect(refused).toMatchObject({ _tag: "WorkspaceConflictError", code: "user-unsupported" });
      expect(String(refused.message)).toContain(`User '${user}' is not in range`);
      expect(w.checked).toEqual([]);
      expect(w.created).toEqual([]);
    }
  });

  it("refuses an exec where the workspace's sealantd does not report exec.user", async () => {
    const w = world(noCapability);
    const refused = failureOf(await w.exec("m4lice000"));
    expect(refused).toMatchObject({ _tag: "WorkspaceConflictError", code: "user-unsupported" });
    expect(String(refused.message)).toBe(
      "Workspace wks_1's sealantd doesn't run processes as another user (its sealantd does not report exec.user), so nothing was started as 'm4lice000'.",
    );
    expect(w.created).toEqual([]);
    expect(w.published).toEqual([]);
  });

  it("refuses, by reason, a user the executor finds out of range or missing", async () => {
    const cases = [
      [95, "User 'm4lice000' is not in range (its uid is outside 40001–49999)"],
      [96, "User 'm4lice000' is not in range (its primary group is not mend (40000))"],
      [90, "User 'm4lice000' is not in workspace wks_1"],
    ] as const;
    for (const [exitCode, words] of cases) {
      const w = world({ supported: true, exitCode });
      const refused = failureOf(await w.exec("m4lice000"));
      expect(refused).toMatchObject({ _tag: "WorkspaceConflictError", code: "user-unsupported" });
      expect(String(refused.message)).toContain(words);
      expect(w.created).toEqual([]);
    }
  });

  it("refuses on Cloudflare, and answers 409 workspace-not-running with no executor", async () => {
    const cloudflare = world(allowed, { adapter: "cloudflare" });
    const refused = failureOf(await cloudflare.exec("m4lice000"));
    expect(refused).toMatchObject({ code: "user-unsupported" });
    expect(String(refused.message)).toContain("doesn't run processes as another user");
    expect(cloudflare.checked).toEqual([]);

    const stopped = world(allowed, { ready: false });
    expect(failureOf(await stopped.exec("m4lice000"))).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "workspace-not-running",
    });
  });

  it("answers 502 when the executor does not answer, and starts nothing", async () => {
    const w = world("fails");
    expect(failureOf(await w.exec("m4lice000"))).toMatchObject({
      _tag: "WorkspaceBadGatewayError",
    });
    expect(w.created).toEqual([]);
  });

  it("runs an allowed exec as the user, recorded on the run, and asks once per executor", async () => {
    const w = world(allowed);
    const first = await w.exec("m4lice000");
    expect(Result.isSuccess(first) ? first.success.user : undefined).toBe("m4lice000");
    await w.exec("m4lice000");
    expect(w.checked).toEqual(["m4lice000"]);
    expect(w.created).toEqual([{ processUser: "m4lice000" }, { processUser: "m4lice000" }]);
    // On the as-user queue, naming the executor the user was checked on.
    expect(w.published).toEqual([
      { user: "m4lice000", checkedExecutorRunId: "run_1" },
      { user: "m4lice000", checkedExecutorRunId: "run_1" },
    ]);
  });

  it("refuses a user on the plain routes, which an older control plane would ignore", async () => {
    const w = world(allowed);
    const refused = failureOf(await w.exec("m4lice000", false));
    expect(refused).toMatchObject({ _tag: "WorkspaceConflictError", code: "user-unsupported" });
    expect(String(refused.message)).toContain("POST /v1/workspaces/wks_1/exec-as-user");
    const session = await w.session("m4lice000", false);
    expect(JSON.stringify(session)).toContain("POST /v1/sessions/as-user");
    expect(w.checked).toEqual([]);
    expect(w.created).toEqual([]);
    expect(w.published).toEqual([]);
  });

  it("asks nothing for an exec without a user", async () => {
    const w = world(noCapability);
    const ran = await w.exec(undefined);
    expect(Result.isSuccess(ran)).toBe(true);
    expect(w.checked).toEqual([]);
    expect(w.created).toEqual([{}]);
    expect(w.published).toEqual([{}]);
  });

  it("refuses a session as a user the same way, before the run exists", async () => {
    const root = world(allowed);
    const refusedRoot = await root.session("root");
    expect(JSON.stringify(refusedRoot)).toContain("user-unsupported");
    expect(root.checked).toEqual([]);

    const old = world(noCapability);
    const refused = await old.session("40001");
    expect(JSON.stringify(refused)).toContain("SessionConflictError");
    expect(JSON.stringify(refused)).toContain("doesn't run processes as another user");
    expect(old.created).toEqual([]);
  });

  it("records an allowed session's user on its run", async () => {
    const w = world(allowed);
    await w.session("m4lice000");
    expect(w.checked).toEqual(["m4lice000"]);
    expect(w.created).toEqual([{ processUser: "m4lice000" }]);
  });
});

describe("a session as a user, on the connection that opens it", () => {
  it("asks the daemon again and opens nothing when it does not report exec.user", async () => {
    processUser.forgetProcessUserAnswers();
    const settled: string[] = [];
    let openCalls = 0;
    const daemon = {
      capabilities: Effect.succeed({ supports: ["restore.owner_map"] }),
      openSession: () => {
        openCalls += 1;
        return Effect.die("never opened");
      },
    };
    const layer = Layer.mergeAll(
      Layer.succeed(WorkspaceRepo, {
        getWorkspaceById: () => Effect.succeed(workspace),
      } as unknown as WorkspaceRepoService),
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        getRuntimeInstanceByRunId: () =>
          Effect.succeed({
            runId: "run_1",
            status: "ready",
            adapter: "docker",
            resourceId: "container-1",
            reference: "container-1",
            endpoint: null,
          }),
      } as unknown as WorkspaceRuntimeInstanceRepoService),
      Layer.succeed(WorkspaceAttemptRepo, {
        getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
      } as never),
      Layer.succeed(RunRepo, {
        createRun: () => Effect.succeed({}),
        markRunRunning: () => Effect.succeed({}),
        markRunFailed: (input: { errorMessage: string }) =>
          Effect.sync(() => {
            settled.push(`run: ${input.errorMessage}`);
            return null;
          }),
      } as unknown as RunRepoService),
      Layer.succeed(WorkspaceSessionRepo, {
        createSession: () => Effect.succeed({}),
        markSessionEnded: (input: { status: string }) =>
          Effect.sync(() => {
            settled.push(`session: ${input.status}`);
            return null;
          }),
      } as never),
      Layer.succeed(TelemetryQuery, { hasEpoch: () => Effect.succeed(true) } as never),
      Layer.succeed(SealantRuntime, { connect: () => Effect.succeed(daemon) } as never),
      Layer.succeed(AccessTokenRepo, {} as never),
    );
    // The check (or a kept yes) said the executor can; the daemon reached to open it cannot.
    const exit = await Effect.runPromiseExit(
      sessionsModule
        .createSession({
          headers: { authorization: "Bearer svc-test" },
          payload: {
            workspaceId: workspace.id,
            ownerUserId: OWNER,
            argv: ["bash"],
            user: "m4lice000",
          },
          processUserChannel: { check: () => Effect.succeed({ supported: true, exitCode: 0 }) },
          asUser: true,
        })
        .pipe(Effect.provide(layer)),
    );
    expect(JSON.stringify(exit)).toContain("SessionConflictError");
    expect(JSON.stringify(exit)).toContain("doesn't run processes as another user");
    expect(openCalls).toBe(0);
    expect(settled).toEqual([
      expect.stringContaining("run: Workspace wks_1's sealantd doesn't run processes"),
      "session: failed",
    ]);
  });
});

describe("the control plane's features", () => {
  it("reports that it passes users through, and the per-person APIs it has", async () => {
    const index = await Effect.runPromise(systemModule.getIndex());
    expect(index.features).toEqual({
      // False on purpose: older SDKs read it as leave to send `user` on the plain routes.
      processUser: false,
      processUserRoutes: true,
      dotfilesApply: true,
      credentialsPartialPut: true,
      credentialsPiOpencode: true,
      captureOwnerMap: true,
      workspaceSshUser: true,
    });
  });
});

describe("inspectWorkspaceImage", () => {
  // The plan the build would make of this spec.
  const planHash = planWorkspaceImageBuild({ blueprint: newWorkspaceSchema.parse(spec) }).planHash;

  const job = (probe: unknown) =>
    ({
      id: "job_1",
      runId: "run_built",
      status: "succeeded",
      publishedReference: "registry/sealant/workspaces/demo:plan-abc",
      publishedDigestReference: "registry/sealant/workspaces/demo@sha256:abc",
      publishedDigest: "sha256:abc",
      resultPayload: {
        metadata: { planHash, ...(probe === undefined ? {} : { imageProbe: probe }) },
      },
    }) as unknown as WorkspaceBuildJob;

  const inspect = (found: WorkspaceBuildJob | undefined, builtBy: string = OWNER) =>
    Effect.runPromise(
      workspacesModule
        .inspectWorkspaceImage({
          payload: { ownerUserId: OWNER, registryId: "default", spec },
        })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(WorkspaceBuildJobRepo, {
                getLatestSucceededJobByPlanHash: (input: { planHash: string }) =>
                  Effect.succeed(input.planHash === planHash ? found : undefined),
              } as unknown as WorkspaceBuildJobRepoService),
              Layer.succeed(WorkspaceAttemptRepo, {
                getAttemptById: () => Effect.succeed({ ownerUserId: builtBy }),
              } as unknown as WorkspaceAttemptRepoService),
            ),
          ),
        ),
    );

  // The image probe a managed image records (#327), able to run the layout.
  const capable = {
    version: 1,
    tools: {
      sudo: true,
      sudoSetuid: true,
      useradd: true,
      groupadd: true,
      setfacl: true,
      getfacl: true,
      setpriv: true,
      flock: true,
    },
    sudoersMend: true,
    sudoersIncludesDir: true,
    noNewPrivileges: false,
    passwdWritable: true,
    mendGroup: "present",
    reservedIdsInUse: [],
    personEnv: true,
    sharedDirs: [],
    sealantd: { supports: ["dotfiles.user", "exec.user", "restore.owner_map"] },
  };
  const withoutSetpriv = { ...capable, tools: { ...capable.tools, setpriv: false } };

  it("answers the plan's image and what it lacks, before any create", async () => {
    const answer = await inspect(job(withoutSetpriv));
    expect(answer.planHash).toBe(planHash);
    expect(answer.publishedImage?.digest).toBe("sha256:abc");
    expect(answer.personLayout).toMatchObject({ status: "unsupported", missing: ["setpriv"] });
  });

  it("is unknown, never supported, while ACL support is undeclared or nothing is built", async () => {
    expect((await inspect(job(capable))).personLayout).toMatchObject({
      status: "unknown",
      missing: [],
      unknown: ["acl"],
      acl: "unknown",
    });
    expect((await inspect(job(undefined))).personLayout.status).toBe("unknown");
    const none = await inspect(undefined);
    expect(none.publishedImage).toBeUndefined();
    expect(none.personLayout.status).toBe("unknown");
  });

  it("names the image only to the owner who built it", async () => {
    const answer = await inspect(job(withoutSetpriv), "usr_bob");
    expect(answer.publishedImage).toBeUndefined();
    expect(answer.personLayout.status).toBe("unsupported");
  });
});
