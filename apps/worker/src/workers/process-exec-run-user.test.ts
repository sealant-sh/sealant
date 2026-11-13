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
} from "@sealant/db";
import { fakeService } from "@sealant/db/testing/fake-service";
import { runRow, runtimeInstanceRow, workspaceRow } from "@sealant/db/testing/rows";
import { produceExecRun, TelemetrySink } from "@sealant/telemetry";
import {
  capabilitiesReport,
  daemonEvent,
  execAccepted,
  healthReport,
  isChangesReading,
} from "@sealant/telemetry/testing";
import {
  SealantRuntime,
  type ProcessUserChannel,
  type SealantExecOptions,
  type SealantSession,
  type SealantTarget,
} from "@sealant/workspaces";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { processRunExecJobEffect } from "./process-run-exec-job.js";

type EventEnvelope = Stream.Success<SealantSession["events"]>;

const RUN = "run_exec";
const TARGET: SealantTarget = { kind: "docker-exec", containerId: "c1", socketPath: "/s" };

const exited = (processId: string, exitCode: number, executionId?: string): EventEnvelope =>
  daemonEvent({
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
  });

const world = (supports: readonly string[] = ["exec.user"]) => {
  const execs: SealantExecOptions[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  const session = fakeService<SealantSession>({
    health: Effect.succeed(healthReport("rt_1")),
    capabilities: Effect.succeed(capabilitiesReport(supports)),
    exec: (options: SealantExecOptions) =>
      Effect.sync(() => {
        execs.push(options);
        return execAccepted(`proc_${String(execs.length)}`, 7);
      }),
    // Each command exits 0; the changes reading exits 1 (no reading), which is enough here.
    events: Stream.suspend(() => {
      const last = execs.at(-1);
      return Stream.make(
        exited(
          `proc_${String(execs.length)}`,
          last === undefined || isChangesReading(last) ? 1 : 0,
          last?.executionId,
        ),
      );
    }),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(SealantRuntime, {
      connect: () => Effect.succeed(session),
      openForwardConnection: () => Effect.die("forwards are unused here"),
    }),
    Layer.succeed(
      TelemetrySink,
      fakeService({
        openEpoch: () => Effect.succeed({ epochId: "tep_1", resumeFromSequence: null }),
        appendBatch: () => Effect.succeed([]),
        closeEpoch: () => Effect.void,
      }),
    ),
    Layer.succeed(
      RunRepo,
      fakeService({
        markRunCompleted: (input) =>
          Effect.sync(() => {
            outcomes.push({ status: "completed", ...input });
            return null;
          }),
        markRunFailed: (input) =>
          Effect.sync(() => {
            outcomes.push({ status: "failed", ...input });
            return null;
          }),
      }),
    ),
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
    const commands = w.execs.filter((options) => !isChangesReading(options));
    expect(commands.map((options) => [options.executable, options.user])).toEqual([
      ["id", "m4lice000"],
      ["touch", "m4lice000"],
    ]);
    const reading = w.execs.filter(isChangesReading);
    expect(reading).toHaveLength(1);
    expect(reading[0]?.user).toBeUndefined();
    // Read as part of the run, so no other run's record takes it for its own.
    expect(reading[0]?.executionId).toBe(RUN);
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
    const failed: Array<string | undefined> = [];
    const channel: ProcessUserChannel = {
      check: (_target, user) => {
        checked.push(user);
        return answer === "fails"
          ? Effect.fail(new Error("bridge closed"))
          : Effect.succeed({ supported: true, exitCode: answer });
      },
    };
    const layer = Layer.mergeAll(
      Layer.succeed(
        RunRepo,
        fakeService({
          claimRunForExec: () => Effect.succeed({ outcome: "claimed", run: runRow() }),
          getRunById: () => Effect.succeed(runRow({ workspaceId: "ws_1" })),
          markRunFailed: (input) =>
            Effect.sync(() => {
              failed.push(input.errorMessage);
              return null;
            }),
        }),
      ),
      // The workspace was restarted after the API checked the user on `run_old`.
      Layer.succeed(
        WorkspaceRepo,
        fakeService({
          getWorkspaceById: () =>
            Effect.succeed(workspaceRow({ id: "ws_1", latestRunId: "run_new" })),
        }),
      ),
      Layer.succeed(
        WorkspaceRuntimeInstanceRepo,
        fakeService({
          getRuntimeInstanceByRunId: () =>
            Effect.succeed(
              runtimeInstanceRow({
                runId: "run_new",
                adapter: "docker",
                resourceId: "container-new",
                endpoint: null,
                launchCredentialInjections: [],
              }),
            ),
        }),
      ),
      Layer.succeed(WorkspaceAttemptRepo, fakeService({})),
      Layer.succeed(ConnectedAccountRepo, fakeService({})),
      Layer.succeed(
        SealantRuntime,
        fakeService({ connect: () => Effect.die("nothing may be started") }),
      ),
      Layer.succeed(TelemetrySink, fakeService({})),
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
