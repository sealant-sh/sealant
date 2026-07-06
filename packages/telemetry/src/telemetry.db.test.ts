/**
 * Integration test for the vertical slice against a REAL Postgres (the dev control-plane DB).
 * Gated on DATABASE_URL so it skips where no DB is available (mirrors runtime.test.ts skipping when
 * the sealantd binary is absent). It drives the REAL PostgresTelemetrySink + Projector + Query +
 * Ingester with a STUB SealantRuntime emitting a handcrafted EventEnvelope stream, then asserts:
 *   (a) the log is written and re-ingest is idempotent (dedup)
 *   (b) a sequence gap and an explicit drop become loss spans
 *   (c) terminal scrollback reassembles byte-exact via streamOffset
 *   (d) projection == rebuild
 *   (e) a near-2^63 bigint round-trips losslessly
 *   (f) stream-end records an early_close loss span
 */
import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { makeSealantDBLayer, runs, sandboxes, SealantDB, telemetryEvents, user } from "@sealant/db";
import { EventPriority, ExitReason, StreamKind } from "@sealant/runtime-client";
import { EventEnvelopeSchema, HealthReportSchema } from "@sealant/runtime-protocol";
import type { EventEnvelope } from "@sealant/runtime-protocol";
import {
  SealantRuntime,
  type SealantRuntimeService,
  type SealantSession,
} from "@sealant/sandboxes";
import { count, eq } from "drizzle-orm";
import { Effect, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InlineByteaArtifactStoreLive } from "./artifact-store.js";
import { ExecutionRunResolverLive } from "./attribution.js";
import { TelemetryIngester, TelemetryIngesterLive } from "./ingester.js";
import { TelemetryProjector, TelemetryProjectorLive } from "./projector.js";
import { TelemetryQuery, TelemetryQueryLive } from "./query.js";
import { PostgresTelemetrySinkLive } from "./sink.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUNTIME_ID = "rt_it_telemetry";
const PROC_ID = "proc_it";
const BIG_DURATION = 9000000000000000001n;
const TARGET = { kind: "docker-exec" as const, containerId: "unused", socketPath: "unused" };

const evt = (sequence: bigint, init: MessageInitShape<typeof EventEnvelopeSchema>) =>
  create(EventEnvelopeSchema, {
    schemaVersion: 1,
    eventId: `evt_it_${sequence.toString()}`,
    runtimeId: RUNTIME_ID,
    sequence,
    observedAt: sequence * 1000n,
    monotonicTimestamp: sequence * 10n,
    captureMethod: 1,
    confidence: 1,
    ...init,
  });

const EVENTS: readonly EventEnvelope[] = [
  evt(1n, {
    processId: PROC_ID,
    payload: {
      case: "processStarted",
      value: {
        pid: 100,
        pgid: 100,
        executable: "/bin/sh",
        args: ["-c", "echo hi"],
        cwd: "/",
        startedAt: 1n,
      },
    },
  }),
  evt(2n, {
    processId: PROC_ID,
    payload: {
      case: "ioChunk",
      value: {
        stream: StreamKind.STDOUT,
        byteCount: 3n,
        streamOffset: 0n,
        content: new TextEncoder().encode("Hel"),
      },
    },
  }),
  evt(3n, {
    processId: PROC_ID,
    payload: {
      case: "ioChunk",
      value: {
        stream: StreamKind.STDOUT,
        byteCount: 3n,
        streamOffset: 3n,
        content: new TextEncoder().encode("lo\n"),
      },
    },
  }),
  evt(4n, {
    processId: PROC_ID,
    payload: {
      case: "processExited",
      value: { exitCode: 0, reason: ExitReason.EXITED, durationMicros: BIG_DURATION },
    },
  }),
  evt(5n, {
    payload: {
      case: "telemetryDropped",
      value: { reason: "queue_full", count: 2n, priority: EventPriority.LOW },
    },
  }),
  // gap: 6 and 7 skipped
  evt(8n, {
    payload: {
      case: "networkRequest",
      value: {
        scheme: 1,
        host: "example.com",
        port: 443,
        bytesSent: 10n,
        bytesReceived: 20n,
        durationMicros: 5n,
      },
    },
  }),
  evt(9n, {}), // no payload -> 'unknown'
];

