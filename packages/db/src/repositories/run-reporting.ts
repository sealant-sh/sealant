import { asc, eq } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
import {
  runArtifacts,
  runDiffFiles,
  runEvents,
  runInputSnapshots,
  runSummaries,
  runValidationResults,
  workspaceRuns,
  type NewRunArtifact,
  type NewRunDiffFile,
  type NewRunEvent,
  type NewRunSummary,
  type NewRunValidationResult,
  type RunArtifact,
  type RunDiffFile,
  type RunEvent,
  type RunInputSnapshot,
  type RunSummary,
  type RunValidationResult,
  type WorkspaceRun,
} from "../schema.js";

export interface AppendRunEventInput {
  readonly id: string;
  readonly sequence: number;
  readonly phase: string;
  readonly level?: RunEvent["level"];
  readonly eventType: string;
  readonly message: string;
  readonly payload?: RunEvent["payload"];
  readonly occurredAt?: Date;
}

export interface ReplaceRunValidationResultInput {
  readonly id: string;
  readonly checkKey: string;
  readonly status: RunValidationResult["status"];
  readonly durationMs?: number;
  readonly message?: string;
  readonly details?: RunValidationResult["details"];
}

export interface ReplaceRunDiffFileInput {
  readonly id: string;
  readonly changeType: RunDiffFile["changeType"];
  readonly path: string;
  readonly oldPath?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly isBinary?: boolean;
  readonly patchArtifactId?: string;
}

export interface InsertRunArtifactInput {
  readonly id: string;
  readonly kind?: RunArtifact["kind"];
  readonly storageBackend?: RunArtifact["storageBackend"];
  readonly storageKey?: string;
  readonly contentType?: string;
  readonly byteSize?: number;
  readonly checksum?: string;
  readonly inlineJson?: RunArtifact["inlineJson"];
}

