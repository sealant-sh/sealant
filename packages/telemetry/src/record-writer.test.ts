/**
 * The run-exec job's record writer against a fake store: a batch the store refuses is retried,
 * held back while the process runs and appended once more after it exits, and only what is still
 * not stored is lost (one `dropped_event` span, and the loss returned for the run to fail on).
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

const event = (sequence: bigint): NormalizedEvent =>
  normalizeEnvelope(
    create(EventEnvelopeSchema, {
      schemaVersion: 1,
      eventId: `evt_${sequence.toString()}`,
      runtimeId: "rt_1",
      sequence,
      payload: { case: "runtimeHeartbeat", value: { state: 2 } },
    }),
  );

const refusal = () =>
  new TelemetrySinkUnexpectedError({
    operation: "appendBatch",
    message: "Failed query: insert into telemetry_events … params: 257,258",
    cause: new Error("Connection terminated unexpectedly"),
  });

/** A store that refuses every append while `down()` says so. */
const fakeStore = (down: () => boolean) => {
  const stored = new Map<string, NormalizedEvent>();
  const spans: LossSpanInput[] = [];
  let attempts = 0;
  const sink: Pick<TelemetrySinkService, "appendBatch" | "insertLossSpan"> = {
    appendBatch: ({ batch }) =>
      Effect.suspend(() => {
        attempts += 1;
        if (down()) return Effect.fail(refusal());
        const fresh = batch.filter((item) => !stored.has(item.eventId));
        for (const item of fresh) stored.set(item.eventId, item);
        return Effect.succeed(fresh);
      }),
    insertLossSpan: ({ span }) => Effect.sync(() => void spans.push(span)),
  };
  return {
    sink,
    stored,
    spans,
    attempts: () => attempts,
  };
};

const writerFor = (store: ReturnType<typeof fakeStore>) =>
  makeRunRecordWriter(
    {
      ...store.sink,
      openEpoch: () => Effect.die("unused"),
      closeEpoch: () => Effect.die("unused"),
      getMaxSequence: () => Effect.die("unused"),
      streamRawLog: () => Stream.die("unused"),
    },
    { runId: "run_1", runtimeId: "rt_1", retry: Schedule.recurs(2) },
  );

describe("makeRunRecordWriter", () => {
  it("retries a refused batch and loses nothing when the store comes back", async () => {
    let refusals = 2;
    const store = fakeStore(() => refusals-- > 0);
    const writer = writerFor(store);
    const loss = await Effect.runPromise(
      Effect.andThen(writer.append([event(1n), event(2n)]), writer.flush),
    );
    expect(loss).toBeUndefined();
    expect(store.attempts()).toBe(3);
    expect([...store.stored.keys()]).toEqual(["evt_1", "evt_2"]);
    expect(store.spans).toEqual([]);
  });

  it("holds a batch back while the store is down and stores it when the process has exited", async () => {
    let down = true;
    const store = fakeStore(() => down);
    const writer = writerFor(store);
    const loss = await Effect.runPromise(
      Effect.gen(function* () {
        yield* writer.append([event(1n), event(2n)]);
        down = false;
        yield* writer.append([event(3n)]);
        return yield* writer.flush;
      }),
    );
    expect(loss).toBeUndefined();
    expect([...store.stored.keys()].toSorted()).toEqual(["evt_1", "evt_2", "evt_3"]);
  });

  it("takes a held-back batch another consumer already stored as stored", async () => {
    let down = true;
    const store = fakeStore(() => down);
    const writer = writerFor(store);
    const loss = await Effect.runPromise(
      Effect.gen(function* () {
        yield* writer.append([event(1n)]);
        // The full-stream ingester stored it meanwhile.
        store.stored.set("evt_1", event(1n));
        down = false;
        return yield* writer.flush;
      }),
    );
    expect(loss).toBeUndefined();
  });

  it("returns what is still not stored after the process exits, with one loss span", async () => {
    const store = fakeStore(() => true);
    const writer = writerFor(store);
    const loss = await Effect.runPromise(
      Effect.andThen(
        Effect.andThen(writer.append([event(5n), event(6n)]), writer.append([event(9n)])),
        writer.flush,
      ),
    );
    expect(loss).toEqual({
      events: 3,
      fromSequence: 5n,
      toSequence: 9n,
      reason: "Connection terminated unexpectedly",
    });
    expect(store.spans).toEqual([
      {
        kind: "dropped_event",
        fromSequence: 5n,
        toSequence: 9n,
        droppedCount: 3n,
        reason: "the record store did not take these events: Connection terminated unexpectedly",
        detectedVia: "marker",
        atSequence: 5n,
      },
    ]);
  });
});
