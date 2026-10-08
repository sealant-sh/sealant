/**
 * The EXEC framing as a person (Mend ADR 0016): every command of an exec run that names a user is
 * started by the daemon as that user (`ExecArgs.user`), with the run as its execution; the
 * worker's own reading of the changes afterwards runs as the workspace's user, as before. A run
 * without a user sends none. A daemon that does not report `exec.user` (the run reached another
 * executor than the API checked) is asked nothing, and the run fails saying why: such a daemon
 * would start the process as root. Driven against a fake daemon session, sink and run repository.
 */
import {
  ConnectedAccountRepo,
  RunRepo,
  WorkspaceAttemptRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type RunRepoService,
} from "@sealant/db";
import { TelemetrySink, type TelemetrySinkService } from "@sealant/telemetry";
import {
  SealantRuntime,
  type ProcessUserChannel,
  type SealantExecOptions,
  type SealantSession,
  type SealantTarget,
} from "@sealant/workspaces";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { processRunExecJobEffect, produceExecRun } from "./process-run-exec-job.js";

type EventEnvelope = Stream.Success<SealantSession["events"]>;

const RUN = "run_exec";
const TARGET: SealantTarget = { kind: "docker-exec", containerId: "c1", socketPath: "/s" };

const exited = (processId: string, exitCode: number, executionId?: string): EventEnvelope =>
  // The protobuf message type carries `$typeName` brands a plain object cannot; the normalizer
  // reads only these fields.
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

const world = (supports: readonly string[] = ["exec.user"]) => {
  const execs: SealantExecOptions[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  const session = {
    health: Effect.succeed({ runtimeId: "rt_1" }),
    capabilities: Effect.succeed({ supports: [...supports] }),
    exec: (options: SealantExecOptions) =>
      Effect.sync(() => {
        execs.push(options);
        return { processId: `proc_${String(execs.length)}`, pid: 7 };
      }),
    // Each command exits 0; the changes reading exits 1 (no reading), which is enough here.
    events: Stream.suspend(() => {
      const last = execs.at(-1);
      return Stream.make(
        exited(
          `proc_${String(execs.length)}`,
          last?.executionId === RUN ? 0 : 1,
          last?.executionId,
        ),
      );
    }),
  } as unknown as SealantSession;
  const layer = Layer.mergeAll(
    Layer.succeed(SealantRuntime, { connect: () => Effect.succeed(session) }),
    Layer.succeed(TelemetrySink, {
      openEpoch: () => Effect.void,
      appendBatch: () => Effect.succeed([]),
      closeEpoch: () => Effect.void,
    } as unknown as TelemetrySinkService),
    Layer.succeed(RunRepo, {
      markRunCompleted: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          outcomes.push({ status: "completed", ...input });
          return null;
        }),
      markRunFailed: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          outcomes.push({ status: "failed", ...input });
          return null;
        }),
    } as unknown as RunRepoService),
  );
  const run = (user?: string) =>
    Effect.runPromise(
      produceExecRun(
        RUN,
        TARGET,
        [
          { executable: "id", args: ["-u"] },
          { executable: "touch", args: ["x"] },
        ],
        user,
      ).pipe(Effect.provide(layer)),
    );
  return { run, execs, outcomes };
};

describe("produceExecRun as a user", () => {
  it("starts every command as the user, and reads the changes as the workspace's user", async () => {
    const w = world();
    await w.run("m4lice000");
    const commands = w.execs.filter((options) => options.executionId === RUN);
    expect(commands.map((options) => [options.executable, options.user])).toEqual([
      ["id", "m4lice000"],
      ["touch", "m4lice000"],
    ]);
    const reading = w.execs.filter((options) => options.executionId !== RUN);
    expect(reading).toHaveLength(1);
    expect(reading[0]?.user).toBeUndefined();
    expect(w.outcomes).toMatchObject([{ status: "completed", id: RUN, exitCode: 0 }]);
  });

  it("sends no user for a run that names none", async () => {
    const w = world();
    await w.run();
    expect(w.execs.every((options) => !("user" in options))).toBe(true);
  });

  it("fails the run, starting nothing, on a daemon that does not report exec.user", async () => {
    const w = world(["restore.owner_map"]);
    await w.run("m4lice000");
    expect(w.execs).toEqual([]);
    expect(w.outcomes).toEqual([
      {
        status: "failed",
        id: RUN,
        errorMessage:
          "The workspace's sealantd doesn't run processes as another user (it does not report exec.user), so nothing was started as 'm4lice000'.",
      },
    ]);
  });
});

describe("a run as a user that reaches another executor than the API checked", () => {
  const job = (answer: "fails" | number) => {
    const checked: string[] = [];
    const failed: string[] = [];
    const channel: ProcessUserChannel = {
      check: (_target, user) => {
        checked.push(user);
        return answer === "fails"
          ? Effect.fail(new Error("bridge closed"))
          : Effect.succeed({ supported: true, exitCode: answer });
      },
    };
    const layer = Layer.mergeAll(
      Layer.succeed(RunRepo, {
        claimRunForExec: () => Effect.succeed({ outcome: "claimed", run: {} }),
        getRunById: () => Effect.succeed({ workspaceId: "ws_1" }),
        markRunFailed: (input: { errorMessage: string }) =>
          Effect.sync(() => {
            failed.push(input.errorMessage);
            return null;
          }),
      } as unknown as RunRepoService),
      // The workspace was restarted after the API checked the user on `run_old`.
      Layer.succeed(WorkspaceRepo, {
        getWorkspaceById: () => Effect.succeed({ id: "ws_1", latestRunId: "run_new" }),
      } as never),
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        getRuntimeInstanceByRunId: () =>
          Effect.succeed({
            runId: "run_new",
            adapter: "docker",
            resourceId: "container-new",
            endpoint: null,
            launchCredentialInjections: [],
          }),
      } as never),
      Layer.succeed(WorkspaceAttemptRepo, {} as never),
      Layer.succeed(ConnectedAccountRepo, {} as never),
      Layer.succeed(SealantRuntime, {
        connect: () => Effect.die("nothing may be started"),
      } as never),
      Layer.succeed(TelemetrySink, {} as never),
    );
    const run = () =>
      Effect.runPromise(
        processRunExecJobEffect({
          runId: RUN,
          commands: [{ executable: "id", args: [] }],
          user: "m4lice000",
          checkedExecutorRunId: "run_old",
          processUserChannel: channel,
        }).pipe(Effect.provide(layer)),
      );
    return { run, checked, failed };
  };

  it("checks the user again there, and fails the run without starting it when refused", async () => {
    const refused = job(95);
    await refused.run();
    expect(refused.checked).toEqual(["m4lice000"]);
    expect(refused.failed).toEqual([
      "The run reached another executor than the one 'm4lice000' was checked on, and there it is refused (its uid is outside 40001–49999); nothing was started.",
    ]);

    const silent = job("fails");
    await silent.run();
    expect(silent.failed[0]).toContain("did not answer the check again");
  });
});
