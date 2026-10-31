/**
 * The exec recorder sends each command once. Connecting is retried while a daemon comes up; once
 * an exec is sent, a lost answer leaves whether the process started unknown, so it is never sent
 * again, and the run fails saying so. An exec run executed in its request runs its commands in
 * order, a nonzero exit as data, and an interruption sends no further command and fails the run.
 */
import { RunRepo, RunRepoUnexpectedError } from "@sealant/db";
import { Deferred, Duration, Effect, Exit, Fiber, Result } from "effect";
import { describe, expect, it } from "vitest";

import { FAKE_CIPHER, FAKE_TARGET, fakeExecWorld } from "./exec-run.fixture.js";
import { executeExecRun, produceExecRun } from "./exec-run.js";
import { TelemetrySink } from "./sink.js";

const RUN = "run_exec";

const commandsOf = (args: readonly string[]) =>
  args.map((arg) => ({ executable: "check", args: [arg] }));

const runCommands = (world: ReturnType<typeof fakeExecWorld>) =>
  world.sent.filter((exec) => exec.executionId === RUN).map((exec) => exec.args);

/** A queued run's row, as the worker finds it. */
const queuedRun = (world: ReturnType<typeof fakeExecWorld>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runs = yield* RunRepo;
      yield* runs.createRun({
        id: RUN,
        workspaceId: "ws_1",
        ownerUserId: "usr_1",
        harnessId: "exec",
      });
    }).pipe(Effect.provide(world.layer)),
  );

const produce = async (world: ReturnType<typeof fakeExecWorld>, args: readonly string[]) => {
  await queuedRun(world);
  await Effect.runPromise(
    produceExecRun(RUN, FAKE_TARGET, commandsOf(args)).pipe(Effect.provide(world.layer)),
  );
};

describe("an exec whose answer is lost after it was sent", () => {
  it("is sent once, the commands after it are not sent, and the run fails saying why", async () => {
    const w = fakeExecWorld({ healthFailures: 2 });
    await produce(w, ["lost", "0"]);
    // Connecting was retried until the daemon answered; the exec was not.
    expect(w.healthReads()).toBe(3);
    expect(runCommands(w)).toEqual([["lost"]]);
    expect(w.row()).toMatchObject({
      status: "failed",
      errorMessage: `Run ${RUN}: command 1/2 was sent to the workspace and its answer was lost, so whether it started is unknown; it may still be running. It was not sent again.`,
    });
  });

  it("is sent once when the daemon refuses it, and the run says nothing started", async () => {
    const w = fakeExecWorld();
    await produce(w, ["refused", "0"]);
    expect(runCommands(w)).toEqual([["refused"]]);
    expect(w.row()).toMatchObject({
      status: "failed",
      errorMessage: `Run ${RUN}: the workspace refused to start command 1/2 (daemon error 3); nothing was started.`,
    });
  });
});

type Bounds = { readonly budget: Duration.Input; readonly syncBackDeadline: Duration.Input };
const FULL_BOUNDS: Bounds = { budget: "30 minutes", syncBackDeadline: "30 seconds" };

/** The run, with its services still to provide: a test can wrap one first. */
const executeRun = (args: readonly string[], bounds: Bounds = FULL_BOUNDS, keyConfigured = true) =>
  executeExecRun({
    run: { id: RUN, workspaceId: "ws_1", ownerUserId: "usr_1", harnessId: "exec" },
    executor: {
      target: FAKE_TARGET,
      attemptId: "run_launch",
      launchCredentialInjections: [],
      ...(keyConfigured ? { credentialCipher: FAKE_CIPHER } : {}),
    },
    commands: commandsOf(args),
    ...bounds,
  });

const execute = (
  world: ReturnType<typeof fakeExecWorld>,
  args: readonly string[],
  bounds: Bounds = FULL_BOUNDS,
  keyConfigured = true,
) => executeRun(args, bounds, keyConfigured).pipe(Effect.provide(world.layer));

const interruptedReason = `Run ${RUN} was interrupted before it completed: no further command was sent, and one already started may still be running.`;
const budgetReason = `Run ${RUN} ran past its budget: no further command was sent, and one already started may still be running.`;

describe("a command the daemon refuses after others ran", () => {
  it("keeps the changes the earlier commands made, since nothing of it started", async () => {
    const w = fakeExecWorld({ readExitCode: 0 });
    await produce(w, ["0", "refused", "0"]);
    expect(runCommands(w)).toEqual([["0"], ["refused"]]);
    expect(w.sent.filter((exec) => exec.executionId === undefined)).toHaveLength(1);
    expect(w.row()).toMatchObject({
      status: "failed",
      errorMessage: `Run ${RUN}: the workspace refused to start command 2/3 (daemon error 3); nothing was started.`,
      changedFiles: [],
    });
  });

  it("reads nothing when the answer was lost, since the process may still be writing", async () => {
    const w = fakeExecWorld({ readExitCode: 0 });
    await produce(w, ["0", "lost"]);
    expect(w.sent.filter((exec) => exec.executionId === undefined)).toHaveLength(0);
    expect(w.row()).toMatchObject({ status: "failed", changedFiles: null });
  });
});

