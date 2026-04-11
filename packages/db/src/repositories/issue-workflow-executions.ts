import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  issueWorkflowExecutionArtifacts,
  issueWorkflowExecutionDiffFiles,
  issueWorkflowExecutionEvents,
  issueWorkflowExecutions,
  issueWorkflowExecutionSummaries,
  issueWorkflowExecutionValidationResults,
  type IssueWorkflowExecution,
  type IssueWorkflowExecutionArtifact,
  type IssueWorkflowExecutionDiffFile,
  type IssueWorkflowExecutionEvent,
  type IssueWorkflowExecutionSummary,
  type IssueWorkflowExecutionValidationResult,
  type NewIssueWorkflowExecutionArtifact,
  type NewIssueWorkflowExecutionDiffFile,
  type NewIssueWorkflowExecutionEvent,
  type NewIssueWorkflowExecutionSummary,
  type NewIssueWorkflowExecutionValidationResult,
} from "../schema.js";

export interface AppendIssueWorkflowExecutionEventInput {
  readonly id: string;
  readonly sequence: number;
  readonly phase: string;
  readonly level?: IssueWorkflowExecutionEvent["level"];
  readonly eventType: string;
  readonly message: string;
  readonly payload?: IssueWorkflowExecutionEvent["payload"];
  readonly occurredAt?: Date;
}

export interface ReplaceIssueWorkflowExecutionValidationResultInput {
  readonly id: string;
  readonly checkKey: string;
  readonly status: IssueWorkflowExecutionValidationResult["status"];
  readonly durationMs?: number;
  readonly message?: string;
  readonly details?: IssueWorkflowExecutionValidationResult["details"];
}

export interface ReplaceIssueWorkflowExecutionDiffFileInput {
  readonly id: string;
  readonly changeType: IssueWorkflowExecutionDiffFile["changeType"];
  readonly path: string;
  readonly oldPath?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly isBinary?: boolean;
  readonly patchArtifactId?: string;
}

export interface InsertIssueWorkflowExecutionArtifactInput {
  readonly id: string;
  readonly kind?: IssueWorkflowExecutionArtifact["kind"];
  readonly storageBackend?: IssueWorkflowExecutionArtifact["storageBackend"];
  readonly storageKey?: string;
  readonly contentType?: string;
  readonly byteSize?: number;
  readonly checksum?: string;
  readonly inlineJson?: IssueWorkflowExecutionArtifact["inlineJson"];
}

export interface UpsertIssueWorkflowExecutionSummaryInput {
  readonly executionId: string;
  readonly objective?: string;
  readonly linkedIssueRef?: string;
  readonly filesChanged?: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly assumptions?: string[];
  readonly warnings?: string[];
  readonly summaryMarkdown?: string;
  readonly generatedAt?: Date;
}

export interface IssueWorkflowExecutionDetailBundle {
  readonly execution: IssueWorkflowExecution;
  readonly summary: IssueWorkflowExecutionSummary | null;
  readonly events: readonly IssueWorkflowExecutionEvent[];
  readonly validationResults: readonly IssueWorkflowExecutionValidationResult[];
  readonly diffFiles: readonly IssueWorkflowExecutionDiffFile[];
  readonly artifacts: readonly IssueWorkflowExecutionArtifact[];
}

/** @deprecated Use IssueWorkflowExecutionRepo + IssueWorkflowExecutionRepoLive instead. */
export const createIssueWorkflowExecutionRepository = (): never => {
  throw new Error(
    "createIssueWorkflowExecutionRepository is disabled during the Effect transition.",
  );
};

/** @deprecated Use IssueWorkflowExecutionRepoService instead. */
export type IssueWorkflowExecutionRepository = IssueWorkflowExecutionRepoService;

const issueWorkflowExecutionRepoOperationSchema = Schema.Literal(
  "appendExecutionEvents",
  "getExecutionDetailBundle",
  "insertExecutionArtifacts",
  "replaceExecutionDiffFiles",
  "replaceExecutionValidationResults",
  "upsertExecutionSummary",
);

