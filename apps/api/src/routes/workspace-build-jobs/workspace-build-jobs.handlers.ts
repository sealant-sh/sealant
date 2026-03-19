import { randomUUID } from "node:crypto";

import type { WorkspaceBuildJob } from "@sealant/db";
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
  const repository = c.get("workspaceBuildJobRepository");
  const job = await repository.insertQueuedJob({
    id: jobId,
    registryId: body.registryId,
    repository: body.repository,
    tag: body.tag,
    requestPayload: body.spec,
  });

  try {
    await c.get("workspaceBuildJobPublisher").publishRequested({
      jobId,
    });
  } catch (error) {
    await repository.markJobFailed({
      id: jobId,
      errorCode: "queue_publish_failed",
      errorMessage: toQueuePublishErrorMessage(error),
    });

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
