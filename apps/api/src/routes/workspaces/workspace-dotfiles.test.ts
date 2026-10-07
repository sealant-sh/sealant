import {
  WorkspaceBadGatewayError,
  WorkspaceBadRequestError,
  WorkspaceInternalServerError,
  WorkspaceNotFoundError,
} from "@sealant/api-contracts";
/**
 * `POST /v1/workspaces/:id/dotfiles` (docs/connected-accounts-design.md §6g): a person's dotfiles
 * applied as their user. The request is checked before the executor is reached (never root, a home
 * Core writes into, something to apply), the daemon must report `dotfiles.user`, the stage script's
 * refusals become stable codes, the archives go over stdin (never into the script or the job), and
 * a `dotfiles` run is queued naming only the staged directory. Driven against fake repositories, a
 * recording stage channel and a recording publisher; nothing reaches an executor.
 */
import type { Run, RunRepoService, Workspace, WorkspaceRuntimeInstance } from "@sealant/db";
import { RunRepo, WorkspaceRepo, WorkspaceRuntimeInstanceRepo } from "@sealant/db";
import type {
  DotfilesStageChannel,
  DotfilesStageResult,
  RunDotfilesApply,
} from "@sealant/workspaces";
import { DOTFILES_STAGE_EXIT, dotfilesStagePath } from "@sealant/workspaces";
import { Effect, Layer, Result } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

let routes: typeof import("./workspace-dotfiles.js");
let RunExecPublisherService: (typeof import("../../services/control-plane-capabilities.js"))["RunExecPublisherService"];

beforeAll(async () => {
  routes = await import("./workspace-dotfiles.js");
  ({ RunExecPublisherService } = await import("../../services/control-plane-capabilities.js"));
});

const OWNER = "usr_owner";
const HOME = "/home/m4lice000";
const workspace = { id: "wks_1", ownerUserId: OWNER, latestRunId: "run_launch" } as Workspace;
const instance = {
  runId: "run_launch",
  status: "ready",
  adapter: "docker",
  resourceId: "container-1",
  reference: "container-1",
  endpoint: "unix:///run/sealant/run_launch.sock",
} as WorkspaceRuntimeInstance;

const runRow = (input: { readonly id: string; readonly harnessId: string }): Run => ({
  id: input.id,
  workspaceId: workspace.id,
  attemptId: null,
  ownerUserId: OWNER,
  harnessId: input.harnessId,
  mode: "one-shot",
  status: "queued",
  prompt: null,
  command: null,
  metadata: null,
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

const newWorld = (stage: Partial<DotfilesStageResult> | "throw" = {}) => {
  const staged: Array<{ readonly script: string; readonly stdin: string }> = [];
  const cleanups: string[] = [];
  const created: Run[] = [];
  const failedRuns: string[] = [];
  const published: Array<{ readonly runId: string; readonly dotfiles?: RunDotfilesApply }> = [];
  let publishFails = false;
  const channel: DotfilesStageChannel = {
    stage: (_target, script, stdin) =>
      Effect.suspend(() => {
        if (stage === "throw") return Effect.fail(new Error("the daemon did not answer"));
        staged.push({ script, stdin });
        return Effect.succeed({ supported: true, exitCode: 0, ...stage });
      }),
    run: (_target, script) =>
      Effect.sync(() => {
        cleanups.push(script);
        return 0;
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: (id: string) => Effect.succeed(id === workspace.id ? workspace : undefined),
    } as never),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: (runId: string) =>
        Effect.succeed(runId === instance.runId ? instance : undefined),
    } as never),
    Layer.succeed(RunRepo, {
      createRun: (input: { readonly id: string; readonly harnessId: string }) =>
        Effect.sync(() => {
          const row = runRow(input);
          created.push(row);
          return row;
        }),
      markRunFailed: (input: { readonly id: string }) =>
        Effect.sync(() => {
          failedRuns.push(input.id);
          return null;
        }),
    } as unknown as RunRepoService),
    Layer.succeed(RunExecPublisherService, {
      publishRequested: (input) => {
        if (publishFails) return Promise.reject(new Error("queue down"));
        published.push(input);
        return Promise.resolve();
      },
    }),
  );
  const apply = (
    payload: Partial<Parameters<typeof routes.applyWorkspaceDotfiles>[0]["payload"]>,
  ) =>
    Effect.runPromise(
      Effect.result(
        routes
          .applyWorkspaceDotfiles({
            workspaceId: workspace.id,
            payload: { ownerUserId: OWNER, user: "m4lice000", home: HOME, ...payload },
            stageChannel: channel,
          })
          .pipe(Effect.provide(layer)),
      ),
    );
  return {
    apply,
    staged,
    cleanups,
    created,
    failedRuns,
    published,
    failPublish: () => {
      publishFails = true;
    },
  };
};

const succeeded = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`refused: ${JSON.stringify(result.failure)}`);
  return result.success;
};
const failed = <A, E>(result: Result.Result<A, E>): E => {
  if (!Result.isFailure(result)) throw new Error("expected a refusal");
  return result.failure;
};

const ARCHIVE = Buffer.from("a dotfiles archive, secret-ish", "utf8").toString("base64");

