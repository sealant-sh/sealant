import { randomUUID } from "node:crypto";

import type {
  SandboxAttemptRepository,
  SandboxRuntimeInstanceRepository,
  WorkspaceBuildJobRepository,
} from "@sealant/db";
import { normalizeUserWorkspaceSpec } from "@sealant/workspace-composition";
import type { Context } from "hono";
import type { z } from "zod";

import {
  resolveSandboxError,
  resolveSandboxPublishedImage,
  resolveSandboxRuntime,
  resolveSandboxStatus,
} from "../../lib/sandbox.js";
import type { AppBindings } from "../../lib/types.js";
import type {
  createSandboxRequestSchema,
  listSandboxesQuerySchema,
  sandboxDetailsSchema,
  sandboxSummarySchema,
} from "./sandboxes.routes.js";

type SandboxAttemptRecord = NonNullable<
  Awaited<ReturnType<SandboxAttemptRepository["getAttemptById"]>>
>;
type WorkspaceBuildJobRecord = Awaited<
  ReturnType<WorkspaceBuildJobRepository["getLatestJobByRunId"]>
>;
type SandboxRuntimeInstanceRecord = Awaited<
  ReturnType<SandboxRuntimeInstanceRepository["getRuntimeInstanceByRunId"]>
>;

const toIsoString = (value: Date | null | undefined): string | undefined => {
  return value?.toISOString();
};

const latestDate = (a: Date, b: Date | undefined): Date => {
  if (b === undefined || a.getTime() >= b.getTime()) {
    return a;
  }

  return b;
};

const toQueuePublishErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : "Failed to enqueue workspace build job.";
};

const isForeignKeyConstraintError = (error: unknown): boolean => {
  return error instanceof Error && error.message.includes("FOREIGN KEY constraint failed");
};

const isUniqueConstraintError = (error: unknown): boolean => {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
};

const readIdempotencyKey = (c: Context<AppBindings>): string | undefined => {
  const key = c.req.header("Idempotency-Key")?.trim();

  if (key === undefined || key.length === 0) {
    return undefined;
  }

  return key;
};

const mapSandboxSummary = (
  attempt: SandboxAttemptRecord,
  latestJob: WorkspaceBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
): z.infer<typeof sandboxSummarySchema> => {
  const runtime = resolveSandboxRuntime(runtimeInstance);
  const publishedImage = resolveSandboxPublishedImage(latestJob);
  const error = resolveSandboxError(latestJob);
  const updatedAt = latestDate(attempt.updatedAt, latestJob?.updatedAt);
  const startedAt = attempt.startedAt ?? latestJob?.startedAt;
  const finishedAt = attempt.finishedAt ?? latestJob?.finishedAt;

  return {
    sandboxId: attempt.id,
    runId: attempt.id,
    ...(latestJob === undefined ? {} : { jobId: latestJob.id }),
    ownerUserId: attempt.ownerUserId,
    status: resolveSandboxStatus({
      attempt,
      latestJob,
      runtimeInstance,
    }),
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
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    ...(toIsoString(startedAt) === undefined ? {} : { startedAt: toIsoString(startedAt) }),
    ...(toIsoString(finishedAt) === undefined ? {} : { finishedAt: toIsoString(finishedAt) }),
  };
};

const mapSandboxDetails = (
  attempt: SandboxAttemptRecord,
  latestJob: WorkspaceBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
): z.infer<typeof sandboxDetailsSchema> => {
  const summary = mapSandboxSummary(attempt, latestJob, runtimeInstance);

  return {
    ...summary,
    runStatus: attempt.status,
    ...(latestJob === undefined ? {} : { jobStatus: latestJob.status }),
    ...(latestJob === undefined ? {} : { spec: latestJob.requestPayload }),
  };
};

const acceptedSandboxResponse = (
  runId: string,
  jobId: string,
  input: {
    readonly registryId: string;
    readonly repository: string;
    readonly tag: string;
  },
) => {
  return {
    sandboxId: runId,
    runId,
    jobId,
    status: "queued" as const,
    registryId: input.registryId,
    repository: input.repository,
    tag: input.tag,
  };
};

