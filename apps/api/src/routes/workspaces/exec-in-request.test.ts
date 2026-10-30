/**
 * An exec run in its request (`execWorkspaceInRequest`): after `execWorkspace`'s admission the run
 * is created, claimed and recorded inside the request, never queued, and the settled run comes
 * back. One budget covers the whole request: past it no further command is sent and the run
 * fails. Driven against the telemetry package's scripted workspace and typed repositories. A
 * service key is configured before the dynamic import because runtime-env parses process.env at
 * module load.
 */
import {
  FAKE_WORKSPACE_ID,
  fakeExecWorld,
  type FakeExecWorldOptions,
  fakeWorkspaceRepos,
} from "@sealant/telemetry/testing";
import { Duration, Effect, Layer, Result } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_SERVICE_KEYS"] = "svc-test";

let workspacesModule: typeof import("./workspaces.module.js");

beforeAll(async () => {
  workspacesModule = await import("./workspaces.module.js");
});

const OWNER = "usr_alice";
const world = (options: FakeExecWorldOptions = {}) => {
  const exec = fakeExecWorld(options);
  const layer = Layer.mergeAll(exec.layer, fakeWorkspaceRepos(OWNER));
  const run = (args: readonly string[], budget?: Duration.Input) =>
    Effect.runPromise(
      Effect.result(
        workspacesModule
          .execWorkspaceInRequest({
            workspaceId: FAKE_WORKSPACE_ID,
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
