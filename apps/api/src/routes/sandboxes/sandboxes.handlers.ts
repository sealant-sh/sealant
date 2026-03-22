import { randomUUID } from "node:crypto";

import type {
  SandboxAttemptRepository,
  SandboxRepository,
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
  listSandboxAttemptsQuerySchema,
  listSandboxEventsQuerySchema,
  listSandboxesQuerySchema,
  sandboxAttemptSummarySchema,
  sandboxDetailsSchema,
  sandboxEventSchema,
  sandboxSummarySchema,
} from "./sandboxes.routes.js";

type SandboxAttemptRecord = NonNullable<
  Awaited<ReturnType<SandboxAttemptRepository["getAttemptById"]>>
>;
type SandboxRecord = NonNullable<Awaited<ReturnType<SandboxRepository["getSandboxById"]>>>;
type WorkspaceBuildJobRecord = Awaited<
  ReturnType<WorkspaceBuildJobRepository["getLatestJobByRunId"]>
>;
type SandboxRuntimeInstanceRecord = Awaited<
  ReturnType<SandboxRuntimeInstanceRepository["getRuntimeInstanceByRunId"]>
>;
type SandboxRunLinkRecord = Awaited<
  ReturnType<SandboxRepository["listSandboxAttemptLinks"]>
>[number];
type SandboxEventType = z.infer<typeof sandboxEventSchema>["type"];

interface SandboxEventDraft {
  readonly sandboxId: string;
  readonly attemptId?: string;
  readonly type: SandboxEventType;
  readonly occurredAt: Date;
  readonly message?: string;
  readonly data?: Record<string, unknown>;
}

const toIsoString = (value: Date | null | undefined): string | undefined => {
  return value?.toISOString();
};

const latestDate = (first: Date, ...rest: Array<Date | undefined>): Date => {
  let latest = first;

  for (const candidate of rest) {
    if (candidate !== undefined && candidate.getTime() > latest.getTime()) {
      latest = candidate;
    }
  }

  return latest;
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

const mapStoredSandboxStatus = (
  status: SandboxRecord["status"],
): z.infer<typeof sandboxSummarySchema>["status"] => {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    case "stopped":
      return "cancelled";
  }
};

const mapAttemptStatusToSandboxStatus = (
  status: SandboxAttemptRecord["status"],
): SandboxRecord["status"] => {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "ready";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
  }
};

const mapSandboxAttemptSummary = (
  link: SandboxRunLinkRecord,
  attempt: SandboxAttemptRecord,
  latestJob: WorkspaceBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
): z.infer<typeof sandboxAttemptSummarySchema> => {
  const runtime = resolveSandboxRuntime(runtimeInstance);
  const publishedImage = resolveSandboxPublishedImage(latestJob);
  const error = resolveSandboxError(latestJob);
  const startedAt = attempt.startedAt ?? latestJob?.startedAt;
  const finishedAt = attempt.finishedAt ?? latestJob?.finishedAt;

  return {
    attemptId: attempt.id,
    relation: link.relation,
    status: resolveSandboxStatus({
      attempt,
      latestJob,
      runtimeInstance,
    }),
    triggerType: attempt.triggerType,
    ...(attempt.triggerRef === null ? {} : { triggerRef: attempt.triggerRef }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(publishedImage === undefined ? {} : { publishedImage }),
    ...(error === undefined ? {} : { error }),
    ...(latestJob === undefined ? {} : { spec: latestJob.requestPayload }),
    queuedAt: attempt.queuedAt.toISOString(),
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString(),
    linkedAt: link.linkedAt.toISOString(),
    ...(toIsoString(startedAt) === undefined ? {} : { startedAt: toIsoString(startedAt) }),
    ...(toIsoString(finishedAt) === undefined ? {} : { finishedAt: toIsoString(finishedAt) }),
    ...(attempt.durationMs === null ? {} : { durationMs: attempt.durationMs }),
  };
};

const toEventId = (input: {
  readonly sandboxId: string;
  readonly attemptId?: string;
  readonly type: SandboxEventType;
  readonly occurredAt: Date;
}): string => {
  return [
    input.sandboxId,
    input.attemptId ?? "sandbox",
    input.type,
    input.occurredAt.getTime(),
  ].join(":");
};

const toEventResponse = (input: SandboxEventDraft): z.infer<typeof sandboxEventSchema> => {
  return {
    eventId: toEventId(input),
    sandboxId: input.sandboxId,
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    type: input.type,
    occurredAt: input.occurredAt.toISOString(),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.data === undefined ? {} : { data: input.data }),
  };
};

