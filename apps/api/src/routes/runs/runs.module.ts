/**
 * Runs route handlers — the API layer of the run-detail read path.
 *
 * Run metadata (create/get/list/update) is served from {@link RunRepo}; the execution record
 * (timeline / byte-exact scrollback / loss report) is served from {@link TelemetryQuery}, which folds
 * the append-only telemetry log. uint64 sequences are emitted as decimal strings (the wire contract).
 */
import { randomUUID } from "node:crypto";

import {
  RunBadRequestError,
  RunInternalServerError,
  RunNotFoundError,
  type CreateRunRequest,
  type GetRunScrollbackQuery,
  type GetRunTimelineQuery,
  type ListRunsQuery,
  type ListRunsResponse,
  type LossSpan,
  type Run,
  type RunChangesResponse,
  type RunLossReport,
  type RunScrollbackResponse,
  type RunStatusWire,
  type RunTimelineResponse,
  type TimelineEntry,
  type UpdateRunRequest,
} from "@sealant/api-contracts";
import { RunRepo } from "@sealant/db";
import { TelemetryQuery } from "@sealant/telemetry";
import { Context, Effect, Stream } from "effect";

import { RunExecPublisherService } from "../../services/control-plane-capabilities.js";

// StreamKind numerics from @sealant/runtime-protocol (avoid a runtime dep for two constants).
const STREAM_KIND_STDOUT = 2;
const STREAM_KIND_STDERR = 3;
// Reconstruct scrollback up to "everything" when no explicit upper bound is given (uint64 max).
const MAX_SEQUENCE = 9_223_372_036_854_775_807n;

type RunRepoService = Context.Service.Shape<typeof RunRepo>;
type RunRecord = NonNullable<Effect.Success<ReturnType<RunRepoService["getRunById"]>>>;

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

// A FK violation surfaces as pg code 23503 (or "foreign key" text) on the underlying SqlError, which
// the repo wraps as the tagged error's `cause` — NOT its static top-level message. Walk the chain.
const isForeignKeyViolation = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (record.code === "23503") {
      return true;
    }
    if (typeof record.message === "string" && record.message.toLowerCase().includes("foreign key")) {
      return true;
    }
    current = record.cause;
  }
  return false;
};

const withRunInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) =>
  effect.pipe(
    Effect.mapError((error) => new RunInternalServerError({ message: toErrorMessage(error, fallback) })),
  );

const mapRun = (run: RunRecord): Run => ({
  runId: run.id,
  sandboxId: run.sandboxId,
  ...(run.attemptId === null ? {} : { attemptId: run.attemptId }),
  ownerUserId: run.ownerUserId,
  harnessId: run.harnessId,
  mode: run.mode,
  status: run.status,
  ...(run.prompt === null ? {} : { prompt: run.prompt }),
  ...(run.exitCode === null ? {} : { exitCode: run.exitCode }),
  ...(run.errorMessage === null ? {} : { errorMessage: run.errorMessage }),
  ...(run.startedAt === null ? {} : { startedAt: run.startedAt.toISOString() }),
  ...(run.finishedAt === null ? {} : { finishedAt: run.finishedAt.toISOString() }),
  createdAt: run.createdAt.toISOString(),
  updatedAt: run.updatedAt.toISOString(),
});

const requireRun = (runId: string) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const run = yield* withRunInternalError(runs.getRunById(runId), "Failed to load run.");
    if (run === undefined) {
      return yield* new RunNotFoundError({ message: `Run not found: ${runId}` });
    }
    return run;
  });

const parseSequence = (raw: string | undefined, field: string) => {
  if (raw === undefined) {
    return Effect.succeed(undefined);
  }
  try {
    return Effect.succeed(BigInt(raw));
  } catch {
    return Effect.fail(new RunBadRequestError({ message: `${field} must be a decimal integer.` }));
  }
};

const parseLimit = (raw: string | undefined, fallback: number, max: number) => {
  if (raw === undefined) {
    return Effect.succeed(fallback);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return Effect.fail(
      new RunBadRequestError({ message: `limit must be an integer between 1 and ${max}.` }),
    );
  }
  return Effect.succeed(value);
};

export const createRun = (payload: CreateRunRequest) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const run = yield* runs
      .createRun({
        id: `run_${randomUUID()}`,
        sandboxId: payload.sandboxId,
        ownerUserId: payload.ownerUserId,
        harnessId: payload.harnessId,
        ...(payload.mode === undefined ? {} : { mode: payload.mode }),
        ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }),
        ...(payload.attemptId === undefined ? {} : { attemptId: payload.attemptId }),
      })
      .pipe(
        Effect.mapError((error) => {
          if (isForeignKeyViolation(error)) {
            return new RunBadRequestError({
              message: `Unknown sandbox or owner for run (sandbox=${payload.sandboxId}).`,
            });
          }
          return new RunInternalServerError({ message: toErrorMessage(error, "Failed to create run.") });
        }),
      );

    // When a command is provided, EXECUTE the run server-side: enqueue a run-exec job for the worker
    // (it docker-execs the harness + ingests telemetry). Absent a command, the run row is created but
    // not executed (the legacy host-local caller-runs-it path).
    const command = payload.command;
    if (command !== undefined) {
      const publisher = yield* RunExecPublisherService;
      yield* Effect.tryPromise({
        try: () => publisher.publishRequested({ runId: run.id, command }),
        catch: (error) =>
          new RunInternalServerError({
            message: toErrorMessage(error, "Failed to enqueue run execution."),
          }),
      });
    }
    return mapRun(run);
  });