describe("an exec run executed in its request", () => {
  it("runs its commands in order, a nonzero exit as data, and returns the settled run", async () => {
    const w = fakeExecWorld();
    const run = await Effect.runPromise(execute(w, ["2", "0"]));
    expect(runCommands(w)).toEqual([["2"], ["0"]]);
    expect(w.steps).toEqual(["create", "claim", "completed", "sync-back"]);
    expect(run).toMatchObject({ id: RUN, status: "completed", exitCode: 0 });
  });

  it("sends no further command when interrupted, and fails the run without claiming it stopped", async () => {
    const w = fakeExecWorld();
    const fiber = Effect.runFork(execute(w, ["hang", "0"]));
    await Effect.runPromise(Deferred.await(w.hanging));
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(runCommands(w)).toEqual([["hang"]]);
    expect(w.epochs).toEqual([{ suspicious: true }]);
    expect(w.steps).toEqual(["create", "claim", "failed", "sync-back"]);
    expect(w.row()).toMatchObject({
      status: "failed",
      errorMessage: interruptedReason,
    });
  });
});

describe("an exec run in its request, against its budget", () => {
  const bounds = { budget: "300 millis", syncBackDeadline: "100 millis" } as const;

  it("past its budget, with a sync-back that never answers, answers within the budget with the failed run", async () => {
    const w = fakeExecWorld({ syncBack: "hangs" });
    const started = Date.now();
    const run = await Effect.runPromise(execute(w, ["hang", "0"], bounds));
    expect(Date.now() - started).toBeLessThan(300 + 100);
    expect(runCommands(w)).toEqual([["hang"]]);
    expect(w.steps).toEqual(["create", "claim", "failed", "sync-back", "sync-back stopped"]);
    expect(run).toMatchObject({ id: RUN, status: "failed", errorMessage: budgetReason });
  });

  it("whose commands completed before the sync-back stalled answers with the completed run", async () => {
    const w = fakeExecWorld({ syncBack: "hangs" });
    const run = await Effect.runPromise(execute(w, ["0"], bounds));
    expect(w.steps).toEqual(["create", "claim", "completed", "sync-back", "sync-back stopped"]);
    expect(run).toMatchObject({ id: RUN, status: "completed", exitCode: 0 });
  });
});

describe("the package's recorder surface", () => {
  it("names the framings and the in-request run, and keeps the recorder's helpers to itself", async () => {
    const telemetry = await import("./index.js");
    for (const name of ["captureChanges", "launchFailureMessage", "RECORD_BATCH_SIZE"]) {
      expect(telemetry).not.toHaveProperty(name);
    }
    for (const name of ["produceExecRun", "produceHarnessRun", "recordProcess", "executeExecRun"]) {
      expect(telemetry).toHaveProperty(name);
    }
  });
});

describe("the two retry policies", () => {
  it("reads the changes again after a lost answer, and never sends a command again", async () => {
    const w = fakeExecWorld({ readFailures: 2, readExitCode: 0 });
    await produce(w, ["0"]);
    expect(runCommands(w)).toEqual([["0"]]);
    expect(w.sent.filter((exec) => exec.executionId === undefined)).toHaveLength(3);
    expect(w.row()).toMatchObject({ status: "completed", exitCode: 0 });
  });
});

describe("an exec run in its request whose record fails it", () => {
  const failureOf = async (world: ReturnType<typeof fakeExecWorld>) => {
    const answered = await Effect.runPromise(Effect.result(execute(world, ["0"])));
    if (!Result.isFailure(answered)) throw new Error("expected a failure");
    return answered.failure;
  };

  it("never answers with a running run when its outcome cannot be written", async () => {
    const w = fakeExecWorld({ failTerminalWrites: true });
    expect(await failureOf(w)).toMatchObject({ _tag: "ExecRunUnsettledError", runId: RUN });
    expect(w.row()).toMatchObject({ status: "running" });
  });

  it("says nothing ran when the run was never created", async () => {
    const w = fakeExecWorld({ failCreate: true });
    expect(await failureOf(w)).toMatchObject({ _tag: "ExecRunNotCreatedError" });
    expect(w.sent).toEqual([]);
  });

  it("says its commands ran when the settled run cannot be read back", async () => {
    const w = fakeExecWorld({ failRead: true });
    expect(await failureOf(w)).toMatchObject({ _tag: "ExecRunUnreadableError", runId: RUN });
    expect(runCommands(w)).toEqual([["0"]]);
  });
});

