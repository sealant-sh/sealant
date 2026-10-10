/**
 * An exec run whose record cannot take one of its events: the log holds a different event at its
 * id or position, and the append fails with a `TelemetrySinkConflictError`. The run fails, as any
 * failed append fails it, but saying why, with the changes the commands made, and the commands
 * after it do not run. Driven against a fake daemon session, sink and run repository.
 */
import { RunRepo, type RunRepoService } from "@sealant/db";
import {
  TelemetrySink,
  TelemetrySinkConflictError,
  type TelemetrySinkService,
} from "@sealant/telemetry";
import {
  SealantRuntime,
  type SealantExecOptions,
  type SealantSession,
  type SealantTarget,
} from "@sealant/workspaces";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { produceExecRun } from "./process-run-exec-job.js";

type EventEnvelope = Stream.Success<SealantSession["events"]>;

const RUN = "run_record";
const TARGET: SealantTarget = { kind: "docker-exec", containerId: "c1", socketPath: "/s" };

// The protobuf message type carries `$typeName` brands a plain object cannot; the normalizer
// reads only these fields.
const exited = (processId: string, exitCode: number, executionId?: string): EventEnvelope =>
  ({
    schemaVersion: 1,
    eventId: `evt_${processId}`,
    runtimeId: "rt_1",
    sequence: 7n,
    observedAt: 1n,
    monotonicTimestamp: 1n,
    captureMethod: 1,
    confidence: 1,
    processId,
    ...(executionId === undefined ? {} : { executionId }),
    payload: { case: "processExited", value: { exitCode, reason: 1 } },
  }) as unknown as EventEnvelope;

const world = () => {
  const execs: SealantExecOptions[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  const session = {
    health: Effect.succeed({ runtimeId: "rt_1" }),
    capabilities: Effect.succeed({ supports: ["exec.user"] }),
    exec: (options: SealantExecOptions) =>
      Effect.sync(() => {
        execs.push(options);
        return { processId: `proc_${String(execs.length)}`, pid: 7 };
      }),
    // The command exits 3; the changes reading exits 1 (no reading), which is enough here.
    events: Stream.suspend(() => {
      const last = execs.at(-1);
      return Stream.make(
        exited(
          `proc_${String(execs.length)}`,
          last?.executionId === RUN ? 3 : 1,
          last?.executionId,
        ),
      );
    }),
  } as unknown as SealantSession;
  const sink: TelemetrySinkService = {
    openEpoch: () => Effect.succeed({ epochId: "tep_1", resumeFromSequence: null }),
    appendBatch: () =>
      Effect.fail(
        new TelemetrySinkConflictError({
          operation: "appendBatch",
          message:
            "1 event(s) differ from the ones the record holds (evt_proc_1 with other payloadCase, payload); the record keeps its own",
          eventIds: ["evt_proc_1"],
        }),
      ),
    insertLossSpan: () => Effect.void,
    closeEpoch: () => Effect.void,
    getMaxSequence: () => Effect.succeed(null),
    streamRawLog: () => Stream.empty,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(SealantRuntime, { connect: () => Effect.succeed(session) }),
    Layer.succeed(TelemetrySink, sink),
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
        { executable: "make", args: ["check"] },
        { executable: "make", args: ["lint"] },
      ]).pipe(Effect.provide(layer)),
    );
  return { run, execs, outcomes };
};

describe("an exec run whose record cannot take one of its events", () => {
  it("fails saying why, with the changes reading, and runs no further command", async () => {
    const w = world();
    await w.run();
    expect(w.execs.filter((options) => options.executionId === RUN)).toHaveLength(1);
    expect(w.outcomes).toEqual([
      {
        status: "failed",
        id: RUN,
        errorMessage:
          "Command 1/2 (make): The run's record could not take its events: 1 event(s) differ from the ones the record holds (evt_proc_1 with other payloadCase, payload); the record keeps its own. Check run aborted.",
        // The changes reading ran (here it exits 1: no reading).
        changesReadFailed: true,
      },
    ]);
  });
});
