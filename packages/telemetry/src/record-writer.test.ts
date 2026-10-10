/**
 * The run-exec job's record writer against a fake log. It appends each batch once and never waits
 * on the store; what the store refused is checked when the process has exited, and only what the
 * log does not hold then (in the run, for a tagged event), or holds a different version of, is
 * lost: one `dropped_event` span for the missing sequences, and the loss returned for the run to
 * fail on. Memory holds sequence ranges, not events.
 */
import { create } from "@bufbuild/protobuf";
import { EventEnvelopeSchema } from "@sealant/runtime-protocol";
import { Effect, Schedule, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { TelemetrySinkUnexpectedError } from "./errors.js";
import { normalizeEnvelope } from "./normalize.js";
import { makeRunRecordWriter } from "./record-writer.js";
import type { TelemetrySinkService } from "./sink.js";
import type { LossSpanInput, NormalizedEvent } from "./types.js";

const RUN = "run_exec";

/** `null`: an untagged daemon event. */
const event = (sequence: bigint, executionId: string | null = RUN): NormalizedEvent =>
  normalizeEnvelope(
    create(EventEnvelopeSchema, {
      schemaVersion: 1,
      eventId: `evt_${sequence.toString()}`,
      runtimeId: "rt_1",
      sequence,
      ...(executionId === null ? {} : { executionId }),
      payload: { case: "runtimeHeartbeat", value: { state: 2 } },
    }),
  );

const events = (from: bigint, count: number) =>
  Array.from({ length: count }, (_, index) => event(from + BigInt(index)));

const refusal = () =>
  new TelemetrySinkUnexpectedError({
    operation: "appendBatch",
    message: "Failed query: insert into telemetry_events … params: 257,258",
    cause: new Error("Connection terminated unexpectedly"),
  });

/** A log of (sequence → run); the store refuses appends while `down()` says so. */
const fakeLog = (down: () => boolean) => {
  const stored = new Map<bigint, string>();
  const spans: LossSpanInput[] = [];
  let appends = 0;
  const sink: TelemetrySinkService = {
    appendBatch: ({ runId, batch }) =>
      Effect.suspend(() => {
        appends += 1;
        if (down()) return Effect.fail(refusal());
        const appended = batch.filter((item) => !stored.has(item.sequence));
        for (const item of appended) stored.set(item.sequence, runId);
        return Effect.succeed({ appended, conflicts: [] });
      }),
    countStored: ({ runId, ranges }) =>
      Effect.sync(() =>
        ranges.map((range) => {
          let n = 0;
          for (let sequence = range.from; sequence <= range.to; sequence += 1n) {
            const run = stored.get(sequence);
            if (run !== undefined && (!range.tagged || run === runId)) n += 1;
          }
          return n;
        }),
      ),
    insertLossSpan: ({ span }) => Effect.sync(() => void spans.push(span)),
    openEpoch: () => Effect.die("unused"),
    closeEpoch: () => Effect.die("unused"),
    getMaxSequence: () => Effect.die("unused"),
    streamRawLog: () => Stream.die("unused"),
  };
  return { sink, stored, spans, appends: () => appends };
};

const writerFor = (log: ReturnType<typeof fakeLog>) =>
  makeRunRecordWriter(log.sink, {
    runId: RUN,
    runtimeId: "rt_1",
    verifySchedule: Schedule.recurs(2),
  });

describe("makeRunRecordWriter", () => {
  it("appends each batch once and finds nothing to check when the store took them", async () => {
    const log = fakeLog(() => false);
    const writer = writerFor(log);
    const loss = await Effect.runPromise(
      Effect.andThen(writer.append(events(1n, 2)), writer.verify),
    );
    expect(loss).toBeUndefined();
    expect(log.appends()).toBe(1);
  });

  it("does not retry a refused batch, and finds it stored by the other writer at the exit", async () => {
    const log = fakeLog(() => true);
    const writer = writerFor(log);
    const loss = await Effect.runPromise(
      Effect.gen(function* () {
        yield* writer.append(events(1n, 3));
        // The full-stream ingester stored the same events under the run.
        for (const item of events(1n, 3)) log.stored.set(item.sequence, RUN);
        return yield* writer.verify;
      }),
    );
    expect(log.appends()).toBe(1);
    expect(loss).toBeUndefined();
    expect(log.spans).toEqual([]);
  });

  it("waits out an ingester that stores the refused events late", async () => {
    const log = fakeLog(() => true);
    const writer = makeRunRecordWriter(log.sink, {
      runId: RUN,
      runtimeId: "rt_1",
      verifySchedule: Schedule.spaced("10 millis").pipe(Schedule.both(Schedule.recurs(20))),
    });
    setTimeout(() => {
      for (const item of events(1n, 2)) log.stored.set(item.sequence, RUN);
    }, 50);
    const loss = await Effect.runPromise(
      Effect.andThen(writer.append(events(1n, 2)), writer.verify),
    );
    expect(loss).toBeUndefined();
  });

  it("keeps sequence ranges, not events: a long outage is one range", async () => {
    const log = fakeLog(() => true);
    const writer = writerFor(log);
    const loss = await Effect.runPromise(
      Effect.gen(function* () {
        for (let start = 1n; start <= 20_000n; start += 256n) {
          yield* writer.append(events(start, 256));
        }
        return yield* writer.verify;
      }),
    );
    expect(loss).toMatchObject({ events: 20_224, fromSequence: 1n, toSequence: 20_224n });
    expect(log.spans).toEqual([
      {
        kind: "dropped_event",
        fromSequence: 1n,
        toSequence: 20_224n,
        droppedCount: 20_224n,
        reason: "the record store did not take these events: Connection terminated unexpectedly",
        detectedVia: "marker",
        atSequence: 1n,
        key: "unstored",
      },
    ]);
  });

  it("returns only the sequences the log does not hold", async () => {
    const log = fakeLog(() => true);
    const writer = writerFor(log);
    const loss = await Effect.runPromise(
      Effect.gen(function* () {
        yield* writer.append(events(5n, 5));
        for (const sequence of [5n, 6n, 7n]) log.stored.set(sequence, RUN);
        return yield* writer.verify;
      }),
    );
    expect(loss).toEqual({
      events: 5,
      fromSequence: 5n,
      toSequence: 9n,
      reason: "Connection terminated unexpectedly",
    });
  });

  it("does not count a tagged event stored under another run, and does an untagged one", async () => {
    const log = fakeLog(() => true);
    const writer = writerFor(log);
    const loss = await Effect.runPromise(
      Effect.gen(function* () {
        yield* writer.append([event(1n), event(2n, null)]);
        log.stored.set(1n, "run_launch");
        log.stored.set(2n, "run_launch");
        return yield* writer.verify;
      }),
    );
    expect(loss).toMatchObject({ events: 1, fromSequence: 1n, toSequence: 1n });
  });

  it("reports an appended event the log holds a different version of", async () => {
    const log = fakeLog(() => false);
    const conflicting: TelemetrySinkService = {
      ...log.sink,
      appendBatch: ({ batch }) =>
        Effect.succeed({
          appended: batch.slice(1),
          conflicts: [
            {
              eventId: "evt_7",
              runId: RUN,
              runtimeId: "rt_1",
              sequence: 7n,
              storedEventIdAtSequence: undefined,
              differences: ["payloadCase", "payload"],
            },
          ],
        }),
    };
    const writer = makeRunRecordWriter(conflicting, { runId: RUN, runtimeId: "rt_1" });
    const loss = await Effect.runPromise(
      Effect.andThen(writer.append(events(7n, 2)), writer.verify),
    );
    expect(loss).toEqual({
      events: 1,
      fromSequence: 7n,
      toSequence: 7n,
      reason: "1 conflict(s) with a different event already stored at the same id or position",
    });
    // The conflict's span is the sink's; the writer adds none for it.
    expect(log.spans).toEqual([]);
  });
});