describe("applyWorkspaceDotfiles", () => {
  it("stages the archives over stdin, queues a dotfiles run naming only the staged directory", async () => {
    const world = newWorld();
    const run = succeeded(
      await world.apply({
        archives: [{ data: ARCHIVE, manager: "copy" }],
        repository: { url: "https://github.com/acme/dots.git", ref: "main" },
      }),
    );
    expect(run.harnessId).toBe("dotfiles");
    expect(run.status).toBe("queued");
    expect(world.staged).toHaveLength(1);
    const [stage] = world.staged;
    // The bytes go over stdin; the script names the user, the home and the run's staging id only.
    expect(stage?.script).not.toContain(ARCHIVE);
    expect(stage?.script).toContain("user='m4lice000'");
    expect(stage?.script).toContain(`home='${HOME}'`);
    expect(stage?.script).toContain(run.runId);
    expect(stage?.stdin.split("\n")).toContain(ARCHIVE);
    expect(world.published).toEqual([
      {
        runId: run.runId,
        dotfiles: {
          user: "m4lice000",
          home: HOME,
          archiveDir: dotfilesStagePath(run.runId),
          repository: {
            url: "https://github.com/acme/dots.git",
            reference: "main",
            bootstrap: true,
          },
        },
      },
    ]);
    // Nothing of an archive reaches the job.
    expect(JSON.stringify(world.published)).not.toContain(ARCHIVE);
    expect(world.cleanups).toEqual([]);
  });

  it("applies a repository alone with nothing staged", async () => {
    const world = newWorld();
    const run = succeeded(
      await world.apply({
        repository: { url: "https://github.com/acme/dots.git", bootstrap: false },
      }),
    );
    expect(world.staged[0]?.stdin).toBe("");
    expect(world.published[0]?.dotfiles).toEqual({
      user: "m4lice000",
      home: HOME,
      repository: { url: "https://github.com/acme/dots.git", bootstrap: false },
    });
    expect(run.runId.startsWith("run_")).toBe(true);
  });

  it("refuses root, a home under /workspace and an empty apply before reaching the executor", async () => {
    const world = newWorld();
    for (const payload of [
      { user: "root", archives: [{ data: ARCHIVE }] },
      { user: "0", archives: [{ data: ARCHIVE }] },
      { home: "/workspace/home/m", archives: [{ data: ARCHIVE }] },
      { home: "/home/../root", archives: [{ data: ARCHIVE }] },
      {},
    ]) {
      const refusal = failed(await world.apply(payload));
      expect(refusal).toBeInstanceOf(WorkspaceBadRequestError);
    }
    expect(world.staged).toEqual([]);
    expect(world.created).toEqual([]);
  });

  it("answers dotfiles-user-unsupported when the daemon cannot apply as a user", async () => {
    const world = newWorld({ supported: false, exitCode: undefined });
    const refusal = failed(await world.apply({ archives: [{ data: ARCHIVE }] }));
    expect(refusal).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "dotfiles-user-unsupported",
    });
    expect(world.created).toEqual([]);
  });

  it("names the stage script's refusals with stable codes and queues nothing", async () => {
    for (const [exitCode, code] of [
      [DOTFILES_STAGE_EXIT.unknownUser, "user-unknown"],
      [DOTFILES_STAGE_EXIT.rootUser, "user-root"],
      [DOTFILES_STAGE_EXIT.homeMismatch, "home-mismatch"],
      [DOTFILES_STAGE_EXIT.homeUnusable, "home-unusable"],
    ] as const) {
      const world = newWorld({ exitCode });
      const refusal = failed(await world.apply({ archives: [{ data: ARCHIVE }] }));
      expect(refusal).toMatchObject({ _tag: "WorkspaceConflictError", code });
      expect(world.created).toEqual([]);
      expect(world.published).toEqual([]);
    }
  });

  it("answers a bad gateway when the executor does not confirm the staging", async () => {
    const world = newWorld("throw");
    expect(failed(await world.apply({ archives: [{ data: ARCHIVE }] }))).toBeInstanceOf(
      WorkspaceBadGatewayError,
    );
    const odd = newWorld({ exitCode: 1 });
    expect(failed(await odd.apply({ archives: [{ data: ARCHIVE }] }))).toBeInstanceOf(
      WorkspaceBadGatewayError,
    );
  });

  it("removes the staged archives and fails the run when the job is not enqueued", async () => {
    const world = newWorld();
    world.failPublish();
    const refusal = failed(await world.apply({ archives: [{ data: ARCHIVE }] }));
    expect(refusal).toBeInstanceOf(WorkspaceInternalServerError);
    const runId = world.created[0]?.id ?? "";
    expect(world.cleanups).toEqual([`rm -rf -- '${dotfilesStagePath(runId)}'`]);
    expect(world.failedRuns).toEqual([runId]);
  });

  it("answers another owner's workspace as not found", async () => {
    const world = newWorld();
    const refusal = failed(
      await world.apply({ ownerUserId: "usr_someone_else", archives: [{ data: ARCHIVE }] }),
    );
    expect(refusal).toBeInstanceOf(WorkspaceNotFoundError);
  });
});
