/**
 * Typed error channel for @sealant/telemetry. Mirrors the repo idiom exactly
 * (packages/workspaces/src/sealantd/runtime.ts, packages/db/src/repositories/*): one
 * `Schema.Literals` operation set + an Invariant/Unexpected `Schema.TaggedErrorClass` pair per
 * service, a `Schema.Union` error type, and a `map*`/`with*` funnel so no raw defect escapes.
 */
import { Effect, Schema } from "effect";

/**
 * Unwraps Effect's wrapper for a rejected `Effect.tryPromise`/`Effect.promise` (effect 4 tags it
 * `UnknownError`; effect 3 used `UnknownException`) so the original cause is classified, not the
 * wrapper. Copied from runtime.ts to keep SDK-promise classification consistent.
 */
export const unwrapEffectCause = (cause: unknown): unknown => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "cause" in cause &&
    (cause as { cause?: unknown }).cause !== undefined
  ) {
    const name = (cause as { name?: unknown }).name;
    if (name === "UnknownError" || name === "UnknownException") {
      return (cause as { cause: unknown }).cause;
    }
  }
  return cause;
};

// ---------------------------------------------------------------------------------------------
// TelemetrySink
// ---------------------------------------------------------------------------------------------
const telemetrySinkOperation = Schema.Literals([
  "openEpoch",
  "appendBatch",
  "insertLossSpan",
  "closeEpoch",
  "getMaxSequence",
  "streamRawLog",
]);
export type TelemetrySinkOperation = typeof telemetrySinkOperation.Type;

export class TelemetrySinkInvariantError extends Schema.TaggedErrorClass<TelemetrySinkInvariantError>()(
  "TelemetrySinkInvariantError",
  { operation: telemetrySinkOperation, message: Schema.String },
) {}

export class TelemetrySinkUnexpectedError extends Schema.TaggedErrorClass<TelemetrySinkUnexpectedError>()(
  "TelemetrySinkUnexpectedError",
  { operation: telemetrySinkOperation, message: Schema.String, cause: Schema.Defect() },
) {}

export const telemetrySinkErrorSchema = Schema.Union([
  TelemetrySinkInvariantError,
  TelemetrySinkUnexpectedError,
]);
export type TelemetrySinkError = typeof telemetrySinkErrorSchema.Type;

export const mapTelemetrySinkError = (
  operation: TelemetrySinkOperation,
  cause: unknown,
): TelemetrySinkError => {
  const unwrapped = unwrapEffectCause(cause);
  if (
    unwrapped instanceof TelemetrySinkInvariantError ||
    unwrapped instanceof TelemetrySinkUnexpectedError
  ) {
    return unwrapped;
  }
  return new TelemetrySinkUnexpectedError({
    operation,
    message: unwrapped instanceof Error ? unwrapped.message : `${operation} failed.`,
    cause: unwrapped,
  });
};