const stubSession: SealantSession = {
  health: Effect.succeed(create(HealthReportSchema, { runtimeId: RUNTIME_ID, state: 2 })),
  capabilities: Effect.die("unused in test"),
  exec: () => Effect.die("unused in test"),
  writeStdin: () => Effect.die("unused in test"),
  signalProcess: () => Effect.die("unused in test"),
  shutdown: () => Effect.die("unused in test"),
  events: Stream.fromIterable(EVENTS),
};

const stubRuntime: SealantRuntimeService = { connect: () => Effect.succeed(stubSession) };

// --- Attribution scenario: a second runtime whose stream carries execution-tagged events -------

const ATTR_RUNTIME_ID = "rt_it_attr";

const attrEvt = (
  sequence: bigint,
  executionId: string | undefined,
  init: MessageInitShape<typeof EventEnvelopeSchema>,
) =>
  create(EventEnvelopeSchema, {
    schemaVersion: 1,
    eventId: `evt_attr_${sequence.toString()}`,
    runtimeId: ATTR_RUNTIME_ID,
    ...(executionId === undefined ? {} : { executionId }),
    sequence,
    observedAt: sequence * 1000n,
    monotonicTimestamp: sequence * 10n,
    captureMethod: 1,
    confidence: 1,
    ...init,
  });

const makeStubRuntime = (events: readonly EventEnvelope[], runtimeId: string) => {
  const session: SealantSession = {
    ...stubSession,
    health: Effect.succeed(create(HealthReportSchema, { runtimeId, state: 2 })),
    events: Stream.fromIterable(events),
  };
  const runtime: SealantRuntimeService = { connect: () => Effect.succeed(session) };
  return runtime;
};

const dbLayer = DATABASE_URL === undefined ? undefined : makeSealantDBLayer(DATABASE_URL);

const buildTestLayer = (db: NonNullable<typeof dbLayer>, runtime: SealantRuntimeService) => {
  const runtimeLayer = Layer.succeed(SealantRuntime, runtime);
  const artifactLayer = InlineByteaArtifactStoreLive.pipe(Layer.provide(db));
  const sinkLayer = PostgresTelemetrySinkLive.pipe(
    Layer.provide(Layer.mergeAll(db, artifactLayer)),
  );
  const resolverLayer = ExecutionRunResolverLive.pipe(Layer.provide(db));
  return Layer.mergeAll(
    db,
    sinkLayer,
    TelemetryProjectorLive.pipe(Layer.provide(db)),
    TelemetryQueryLive.pipe(Layer.provide(Layer.mergeAll(db, artifactLayer))),
    TelemetryIngesterLive.pipe(
      Layer.provide(Layer.mergeAll(runtimeLayer, sinkLayer, resolverLayer)),
    ),
  );
};

const runId = `run_it_${RUNTIME_ID}`;
const sandboxId = `sbx_it_${RUNTIME_ID}`;
const userId = `user_it_${RUNTIME_ID}`;
// Attribution scenario rows: a launch run + an interactive "ssh" run in the SAME sandbox, and a
// run in a FOREIGN sandbox that must NOT be attributable from this sandbox's stream.
const attrLaunchRunId = `run_it_launch_${ATTR_RUNTIME_ID}`;
const attrSshRunId = `run_it_ssh_${ATTR_RUNTIME_ID}`;
const foreignSandboxId = `sbx_it_foreign_${ATTR_RUNTIME_ID}`;
const foreignRunId = `run_it_foreign_${ATTR_RUNTIME_ID}`;
const SSH_PROC_ID = "proc_it_ssh";

