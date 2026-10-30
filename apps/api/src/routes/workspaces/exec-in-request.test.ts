/**
 * An exec run in its request (`execWorkspaceInRequest`): after `execWorkspace`'s admission the run
 * is created, claimed and recorded inside the request, never queued, and the settled run comes
 * back. One budget covers the whole request: past it no further command is sent and the run
 * fails. Driven against a fake executor, sink and repositories. A service key is configured before
 * the dynamic import because runtime-env parses process.env at module load.
 */
import {
  ConnectedAccountRepo,
  RunRepo,
  WorkspaceAttemptRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type Run,
  type Workspace,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { TelemetrySink } from "@sealant/telemetry";
import { SealantRuntime, type SealantExecOptions, type SealantSession } from "@sealant/workspaces";
import { Duration, Effect, Layer, Result, Stream } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_SERVICE_KEYS"] = "svc-test";

let workspacesModule: typeof import("./workspaces.module.js");

beforeAll(async () => {
  workspacesModule = await import("./workspaces.module.js");
});

const OWNER = "usr_alice";
const workspace = { id: "wks_1", ownerUserId: OWNER, latestRunId: "run_launch" } as Workspace;
const instance = {
  runId: "run_launch",
  status: "ready",
  adapter: "docker",
  resourceId: "container-1",
  reference: "container-1",
  endpoint: null,
  launchCredentialInjections: [],
} as unknown as WorkspaceRuntimeInstance;

type EventEnvelope = Stream.Success<SealantSession["events"]>;

// The protobuf message type carries `$typeName` brands a plain object cannot; the normalizer
// reads only these fields.
const exited = (processId: string, exitCode: number, executionId?: string): EventEnvelope =>
  ({
    schemaVersion: 1,
    eventId: `evt_${processId}`,
    runtimeId: "rt_1",
    sequence: 1n,
    observedAt: 1n,
    monotonicTimestamp: 1n,
    captureMethod: 1,
    confidence: 1,
    processId,
    ...(executionId === undefined ? {} : { executionId }),
    payload: { case: "processExited", value: { exitCode, reason: 1 } },
  }) as unknown as EventEnvelope;

/** Commands exit with the code their first argument names; `hang` never exits. */
const world = () => {
  const sent: SealantExecOptions[] = [];
  let row: Run | undefined;
  const session = {
    health: Effect.succeed({ runtimeId: "rt_1" }),
    capabilities: Effect.succeed({ supports: [] }),
    exec: (exec: SealantExecOptions) =>
      Effect.sync(() => {
        sent.push(exec);
        return { processId: `proc_${String(sent.length)}`, pid: 7 };
      }),
    events: Stream.suspend(() => {
      const last = sent.at(-1);
      const processId = `proc_${String(sent.length)}`;
      if (last?.executionId === undefined) return Stream.make(exited(processId, 1));
      const code = last.args?.[0];
      return code === "hang"
        ? Stream.never
        : Stream.make(exited(processId, Number(code), last.executionId));
    }),
  } as unknown as SealantSession;
  const update = (input: Partial<Run>) =>
    Effect.sync(() => {
      if (row !== undefined) row = { ...row, ...input };
      return row;
    });
  const layer = Layer.mergeAll(
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: (id: string) => Effect.succeed(id === workspace.id ? workspace : undefined),
    } as never),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: () => Effect.succeed(instance),
    } as never),
    Layer.succeed(RunRepo, {
      createRun: (input: { id: string; workspaceId: string; ownerUserId: string }) =>
        Effect.sync(() => {
          row = {
            id: input.id,
            workspaceId: input.workspaceId,
            attemptId: null,
            ownerUserId: input.ownerUserId,
            harnessId: "exec",
            mode: "one-shot",
            status: "queued",
            prompt: null,
            command: null,
            metadata: null,
            processUser: null,
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
          };
          return row;
        }),
      claimRunForExec: () =>
        update({ status: "running" }).pipe(Effect.map((run) => ({ outcome: "claimed", run }))),
      markRunCompleted: (input: { exitCode: number }) =>
        update({ status: "completed", exitCode: input.exitCode }),
      markRunFailed: (input: { errorMessage?: string }) =>
        update({ status: "failed", errorMessage: input.errorMessage ?? null }),
      getRunById: () => Effect.sync(() => row),
    } as never),
    Layer.succeed(SealantRuntime, {
      connect: () => Effect.succeed(session),
      openForwardConnection: () => Effect.die("forwards are unused here"),
    }),
    Layer.succeed(TelemetrySink, {
      openEpoch: () => Effect.succeed({ epochId: "tep_1", resumeFromSequence: null }),
      appendBatch: () => Effect.succeed([]),
      closeEpoch: () => Effect.void,
    } as never),
    Layer.succeed(WorkspaceAttemptRepo, {
      getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
    } as never),
    Layer.succeed(ConnectedAccountRepo, {} as never),
  );
  const exec = (args: readonly string[], budget?: Duration.Input) =>
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
  return { exec, sent, row: () => row };
};

describe("an exec run in its request", () => {
  it("answers with the settled run, its commands run in order and nothing queued", async () => {
    const w = world();
    const answered = await w.exec(["3", "0"]);
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
    const answered = await w.exec(["hang", "0"], "50 millis");
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
