/**
 * TelemetryProjector — rebuilds the disposable read-model projections (`telemetry_timeline`,
 * `telemetry_scrollback`) from the append-only log by a pure re-fold. It depends on `SealantDB`
 * ONLY (never `TelemetrySink`), which breaks the Sink<->Projector layer cycle: the Sink writes
 * projections inline during ingest using the SAME pure derivations, so `rebuild` reproduces them
 * exactly (`projection == rebuild`).
 */
import {
  SealantDB,
  telemetryEvents,
  telemetryScrollback,
  telemetryTimeline,
  type NewTelemetryScrollbackRow,
  type TSealantDB,
} from "@sealant/db";
import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { type TelemetryProjectorError, withTelemetryProjectorError } from "./errors.js";
import { deriveScrollbackRow, deriveTimelineRow, eventRowToNormalized } from "./normalize.js";

export interface TelemetryProjectorService {
  /** Truncate this run's projections and re-fold them from the log. */
  readonly rebuild: (runId: string) => Effect.Effect<void, TelemetryProjectorError>;
}

export class TelemetryProjector extends Context.Service<
  TelemetryProjector,
  TelemetryProjectorService
>()("@sealant/telemetry/TelemetryProjector") {}

export const makeTelemetryProjector = (db: TSealantDB): TelemetryProjectorService => ({
  rebuild: (runId) =>
    withTelemetryProjectorError(
      "rebuild",
      db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.delete(telemetryTimeline).where(eq(telemetryTimeline.runId, runId));
          yield* tx.delete(telemetryScrollback).where(eq(telemetryScrollback.runId, runId));

          const rows = yield* tx
            .select()
            .from(telemetryEvents)
            .where(eq(telemetryEvents.runId, runId))
            .orderBy(asc(telemetryEvents.runtimeId), asc(telemetryEvents.sequence));
          if (rows.length === 0) {
            return;
          }

          const normalized = rows.map(eventRowToNormalized);
          yield* tx
            .insert(telemetryTimeline)
            .values(normalized.map((event) => deriveTimelineRow(event, runId)))
            .onConflictDoNothing();

          const scrollbackRows = normalized
            .map((event) => deriveScrollbackRow(event, runId))
            .filter((row): row is NewTelemetryScrollbackRow => row !== undefined);
          if (scrollbackRows.length > 0) {
            yield* tx.insert(telemetryScrollback).values(scrollbackRows).onConflictDoNothing();
          }
        }),
      ),
    ),
});

export const TelemetryProjectorLive = Layer.effect(
  TelemetryProjector,
  Effect.gen(function* () {
    const db = yield* SealantDB;
    return makeTelemetryProjector(db);
  }),
);
