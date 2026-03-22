import type {
  RunDetailBundle,
  SandboxRuntimeInstanceRepository,
  WorkspaceBuildJobRepository,
} from "@sealant/db";
import type { Context } from "hono";
import type { z } from "zod";

import {
  resolveSandboxError,
  resolveSandboxPublishedImage,
  resolveSandboxRuntime,
  resolveSandboxStatus,
} from "../../lib/sandbox.js";
import type { AppBindings } from "../../lib/types.js";
import type { runDetailsResponseSchema } from "./runs.routes.js";

type WorkspaceBuildJobRecord = Awaited<
  ReturnType<WorkspaceBuildJobRepository["getLatestJobByRunId"]>
>;
type SandboxRuntimeInstanceRecord = Awaited<
  ReturnType<SandboxRuntimeInstanceRepository["getRuntimeInstanceByRunId"]>
>;

const toIsoString = (value: Date | null): string | null => {
  return value?.toISOString() ?? null;
};

const toOptionalIsoString = (value: Date | null | undefined): string | undefined => {
  return value?.toISOString();
};

const latestDate = (a: Date, b: Date | undefined): Date => {
  if (b === undefined || a.getTime() >= b.getTime()) {
    return a;
  }

  return b;
};

const mapRunSandbox = (
  detail: RunDetailBundle,
  latestJob: WorkspaceBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
): z.infer<typeof runDetailsResponseSchema>["sandbox"] => {
  const runtime = resolveSandboxRuntime(runtimeInstance);
  const publishedImage = resolveSandboxPublishedImage(latestJob);
  const error = resolveSandboxError(latestJob);
  const updatedAt = latestDate(detail.run.updatedAt, latestJob?.updatedAt);
  const startedAt = detail.run.startedAt ?? latestJob?.startedAt;
  const finishedAt = detail.run.finishedAt ?? latestJob?.finishedAt;

  return {
    sandboxId: detail.run.id,
    ...(latestJob === undefined ? {} : { jobId: latestJob.id }),
    status: resolveSandboxStatus({
      attempt: detail.run,
      latestJob,
      runtimeInstance,
    }),
    runStatus: detail.run.status,
    ...(latestJob === undefined ? {} : { jobStatus: latestJob.status }),
    ...(latestJob === undefined
      ? {}
      : {
          registryId: latestJob.registryId,
          repository: latestJob.repository,
          tag: latestJob.tag,
        }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(publishedImage === undefined ? {} : { publishedImage }),
    ...(error === undefined ? {} : { error }),
    createdAt: detail.run.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    ...(toOptionalIsoString(startedAt) === undefined
      ? {}
      : { startedAt: toOptionalIsoString(startedAt) }),
    ...(toOptionalIsoString(finishedAt) === undefined
      ? {}
      : { finishedAt: toOptionalIsoString(finishedAt) }),
  };
};

const mapRunDetails = (
  detail: RunDetailBundle,
  latestJob: WorkspaceBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
): z.infer<typeof runDetailsResponseSchema> => {
  return {
    run: {
      id: detail.run.id,
      ownerUserId: detail.run.ownerUserId,
      status: detail.run.status,
      triggerType: detail.run.triggerType,
      triggerRef: detail.run.triggerRef,
      requestedByUserId: detail.run.requestedByUserId,
      cancelReason: detail.run.cancelReason,
      queuedAt: detail.run.queuedAt.toISOString(),
      startedAt: toIsoString(detail.run.startedAt),
      finishedAt: toIsoString(detail.run.finishedAt),
      durationMs: detail.run.durationMs,
      createdAt: detail.run.createdAt.toISOString(),
      updatedAt: detail.run.updatedAt.toISOString(),
    },
    sandbox: mapRunSandbox(detail, latestJob, runtimeInstance),
    inputSnapshot:
      detail.inputSnapshot === null
        ? null
        : {
            userSpecPayload: detail.inputSnapshot.userSpecPayload,
            resolvedSpecPayload: detail.inputSnapshot.resolvedSpecPayload,
            blueprintPayload: detail.inputSnapshot.blueprintPayload,
            profileConfigSnapshot: detail.inputSnapshot.profileConfigSnapshot ?? null,
            repositoryProfileConfigSnapshot:
              detail.inputSnapshot.repositoryProfileConfigSnapshot ?? null,
            createdAt: detail.inputSnapshot.createdAt.toISOString(),
          },
    summary:
      detail.summary === null
        ? null
        : {
            objective: detail.summary.objective,
            linkedIssueRef: detail.summary.linkedIssueRef,
            filesChanged: detail.summary.filesChanged,
            additions: detail.summary.additions,
            deletions: detail.summary.deletions,
            assumptions: detail.summary.assumptions,
            warnings: detail.summary.warnings,
            summaryMarkdown: detail.summary.summaryMarkdown,
            generatedAt: detail.summary.generatedAt.toISOString(),
            updatedAt: detail.summary.updatedAt.toISOString(),
          },
    events: detail.events.map((event) => {
      return {
        id: event.id,
        sequence: event.sequence,
        phase: event.phase,
        level: event.level,
        eventType: event.eventType,
        message: event.message,
        payload: event.payload ?? null,
        occurredAt: event.occurredAt.toISOString(),
      };
    }),
    validationResults: detail.validationResults.map((result) => {
      return {
        id: result.id,
        checkKey: result.checkKey,
        status: result.status,
        durationMs: result.durationMs,
        message: result.message,
        details: result.details ?? null,
        createdAt: result.createdAt.toISOString(),
      };
    }),
    diffFiles: detail.diffFiles.map((diffFile) => {
      return {
        id: diffFile.id,
        changeType: diffFile.changeType,
        path: diffFile.path,
        oldPath: diffFile.oldPath,
        additions: diffFile.additions,
        deletions: diffFile.deletions,
        isBinary: diffFile.isBinary,
        patchArtifactId: diffFile.patchArtifactId,
        createdAt: diffFile.createdAt.toISOString(),
      };
    }),
    artifacts: detail.artifacts.map((artifact) => {
      return {
        id: artifact.id,
        kind: artifact.kind,
        storageBackend: artifact.storageBackend,
        storageKey: artifact.storageKey,
        contentType: artifact.contentType,
        byteSize: artifact.byteSize,
        checksum: artifact.checksum,
        inlineJson: artifact.inlineJson ?? null,
        createdAt: artifact.createdAt.toISOString(),
      };
    }),
  };
};

export const getRun = async (c: Context<AppBindings>) => {
  const { runId } = c.req.param() as {
    runId: string;
  };
  const detail = await c.get("runReportingRepository").getRunDetailBundle(runId);

  if (detail === null) {
    return c.json(
      {
        message: `Run not found: ${runId}`,
      },
      404,
    );
  }

  const latestJob = await c.get("workspaceBuildJobRepository").getLatestJobByRunId(runId);
  const runtimeInstance = await c
    .get("sandboxRuntimeInstanceRepository")
    .getRuntimeInstanceByRunId(runId);

  return c.json(mapRunDetails(detail, latestJob, runtimeInstance));
};