const ATTR_EVENTS: readonly EventEnvelope[] = [
  attrEvt(1n, attrSshRunId, {
    processId: SSH_PROC_ID,
    payload: {
      case: "ioChunk",
      value: {
        stream: StreamKind.STDOUT,
        byteCount: 4n,
        streamOffset: 0n,
        content: new TextEncoder().encode("ssh\n"),
      },
    },
  }),
  // Tagged with a run from ANOTHER sandbox: attribution must refuse it (falls back to default).
  attrEvt(2n, foreignRunId, {
    payload: { case: "runtimeHeartbeat", value: { state: 2 } },
  }),
  // Untagged daemon event: default run, the pre-attribution behavior.
  attrEvt(3n, undefined, {
    payload: { case: "runtimeHeartbeat", value: { state: 2 } },
  }),
];

describe.skipIf(DATABASE_URL === undefined)(
  "@sealant/telemetry vertical slice (real Postgres)",
  () => {
    const db = dbLayer!;
    const testLayer = buildTestLayer(db, stubRuntime);

    const seed = Effect.gen(function* () {
      const handle = yield* SealantDB;
      yield* handle.delete(sandboxes).where(eq(sandboxes.id, sandboxId)); // cascades runs -> telemetry_*
      yield* handle.delete(sandboxes).where(eq(sandboxes.id, foreignSandboxId));
      yield* handle.delete(user).where(eq(user.id, userId));
      const now = new Date();
      yield* handle
        .insert(user)
        .values({
          id: userId,
          name: "telemetry-it",
          email: `${userId}@example.test`,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      yield* handle
        .insert(sandboxes)
        .values({ id: sandboxId, ownerUserId: userId, createdAt: now, updatedAt: now })
        .onConflictDoNothing();
      yield* handle
        .insert(sandboxes)
        .values({ id: foreignSandboxId, ownerUserId: userId, createdAt: now, updatedAt: now })
        .onConflictDoNothing();
      yield* handle
        .insert(runs)
        .values([
          {
            id: runId,
            sandboxId,
            ownerUserId: userId,
            harnessId: "opencode",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: attrLaunchRunId,
            sandboxId,
            ownerUserId: userId,
            harnessId: "opencode",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: attrSshRunId,
            sandboxId,
            ownerUserId: userId,
            harnessId: "ssh",
            mode: "interactive" as const,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: foreignRunId,
            sandboxId: foreignSandboxId,
            ownerUserId: userId,
            harnessId: "opencode",
            createdAt: now,
            updatedAt: now,
          },
        ])
        .onConflictDoNothing();
    });

    const cleanup = Effect.gen(function* () {
      const handle = yield* SealantDB;
      yield* handle.delete(sandboxes).where(eq(sandboxes.id, sandboxId)); // cascades runs -> telemetry_*
      yield* handle.delete(sandboxes).where(eq(sandboxes.id, foreignSandboxId));
      yield* handle.delete(user).where(eq(user.id, userId));
    });

    beforeAll(async () => {
      await Effect.runPromise(seed.pipe(Effect.provide(db)));
    });

    afterAll(async () => {
      await Effect.runPromise(cleanup.pipe(Effect.provide(db)));
    });

    it("ingests, dedups, accounts for loss, reconstructs scrollback, and rebuilds projections", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const ingester = yield* TelemetryIngester;
          const query = yield* TelemetryQuery;
          const projector = yield* TelemetryProjector;
          const handle = yield* SealantDB;

          const countEvents = handle
            .select({ value: count() })
            .from(telemetryEvents)
            .where(eq(telemetryEvents.runId, runId))
            .pipe(Effect.map((rows) => Number(rows[0]?.value ?? 0)));

          // First ingest.
          yield* Effect.scoped(ingester.run(runId, TARGET));
          const afterFirst = yield* countEvents;

          // (a) Re-ingest is idempotent (dedup on (runtime_id, sequence)).
          yield* Effect.scoped(ingester.run(runId, TARGET));
          const afterSecond = yield* countEvents;

          // (b) Loss accounting.
          const loss = yield* query.getLossReport(runId);

          // (c) Byte-exact scrollback.
          const chunks = yield* Stream.runCollect(
            query.reconstructScrollback(runId, PROC_ID, StreamKind.STDOUT, 1000n),
          );
          const scrollback = Buffer.concat(chunks.map((bytes) => Buffer.from(bytes))).toString(
            "utf8",
          );

          // (d) projection == rebuild.
          const timelineBefore = yield* Stream.runCollect(query.getTimeline(runId));
          yield* projector.rebuild(runId);
          const timelineAfter = yield* Stream.runCollect(query.getTimeline(runId));

          // (e) bigint fidelity.
          const exitedEvent = yield* query.getEvent(runId, 4n);

          return {
            afterFirst,
            afterSecond,
            loss,
            scrollback,
            timelineBefore,
            timelineAfter,
            exitedSequence: exitedEvent.sequence,
            exitedDuration: exitedEvent.payload.durationMicros,
          };
        }).pipe(Effect.provide(testLayer)),
      );

      // (a) all 7 events persisted; re-ingest added nothing.
      expect(result.afterFirst).toBe(7);
      expect(result.afterSecond).toBe(7);

      // (b) one explicit drop (count 2), one inferred gap (6..7), and an early close.
      expect(result.loss.droppedEventCount).toBe(2n);
      expect(result.loss.sequenceGapCount).toBe(1);
      expect(result.loss.earlyClose).toBe(true); // (f)

      // (c) "Hel" + "lo\n" reassembled by streamOffset.
      expect(result.scrollback).toBe("Hello\n");

      // (d) rebuild reproduces the timeline byte-identically.
      expect(result.timelineAfter).toEqual(result.timelineBefore);
      expect(result.timelineBefore).toHaveLength(7);

      // (e) near-2^63 values are stored losslessly.
      expect(result.exitedSequence).toBe(4n);
      expect(result.exitedDuration).toBe(BIG_DURATION.toString());
    });

    it("attributes execution-tagged events to their run (same-sandbox only)", async () => {
      const attrLayer = buildTestLayer(db, makeStubRuntime(ATTR_EVENTS, ATTR_RUNTIME_ID));

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const ingester = yield* TelemetryIngester;
          const query = yield* TelemetryQuery;
          const handle = yield* SealantDB;

          // The connection's default run is the launch run; tagged events must be re-attributed.
          yield* Effect.scoped(ingester.run(attrLaunchRunId, TARGET));

          const rows = yield* handle
            .select({ eventId: telemetryEvents.eventId, runId: telemetryEvents.runId })
            .from(telemetryEvents)
            .where(eq(telemetryEvents.runtimeId, ATTR_RUNTIME_ID));

          // The scrollback projection must follow the attribution too.
          const chunks = yield* Stream.runCollect(
            query.reconstructScrollback(attrSshRunId, SSH_PROC_ID, StreamKind.STDOUT, 1000n),
          );
          const sshScrollback = Buffer.concat(chunks.map((bytes) => Buffer.from(bytes))).toString(
            "utf8",
          );

          return {
            byEvent: new Map(rows.map((row) => [row.eventId, row.runId])),
            sshScrollback,
          };
        }).pipe(Effect.provide(attrLayer)),
      );

      // Tagged with the same-sandbox ssh run -> attributed to it.
      expect(result.byEvent.get("evt_attr_1")).toBe(attrSshRunId);
      // Tagged with a foreign sandbox's run -> refused, falls back to the default run.
      expect(result.byEvent.get("evt_attr_2")).toBe(attrLaunchRunId);
      // Untagged -> default run.
      expect(result.byEvent.get("evt_attr_3")).toBe(attrLaunchRunId);
      // The ssh run's record reads back its own bytes.
      expect(result.sshScrollback).toBe("ssh\n");
    });
  },
);
