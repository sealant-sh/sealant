/**
 * Mend ADR 0016's surface on create, exec and sessions: a `credentialsHome` follows the home rules;
 * a process asked to run as a Linux user is refused (`user-unsupported`) before anything starts,
 * never run as the workspace's own user, while no released sealantd can start one as another user;
 * and an image's per-person capability is readable before create. A service key is configured
 * before the dynamic imports because runtime-env parses process.env at module load.
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
  type RunRepoService,
  type Workspace,
  type WorkspaceAttemptRepoService,
  type WorkspaceBuildJob,
  type WorkspaceBuildJobRepoService,
  type WorkspaceRepoService,
} from "@sealant/db";
import { TelemetryQuery } from "@sealant/telemetry";
import { newWorkspaceSchema } from "@sealant/validators";
import { planWorkspaceImageBuild, SealantRuntime } from "@sealant/workspaces";
import { Effect, Layer, Result } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_SERVICE_KEYS"] = "svc-test";

let workspacesModule: typeof import("./workspaces.module.js");
let sessionsModule: typeof import("../sessions/sessions.module.js");
let capabilities: typeof import("../../services/control-plane-capabilities.js");

beforeAll(async () => {
  workspacesModule = await import("./workspaces.module.js");
  sessionsModule = await import("../sessions/sessions.module.js");
  capabilities = await import("../../services/control-plane-capabilities.js");
});

const OWNER = "usr_alice";
const workspace = { id: "wks_1", ownerUserId: OWNER, latestRunId: "run_1" } as Workspace;

const spec = {
  sources: { workspace: { url: "https://github.com/example/repo.git" } },
  harness: { id: "opencode" },
};

const untouched = Effect.die("nothing may be started for a refused user");

const repos = () =>
  Layer.mergeAll(
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: (id: string) => Effect.succeed(id === workspace.id ? workspace : undefined),
    } as unknown as WorkspaceRepoService),
    Layer.succeed(RunRepo, { createRun: () => untouched } as unknown as RunRepoService),
    Layer.succeed(ConnectedAccountRepo, {} as unknown as ConnectedAccountRepoService),
    // Never reached by a refused request: anything touching them fails the test.
    Layer.succeed(AccessTokenRepo, {} as never),
    Layer.succeed(SealantRuntime, {} as never),
    Layer.succeed(TelemetryQuery, {} as never),
    Layer.succeed(WorkspaceAttemptRepo, {} as never),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {} as never),
    Layer.succeed(WorkspaceSessionRepo, {} as never),
    Layer.succeed(capabilities.RunExecPublisherService, {} as never),
  );

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
  it("refuses an exec as a user before any run is made", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        workspacesModule
          .execWorkspace({
            workspaceId: workspace.id,
            payload: {
              ownerUserId: OWNER,
              user: "m4lice000",
              commands: [{ executable: "id", args: [] }],
            },
          })
          .pipe(Effect.provide(repos())),
      ),
    );
    expect(failureOf(result)).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "user-unsupported",
    });
  });

  it("refuses a session as a user before the daemon is reached", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        sessionsModule
          .createSession({
            headers: { authorization: "Bearer svc-test" },
            payload: {
              workspaceId: workspace.id,
              ownerUserId: OWNER,
              argv: ["bash"],
              user: "40001",
            },
          })
          .pipe(Effect.provide(repos())),
      ),
    );
    expect(failureOf(result)).toMatchObject({
      _tag: "SessionConflictError",
      code: "user-unsupported",
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
