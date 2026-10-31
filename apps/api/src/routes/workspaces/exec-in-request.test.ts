/**
 * An exec run in its request (`execWorkspaceInRequest`): after `execWorkspace`'s admission the run
 * is created, claimed and recorded inside the request, never queued, and the settled run comes
 * back. Its checks have their own bound; its budget covers the run: past it no further command is
 * sent and the run fails. Driven against the telemetry package's scripted workspace and typed
 * repositories. A service key is configured before the dynamic import because runtime-env parses
 * process.env at module load.
 */
import { credentialCipherLayer } from "@sealant/credentials";
import {
  FAKE_WORKSPACE_ID,
  fakeExecWorld,
  type FakeExecWorldOptions,
  fakeWorkspaceRepos,
} from "@sealant/telemetry/testing";
import { Duration, Effect, Layer, Result } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env["SEALANT_SERVICE_KEYS"] = "svc-test";

let workspacesModule: typeof import("./workspaces.module.js");

beforeAll(async () => {
  workspacesModule = await import("./workspaces.module.js");
});

const OWNER = "usr_alice";
const KEY = Buffer.alloc(32, 7).toString("base64");
type Bounds = Partial<Record<"admission" | "budget" | "syncBack", Duration.Input>>;

const world = (
  options: FakeExecWorldOptions & { readonly ready?: boolean; readonly answers?: boolean } = {},
) => {
  const exec = fakeExecWorld(options);
  const layer = Layer.mergeAll(
    exec.layer,
    credentialCipherLayer({ key: KEY }),
    fakeWorkspaceRepos(OWNER, {
      ...(options.ready === undefined ? {} : { ready: options.ready }),
      ...(options.answers === undefined ? {} : { answers: options.answers }),
    }),
  );
  const run = (args: readonly string[], bounds?: Bounds, module = workspacesModule) =>
    Effect.runPromise(
      Effect.result(
        module
          .execWorkspaceInRequest({
            workspaceId: FAKE_WORKSPACE_ID,
            payload: {
              ownerUserId: OWNER,
              commands: args.map((arg) => ({ executable: "check", args: [arg] })),
            },
            ...(bounds === undefined ? {} : { bounds }),
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

  it("past its budget sends no further command, and answers with the failed run", async () => {
    const w = world();
    const answered = await w.run(["hang", "0"], { budget: "150 millis", syncBack: "50 millis" });
    if (!Result.isSuccess(answered)) throw new Error("expected the settled run");
    const runId = answered.success.runId;
    expect(answered.success).toMatchObject({
      status: "failed",
      errorMessage: `Run ${runId} ran past its budget: no further command was sent, and one already started may still be running.`,
    });
    expect(w.sent.map((exec) => exec.args)).toEqual([["hang"]]);
  });

  it("whose checks do not answer in time is refused, naming no run, and nothing is created", async () => {
    const w = world({ answers: false });
    const answered = await w.run(["0"], { admission: "50 millis" });
    if (!Result.isFailure(answered)) throw new Error("expected a refusal");
    expect(answered.failure).toMatchObject({
      _tag: "WorkspaceBadGatewayError",
      message: `Workspace ${FAKE_WORKSPACE_ID} did not answer the exec's checks in time; nothing was started.`,
    });
    expect(w.steps).toEqual([]);
  });

  it("without a ready executor is refused before any run exists", async () => {
    const w = world({ ready: false });
    const answered = await w.run(["0"]);
    if (!Result.isFailure(answered)) throw new Error("expected a refusal");
    expect(answered.failure).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "workspace-not-running",
      message: `Workspace ${FAKE_WORKSPACE_ID} has no running executor to exec in.`,
    });
    expect(w.steps).toEqual([]);
  });

  it("answers each failure of the record with what the caller may do", async () => {
    const failureOf = async (options: FakeExecWorldOptions) => {
      const w = world(options);
      const answered = await w.run(["0"]);
      if (!Result.isFailure(answered)) throw new Error("expected a failure");
      return { failure: answered.failure, runId: w.row()?.id ?? "" };
    };
    const notCreated = await failureOf({ failCreate: true });
    expect(notCreated.failure).toMatchObject({
      _tag: "WorkspaceInternalServerError",
      message: "The exec run could not be created; nothing ran, so it is safe to ask again.",
    });
    const unsettled = await failureOf({ failTerminalWrites: true });
    expect(unsettled.failure).toMatchObject({
      _tag: "WorkspaceInternalServerError",
      message: `Exec run ${unsettled.runId}'s outcome could not be recorded, and its commands may have run; do not run them again.`,
    });
    const unreadable = await failureOf({ failRead: true });
    expect(unreadable.failure).toMatchObject({
      _tag: "WorkspaceInternalServerError",
      message: `Exec run ${unreadable.runId} settled but could not be read back; its commands may have run, so read it at GET /v1/runs/${unreadable.runId} rather than running them again.`,
    });
  });
});

/** The module as an API started with or without SEALANT_CREDENTIALS_KEY reads its config. */
const moduleWithKey = async (key: string | undefined) => {
  vi.resetModules();
  if (key === undefined) delete process.env["SEALANT_CREDENTIALS_KEY"];
  else process.env["SEALANT_CREDENTIALS_KEY"] = key;
  return import("./workspaces.module.js");
};

describe("the credential sync-back after an exec in its request", () => {
  it("runs when the credentials key is configured", async () => {
    const w = world();
    const answered = await w.run(["0"], undefined, await moduleWithKey(KEY));
    expect(Result.isSuccess(answered)).toBe(true);
    expect(w.steps).toContain("sync-back");
  });

  it("does not run without the key, though the API always has a cipher", async () => {
    const w = world();
    const answered = await w.run(["0"], undefined, await moduleWithKey(undefined));
    expect(Result.isSuccess(answered)).toBe(true);
    expect(w.steps).not.toContain("sync-back");
  });
});
