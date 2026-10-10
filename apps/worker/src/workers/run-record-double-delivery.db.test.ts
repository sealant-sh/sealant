/**
 * The double delivery that failed a person's exec run (2026-10-10), end to end against a REAL
 * Postgres. Gated on SEALANT_TEST_DATABASE_URL (or DATABASE_URL), like the other `*.db.test.ts`.
 *
 * Every event of an exec run reaches the record twice: the run-exec job (`captureRun`) records its
 * run's events on its own connection to the runtime, and the telemetry worker's full-stream
 * ingester records every event of the runtime on another, attributing the run's events to the run.
 * Both write the same rows at about the same moment. Before `appendBatch` took a conflict on any
 * unique key, a second insert that landed inside the first one's window failed on the primary key,
 * the job failed the run ("Run execution failed before completion") while its process went on and
 * exited 0, and the ingester recorded the rest. That window is microseconds wide and the two
 * consumers' work between receiving and appending differs, so this suite does not hit it:
 * `sink-redelivery.db.test.ts` (in @sealant/telemetry) holds it open deterministically, against
 * the sink alone. This one proves the whole path: both consumers, one copy of each event, the
 * run's exit observed.
 */
import { makeSealantDBLayer, runs, SealantDB, user, workspaces } from "@sealant/db";
import {
  ExecutionRunResolverLive,
  InlineByteaArtifactStoreLive,
  PostgresTelemetrySinkLive,
  TelemetryIngester,
  TelemetryIngesterLive,
} from "@sealant/telemetry";
import { SealantRuntime, type SealantSession, type SealantTarget } from "@sealant/workspaces";
import { Deferred, Effect, Layer, Logger, PubSub, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { captureRun } from "./process-run-exec-job.js";

type EventEnvelope = Stream.Success<SealantSession["events"]>;

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const TAG = "it_double_delivery";
const userId = `user_${TAG}`;
const workspaceId = `ws_${TAG}`;
/** The workspace's launch run: the ingester's default run. */
const launchRunId = `run_launch_${TAG}`;
/** The person's exec run, threaded through the daemon as the execution id. */
const execRunId = `run_exec_${TAG}`;
const TARGET: SealantTarget = { kind: "docker-exec", containerId: "c1", socketPath: "/s" };
const PROC = "proc_exec";
/** One full batch per burst, so both consumers append the same batch at the same moment. */
const BURST = 256;
const BURSTS = 40;
const CHUNKS = BURST * BURSTS;

// The protobuf message type carries `$typeName` brands a plain object cannot; the normalizer reads
// only these fields.
const envelope = (runtimeId: string, sequence: number, payload: unknown): EventEnvelope =>
  ({
    schemaVersion: 1,
    eventId: `evt_${runtimeId}_${sequence.toString(16)}`,
    runtimeId,
    executionId: execRunId,
    processId: PROC,
    sequence: BigInt(sequence),
    observedAt: BigInt(sequence) * 1000n,
    monotonicTimestamp: BigInt(sequence) * 10n,
    captureMethod: 1,
    confidence: 1,
    payload,
  }) as unknown as EventEnvelope;

/** One exec as the daemon reports it: start, output, exit 0. */
const execEvents = (runtimeId: string): readonly EventEnvelope[] => [
  envelope(runtimeId, 1, {
    case: "processStarted",
    value: { pid: 7, pgid: 7, executable: "sh", args: ["-c", "true"], cwd: "/workspace/repo" },
  }),
  // Output whose bytes are not stored: the race is in the event rows, and content would add one
  // artifact write per event before each batch's transaction.
  ...Array.from({ length: CHUNKS }, (_, index) =>
    envelope(runtimeId, index + 2, {
      case: "ioChunk",
      value: { stream: 2, byteCount: 3n, streamOffset: BigInt(index * 3) },
    }),
  ),
  envelope(runtimeId, CHUNKS + 2, {
    case: "processExited",
    value: { exitCode: 0, reason: 1 },
  }),
];

/**
 * A daemon fans every event out to each connection at the same instant: here, one PubSub that both
 * connections subscribe to, published to in bursts once both have.
 */
const daemonFor = (runtimeId: string) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<EventEnvelope>();
    const bothSubscribed = yield* Deferred.make<void>();
    let subscribers = 0;
    const events = execEvents(runtimeId);
    const last = events.at(-1)!.sequence;
    const runtime = {
      connect: () =>
        Effect.succeed({
          health: Effect.succeed({ runtimeId }),
          capabilities: Effect.succeed({ supports: ["exec.user"] }),
          exec: () => Effect.succeed({ processId: PROC, pid: 7 }),
          events: Stream.unwrap(
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(pubsub);
              subscribers += 1;
              if (subscribers === 2) yield* Deferred.succeed(bothSubscribed, undefined);
              return Stream.fromSubscription(subscription).pipe(
                Stream.takeUntil((event) => event.sequence === last),
              );
            }),
          ),
        } as unknown as SealantSession),
    };
    const publish = Effect.gen(function* () {
      yield* Deferred.await(bothSubscribed);
      yield* PubSub.publishAll(pubsub, events.slice(0, 1));
      for (let start = 1; start < events.length; start += BURST) {
        yield* PubSub.publishAll(pubsub, events.slice(start, start + BURST));
        yield* Effect.sleep("2 millis");
      }
    });
    return { runtime, publish };
  });

