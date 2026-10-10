/**
 * An exec run whose record store refuses appends. The job does not retry or wait: when the process
 * has exited it checks the log for what was refused. Events the other writer stored (the box's
 * duplicate key: the ingester had inserted the same row) are there, and the run completes. Events
 * not in the log are lost output, so the run fails, saying how many and why, with the exit code it
 * observed and the changes the commands made. Driven against a fake daemon session, sink and run
 * repository.
 */
import { RunRepo, type RunRepoService } from "@sealant/db";
import {
  TelemetrySink,
  TelemetrySinkUnexpectedError,
  type LossSpanInput,
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

const duplicateKey = () =>
  new TelemetrySinkUnexpectedError({
    operation: "appendBatch",
    message: "Failed query: insert into telemetry_events …",
    cause: new Error('duplicate key value violates unique constraint "telemetry_events_pkey"'),
  });

/**
 * `racing`: every append is refused, but the other writer has the events in the log. `down`: every
 * append is refused and nothing reaches the log.
 */
const world = (store: "racing" | "down") => {
  const execs: SealantExecOptions[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  const spans: LossSpanInput[] = [];
  const logged = new Set<bigint>();
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
  const sink = {
    openEpoch: () => Effect.succeed({ epochId: "tep_1", resumeFromSequence: null }),
    appendBatch: ({ batch }) =>
      Effect.suspend(() => {
        if (store === "racing") for (const event of batch) logged.add(event.sequence);
        return Effect.fail(duplicateKey());
      }),
    countStored: ({ ranges }) =>
      Effect.sync(() =>
        ranges.map((range) => {
          let n = 0;
          for (let sequence = range.from; sequence <= range.to; sequence += 1n) {
            if (logged.has(sequence)) n += 1;
          }
          return n;
        }),
      ),
    insertLossSpan: ({ span }) => Effect.sync(() => void spans.push(span)),
    closeEpoch: () => Effect.void,
    getMaxSequence: () => Effect.succeed(null),
    streamRawLog: () => Stream.empty,
  } satisfies TelemetrySinkService;
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
      produceExecRun(RUN, TARGET, [{ executable: "make", args: ["check"] }]).pipe(
        Effect.provide(layer),
      ),
    );
  return { run, outcomes, spans };
};

describe("an exec run whose record store refuses appends", () => {
  it("completes when the refused events are in the log (the box's duplicate key)", async () => {
    const w = world("racing");
    await w.run();
    expect(w.outcomes).toMatchObject([{ status: "completed", id: RUN, exitCode: 3 }]);
    expect(w.spans).toEqual([]);
  });

  it("fails with the observed exit, the changes and what was lost when the events are not in the log", async () => {
    const w = world("down");
    await w.run();
    expect(w.outcomes).toEqual([
      {
        status: "failed",
        id: RUN,
        exitCode: 3,
        errorMessage:
          'Command 1/1 (make): The command exited 3, but 1 event(s) of its record (sequences 7–7) are not stored: duplicate key value violates unique constraint "telemetry_events_pkey"; check run aborted.',
        // The changes reading ran (here it exits 1: no reading).
        changesReadFailed: true,
      },
    ]);
    expect(w.spans).toMatchObject([{ kind: "dropped_event", droppedCount: 1n }]);
  }, 20_000);
});
