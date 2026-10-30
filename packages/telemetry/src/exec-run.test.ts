/**
 * The exec recorder sends each command once. Connecting is retried while a daemon comes up; once
 * an exec is sent, a lost answer leaves whether the process started unknown, so it is never sent
 * again, and the run fails saying so. An exec run executed in its request runs its commands in
 * order, a nonzero exit as data, and an interruption sends no further command and fails the run.
 */
import { RunRepo } from "@sealant/db";
import { Deferred, type Duration, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { FAKE_TARGET, fakeExecWorld } from "./exec-run.fixture.js";
import { executeExecRun, produceExecRun } from "./exec-run.js";

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

const execute = (
  world: ReturnType<typeof fakeExecWorld>,
  args: readonly string[],
  bounds: { readonly budget: Duration.Input; readonly syncBackDeadline: Duration.Input } = {
    budget: "30 minutes",
    syncBackDeadline: "30 seconds",
  },
) =>
  executeExecRun({
    run: { id: RUN, workspaceId: "ws_1", ownerUserId: "usr_1", harnessId: "exec" },
    executor: { target: FAKE_TARGET, attemptId: "run_launch", launchCredentialInjections: [] },
    commands: commandsOf(args),
    ...bounds,
  }).pipe(Effect.provide(world.layer));

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