const dbLayer = DATABASE_URL === undefined ? undefined : makeSealantDBLayer(DATABASE_URL);

describe.skipIf(DATABASE_URL === undefined)(
  "an exec run recorded by its job and the full-stream ingester at once (real Postgres)",
  () => {
    const db = dbLayer!;
    const artifactLayer = InlineByteaArtifactStoreLive.pipe(Layer.provide(db));
    const sinkLayer = PostgresTelemetrySinkLive.pipe(
      Layer.provide(Layer.mergeAll(db, artifactLayer)),
    );
    const layerFor = (runtime: Effect.Success<ReturnType<typeof daemonFor>>["runtime"]) => {
      const runtimeLayer = Layer.succeed(SealantRuntime, runtime);
      return Layer.mergeAll(
        db,
        sinkLayer,
        runtimeLayer,
        TelemetryIngesterLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              runtimeLayer,
              sinkLayer,
              ExecutionRunResolverLive.pipe(Layer.provide(db)),
            ),
          ),
        ),
      );
    };

    const cleanup = Effect.gen(function* () {
      const handle = yield* SealantDB;
      // Constant test ids only (the worker has no query builder of its own to bind them with).
      yield* handle.execute(`DELETE FROM "workspaces" WHERE "id" = '${workspaceId}'`); // cascades
      yield* handle.execute(`DELETE FROM "user" WHERE "id" = '${userId}'`);
    });

    beforeAll(async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* cleanup;
          const handle = yield* SealantDB;
          const now = new Date();
          yield* handle.insert(user).values({
            id: userId,
            name: TAG,
            email: `${userId}@example.test`,
            createdAt: now,
            updatedAt: now,
          });
          yield* handle
            .insert(workspaces)
            .values({ id: workspaceId, ownerUserId: userId, createdAt: now, updatedAt: now });
          yield* handle.insert(runs).values(
            [launchRunId, execRunId].map((id) => ({
              id,
              workspaceId,
              ownerUserId: userId,
              harnessId: "exec",
              createdAt: now,
              updatedAt: now,
            })),
          );
        }).pipe(Effect.provide(db)),
      );
    });

    afterAll(async () => {
      await Effect.runPromise(cleanup.pipe(Effect.provide(db)));
    });

    it("records every event once and the run's exit, with no failed append", async () => {
      const problems: string[] = [];
      const recorder = Logger.make(({ message, logLevel }) => {
        if (logLevel === "Error" || logLevel === "Warn") {
          problems.push(Array.isArray(message) ? message.map(String).join(" ") : "");
        }
      });

      const runtimeId = `rt_${TAG}`;
      const daemon = await Effect.runPromise(daemonFor(runtimeId));
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const ingester = yield* TelemetryIngester;
          const [exitCode] = yield* Effect.all(
            [
              captureRun(execRunId, TARGET, { executable: "sh", args: ["-c", "true"] }),
              Effect.scoped(ingester.run(launchRunId, TARGET)),
              daemon.publish,
            ],
            { concurrency: "unbounded" },
          );
          const handle = yield* SealantDB;
          const [stored] = yield* handle.execute<{ n: number }>(
            `SELECT count(*)::int AS n FROM "telemetry_events" WHERE "runtime_id" = '${runtimeId}' AND "run_id" = '${execRunId}'`,
          );
          return { exitCode, stored: stored?.n ?? 0 };
        }).pipe(Effect.provide(layerFor(daemon.runtime)), Effect.provide(Logger.layer([recorder]))),
      );
      expect(outcome).toEqual({ exitCode: 0, stored: CHUNKS + 2 });
      expect(problems).toEqual([]);
    }, 60_000);
  },
);