const ensureSandboxForAttempt = async (
  sandboxRepository: SandboxRepository,
  attempt: SandboxAttemptRecord,
): Promise<SandboxRecord> => {
  const existing = await sandboxRepository.getSandboxByAttemptId(attempt.id);

  if (existing !== undefined) {
    return existing;
  }

  const sandbox = await sandboxRepository.createSandbox({
    id: randomUUID(),
    ownerUserId: attempt.ownerUserId,
    ...(attempt.repositoryId === null ? {} : { repositoryId: attempt.repositoryId }),
    ...(attempt.repositoryProfileRevisionId === null
      ? {}
      : { repositoryProfileRevisionId: attempt.repositoryProfileRevisionId }),
    ...(attempt.profileRevisionId === null ? {} : { profileRevisionId: attempt.profileRevisionId }),
    ...(attempt.requestedByUserId === null ? {} : { requestedByUserId: attempt.requestedByUserId }),
    status: mapAttemptStatusToSandboxStatus(attempt.status),
  });

  await sandboxRepository.linkSandboxAttempt({
    sandboxId: sandbox.id,
    attemptId: attempt.id,
    relation: "launch",
  });

  return sandbox;
};

const mapSandboxSummary = (
  sandbox: SandboxRecord,
  attempt: SandboxAttemptRecord | undefined,
  latestJob: WorkspaceBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
): z.infer<typeof sandboxSummarySchema> => {
  const runtime = resolveSandboxRuntime(runtimeInstance);
  const publishedImage = resolveSandboxPublishedImage(latestJob);
  const error = resolveSandboxError(latestJob);
  const updatedAt = latestDate(
    sandbox.updatedAt,
    attempt?.updatedAt,
    latestJob?.updatedAt,
    runtimeInstance?.updatedAt,
  );
  const startedAt = attempt?.startedAt ?? latestJob?.startedAt;
  const finishedAt = attempt?.finishedAt ?? latestJob?.finishedAt;
  const status =
    attempt === undefined
      ? mapStoredSandboxStatus(sandbox.status)
      : resolveSandboxStatus({
          attempt,
          latestJob,
          runtimeInstance,
        });

  return {
    sandboxId: sandbox.id,
    ownerUserId: sandbox.ownerUserId,
    status,
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
    createdAt: sandbox.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    ...(toIsoString(startedAt) === undefined ? {} : { startedAt: toIsoString(startedAt) }),
    ...(toIsoString(finishedAt) === undefined ? {} : { finishedAt: toIsoString(finishedAt) }),
  };
};

const mapSandboxDetails = (
  sandbox: SandboxRecord,
  attempt: SandboxAttemptRecord | undefined,
  latestJob: WorkspaceBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
): z.infer<typeof sandboxDetailsSchema> => {
  const summary = mapSandboxSummary(sandbox, attempt, latestJob, runtimeInstance);

  return {
    ...summary,
    ...(latestJob === undefined ? {} : { spec: latestJob.requestPayload }),
  };
};

