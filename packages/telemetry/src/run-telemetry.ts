/**
 * RunTelemetry — the single SDK-facing read facade a future consumer SDK imports. The MVP methods
 * delegate to {@link TelemetryQuery}; the NORTH-STAR time-travel / rollup methods are TYPED now but
 * fail with `TelemetryQueryUnimplementedError` so callers compile against a stable surface. Each is
 * later implemented as an additional pure fold of the same log up to `atSequence` — no re-capture.
 */
import { Context, Effect, Layer, Stream } from "effect";

import { TelemetryQueryUnimplementedError, type TelemetryQueryError } from "./errors.js";
import { TelemetryQuery, type TelemetryQueryService } from "./query.js";
import type { FileTreeSnapshot, NetConn, ProcessTree, RunRollup, TimelineEntry } from "./types.js";

export interface RunTelemetryService {
  // ---- MVP (implemented) ----
  readonly listRuns: TelemetryQueryService["listRuns"];
  readonly getTimeline: TelemetryQueryService["getTimeline"];
  readonly getEvent: TelemetryQueryService["getEvent"];
  readonly getLossReport: TelemetryQueryService["getLossReport"];
  readonly reconstructScrollback: TelemetryQueryService["reconstructScrollback"];

  // ---- FUTURE (typed; fail with TelemetryQueryUnimplementedError) ----
  readonly getRunRollup: (runId: string) => Effect.Effect<RunRollup, TelemetryQueryError>;
  readonly reconstructFileTree: (
    runId: string,
    atSequence: bigint,
  ) => Effect.Effect<FileTreeSnapshot, TelemetryQueryError>;
  readonly reconstructProcessTree: (
    runId: string,
    atSequence: bigint,
  ) => Effect.Effect<ProcessTree, TelemetryQueryError>;
  readonly reconstructNetworkInFlight: (
    runId: string,
    atSequence: bigint,
  ) => Effect.Effect<readonly NetConn[], TelemetryQueryError>;
  readonly tail: (
    runId: string,
    fromSequence?: bigint,
  ) => Stream.Stream<TimelineEntry, TelemetryQueryError>;
}

export class RunTelemetry extends Context.Service<RunTelemetry, RunTelemetryService>()(
  "@sealant/telemetry/RunTelemetry",
) {}

const unimplemented = (name: string): TelemetryQueryUnimplementedError =>
  new TelemetryQueryUnimplementedError({
    operation: "unimplemented",
    message: `${name} is a future read model (an additional fold of the log); not implemented in the MVP.`,
  });

export const makeRunTelemetry = (query: TelemetryQueryService): RunTelemetryService => ({
  listRuns: query.listRuns,
  getTimeline: query.getTimeline,
  getEvent: query.getEvent,
  getLossReport: query.getLossReport,
  reconstructScrollback: query.reconstructScrollback,

  getRunRollup: () => Effect.fail(unimplemented("getRunRollup")),
  reconstructFileTree: () => Effect.fail(unimplemented("reconstructFileTree")),
  reconstructProcessTree: () => Effect.fail(unimplemented("reconstructProcessTree")),
  reconstructNetworkInFlight: () => Effect.fail(unimplemented("reconstructNetworkInFlight")),
  tail: () => Stream.fail(unimplemented("tail")),
});

export const RunTelemetryLive = Layer.effect(
  RunTelemetry,
  Effect.gen(function* () {
    const query = yield* TelemetryQuery;
    return makeRunTelemetry(query);
  }),
);