export const createSandbox = async (c: Context<AppBindings>) => {
  const body = (
    c.req as typeof c.req & {
      valid(target: "json"): z.infer<typeof createSandboxRequestSchema>;
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

  const idempotencyKey = readIdempotencyKey(c);
  const workspaceBuildJobs = c.get("workspaceBuildJobRepository");
  const sandboxAttempts = c.get("sandboxAttemptRepository");

  if (idempotencyKey !== undefined) {
    const existingJob = await workspaceBuildJobs.getJobByIdempotencyKey(idempotencyKey);

    if (existingJob !== undefined && existingJob.runId !== null) {
      const existingRun = await sandboxAttempts.getAttemptById(existingJob.runId);

      if (existingRun !== undefined) {
        c.header("Location", `/v1/sandboxes/${encodeURIComponent(existingRun.id)}`);
        return c.json(
          acceptedSandboxResponse(existingRun.id, existingJob.id, {
            registryId: existingJob.registryId,
            repository: existingJob.repository,
            tag: existingJob.tag,
          }),
          202,
        );
      }
    }
  }

  const runId = randomUUID();
  const jobId = randomUUID();
  const blueprintPayload = normalizeUserWorkspaceSpec(body.spec);

  try {
    const attempt = await sandboxAttempts.createQueuedAttempt({
      id: runId,
      ownerUserId: body.ownerUserId,
      triggerType: "api",
      requestedByUserId: body.ownerUserId,
    });

    await sandboxAttempts.setAttemptSnapshot({
      runId: attempt.id,
      userSpecPayload: body.spec,
      resolvedSpecPayload: body.spec,
      blueprintPayload,
    });

    await workspaceBuildJobs.insertQueuedJob({
      id: jobId,
      runId: attempt.id,
      registryId: body.registryId,
      repository: body.repository,
      tag: body.tag,
      requestPayload: body.spec,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
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

    if (idempotencyKey !== undefined && isUniqueConstraintError(error)) {
      const existingJob = await workspaceBuildJobs.getJobByIdempotencyKey(idempotencyKey);

      if (existingJob !== undefined && existingJob.runId !== null) {
        c.header("Location", `/v1/sandboxes/${encodeURIComponent(existingJob.runId)}`);
        return c.json(
          acceptedSandboxResponse(existingJob.runId, existingJob.id, {
            registryId: existingJob.registryId,
            repository: existingJob.repository,
            tag: existingJob.tag,
          }),
          202,
        );
      }
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
      sandboxAttempts.markAttemptFailed({
        id: runId,
      }),
    ]);

    return c.json(
      {
        message: `Sandbox ${runId} was recorded but could not be queued.`,
      },
      502,
    );
  }

  c.header("Location", `/v1/sandboxes/${encodeURIComponent(runId)}`);

  return c.json(
    acceptedSandboxResponse(runId, jobId, {
      registryId: body.registryId,
      repository: body.repository,
      tag: body.tag,
    }),
    202,
  );
};

export const listSandboxes = async (c: Context<AppBindings>) => {
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): z.infer<typeof listSandboxesQuerySchema>;
    }
  ).valid("query");

  const runLimit = query.status === undefined ? query.limit : Math.min(query.limit * 4, 100);
  const attempts = await c.get("sandboxAttemptRepository").listAttempts({
    ownerUserId: query.ownerUserId,
    limit: runLimit,
  });
  const latestJobsByRunId = await c
    .get("workspaceBuildJobRepository")
    .listLatestJobsByRunIds(attempts.map((attempt) => attempt.id));
  const runtimeInstancesByRunId = await c
    .get("sandboxRuntimeInstanceRepository")
    .listRuntimeInstancesByRunIds(attempts.map((attempt) => attempt.id));

  const items = attempts
    .map((attempt) =>
      mapSandboxSummary(
        attempt,
        latestJobsByRunId.get(attempt.id),
        runtimeInstancesByRunId.get(attempt.id),
      ),
    )
    .filter((item) => (query.status === undefined ? true : item.status === query.status))
    .slice(0, query.limit);

  return c.json({
    items,
  });
};

export const getSandbox = async (c: Context<AppBindings>) => {
  const { sandboxId } = c.req.param() as {
    sandboxId: string;
  };
  const attempt = await c.get("sandboxAttemptRepository").getAttemptById(sandboxId);

  if (attempt === undefined) {
    return c.json(
      {
        message: `Sandbox not found: ${sandboxId}`,
      },
      404,
    );
  }

  const latestJob = await c.get("workspaceBuildJobRepository").getLatestJobByRunId(attempt.id);
  const runtimeInstance = await c
    .get("sandboxRuntimeInstanceRepository")
    .getRuntimeInstanceByRunId(attempt.id);

  return c.json(mapSandboxDetails(attempt, latestJob, runtimeInstance));
};
