import { randomUUID } from "node:crypto";

import type { WorkspaceBuildJob } from "@sealant/db";
import { normalizeUserWorkspaceSpec } from "@sealant/workspace-composition";
import type { Context } from "hono";
import type { z } from "zod";

import type { AppBindings } from "../../lib/types.js";
import type {
  createWorkspaceBuildJobRequestSchema,
  workspaceBuildJobDetailsSchema,
} from "./workspace-build-jobs.routes.js";

const toIsoString = (value: Date | null | undefined): string | undefined => {
  return value?.toISOString();
};

const mapJobToDetailsResponse = (
  job: WorkspaceBuildJob,
): z.infer<typeof workspaceBuildJobDetailsSchema> => {
  const publishedImage =
    job.publishedReference !== null &&
    job.publishedDigestReference !== null &&
    job.publishedDigest !== null
      ? {
          reference: job.publishedReference,
          digestReference: job.publishedDigestReference,
          digest: job.publishedDigest,
        }
      : undefined;

  const error =
    job.errorMessage !== null
      ? {
          message: job.errorMessage,
          ...(job.errorCode === null ? {} : { code: job.errorCode }),
        }
      : undefined;

  return {
    jobId: job.id,
    ...(job.runId === null ? {} : { runId: job.runId }),
    status: job.status,
    registryId: job.registryId,
    repository: job.repository,
    tag: job.tag,
    spec: job.requestPayload,
    ...(job.executorId === null ? {} : { executorId: job.executorId }),
    ...(job.resultPayload === null ? {} : { result: job.resultPayload }),
    ...(publishedImage === undefined ? {} : { publishedImage }),
    ...(error === undefined ? {} : { error }),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    ...(toIsoString(job.startedAt) === undefined ? {} : { startedAt: toIsoString(job.startedAt) }),
    ...(toIsoString(job.finishedAt) === undefined
      ? {}
      : { finishedAt: toIsoString(job.finishedAt) }),
  };
};

const toQueuePublishErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : "Failed to enqueue workspace build job.";
};

const isForeignKeyConstraintError = (error: unknown): boolean => {
  return error instanceof Error && error.message.includes("FOREIGN KEY constraint failed");
};

export const createWorkspaceBuildJob = async (c: Context<AppBindings>) => {
  const body = (
    c.req as typeof c.req & {
      valid(target: "json"): z.infer<typeof createWorkspaceBuildJobRequestSchema>;
    }
  ).valid("json");
  const env = c.get("env");

  if (body.registryId !== env.REGISTRY_NAME) {
    return c.json(
      {
        message: `Unknown registry: ${body.registryId}`,
      },
      404,
    );
  }

  const jobId = randomUUID();
  const runId = randomUUID();
  const workspaceBuildJobs = c.get("workspaceBuildJobRepository");
  const workspaceRuns = c.get("workspaceRunRepository");
  const blueprintPayload = normalizeUserWorkspaceSpec(body.spec);

  let job: WorkspaceBuildJob;

  try {
    const run = await workspaceRuns.createQueuedRun({
      id: runId,
      ownerUserId: body.ownerUserId,
      triggerType: "api",
      requestedByUserId: body.ownerUserId,
    });

    await workspaceRuns.setRunInputSnapshot({
      runId: run.id,
      userSpecPayload: body.spec,
      resolvedSpecPayload: body.spec,
      blueprintPayload,
    });

    job = await workspaceBuildJobs.insertQueuedJob({
      id: jobId,
      runId: run.id,
      registryId: body.registryId,
      repository: body.repository,
      tag: body.tag,
      requestPayload: body.spec,
    });
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      return c.json(
        {
          message: `Unknown owner user: ${body.ownerUserId}`,
        },
        404,
      );
    }

    throw error;
  }

  try {
    await c.get("workspaceBuildJobPublisher").publishRequested({
      jobId,
    });
  } catch (error) {
    await Promise.all([
      workspaceBuildJobs.markJobFailed({
        id: jobId,
        errorCode: "queue_publish_failed",
        errorMessage: toQueuePublishErrorMessage(error),
      }),
      workspaceRuns.markRunFailed({
        id: runId,
      }),
    ]);

    return c.json(
      {
        message: `Workspace build job ${jobId} was recorded but could not be queued.`,
      },
      502,
    );
  }

  return c.json(
    {
      jobId: job.id,
      runId,
      status: job.status,
      registryId: job.registryId,
      repository: job.repository,
      tag: job.tag,
    },
    202,
  );
};

export const getWorkspaceBuildJob = async (c: Context<AppBindings>) => {
  const { jobId } = c.req.param() as {
    jobId: string;
  };
  const job = await c.get("workspaceBuildJobRepository").getJobById(jobId);

  if (job === undefined) {
    return c.json(
      {
        message: `Workspace build job not found: ${jobId}`,
      },
      404,
    );
  }

  return c.json(mapJobToDetailsResponse(job));
};