const acceptedSandboxResponse = (
  sandboxId: string,
  input: {
    readonly registryId: string;
    readonly repository: string;
    readonly tag: string;
  },
) => {
  return {
    sandboxId,
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
  const sandboxes = c.get("sandboxRepository");
  const workspaceBuildJobs = c.get("workspaceBuildJobRepository");
  const sandboxAttempts = c.get("sandboxAttemptRepository");

  if (idempotencyKey !== undefined) {
    const existingJob = await workspaceBuildJobs.getJobByIdempotencyKey(idempotencyKey);

    if (existingJob !== undefined && existingJob.runId !== null) {
      const existingRun = await sandboxAttempts.getAttemptById(existingJob.runId);

      if (existingRun !== undefined) {
        const existingSandbox = await ensureSandboxForAttempt(sandboxes, existingRun);

        c.header("Location", `/v1/sandboxes/${encodeURIComponent(existingSandbox.id)}`);
        return c.json(
          acceptedSandboxResponse(existingSandbox.id, {
            registryId: existingJob.registryId,
            repository: existingJob.repository,
            tag: existingJob.tag,
          }),
          202,
        );
      }
    }
  }

  const sandboxId = randomUUID();
  const runId = randomUUID();
  const jobId = randomUUID();
  const blueprintPayload = normalizeUserWorkspaceSpec(body.spec);

  try {
    const sandbox = await sandboxes.createSandbox({
      id: sandboxId,
      ownerUserId: body.ownerUserId,
      requestedByUserId: body.ownerUserId,
      status: "queued",
    });

    const attempt = await sandboxAttempts.createQueuedAttempt({
      id: runId,
      ownerUserId: body.ownerUserId,
      triggerType: "api",
      requestedByUserId: body.ownerUserId,
    });

    await sandboxes.linkSandboxAttempt({
      sandboxId: sandbox.id,
      attemptId: attempt.id,
      relation: "launch",
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
        const existingRun = await sandboxAttempts.getAttemptById(existingJob.runId);

        if (existingRun !== undefined) {
          const existingSandbox = await ensureSandboxForAttempt(sandboxes, existingRun);

          c.header("Location", `/v1/sandboxes/${encodeURIComponent(existingSandbox.id)}`);
          return c.json(
            acceptedSandboxResponse(existingSandbox.id, {
              registryId: existingJob.registryId,
              repository: existingJob.repository,
              tag: existingJob.tag,
            }),
            202,
          );
        }
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
      sandboxes.setSandboxStatus({
        id: sandboxId,
        status: "failed",
      }),
    ]);

    return c.json(
      {
        message: `Sandbox ${sandboxId} was recorded but could not be queued.`,
      },
      502,
    );
  }

  c.header("Location", `/v1/sandboxes/${encodeURIComponent(sandboxId)}`);

  return c.json(
    acceptedSandboxResponse(sandboxId, {
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

  const sandboxLimit = query.status === undefined ? query.limit : Math.min(query.limit * 4, 100);
  const sandboxes = await c.get("sandboxRepository").listSandboxes({
    ownerUserId: query.ownerUserId,
    limit: sandboxLimit,
  });
  const latestRunIds = sandboxes.flatMap((sandbox) => {
    return sandbox.latestRunId === null ? [] : [sandbox.latestRunId];
  });
  const attempts = await Promise.all(
    latestRunIds.map(async (runId) => {
      return [runId, await c.get("sandboxAttemptRepository").getAttemptById(runId)] as const;
    }),
  );
  const attemptsByRunId = new Map(
    attempts.flatMap(([runId, attempt]) => {
      return attempt === undefined ? [] : [[runId, attempt] as const];
    }),
  );
  const latestJobsByRunId = await c
    .get("workspaceBuildJobRepository")
    .listLatestJobsByRunIds(latestRunIds);
  const runtimeInstancesByRunId = await c
    .get("sandboxRuntimeInstanceRepository")
    .listRuntimeInstancesByRunIds(latestRunIds);

  const items = sandboxes
    .map((sandbox) => {
      const runId = sandbox.latestRunId ?? undefined;

      return mapSandboxSummary(
        sandbox,
        runId === undefined ? undefined : attemptsByRunId.get(runId),
        runId === undefined ? undefined : latestJobsByRunId.get(runId),
        runId === undefined ? undefined : runtimeInstancesByRunId.get(runId),
      );
    })
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
  const sandbox = await c.get("sandboxRepository").getSandboxById(sandboxId);

  if (sandbox === undefined) {
    return c.json(
      {
        message: `Sandbox not found: ${sandboxId}`,
      },
      404,
    );
  }

  if (sandbox.latestRunId === null) {
    return c.json(mapSandboxDetails(sandbox, undefined, undefined, undefined));
  }

  const attempt = await c.get("sandboxAttemptRepository").getAttemptById(sandbox.latestRunId);
  const latestJob = await c
    .get("workspaceBuildJobRepository")
    .getLatestJobByRunId(sandbox.latestRunId);
  const runtimeInstance = await c
    .get("sandboxRuntimeInstanceRepository")
    .getRuntimeInstanceByRunId(sandbox.latestRunId);

  return c.json(mapSandboxDetails(sandbox, attempt, latestJob, runtimeInstance));
};

export const listSandboxAttempts = async (c: Context<AppBindings>) => {
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): z.infer<typeof listSandboxAttemptsQuerySchema>;
    }
  ).valid("query");
  const { sandboxId } = c.req.param() as {
    sandboxId: string;
  };
  const sandbox = await c.get("sandboxRepository").getSandboxById(sandboxId);

  if (sandbox === undefined) {
    return c.json(
      {
        message: `Sandbox not found: ${sandboxId}`,
      },
      404,
    );
  }

  const links = await c.get("sandboxRepository").listSandboxAttemptLinks(sandbox.id, query.limit);
  const runIds = links.map((link) => link.runId);
  const attempts = await Promise.all(
    runIds.map(async (runId) => {
      return [runId, await c.get("sandboxAttemptRepository").getAttemptById(runId)] as const;
    }),
  );
  const attemptsByRunId = new Map(
    attempts.flatMap(([runId, attempt]) => {
      return attempt === undefined ? [] : [[runId, attempt] as const];
    }),
  );
  const latestJobsByRunId = await c
    .get("workspaceBuildJobRepository")
    .listLatestJobsByRunIds(runIds);
  const runtimeInstancesByRunId = await c
    .get("sandboxRuntimeInstanceRepository")
    .listRuntimeInstancesByRunIds(runIds);

  const items = links.flatMap((link) => {
    const attempt = attemptsByRunId.get(link.runId);

    if (attempt === undefined) {
      return [];
    }

    return [
      mapSandboxAttemptSummary(
        link,
        attempt,
        latestJobsByRunId.get(link.runId),
        runtimeInstancesByRunId.get(link.runId),
      ),
    ];
  });

  return c.json({
    items,
  });
};

export const listSandboxEvents = async (c: Context<AppBindings>) => {
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): z.infer<typeof listSandboxEventsQuerySchema>;
    }
  ).valid("query");
  const { sandboxId } = c.req.param() as {
    sandboxId: string;
  };
  const sandbox = await c.get("sandboxRepository").getSandboxById(sandboxId);

  if (sandbox === undefined) {
    return c.json(
      {
        message: `Sandbox not found: ${sandboxId}`,
      },
      404,
    );
  }

  const links = await c.get("sandboxRepository").listSandboxAttemptLinks(sandbox.id, query.limit);
  const runIds = links.map((link) => link.runId);
  const attempts = await Promise.all(
    runIds.map(async (runId) => {
      return [runId, await c.get("sandboxAttemptRepository").getAttemptById(runId)] as const;
    }),
  );
  const attemptsByRunId = new Map(
    attempts.flatMap(([runId, attempt]) => {
      return attempt === undefined ? [] : [[runId, attempt] as const];
    }),
  );
  const latestJobsByRunId = await c
    .get("workspaceBuildJobRepository")
    .listLatestJobsByRunIds(runIds);
  const runtimeInstancesByRunId = await c
    .get("sandboxRuntimeInstanceRepository")
    .listRuntimeInstancesByRunIds(runIds);

  const events: SandboxEventDraft[] = [
    {
      sandboxId: sandbox.id,
      type: "sandbox.created",
      occurredAt: sandbox.createdAt,
      message: "Sandbox created.",
    },
  ];

  for (const link of links) {
    const attempt = attemptsByRunId.get(link.runId);

    if (attempt === undefined) {
      continue;
    }

    const latestJob = latestJobsByRunId.get(link.runId);
    const runtimeInstance = runtimeInstancesByRunId.get(link.runId);

    events.push({
      sandboxId: sandbox.id,
      attemptId: attempt.id,
      type: "attempt.queued",
      occurredAt: attempt.queuedAt,
      message: "Sandbox attempt queued.",
      data: {
        relation: link.relation,
        triggerType: attempt.triggerType,
      },
    });

    if (attempt.startedAt !== null) {
      events.push({
        sandboxId: sandbox.id,
        attemptId: attempt.id,
        type: "attempt.running",
        occurredAt: attempt.startedAt,
        message: "Sandbox attempt started.",
      });
    }

    if (
      latestJob !== undefined &&
      latestJob.publishedReference !== null &&
      latestJob.publishedDigestReference !== null &&
      latestJob.publishedDigest !== null
    ) {
      events.push({
        sandboxId: sandbox.id,
        attemptId: attempt.id,
        type: "image.published",
        occurredAt: latestJob.finishedAt ?? latestJob.updatedAt,
        message: "Workspace image published.",
        data: {
          reference: latestJob.publishedReference,
          digestReference: latestJob.publishedDigestReference,
          digest: latestJob.publishedDigest,
        },
      });
    }

    if (runtimeInstance !== undefined) {
      const runtimeOccurredAt =
        runtimeInstance.status === "running"
          ? (runtimeInstance.launchedAt ?? runtimeInstance.updatedAt)
          : runtimeInstance.status === "pending"
            ? runtimeInstance.createdAt
            : (runtimeInstance.finishedAt ?? runtimeInstance.updatedAt);

      events.push({
        sandboxId: sandbox.id,
        attemptId: attempt.id,
        type: `runtime.${runtimeInstance.status}`,
        occurredAt: runtimeOccurredAt,
        message: `Runtime status updated to ${runtimeInstance.status}.`,
        data: {
          ...(runtimeInstance.adapter === null ? {} : { adapter: runtimeInstance.adapter }),
          ...(runtimeInstance.resourceId === null
            ? {}
            : { resourceId: runtimeInstance.resourceId }),
          ...(runtimeInstance.reference === null ? {} : { reference: runtimeInstance.reference }),
          ...(runtimeInstance.endpoint === null ? {} : { endpoint: runtimeInstance.endpoint }),
          ...(runtimeInstance.errorCode === null ? {} : { errorCode: runtimeInstance.errorCode }),
          ...(runtimeInstance.errorMessage === null
            ? {}
            : { errorMessage: runtimeInstance.errorMessage }),
        },
      });
    }

    if (attempt.status === "succeeded" && attempt.finishedAt !== null) {
      events.push({
        sandboxId: sandbox.id,
        attemptId: attempt.id,
        type: "attempt.succeeded",
        occurredAt: attempt.finishedAt,
        message: "Sandbox attempt completed successfully.",
      });
    }

    if (attempt.status === "failed" && attempt.finishedAt !== null) {
      events.push({
        sandboxId: sandbox.id,
        attemptId: attempt.id,
        type: "attempt.failed",
        occurredAt: attempt.finishedAt,
        message: "Sandbox attempt failed.",
      });
    }

    if (attempt.status === "cancelled" && attempt.finishedAt !== null) {
      events.push({
        sandboxId: sandbox.id,
        attemptId: attempt.id,
        type: "attempt.cancelled",
        occurredAt: attempt.finishedAt,
        message: "Sandbox attempt was cancelled.",
        ...(attempt.cancelReason === null ? {} : { data: { cancelReason: attempt.cancelReason } }),
      });
    }
  }

  const items = [...events]
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .slice(0, query.limit)
    .map(toEventResponse);

  return c.json({
    items,
  });
};
