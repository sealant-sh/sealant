/**
 * The exec recorder sends each command once. Connecting is retried while a daemon comes up; once
 * an exec is sent, a lost answer leaves whether the process started unknown, so it is never sent
 * again, and the run fails saying so. Driven against a fake daemon session, sink and run repository.
 */
import {
  ConnectedAccountRepo,
  type ConnectedAccountRepoService,
  RunRepo,
  type RunRepoService,
  WorkspaceAttemptRepo,
  type WorkspaceAttemptRepoService,
} from "@sealant/db";
import {
  SealantControlError,
  SealantRuntime,
  type SealantExecOptions,
  type SealantSession,
  type SealantTarget,
  TransportError,
} from "@sealant/workspaces";
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { executeExecRun, produceExecRun } from "./exec-run.js";
import { TelemetrySink, type TelemetrySinkService } from "./sink.js";

const RUN = "run_send_once";
const TARGET: SealantTarget = { kind: "docker-exec", containerId: "c1", socketPath: "/s" };

const lost = new TransportError({ operation: "exec", message: "bridge closed", cause: undefined });

const world = (options: {
  readonly healthFailures?: number;
  readonly execFails: TransportError | SealantControlError;
}) => {
  const sent: SealantExecOptions[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  let healthReads = 0;
  const session = {
    health: Effect.suspend(() => {
      healthReads += 1;
      return healthReads <= (options.healthFailures ?? 0)
        ? Effect.fail(new TransportError({ operation: "health", message: "not up", cause: 0 }))
        : Effect.succeed({ runtimeId: "rt_1" });
    }),
    capabilities: Effect.succeed({ supports: [] }),
    exec: (exec: SealantExecOptions) =>
      Effect.suspend(() => {
        sent.push(exec);
        return Effect.fail(options.execFails);
      }),
    events: Stream.empty,
  } as unknown as SealantSession;
  const layer = Layer.mergeAll(
    Layer.succeed(SealantRuntime, {
      connect: () => Effect.succeed(session),
      openForwardConnection: () => Effect.die("forwards are unused here"),
    }),
    Layer.succeed(TelemetrySink, {} as TelemetrySinkService),
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
  const run = () =>
    Effect.runPromise(
      produceExecRun(RUN, TARGET, [
        { executable: "make", args: ["migrate"] },
        { executable: "make", args: ["check"] },
      ]).pipe(Effect.provide(layer)),
    );
  return { run, sent, outcomes, healthReads: () => healthReads };
};

describe("an exec whose answer is lost after it was sent", () => {
  it("is sent once, the commands after it are not sent, and the run fails saying why", async () => {
    const w = world({ healthFailures: 2, execFails: lost });
    await w.run();
    // Connecting was retried until the daemon answered; the exec was not.
    expect(w.healthReads()).toBe(3);
    expect(w.sent.map((exec) => exec.args)).toEqual([["migrate"]]);
    expect(w.outcomes).toEqual([
      {
        status: "failed",
        id: RUN,
        errorMessage: `Run ${RUN}: command 1/2 was sent to the workspace and its answer was lost, so whether it started is unknown; it may still be running. It was not sent again.`,
      },
    ]);
  });

  it("is sent once when the daemon refuses it, and the run says nothing started", async () => {
    const refused = new SealantControlError({
      operation: "exec",
      code: 3,
      message: "no such file",
    });
    const w = world({ execFails: refused });
    await w.run();
    expect(w.sent).toHaveLength(1);
    expect(w.outcomes).toEqual([
      {
        status: "failed",
        id: RUN,
        errorMessage: `Run ${RUN}: the workspace refused to start command 1/2 (daemon error 3); nothing was started.`,
      },
    ]);
  });
});

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

/**
 * A workspace whose commands exit with the code their first argument names (`hang` never exits),
 * whose changes reading exits 1 (no reading, enough here), and a run repository that keeps the
 * one run's row.
 */
const requestWorld = () => {
  const sent: SealantExecOptions[] = [];
  const steps: string[] = [];
  const epochs: Array<{ suspicious: boolean }> = [];
  const hanging = Deferred.makeUnsafe<void>();
  let row: Record<string, unknown> | undefined;
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
      if (last?.executionId !== RUN) return Stream.make(exited(processId, 1));
      const code = last.args?.[0];
      if (code === "hang") {
        return Stream.fromEffect(Deferred.succeed(hanging, undefined)).pipe(
          Stream.flatMap(() => Stream.never),
        );
      }
      return Stream.make(exited(processId, Number(code), RUN));
    }),
  } as unknown as SealantSession;
  const update = (step: string, input: Record<string, unknown>) =>
    Effect.sync(() => {
      steps.push(step);
      row = { ...row, ...input };
      return row;
    });
  const layer = Layer.mergeAll(
    Layer.succeed(SealantRuntime, {
      connect: () => Effect.succeed(session),
      openForwardConnection: () => Effect.die("forwards are unused here"),
    }),
    Layer.succeed(TelemetrySink, {
      openEpoch: () => Effect.succeed({ epochId: "tep_1", resumeFromSequence: null }),
      appendBatch: () => Effect.succeed([]),
      closeEpoch: (input: { suspicious: boolean }) =>
        Effect.sync(() => {
          epochs.push({ suspicious: input.suspicious });
        }),
    } as unknown as TelemetrySinkService),
    Layer.succeed(RunRepo, {
      createRun: (input: Record<string, unknown>) =>
        update("create", { ...input, status: "queued" }),
      claimRunForExec: () =>
        update("claim", { status: "running" }).pipe(
          Effect.map((run) => ({ outcome: "claimed", run })),
        ),
      markRunCompleted: (input: Record<string, unknown>) =>
        update("completed", { ...input, status: "completed" }),
      markRunFailed: (input: Record<string, unknown>) =>
        update("failed", { ...input, status: "failed" }),
      getRunById: () => Effect.sync(() => row),
    } as unknown as RunRepoService),
    Layer.succeed(WorkspaceAttemptRepo, {
      getAttemptSnapshotByRunId: () =>
        Effect.sync(() => {
          steps.push("sync-back");
          return undefined;
        }),
    } as unknown as WorkspaceAttemptRepoService),
    Layer.succeed(ConnectedAccountRepo, {} as unknown as ConnectedAccountRepoService),
  );
  const execute = (args: readonly string[]) =>
    executeExecRun({
      run: { id: RUN, workspaceId: "ws_1", ownerUserId: "usr_1", harnessId: "exec" },
      executor: { target: TARGET, attemptId: "run_launch", launchCredentialInjections: [] },
      commands: args.map((arg) => ({ executable: "check", args: [arg] })),
    }).pipe(Effect.provide(layer));
  return { execute, sent, steps, epochs, hanging, row: () => row };
};

describe("an exec run executed in its request", () => {
  it("runs its commands in order, a nonzero exit as data, and returns the settled run", async () => {
    const w = requestWorld();
    const run = await Effect.runPromise(w.execute(["2", "0"]));
    expect(w.sent.filter((exec) => exec.executionId === RUN).map((exec) => exec.args)).toEqual([
      ["2"],
      ["0"],
    ]);
    expect(w.steps).toEqual(["create", "claim", "completed", "sync-back"]);
    expect(run).toMatchObject({ id: RUN, status: "completed", exitCode: 0 });
  });

  it("sends no further command when interrupted, and fails the run without claiming it stopped", async () => {
    const w = requestWorld();
    const fiber = Effect.runFork(w.execute(["hang", "0"]));
    await Effect.runPromise(Deferred.await(w.hanging));
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(w.sent.map((exec) => exec.args)).toEqual([["hang"]]);
    expect(w.epochs).toEqual([{ suspicious: true }]);
    expect(w.steps).toEqual(["create", "claim", "failed", "sync-back"]);
    expect(w.row()).toMatchObject({
      status: "failed",
      errorMessage: `Run ${RUN} was interrupted before it completed: no further command was sent, and one already started may still be running.`,
    });
  });
});
