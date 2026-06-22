import { RuntimeState } from "@sealant/runtime-client";
/**
 * TelemetryIngester — one `Effect.gen` Stream program per run. It owns a DEDICATED second
 * `SealantRuntime.connect` (never sharing execInSandbox's single-consumer iterator) and drains the
 * WHOLE runtime telemetry stream (heartbeats, drops, all processes) for the connection's lifetime —
 * no `takeUntil(processExited)`.
 *
 * Pipeline: events -> per-runtime gap detection + loss-span persist (tap) -> bound the unbounded
 * SDK queue (groupedWithin) -> normalize + idempotent appendBatch (mapEffect, retried) -> runDrain.
 * A finalizer closes the epoch and records `early_close` unless a clean terminal STOPPED was observed
 * (stream-end is SUSPICIOUS, never a clean EOF).
 */
import { SealantRuntime, type SealantRuntimeService, type SealantTarget } from "@sealant/sandboxes";
import { Context, Effect, Layer, Ref, Schedule, Stream } from "effect";
import type * as Scope from "effect/Scope";

import { type TelemetryIngesterError, withTelemetryIngesterError } from "./errors.js";
import { detectGap, normalizeEnvelope } from "./normalize.js";
import { TelemetrySink, type TelemetrySinkService } from "./sink.js";
import type { GapDetectionState } from "./types.js";

const BATCH_SIZE = 256;
const BATCH_WINDOW = "250 millis";

export interface TelemetryIngesterService {
  /** Ingest the full telemetry stream for `runId` from `target` until the connection ends. */
  readonly run: (
    runId: string,
    target: SealantTarget,
  ) => Effect.Effect<void, TelemetryIngesterError, Scope.Scope>;
}

export class TelemetryIngester extends Context.Service<
  TelemetryIngester,
  TelemetryIngesterService
>()("@sealant/telemetry/TelemetryIngester") {}

export const makeTelemetryIngester = (
  runtime: SealantRuntimeService,
  sink: TelemetrySinkService,
): TelemetryIngesterService => ({
  run: (runId, target) =>
    withTelemetryIngesterError(
      "run",
      Effect.gen(function* () {
        const session = yield* runtime.connect(target);
        const health = yield* session.health;
        const runtimeId = health.runtimeId;

        yield* sink.openEpoch({ runId, runtimeId, schemaVersion: 0 });
        const resume = yield* sink.getMaxSequence(runtimeId);
        const sawTerminalStop = yield* Ref.make(false);

        // Per-runtime gap-detection state. Mutated in-order by the single-fiber stream tap.
        const gapState: GapDetectionState = {
          lastSequenceByRuntime: new Map(resume === null ? [] : [[runtimeId, resume]]),
        };

        const drain = session.events.pipe(
          Stream.tap((env) =>
            Effect.gen(function* () {
              if (
                env.payload.case === "runtimeStateChanged" &&
                env.payload.value.state === RuntimeState.STOPPED
              ) {
                yield* Ref.set(sawTerminalStop, true);
              }
              const { lossSpan } = detectGap(gapState, env);
              if (lossSpan !== undefined) {
                yield* sink.insertLossSpan({ runId, runtimeId, span: lossSpan });
              }
            }),
          ),
          Stream.groupedWithin(BATCH_SIZE, BATCH_WINDOW),
          Stream.mapEffect((batch) =>
            sink
              .appendBatch({ runId, runtimeId, batch: batch.map(normalizeEnvelope) })
              .pipe(
                Effect.retry(
                  Schedule.exponential("100 millis").pipe(Schedule.both(Schedule.recurs(5))),
                ),
              ),
          ),
          Stream.runDrain,
        );

        yield* drain.pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const stopped = yield* Ref.get(sawTerminalStop);
              yield* sink
                .closeEpoch({
                  runId,
                  runtimeId,
                  closeReason: stopped ? "shutdown" : "stream-end",
                  suspicious: !stopped,
                })
                .pipe(Effect.ignore);
            }),
          ),
        );
      }),
    ),
});

export const TelemetryIngesterLive = Layer.effect(
  TelemetryIngester,
  Effect.gen(function* () {
    const runtime = yield* SealantRuntime;
    const sink = yield* TelemetrySink;
    return makeTelemetryIngester(runtime, sink);
  }),
);
