import { asc, eq } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
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

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createIssueWorkflowExecutionRepository = (client: DatabaseClient) => {
  const { db } = client;

  const appendExecutionEvents = async (
    executionId: string,
    events: readonly AppendIssueWorkflowExecutionEventInput[],
  ): Promise<readonly IssueWorkflowExecutionEvent[]> => {
    if (events.length === 0) {
      return [];
    }

    return db.transaction(async (tx) => {
      const inserted: IssueWorkflowExecutionEvent[] = [];

      for (const event of events) {
        const [row] = await tx
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
          .returning();

        inserted.push(assertInserted(row, `Failed to append event ${event.id}.`));
      }

      return inserted;
    });
  };

  const replaceExecutionValidationResults = async (
    executionId: string,
    results: readonly ReplaceIssueWorkflowExecutionValidationResultInput[],
  ): Promise<readonly IssueWorkflowExecutionValidationResult[]> => {
    return db.transaction(async (tx) => {
      await tx
        .delete(issueWorkflowExecutionValidationResults)
        .where(eq(issueWorkflowExecutionValidationResults.executionId, executionId));

      if (results.length === 0) {
        return [];
      }

      return tx
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
    });
  };

  const replaceExecutionDiffFiles = async (
    executionId: string,
    files: readonly ReplaceIssueWorkflowExecutionDiffFileInput[],
  ): Promise<readonly IssueWorkflowExecutionDiffFile[]> => {
    return db.transaction(async (tx) => {
      await tx
        .delete(issueWorkflowExecutionDiffFiles)
        .where(eq(issueWorkflowExecutionDiffFiles.executionId, executionId));

      if (files.length === 0) {
        return [];
      }

      return tx
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
    });
  };

  const insertExecutionArtifacts = async (
    executionId: string,
    artifacts: readonly InsertIssueWorkflowExecutionArtifactInput[],
  ): Promise<readonly IssueWorkflowExecutionArtifact[]> => {
    if (artifacts.length === 0) {
      return [];
    }

    return db
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
            ...(artifact.storageKey === undefined ? {} : { storageKey: artifact.storageKey }),
            ...(artifact.contentType === undefined ? {} : { contentType: artifact.contentType }),
            ...(artifact.byteSize === undefined ? {} : { byteSize: artifact.byteSize }),
            ...(artifact.checksum === undefined ? {} : { checksum: artifact.checksum }),
            ...(artifact.inlineJson === undefined ? {} : { inlineJson: artifact.inlineJson }),
          } satisfies NewIssueWorkflowExecutionArtifact;
        }),
      )
      .returning();
  };

  const upsertExecutionSummary = async (
    input: UpsertIssueWorkflowExecutionSummaryInput,
  ): Promise<IssueWorkflowExecutionSummary> => {
    const [summary] = await db
      .insert(issueWorkflowExecutionSummaries)
      .values({
        executionId: input.executionId,
        ...(input.objective === undefined ? {} : { objective: input.objective }),
        ...(input.linkedIssueRef === undefined ? {} : { linkedIssueRef: input.linkedIssueRef }),
        ...(input.filesChanged === undefined ? {} : { filesChanged: input.filesChanged }),
        ...(input.additions === undefined ? {} : { additions: input.additions }),
        ...(input.deletions === undefined ? {} : { deletions: input.deletions }),
        ...(input.assumptions === undefined ? {} : { assumptions: input.assumptions }),
        ...(input.warnings === undefined ? {} : { warnings: input.warnings }),
        ...(input.summaryMarkdown === undefined ? {} : { summaryMarkdown: input.summaryMarkdown }),
        ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
      } satisfies NewIssueWorkflowExecutionSummary)
      .onConflictDoUpdate({
        target: issueWorkflowExecutionSummaries.executionId,
        set: {
          ...(input.objective === undefined ? {} : { objective: input.objective }),
          ...(input.linkedIssueRef === undefined ? {} : { linkedIssueRef: input.linkedIssueRef }),
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

    return assertInserted(summary, `Failed to upsert summary for execution ${input.executionId}.`);
  };

  const getExecutionDetailBundle = async (
    executionId: string,
  ): Promise<IssueWorkflowExecutionDetailBundle | null> => {
    const [execution] = await db
      .select()
      .from(issueWorkflowExecutions)
      .where(eq(issueWorkflowExecutions.id, executionId))
      .limit(1);

    if (execution === undefined) {
      return null;
    }

    const [summary] = await db
      .select()
      .from(issueWorkflowExecutionSummaries)
      .where(eq(issueWorkflowExecutionSummaries.executionId, executionId))
      .limit(1);

    const events = await db
      .select()
      .from(issueWorkflowExecutionEvents)
      .where(eq(issueWorkflowExecutionEvents.executionId, executionId))
      .orderBy(asc(issueWorkflowExecutionEvents.sequence));

    const validationResults = await db
      .select()
      .from(issueWorkflowExecutionValidationResults)
      .where(eq(issueWorkflowExecutionValidationResults.executionId, executionId))
      .orderBy(asc(issueWorkflowExecutionValidationResults.checkKey));

    const diffFiles = await db
      .select()
      .from(issueWorkflowExecutionDiffFiles)
      .where(eq(issueWorkflowExecutionDiffFiles.executionId, executionId))
      .orderBy(asc(issueWorkflowExecutionDiffFiles.path));

    const artifacts = await db
      .select()
      .from(issueWorkflowExecutionArtifacts)
      .where(eq(issueWorkflowExecutionArtifacts.executionId, executionId))
      .orderBy(asc(issueWorkflowExecutionArtifacts.createdAt));

    return {
      execution,
      summary: summary ?? null,
      events,
      validationResults,
      diffFiles,
      artifacts,
    };
  };

  return {
    appendExecutionEvents,
    getExecutionDetailBundle,
    insertExecutionArtifacts,
    replaceExecutionDiffFiles,
    replaceExecutionValidationResults,
    upsertExecutionSummary,
  };
};

export type IssueWorkflowExecutionRepository = ReturnType<
  typeof createIssueWorkflowExecutionRepository
>;