export const listRuns = (query: ListRunsQuery) =>
  Effect.gen(function* () {
    const limit = yield* parseLimit(query.limit, 50, 200);
    const runs = yield* RunRepo;
    const items = yield* withRunInternalError(
      runs.listRuns({
        ...(query.sandboxId === undefined ? {} : { sandboxId: query.sandboxId }),
        ...(query.ownerUserId === undefined ? {} : { ownerUserId: query.ownerUserId }),
        ...(query.status === undefined ? {} : { statuses: [query.status] }),
        limit,
      }),
      "Failed to list runs.",
    );
    return { items: items.map(mapRun) } satisfies ListRunsResponse;
  });

export const getRun = (runId: string) =>
  Effect.gen(function* () {
    const run = yield* requireRun(runId);
    return mapRun(run);
  });

export const getRunChanges = (runId: string) =>
  Effect.gen(function* () {
    const run = yield* requireRun(runId);
    return {
      files: (run.changedFiles ?? []).map((file) => ({
        path: file.path,
        change: file.change,
        ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      })),
      diff: run.diff ?? "",
    } satisfies RunChangesResponse;
  });

export const updateRun = (input: { readonly runId: string; readonly payload: UpdateRunRequest }) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    yield* requireRun(input.runId);
    const status: RunStatusWire | undefined = input.payload.status;

    const updated = yield* withRunInternalError(
      status === "running"
        ? runs.markRunRunning({ id: input.runId })
        : status === "completed"
          ? runs.markRunCompleted({ id: input.runId, exitCode: input.payload.exitCode ?? 0 })
          : status === "failed"
            ? runs.markRunFailed({
                id: input.runId,
                ...(input.payload.exitCode === undefined ? {} : { exitCode: input.payload.exitCode }),
                ...(input.payload.errorMessage === undefined
                  ? {}
                  : { errorMessage: input.payload.errorMessage }),
              })
            : Effect.succeed<RunRecord | null>(null),
      "Failed to update run.",
    );

    if (status !== "running" && status !== "completed" && status !== "failed") {
      return yield* new RunBadRequestError({
        message: "updateRun supports status transitions to running, completed, or failed.",
      });
    }

    if (updated === null) {
      return yield* new RunNotFoundError({ message: `Run not found: ${input.runId}` });
    }

    return mapRun(updated);
  });

export const getRunTimeline = (input: {
  readonly runId: string;
  readonly query: GetRunTimelineQuery;
}) =>
  Effect.gen(function* () {
    yield* requireRun(input.runId);
    const fromSequence = yield* parseSequence(input.query.fromSequence, "fromSequence");
    const toSequence = yield* parseSequence(input.query.toSequence, "toSequence");
    const limit = yield* parseLimit(input.query.limit, 500, 5000);

    const query = yield* TelemetryQuery;
    const chunk = yield* withRunInternalError(
      Stream.runCollect(
        query.getTimeline(input.runId, {
          ...(fromSequence === undefined ? {} : { fromSequence }),
          ...(toSequence === undefined ? {} : { toSequence }),
        }),
      ),
      "Failed to read run timeline.",
    );

    const items = Array.from(chunk)
      .slice(0, limit)
      .map(
        (entry): TimelineEntry => ({
          eventId: entry.eventId,
          sequence: entry.sequence.toString(),
          kind: entry.kind,
          occurredAt: entry.occurredAt.toString(),
          summary: entry.summary,
          ...(entry.ref === null || entry.ref === undefined ? {} : { ref: entry.ref }),
        }),
      );

    return { items } satisfies RunTimelineResponse;
  });

export const getRunScrollback = (input: {
  readonly runId: string;
  readonly query: GetRunScrollbackQuery;
}) =>
  Effect.gen(function* () {
    yield* requireRun(input.runId);
    const atSequence = (yield* parseSequence(input.query.atSequence, "atSequence")) ?? MAX_SEQUENCE;
    const streamKind = input.query.stream === "stdout" ? STREAM_KIND_STDOUT : STREAM_KIND_STDERR;

    const query = yield* TelemetryQuery;
    const chunk = yield* withRunInternalError(
      Stream.runCollect(
        query.reconstructScrollback(input.runId, input.query.processId, streamKind, atSequence),
      ),
      "Failed to reconstruct run scrollback.",
    );

    const buffer = Buffer.concat(Array.from(chunk));
    return {
      processId: input.query.processId,
      stream: input.query.stream,
      byteCount: buffer.byteLength,
      contentBase64: buffer.toString("base64"),
    } satisfies RunScrollbackResponse;
  });

export const getRunLoss = (runId: string) =>
  Effect.gen(function* () {
    yield* requireRun(runId);
    const query = yield* TelemetryQuery;
    const report = yield* withRunInternalError(query.getLossReport(runId), "Failed to read loss report.");

    return {
      runId: report.runId,
      droppedEventCount: report.droppedEventCount.toString(),
      sequenceGapCount: report.sequenceGapCount,
      watchOverflowCount: report.watchOverflowCount,
      earlyClose: report.earlyClose,
      // kind/detectedVia are DB-enum-constrained at the source; cast to the wire literal unions.
      spans: report.spans.map(
        (span): LossSpan => ({
          kind: span.kind as LossSpan["kind"],
          ...(span.fromSequence === null || span.fromSequence === undefined
            ? {}
            : { fromSequence: span.fromSequence.toString() }),
          ...(span.toSequence === null || span.toSequence === undefined
            ? {}
            : { toSequence: span.toSequence.toString() }),
          ...(span.droppedCount === null || span.droppedCount === undefined
            ? {}
            : { droppedCount: span.droppedCount.toString() }),
          detectedVia: span.detectedVia as LossSpan["detectedVia"],
          ...(span.reason === null || span.reason === undefined ? {} : { reason: span.reason }),
        }),
      ),
    } satisfies RunLossReport;
  });