export const withTelemetrySinkError = <A, R>(
  operation: TelemetrySinkOperation,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, TelemetrySinkError, R> =>
  effect.pipe(Effect.mapError((cause) => mapTelemetrySinkError(operation, cause)));

// ---------------------------------------------------------------------------------------------
// ArtifactStore
// ---------------------------------------------------------------------------------------------
const artifactStoreOperation = Schema.Literals(["put", "get"]);
export type ArtifactStoreOperation = typeof artifactStoreOperation.Type;

export class ArtifactStoreInvariantError extends Schema.TaggedErrorClass<ArtifactStoreInvariantError>()(
  "ArtifactStoreInvariantError",
  { operation: artifactStoreOperation, message: Schema.String },
) {}

export class ArtifactStoreUnexpectedError extends Schema.TaggedErrorClass<ArtifactStoreUnexpectedError>()(
  "ArtifactStoreUnexpectedError",
  { operation: artifactStoreOperation, message: Schema.String, cause: Schema.Defect() },
) {}

export const artifactStoreErrorSchema = Schema.Union([
  ArtifactStoreInvariantError,
  ArtifactStoreUnexpectedError,
]);
export type ArtifactStoreError = typeof artifactStoreErrorSchema.Type;

export const mapArtifactStoreError = (
  operation: ArtifactStoreOperation,
  cause: unknown,
): ArtifactStoreError => {
  const unwrapped = unwrapEffectCause(cause);
  if (
    unwrapped instanceof ArtifactStoreInvariantError ||
    unwrapped instanceof ArtifactStoreUnexpectedError
  ) {
    return unwrapped;
  }
  return new ArtifactStoreUnexpectedError({
    operation,
    message: unwrapped instanceof Error ? unwrapped.message : `${operation} failed.`,
    cause: unwrapped,
  });
};

export const withArtifactStoreError = <A, R>(
  operation: ArtifactStoreOperation,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, ArtifactStoreError, R> =>
  effect.pipe(Effect.mapError((cause) => mapArtifactStoreError(operation, cause)));

// ---------------------------------------------------------------------------------------------
// TelemetryProjector
// ---------------------------------------------------------------------------------------------
const telemetryProjectorOperation = Schema.Literals(["rebuild"]);
export type TelemetryProjectorOperation = typeof telemetryProjectorOperation.Type;

export class TelemetryProjectorUnexpectedError extends Schema.TaggedErrorClass<TelemetryProjectorUnexpectedError>()(
  "TelemetryProjectorUnexpectedError",
  { operation: telemetryProjectorOperation, message: Schema.String, cause: Schema.Defect() },
) {}

export const telemetryProjectorErrorSchema = Schema.Union([TelemetryProjectorUnexpectedError]);
export type TelemetryProjectorError = typeof telemetryProjectorErrorSchema.Type;

export const withTelemetryProjectorError = <A, R>(
  operation: TelemetryProjectorOperation,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, TelemetryProjectorError, R> =>
  effect.pipe(
    Effect.mapError((cause) => {
      const unwrapped = unwrapEffectCause(cause);
      if (unwrapped instanceof TelemetryProjectorUnexpectedError) {
        return unwrapped;
      }
      return new TelemetryProjectorUnexpectedError({
        operation,
        message: unwrapped instanceof Error ? unwrapped.message : `${operation} failed.`,
        cause: unwrapped,
      });
    }),
  );

// ---------------------------------------------------------------------------------------------
// TelemetryQuery (+ a NotImplemented variant for the typed-but-stubbed future SDK methods)
// ---------------------------------------------------------------------------------------------
const telemetryQueryOperation = Schema.Literals([
  "listRuns",
  "getTimeline",
  "getEvent",
  "getLossReport",
  "reconstructScrollback",
  "unimplemented",
]);
export type TelemetryQueryOperation = typeof telemetryQueryOperation.Type;

export class TelemetryQueryInvariantError extends Schema.TaggedErrorClass<TelemetryQueryInvariantError>()(
  "TelemetryQueryInvariantError",
  { operation: telemetryQueryOperation, message: Schema.String },
) {}

export class TelemetryQueryUnexpectedError extends Schema.TaggedErrorClass<TelemetryQueryUnexpectedError>()(
  "TelemetryQueryUnexpectedError",
  { operation: telemetryQueryOperation, message: Schema.String, cause: Schema.Defect() },
) {}

export class TelemetryQueryUnimplementedError extends Schema.TaggedErrorClass<TelemetryQueryUnimplementedError>()(
  "TelemetryQueryUnimplementedError",
  { operation: telemetryQueryOperation, message: Schema.String },
) {}

export const telemetryQueryErrorSchema = Schema.Union([
  TelemetryQueryInvariantError,
  TelemetryQueryUnexpectedError,
  TelemetryQueryUnimplementedError,
]);
export type TelemetryQueryError = typeof telemetryQueryErrorSchema.Type;

export const mapTelemetryQueryError = (
  operation: TelemetryQueryOperation,
  cause: unknown,
): TelemetryQueryError => {
  const unwrapped = unwrapEffectCause(cause);
  if (
    unwrapped instanceof TelemetryQueryInvariantError ||
    unwrapped instanceof TelemetryQueryUnexpectedError ||
    unwrapped instanceof TelemetryQueryUnimplementedError
  ) {
    return unwrapped;
  }
  return new TelemetryQueryUnexpectedError({
    operation,
    message: unwrapped instanceof Error ? unwrapped.message : `${operation} failed.`,
    cause: unwrapped,
  });
};

export const withTelemetryQueryError = <A, R>(
  operation: TelemetryQueryOperation,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, TelemetryQueryError, R> =>
  effect.pipe(Effect.mapError((cause) => mapTelemetryQueryError(operation, cause)));

// ---------------------------------------------------------------------------------------------
// TelemetryIngester
// ---------------------------------------------------------------------------------------------
const telemetryIngesterOperation = Schema.Literals(["run"]);
export type TelemetryIngesterOperation = typeof telemetryIngesterOperation.Type;

export class TelemetryIngesterUnexpectedError extends Schema.TaggedErrorClass<TelemetryIngesterUnexpectedError>()(
  "TelemetryIngesterUnexpectedError",
  { operation: telemetryIngesterOperation, message: Schema.String, cause: Schema.Defect() },
) {}

export const telemetryIngesterErrorSchema = Schema.Union([TelemetryIngesterUnexpectedError]);
export type TelemetryIngesterError = typeof telemetryIngesterErrorSchema.Type;

export const withTelemetryIngesterError = <A, R>(
  operation: TelemetryIngesterOperation,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, TelemetryIngesterError, R> =>
  effect.pipe(
    Effect.mapError((cause) => {
      const unwrapped = unwrapEffectCause(cause);
      if (unwrapped instanceof TelemetryIngesterUnexpectedError) {
        return unwrapped;
      }
      return new TelemetryIngesterUnexpectedError({
        operation,
        message: unwrapped instanceof Error ? unwrapped.message : `${operation} failed.`,
        cause: unwrapped,
      });
    }),
  );
