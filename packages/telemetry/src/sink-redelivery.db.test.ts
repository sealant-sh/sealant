/**
 * `appendBatch` against a REAL Postgres when the same events arrive more than once. Gated on
 * SEALANT_TEST_DATABASE_URL (or DATABASE_URL), like `telemetry.db.test.ts`.
 *
 * The case this was written for (2026-10-10): a person's exec run failed because its run-exec job
 * and the full-stream ingester, each on its own connection to the runtime, inserted the same event
 * at the same moment. The insert's only arbiter was `(runtime_id, sequence)`, so the second
 * transaction did not wait the first one out on it and failed on the primary key (`event_id`)
 * instead: `duplicate key value violates unique constraint "telemetry_events_pkey"`.
 */
import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  makeSealantDBLayer,
  runs,
  SealantDB,
  telemetryEvents,
  user,
  workspaces,
} from "@sealant/db";
import { StreamKind } from "@sealant/runtime-client";
import { EventEnvelopeSchema } from "@sealant/runtime-protocol";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer, Logger } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InlineByteaArtifactStoreLive } from "./artifact-store.js";
import { normalizeEnvelope } from "./normalize.js";
import { PostgresTelemetrySinkLive, TelemetrySink } from "./sink.js";
import type { NormalizedEvent } from "./types.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const RUNTIME_ID = "rt_it_redelivery";
const runId = `run_it_${RUNTIME_ID}`;
const workspaceId = `ws_it_${RUNTIME_ID}`;
const userId = `user_it_${RUNTIME_ID}`;

const event = (
  sequence: bigint,
  init: MessageInitShape<typeof EventEnvelopeSchema> = {},
): NormalizedEvent =>
  normalizeEnvelope(
    create(EventEnvelopeSchema, {
      schemaVersion: 1,
      eventId: `evt_redelivery_${sequence.toString(16)}`,
      runtimeId: RUNTIME_ID,
      executionId: runId,
      processId: "proc_redelivery",
      sequence,
      observedAt: sequence * 1000n,
      monotonicTimestamp: sequence * 10n,
      captureMethod: 1,
      confidence: 1,
      payload: {
        case: "ioChunk",
        value: {
          stream: StreamKind.STDOUT,
          byteCount: 2n,
          streamOffset: (sequence - 1n) * 2n,
          content: new TextEncoder().encode(`${String(sequence % 10n)}\n`),
        },
      },
      ...init,
    }),
  );

const events = (from: bigint, count: number) =>
  Array.from({ length: count }, (_, index) => event(from + BigInt(index)));

const dbLayer = DATABASE_URL === undefined ? undefined : makeSealantDBLayer(DATABASE_URL);