export interface UpsertRunSummaryInput {
  readonly runId: string;
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

export interface RunDetailBundle {
  readonly run: WorkspaceRun;
  readonly inputSnapshot: RunInputSnapshot | null;
  readonly summary: RunSummary | null;
  readonly events: readonly RunEvent[];
  readonly validationResults: readonly RunValidationResult[];
  readonly diffFiles: readonly RunDiffFile[];
  readonly artifacts: readonly RunArtifact[];
}

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createRunReportingRepository = (client: DatabaseClient) => {
  const { db } = client;

  const appendRunEvents = async (
    runId: string,
    events: readonly AppendRunEventInput[],
  ): Promise<readonly RunEvent[]> => {
    if (events.length === 0) {
      return [];
    }

    return db.transaction(async (tx) => {
      const inserted: RunEvent[] = [];

      for (const event of events) {
        const [row] = await tx
          .insert(runEvents)
          .values({
            id: event.id,
            runId,
            sequence: event.sequence,
            phase: event.phase,
            ...(event.level === undefined ? {} : { level: event.level }),
            eventType: event.eventType,
            message: event.message,
            ...(event.payload === undefined ? {} : { payload: event.payload }),
            ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
          } satisfies NewRunEvent)
          .onConflictDoUpdate({
            target: [runEvents.runId, runEvents.sequence],
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

  const replaceRunValidationResults = async (
    runId: string,
    results: readonly ReplaceRunValidationResultInput[],
  ): Promise<readonly RunValidationResult[]> => {
    return db.transaction(async (tx) => {
      await tx.delete(runValidationResults).where(eq(runValidationResults.runId, runId));

      if (results.length === 0) {
        return [];
      }

      return tx
        .insert(runValidationResults)
        .values(
          results.map((result) => {
            return {
              id: result.id,
              runId,
              checkKey: result.checkKey,
              status: result.status,
              ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
              ...(result.message === undefined ? {} : { message: result.message }),
              ...(result.details === undefined ? {} : { details: result.details }),
            } satisfies NewRunValidationResult;
          }),
        )
        .returning();
    });
  };

  const replaceRunDiffFiles = async (
    runId: string,
    files: readonly ReplaceRunDiffFileInput[],
  ): Promise<readonly RunDiffFile[]> => {
    return db.transaction(async (tx) => {
      await tx.delete(runDiffFiles).where(eq(runDiffFiles.runId, runId));

      if (files.length === 0) {
        return [];
      }

      return tx
        .insert(runDiffFiles)
        .values(
          files.map((file) => {
            return {
              id: file.id,
              runId,
              changeType: file.changeType,
              path: file.path,
              ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
              ...(file.additions === undefined ? {} : { additions: file.additions }),
              ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
              ...(file.isBinary === undefined ? {} : { isBinary: file.isBinary }),
              ...(file.patchArtifactId === undefined
                ? {}
                : { patchArtifactId: file.patchArtifactId }),
            } satisfies NewRunDiffFile;
          }),
        )
        .returning();
    });
  };

  const insertRunArtifacts = async (
    runId: string,
    artifacts: readonly InsertRunArtifactInput[],
  ): Promise<readonly RunArtifact[]> => {
    if (artifacts.length === 0) {
      return [];
    }

    return db
      .insert(runArtifacts)
      .values(
        artifacts.map((artifact) => {
          return {
            id: artifact.id,
            runId,
            ...(artifact.kind === undefined ? {} : { kind: artifact.kind }),
            ...(artifact.storageBackend === undefined
              ? {}
              : { storageBackend: artifact.storageBackend }),
            ...(artifact.storageKey === undefined ? {} : { storageKey: artifact.storageKey }),
            ...(artifact.contentType === undefined ? {} : { contentType: artifact.contentType }),
            ...(artifact.byteSize === undefined ? {} : { byteSize: artifact.byteSize }),
            ...(artifact.checksum === undefined ? {} : { checksum: artifact.checksum }),
            ...(artifact.inlineJson === undefined ? {} : { inlineJson: artifact.inlineJson }),
          } satisfies NewRunArtifact;
        }),
      )
      .returning();
  };

  const upsertRunSummary = async (input: UpsertRunSummaryInput): Promise<RunSummary> => {
    const [summary] = await db
      .insert(runSummaries)
      .values({
        runId: input.runId,
        ...(input.objective === undefined ? {} : { objective: input.objective }),
        ...(input.linkedIssueRef === undefined ? {} : { linkedIssueRef: input.linkedIssueRef }),
        ...(input.filesChanged === undefined ? {} : { filesChanged: input.filesChanged }),
        ...(input.additions === undefined ? {} : { additions: input.additions }),
        ...(input.deletions === undefined ? {} : { deletions: input.deletions }),
        ...(input.assumptions === undefined ? {} : { assumptions: input.assumptions }),
        ...(input.warnings === undefined ? {} : { warnings: input.warnings }),
        ...(input.summaryMarkdown === undefined ? {} : { summaryMarkdown: input.summaryMarkdown }),
        ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
      } satisfies NewRunSummary)
      .onConflictDoUpdate({
        target: runSummaries.runId,
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

    return assertInserted(summary, `Failed to upsert run summary for run ${input.runId}.`);
  };

  const getRunDetailBundle = async (runId: string): Promise<RunDetailBundle | null> => {
    const [run] = await db.select().from(workspaceRuns).where(eq(workspaceRuns.id, runId)).limit(1);

    if (run === undefined) {
      return null;
    }

    const [inputSnapshot] = await db
      .select()
      .from(runInputSnapshots)
      .where(eq(runInputSnapshots.runId, runId))
      .limit(1);

    const [summary] = await db
      .select()
      .from(runSummaries)
      .where(eq(runSummaries.runId, runId))
      .limit(1);

    const events = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.sequence));

    const validationResults = await db
      .select()
      .from(runValidationResults)
      .where(eq(runValidationResults.runId, runId))
      .orderBy(asc(runValidationResults.checkKey));

    const diffFiles = await db
      .select()
      .from(runDiffFiles)
      .where(eq(runDiffFiles.runId, runId))
      .orderBy(asc(runDiffFiles.path));

    const artifacts = await db
      .select()
      .from(runArtifacts)
      .where(eq(runArtifacts.runId, runId))
      .orderBy(asc(runArtifacts.createdAt));

    return {
      run,
      inputSnapshot: inputSnapshot ?? null,
      summary: summary ?? null,
      events,
      validationResults,
      diffFiles,
      artifacts,
    };
  };

  return {
    appendRunEvents,
    getRunDetailBundle,
    insertRunArtifacts,
    replaceRunDiffFiles,
    replaceRunValidationResults,
    upsertRunSummary,
  };
};

export type RunReportingRepository = ReturnType<typeof createRunReportingRepository>;