describe("the credential sync-back after an exec run in its request", () => {
  it("does not run without a credentials cipher, as the worker's helpers skip one", async () => {
    const w = fakeExecWorld();
    const bounds = { budget: "30 minutes", syncBackDeadline: "30 seconds" } as const;
    const run = await Effect.runPromise(execute(w, ["0"], bounds, false));
    expect(run).toMatchObject({ status: "completed" });
    expect(w.steps).toEqual(["create", "claim", "completed"]);
  });
});

describe("an exec run in its request whose completion answer is lost", () => {
  it("answers with the completed run, and never writes it off as failed", async () => {
    const w = fakeExecWorld();
    const run = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* RunRepo;
        return yield* executeRun(["0"]).pipe(
          Effect.provideService(RunRepo, {
            ...runs,
            markRunCompleted: (input) =>
              runs.markRunCompleted(input).pipe(
                Effect.andThen(
                  Effect.fail(
                    new RunRepoUnexpectedError({
                      operation: "markRunCompleted",
                      message: "the answer was lost",
                      cause: 0,
                    }),
                  ),
                ),
              ),
          }),
        );
      }).pipe(Effect.provide(w.layer)),
    );
    expect(run).toMatchObject({ id: RUN, status: "completed", exitCode: 0 });
    expect(w.row()).toMatchObject({ status: "completed", errorMessage: null });
    expect(w.steps).not.toContain("failed");
  });
});

/** A boundary 300 ms slow: a database or telemetry call that stalls. */
const stall = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.sleep("300 millis").pipe(Effect.andThen(effect));

describe("an exec run in its request whose persistence stalls", () => {
  const BUDGET_MS = 60;
  /** What the timers may add on top of the budget. */
  const SLACK_MS = 40;
  const bounds: Bounds = { budget: Duration.millis(BUDGET_MS), syncBackDeadline: "10 millis" };

  /** The run with one boundary 300 ms slow, answered (success or failure) and timed. */
  const probe = async (
    stalled: "create" | "read" | "settlement" | "closeEpoch",
    command: "0" | "hang",
  ) => {
    const w = fakeExecWorld();
    const started = Date.now();
    const answered = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* RunRepo;
        const sink = yield* TelemetrySink;
        return yield* executeRun([command], bounds, false).pipe(
          Effect.provideService(RunRepo, {
            ...runs,
            createRun: (input) =>
              stalled === "create" ? stall(runs.createRun(input)) : runs.createRun(input),
            getRunById: (id) =>
              stalled === "read" ? stall(runs.getRunById(id)) : runs.getRunById(id),
            markRunFailed: (input) =>
              stalled === "settlement"
                ? stall(runs.markRunFailed(input))
                : runs.markRunFailed(input),
          }),
          Effect.provideService(TelemetrySink, {
            ...sink,
            closeEpoch: (input) =>
              stalled === "closeEpoch" ? stall(sink.closeEpoch(input)) : sink.closeEpoch(input),
          }),
          Effect.result,
        );
      }).pipe(Effect.provide(w.layer)),
    );
    return { answered, elapsedMs: Date.now() - started, world: w };
  };

  it("answers within its budget when creating the run stalls, and sends nothing", async () => {
    const { answered, elapsedMs, world } = await probe("create", "0");
    expect(elapsedMs).toBeLessThan(BUDGET_MS + SLACK_MS);
    expect(answered).toMatchObject({ failure: { _tag: "ExecRunNotCreatedError" } });
    expect(world.sent).toEqual([]);
  });

  it("answers within its budget when reading the settled run back stalls", async () => {
    const { answered, elapsedMs } = await probe("read", "0");
    expect(elapsedMs).toBeLessThan(BUDGET_MS + SLACK_MS);
    expect(answered).toMatchObject({ failure: { _tag: "ExecRunUnreadableError", runId: RUN } });
  });

  it("answers within its budget when writing its failure stalls", async () => {
    const { answered, elapsedMs } = await probe("settlement", "hang");
    expect(elapsedMs).toBeLessThan(BUDGET_MS + SLACK_MS);
    expect(answered).toMatchObject({ failure: { _tag: "ExecRunUnsettledError", runId: RUN } });
  });

  it("answers within its budget, with the failed run, when closing its record stalls", async () => {
    const { answered, elapsedMs } = await probe("closeEpoch", "hang");
    expect(elapsedMs).toBeLessThan(BUDGET_MS + SLACK_MS);
    expect(answered).toMatchObject({
      success: { id: RUN, status: "failed", errorMessage: budgetReason },
    });
  });
});