describe.skipIf(DATABASE_URL === undefined)("appendBatch re-delivery (real Postgres)", () => {
  const db = dbLayer!;
  const artifactLayer = InlineByteaArtifactStoreLive.pipe(Layer.provide(db));
  const layer = Layer.mergeAll(
    db,
    PostgresTelemetrySinkLive.pipe(Layer.provide(Layer.mergeAll(db, artifactLayer))),
  );

  const errors: string[] = [];
  const recorder = Logger.make(({ message, logLevel }) => {
    if (logLevel === "Error" || logLevel === "Warn") {
      errors.push(Array.isArray(message) ? message.map((part) => String(part)).join(" ") : "");
    }
  });
  const run = <A, E>(effect: Effect.Effect<A, E, TelemetrySink | SealantDB>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(Logger.layer([recorder]))));

  const append = (batch: readonly NormalizedEvent[]) =>
    Effect.gen(function* () {
      const sink = yield* TelemetrySink;
      return yield* sink.appendBatch({ runId, runtimeId: RUNTIME_ID, batch });
    });

  const stored = Effect.gen(function* () {
    const handle = yield* SealantDB;
    return yield* handle
      .select()
      .from(telemetryEvents)
      .where(eq(telemetryEvents.runtimeId, RUNTIME_ID))
      .orderBy(asc(telemetryEvents.sequence));
  });

  const cleanup = Effect.gen(function* () {
    const handle = yield* SealantDB;
    yield* handle.delete(workspaces).where(eq(workspaces.id, workspaceId)); // cascades
    yield* handle.delete(user).where(eq(user.id, userId));
  });

  beforeAll(async () => {
    await run(
      Effect.gen(function* () {
        yield* cleanup;
        const handle = yield* SealantDB;
        const now = new Date();
        yield* handle.insert(user).values({
          id: userId,
          name: "redelivery-it",
          email: `${userId}@example.test`,
          createdAt: now,
          updatedAt: now,
        });
        yield* handle
          .insert(workspaces)
          .values({ id: workspaceId, ownerUserId: userId, createdAt: now, updatedAt: now });
        yield* handle.insert(runs).values({
          id: runId,
          workspaceId,
          ownerUserId: userId,
          harnessId: "exec",
          createdAt: now,
          updatedAt: now,
        });
        const sink = yield* TelemetrySink;
        yield* sink.openEpoch({ runId, runtimeId: RUNTIME_ID, schemaVersion: 0 });
      }),
    );
  });

  afterAll(async () => {
    await run(cleanup);
  });

  it("takes an identical re-delivered batch as nothing", async () => {
    errors.length = 0;
    const started = event(1n, {
      payload: {
        case: "processStarted",
        value: { pid: 7, pgid: 7, executable: "sh", args: ["-c", "echo secret"], cwd: "/" },
      },
    });
    const batch = [started, ...events(2n, 3)];
    const [first, second] = await run(Effect.all([append(batch), append(batch)]));
    expect(first).toHaveLength(4);
    expect(second).toEqual([]);
    expect((await run(stored)).map((row) => row.sequence)).toEqual([1n, 2n, 3n, 4n]);
    expect(errors).toEqual([]);
  });

  it("takes only the new events of a retried batch whose first attempt committed", async () => {
    errors.length = 0;
    await run(append(events(10n, 3)));
    // The first attempt's commit was not acknowledged; the retry carries it again, and more.
    const retried = await run(append(events(10n, 5)));
    expect(retried.map((committed) => committed.sequence)).toEqual([13n, 14n]);
    expect(
      (await run(stored)).filter((row) => row.sequence >= 10n).map((row) => row.sequence),
    ).toEqual([10n, 11n, 12n, 13n, 14n]);
    expect(errors).toEqual([]);
  });

  it("stores each event once when two consumers append the same batches at the same time", async () => {
    errors.length = 0;
    // A run-exec job and the full-stream ingester, each with its own connection and transaction.
    // The window is narrow (one transaction's arbiter check to its own index insert): against the
    // old arbiter this failed within the first few hundred rounds of one-event batches.
    const rounds = 500;
    const size = 1;
    const results = await run(
      Effect.forEach(
        Array.from({ length: rounds }, (_, round) => events(1000n + BigInt(round * size), size)),
        (batch) => Effect.all([append(batch), append(batch)], { concurrency: 2 }),
      ),
    );
    for (const [a, b] of results) {
      expect(a.length + b.length).toBe(size);
    }
    expect((await run(stored)).filter((row) => row.sequence >= 1000n)).toHaveLength(rounds * size);
    expect(errors).toEqual([]);
  });

  it("keeps the stored event, logs an error and does not fail when a different event reuses its id or position", async () => {
    errors.length = 0;
    await run(append([event(100n), event(101n)]));
    // Same id, another sequence: the old arbiter let it through to fail on the primary key.
    const sameId = { ...event(102n), eventId: event(100n).eventId };
    // Same position, another id and other bytes.
    const samePosition = event(101n, {
      eventId: "evt_redelivery_other",
      payload: { case: "runtimeHeartbeat", value: { state: 2 } },
    });
    const committed = await run(append([sameId, samePosition, event(103n)]));

    expect(committed.map((row) => row.sequence)).toEqual([103n]);
    const kept = (await run(stored)).filter((row) => row.sequence >= 100n && row.sequence < 200n);
    expect(kept.map((row) => [row.eventId, row.sequence, row.payloadCase])).toEqual([
      ["evt_redelivery_64", 100n, "ioChunk"],
      ["evt_redelivery_65", 101n, "ioChunk"],
      ["evt_redelivery_67", 103n, "ioChunk"],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("2 re-delivered event(s)");
  });
});