export class IssueWorkflowExecutionRepoInvariantError extends Schema.TaggedError<IssueWorkflowExecutionRepoInvariantError>(
  "IssueWorkflowExecutionRepoInvariantError",
)("IssueWorkflowExecutionRepoInvariantError", {
  operation: issueWorkflowExecutionRepoOperationSchema,
  message: Schema.String,
}) {}

export class IssueWorkflowExecutionRepoUnexpectedError extends Schema.TaggedError<IssueWorkflowExecutionRepoUnexpectedError>(
  "IssueWorkflowExecutionRepoUnexpectedError",
)("IssueWorkflowExecutionRepoUnexpectedError", {
  operation: issueWorkflowExecutionRepoOperationSchema,
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export const issueWorkflowExecutionRepoErrorSchema = Schema.Union(
  IssueWorkflowExecutionRepoInvariantError,
  IssueWorkflowExecutionRepoUnexpectedError,
);

export type IssueWorkflowExecutionRepoError = typeof issueWorkflowExecutionRepoErrorSchema.Type;

type IssueWorkflowExecutionRepoOperation = typeof issueWorkflowExecutionRepoOperationSchema.Type;

const mapIssueWorkflowExecutionRepoError = (
  operation: IssueWorkflowExecutionRepoOperation,
  cause: unknown,
): IssueWorkflowExecutionRepoError => {
  if (
    cause instanceof IssueWorkflowExecutionRepoInvariantError ||
    cause instanceof IssueWorkflowExecutionRepoUnexpectedError
  ) {
    return cause;
  }

  return new IssueWorkflowExecutionRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withIssueWorkflowExecutionRepoError = <A>(
  operation: IssueWorkflowExecutionRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, IssueWorkflowExecutionRepoError> => {
  return effect.pipe(
    Effect.mapError((cause) => mapIssueWorkflowExecutionRepoError(operation, cause)),
  );
};

export interface IssueWorkflowExecutionRepoService {
  readonly appendExecutionEvents: (
    executionId: string,
    events: readonly AppendIssueWorkflowExecutionEventInput[],
  ) => Effect.Effect<readonly IssueWorkflowExecutionEvent[], IssueWorkflowExecutionRepoError>;
  readonly replaceExecutionValidationResults: (
    executionId: string,
    results: readonly ReplaceIssueWorkflowExecutionValidationResultInput[],
  ) => Effect.Effect<
    readonly IssueWorkflowExecutionValidationResult[],
    IssueWorkflowExecutionRepoError
  >;
  readonly replaceExecutionDiffFiles: (
    executionId: string,
    files: readonly ReplaceIssueWorkflowExecutionDiffFileInput[],
  ) => Effect.Effect<readonly IssueWorkflowExecutionDiffFile[], IssueWorkflowExecutionRepoError>;
  readonly insertExecutionArtifacts: (
    executionId: string,
    artifacts: readonly InsertIssueWorkflowExecutionArtifactInput[],
  ) => Effect.Effect<readonly IssueWorkflowExecutionArtifact[], IssueWorkflowExecutionRepoError>;
  readonly upsertExecutionSummary: (
    input: UpsertIssueWorkflowExecutionSummaryInput,
  ) => Effect.Effect<IssueWorkflowExecutionSummary, IssueWorkflowExecutionRepoError>;
  readonly getExecutionDetailBundle: (
    executionId: string,
  ) => Effect.Effect<IssueWorkflowExecutionDetailBundle | null, IssueWorkflowExecutionRepoError>;
}

export class IssueWorkflowExecutionRepo extends Context.Tag("IssueWorkflowExecutionRepo")<
  IssueWorkflowExecutionRepo,
  IssueWorkflowExecutionRepoService
>() {}

export const IssueWorkflowExecutionRepoLive = Layer.effect(
  IssueWorkflowExecutionRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      appendExecutionEvents: (executionId, events) =>
        withIssueWorkflowExecutionRepoError(
          "appendExecutionEvents",
          db.transaction((tx) =>
            Effect.gen(function* () {
              if (events.length === 0) {
                return [];
              }

              const inserted = yield* Effect.forEach(events, (event) =>
                tx
                  .insert(issueWorkflowExecutionEvents)
                  .values({
                    id: event.id,
                    executionId,
                    sequence: event.sequence,
                    phase: event.phase,
                    ...(event.level === undefined ? {} : { level: event.level }),
                    eventType: event.eventType,
                    message: event.message,
                    ...(event.payload === undefined ? {} : { payload: event.payload }),
                    ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
                  } satisfies NewIssueWorkflowExecutionEvent)
                  .onConflictDoUpdate({
                    target: [
                      issueWorkflowExecutionEvents.executionId,
                      issueWorkflowExecutionEvents.sequence,
                    ],
                    set: {
                      id: event.id,
                      phase: event.phase,
                      ...(event.level === undefined ? {} : { level: event.level }),
                      eventType: event.eventType,
                      message: event.message,
                      ...(event.payload === undefined ? {} : { payload: event.payload }),
                      ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
                    },
                  })
                  .returning()
                  .pipe(
                    Effect.map((rows) => rows[0]),
                    Effect.flatMap((row) => {
                      if (row === undefined) {
                        return new IssueWorkflowExecutionRepoInvariantError({
                          operation: "appendExecutionEvents",
                          message: `Failed to append event ${event.id}.`,
                        });
                      }

                      return Effect.succeed(row);
                    }),
                  ),
              );

              return inserted;
            }),
          ),
        ),

      replaceExecutionValidationResults: (executionId, results) =>
        withIssueWorkflowExecutionRepoError(
          "replaceExecutionValidationResults",
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(issueWorkflowExecutionValidationResults)
                .where(eq(issueWorkflowExecutionValidationResults.executionId, executionId));

              if (results.length === 0) {
                return [];
              }

              return yield* tx
                .insert(issueWorkflowExecutionValidationResults)
                .values(
                  results.map((result) => {
                    return {
                      id: result.id,
                      executionId,
                      checkKey: result.checkKey,
                      status: result.status,
                      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
                      ...(result.message === undefined ? {} : { message: result.message }),
                      ...(result.details === undefined ? {} : { details: result.details }),
                    } satisfies NewIssueWorkflowExecutionValidationResult;
                  }),
                )
                .returning();
            }),
          ),
        ),

      replaceExecutionDiffFiles: (executionId, files) =>
        withIssueWorkflowExecutionRepoError(
          "replaceExecutionDiffFiles",
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(issueWorkflowExecutionDiffFiles)
                .where(eq(issueWorkflowExecutionDiffFiles.executionId, executionId));

              if (files.length === 0) {
                return [];
              }

              return yield* tx
                .insert(issueWorkflowExecutionDiffFiles)
                .values(
                  files.map((file) => {
                    return {
                      id: file.id,
                      executionId,
                      changeType: file.changeType,
                      path: file.path,
                      ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
                      ...(file.additions === undefined ? {} : { additions: file.additions }),
                      ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
                      ...(file.isBinary === undefined ? {} : { isBinary: file.isBinary }),
                      ...(file.patchArtifactId === undefined
                        ? {}
                        : { patchArtifactId: file.patchArtifactId }),
                    } satisfies NewIssueWorkflowExecutionDiffFile;
                  }),
                )
                .returning();
            }),
          ),
        ),

      insertExecutionArtifacts: (executionId, artifacts) =>
        withIssueWorkflowExecutionRepoError(
          "insertExecutionArtifacts",
          Effect.gen(function* () {
            if (artifacts.length === 0) {
              return [];
            }

            return yield* db
              .insert(issueWorkflowExecutionArtifacts)
              .values(
                artifacts.map((artifact) => {
                  return {
                    id: artifact.id,
                    executionId,
                    ...(artifact.kind === undefined ? {} : { kind: artifact.kind }),
                    ...(artifact.storageBackend === undefined
                      ? {}
                      : { storageBackend: artifact.storageBackend }),
                    ...(artifact.storageKey === undefined
                      ? {}
                      : { storageKey: artifact.storageKey }),
                    ...(artifact.contentType === undefined
                      ? {}
                      : { contentType: artifact.contentType }),
                    ...(artifact.byteSize === undefined ? {} : { byteSize: artifact.byteSize }),
                    ...(artifact.checksum === undefined ? {} : { checksum: artifact.checksum }),
                    ...(artifact.inlineJson === undefined
                      ? {}
                      : { inlineJson: artifact.inlineJson }),
                  } satisfies NewIssueWorkflowExecutionArtifact;
                }),
              )
              .returning();
          }),
        ),

      upsertExecutionSummary: (input) =>
        withIssueWorkflowExecutionRepoError(
          "upsertExecutionSummary",
          Effect.gen(function* () {
            const [summary] = yield* db
              .insert(issueWorkflowExecutionSummaries)
              .values({
                executionId: input.executionId,
                ...(input.objective === undefined ? {} : { objective: input.objective }),
                ...(input.linkedIssueRef === undefined
                  ? {}
                  : { linkedIssueRef: input.linkedIssueRef }),
                ...(input.filesChanged === undefined ? {} : { filesChanged: input.filesChanged }),
                ...(input.additions === undefined ? {} : { additions: input.additions }),
                ...(input.deletions === undefined ? {} : { deletions: input.deletions }),
                ...(input.assumptions === undefined ? {} : { assumptions: input.assumptions }),
                ...(input.warnings === undefined ? {} : { warnings: input.warnings }),
                ...(input.summaryMarkdown === undefined
                  ? {}
                  : { summaryMarkdown: input.summaryMarkdown }),
                ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
              } satisfies NewIssueWorkflowExecutionSummary)
              .onConflictDoUpdate({
                target: issueWorkflowExecutionSummaries.executionId,
                set: {
                  ...(input.objective === undefined ? {} : { objective: input.objective }),
                  ...(input.linkedIssueRef === undefined
                    ? {}
                    : { linkedIssueRef: input.linkedIssueRef }),
                  ...(input.filesChanged === undefined ? {} : { filesChanged: input.filesChanged }),
                  ...(input.additions === undefined ? {} : { additions: input.additions }),
                  ...(input.deletions === undefined ? {} : { deletions: input.deletions }),
                  ...(input.assumptions === undefined ? {} : { assumptions: input.assumptions }),
                  ...(input.warnings === undefined ? {} : { warnings: input.warnings }),
                  ...(input.summaryMarkdown === undefined
                    ? {}
                    : { summaryMarkdown: input.summaryMarkdown }),
                  ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
                },
              })
              .returning();

            if (summary === undefined) {
              return yield* new IssueWorkflowExecutionRepoInvariantError({
                operation: "upsertExecutionSummary",
                message: `Failed to upsert summary for execution ${input.executionId}.`,
              });
            }

            return summary;
          }),
        ),

      getExecutionDetailBundle: (executionId) =>
        withIssueWorkflowExecutionRepoError(
          "getExecutionDetailBundle",
          Effect.gen(function* () {
            const execution = yield* db.query.issueWorkflowExecutions.findFirst({
              where: { id: executionId },
              with: {
                summary: true,
                events: { orderBy: { sequence: "asc" } },
                validationResults: { orderBy: { checkKey: "asc" } },
                diffFiles: { orderBy: { path: "asc" } },
                artifacts: { orderBy: { createdAt: "asc" } },
              },
            });

            if (execution === undefined) {
              return null;
            }

            return {
              execution,
              summary: execution.summary,
              events: execution.events,
              validationResults: execution.validationResults,
              diffFiles: execution.diffFiles,
              artifacts: execution.artifacts,
            };
          }),
        ),
    } satisfies IssueWorkflowExecutionRepoService;
  }),
);
