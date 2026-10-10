/**
 * The DOTFILES framing of the run-exec worker (`produceDotfilesRun`): `dotfiles.apply` as the
 * person's user with the run as its execution, the staged archives removed once the daemon answers,
 * the bootstrap's events (and only this run's) recorded to its exit, and the run completed with
 * that exit code or failed with the daemon's words. Driven against a fake daemon session, sink and
 * run repository; nothing reaches Docker or Postgres.
 */
import { RunRepo, type RunRepoService } from "@sealant/db";
import { TelemetrySink, type TelemetrySinkService } from "@sealant/telemetry";
import {
  SealantControlError,
  SealantRuntime,
  dotfilesStagePath,
  type DotfilesStageChannel,
  type SealantDotfilesApplied,
  type SealantDotfilesApplyArgs,
  type SealantError,
  type SealantSession,
  type SealantTarget,
} from "@sealant/workspaces";
import { Duration, Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { produceDotfilesRun } from "./process-run-exec-job.js";

type EventEnvelope = Stream.Success<SealantSession["events"]>;

const RUN = "run_dots";
const TARGET: SealantTarget = { kind: "docker-exec", containerId: "c1", socketPath: "/s" };
const DOTFILES = {
  user: "m4lice000",
  home: "/home/m4lice000",
  archiveDir: dotfilesStagePath(RUN),
} as const;

let sequence = 0n;
/** A daemon event as the session yields it (the fields the normalizer reads; test-only shape). */
const event = (fields: {
  readonly executionId?: string;
  readonly processId: string;
  readonly payload: { readonly case: string; readonly value: Record<string, unknown> };
}): EventEnvelope => {
  sequence += 1n;
  const shaped = {
    schemaVersion: 1,
    eventId: `evt_${sequence.toString()}`,
    runtimeId: "rt_1",
    sequence,
    observedAt: sequence,
    monotonicTimestamp: sequence,
    captureMethod: 1,
    confidence: 1,
    ...fields,
  };
  // The protobuf message type carries `$typeName` brands a plain object cannot; the normalizer
  // reads only the fields above.
  return shaped as unknown as EventEnvelope;
};

const started = (processId: string, executionId?: string) =>
  event({
    processId,
    ...(executionId === undefined ? {} : { executionId }),
    payload: {
      case: "processStarted",
      value: { pid: 7, pgid: 7, executable: "/bin/sh", args: ["-c", "./install.sh"], cwd: "/" },
    },
  });
const exited = (processId: string, exitCode: number, executionId?: string) =>
  event({
    processId,
    ...(executionId === undefined ? {} : { executionId }),
    payload: { case: "processExited", value: { exitCode, reason: 1 } },
  });

const world = (daemon: {
  readonly apply: (
    args: SealantDotfilesApplyArgs,
  ) => Effect.Effect<SealantDotfilesApplied, SealantError>;
  readonly events?: Stream.Stream<EventEnvelope, SealantError>;
}) => {
  const applied: SealantDotfilesApplyArgs[] = [];
  const signals: Array<{ readonly processId: string; readonly signal: number }> = [];
  const appended: EventEnvelope["processId"][] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  const cleanups: string[] = [];
  const epochs: string[] = [];

  const session = {
    health: Effect.succeed({ runtimeId: "rt_1" }),
    dotfilesApply: (args: SealantDotfilesApplyArgs) => {
      applied.push(args);
      return daemon.apply(args);
    },
    events: daemon.events ?? Stream.empty,
    signalProcess: (processId: string, signal: number) => {
      signals.push({ processId, signal });
      return Effect.void;
    },
  } as unknown as SealantSession;
  const runtime = Layer.succeed(SealantRuntime, { connect: () => Effect.succeed(session) });
  const sink = Layer.succeed(TelemetrySink, {
    openEpoch: () => Effect.sync(() => epochs.push("open")),
    appendBatch: (input: { readonly batch: ReadonlyArray<{ readonly processId?: string }> }) =>
      Effect.sync(() => {
        for (const normalized of input.batch) appended.push(normalized.processId);
        return { appended: input.batch, conflicts: [] };
      }),
    closeEpoch: (input: { readonly closeReason: string }) =>
      Effect.sync(() => epochs.push(`close:${input.closeReason}`)),
  } as unknown as TelemetrySinkService);
  const runs = Layer.succeed(RunRepo, {
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
  } as unknown as RunRepoService);
  const stageChannel: DotfilesStageChannel = {
    stage: () => Effect.die("unused"),
    run: (_target, script) =>
      Effect.sync(() => {
        cleanups.push(script);
        return 0;
      }),
  };
  const run = (
    dotfiles: Parameters<typeof produceDotfilesRun>[2] = DOTFILES,
    timeouts: { readonly bootstrapTimeout?: Duration.Input } = {},
  ) =>
    Effect.runPromise(
      produceDotfilesRun(RUN, TARGET, dotfiles, { stageChannel, ...timeouts }).pipe(
        Effect.provide(Layer.mergeAll(runtime, sink, runs)),
      ),
    );
  return { run, applied, signals, appended, outcomes, cleanups, epochs };
};

describe("produceDotfilesRun", () => {
  it("applies as the user with the run as the execution; no bootstrap completes the run with 0", async () => {
    const w = world({
      apply: () => Effect.succeed({ user: "m4lice000", home: "/home/m4lice000" }),
    });
    await w.run();
    expect(w.applied).toEqual([
      { user: "m4lice000", archiveDir: dotfilesStagePath(RUN), executionId: RUN },
    ]);
    expect(w.cleanups).toEqual([`rm -rf -- '${dotfilesStagePath(RUN)}'`]);
    expect(w.outcomes).toEqual([{ status: "completed", id: RUN, exitCode: 0 }]);
    expect(w.epochs).toEqual(["open", "close:stream-end"]);
  });

  it("records the bootstrap's own events to its exit and completes with its exit code", async () => {
    const w = world({
      apply: () =>
        Effect.succeed({
          user: "m4lice000",
          home: "/home/m4lice000",
          bootstrap: { processId: "proc_boot", pid: 7 },
        }),
      events: Stream.fromIterable([
        // Another execution's process (a session in the same workspace) is not this run's.
        started("proc_other", "run_other"),
        started("proc_boot", RUN),
        // An untagged daemon event is not this run's either.
        started("proc_untagged"),
        exited("proc_boot", 3, RUN),
        started("proc_late", RUN),
      ]),
    });
    await w.run();
    expect(w.appended).toEqual(["proc_boot", "proc_boot"]);
    expect(w.outcomes).toEqual([{ status: "completed", id: RUN, exitCode: 3 }]);
    expect(w.epochs).toEqual(["open", "close:stream-end"]);
  });

  it("fails with the daemon's words when the apply is refused, and still removes the staged archives", async () => {
    const w = world({
      apply: () =>
        Effect.fail(
          new SealantControlError({
            operation: "dotfilesApply",
            code: 5,
            message: "dotfiles.apply as m4lice000: git clone of dotfiles exited with 128",
          }),
        ),
    });
    await w.run();
    expect(w.cleanups).toHaveLength(1);
    expect(w.outcomes).toEqual([
      {
        status: "failed",
        id: RUN,
        errorMessage:
          "The dotfiles were not applied as m4lice000: dotfiles.apply as m4lice000: git clone of dotfiles exited with 128",
      },
    ]);
  });

  it("stops a bootstrap that runs past its bound and fails the run", async () => {
    const w = world({
      apply: () =>
        Effect.succeed({
          user: "m4lice000",
          home: "/home/m4lice000",
          bootstrap: { processId: "proc_boot", pid: 7 },
        }),
      events: Stream.never,
    });
    await w.run(DOTFILES, { bootstrapTimeout: Duration.millis(20) });
    expect(w.signals).toEqual([{ processId: "proc_boot", signal: 15 }]);
    expect(w.outcomes).toHaveLength(1);
    expect(w.outcomes[0]).toMatchObject({ status: "failed", id: RUN });
    expect(String(w.outcomes[0]?.["errorMessage"])).toMatch(/more than 30 minutes and was stopped/);
  });

  it("fails when the daemon applied into another home than the one checked", async () => {
    const w = world({
      apply: () => Effect.succeed({ user: "m4lice000", home: "/home/elsewhere" }),
    });
    await w.run();
    expect(w.outcomes[0]).toMatchObject({ status: "failed" });
    expect(String(w.outcomes[0]?.["errorMessage"])).toMatch(/no longer \/home\/m4lice000/);
  });

  it("removes only the directory staged for this run; a repository alone removes nothing", async () => {
    const w = world({
      apply: () => Effect.succeed({ user: "m4lice000", home: "/home/m4lice000" }),
    });
    await w.run({ ...DOTFILES, archiveDir: "/etc" });
    await w.run({
      user: "m4lice000",
      home: "/home/m4lice000",
      repository: { url: "https://github.com/acme/dots.git", bootstrap: true },
    });
    expect(w.cleanups).toEqual([]);
    expect(w.applied[1]).toEqual({
      user: "m4lice000",
      repository: { url: "https://github.com/acme/dots.git", bootstrap: true },
      executionId: RUN,
    });
  });
});
