import { randomUUID } from "node:crypto";

import type {
  SandboxAttemptRepository,
  SandboxRepository,
  SandboxRuntimeInstanceRepository,
  WorkspaceBuildJobRequestPayload,
  WorkspaceBuildJobRepository,
} from "@sealant/db";
import { workspaceBuildJobRequestPayloadSchema } from "@sealant/db";
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
  renameSandboxRequestSchema,
  renameSandboxResponseSchema,
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
type SandboxAttemptSnapshotRecord = Awaited<
  ReturnType<SandboxAttemptRepository["getAttemptSnapshotByRunId"]>
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

const sanitizeSandboxName = (name: string): string => {
  return name.trim().replace(/\s+/g, " ").slice(0, 120);
};

const toTitleToken = (value: string): string => {
  return value
    .trim()
    .split(/[\s._-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      return segment.charAt(0).toUpperCase() + segment.slice(1);
    })
    .join(" ");
};

const deriveRepositoryNameToken = (repository: string): string => {
  const segments = repository.split("/").filter((segment) => segment.length > 0);
  const tail = segments[segments.length - 1] ?? repository;
  const token = toTitleToken(tail);

  if (token.length > 0) {
    return token;
  }

  return "Sandbox";
};

const deriveSourceRef = (spec: WorkspaceBuildJobRequestPayload): string | undefined => {
  const source = spec.sources?.workspace ?? spec.source ?? spec.repo;

  if (typeof source === "string" || source === undefined) {
    return undefined;
  }

  const ref = source.ref?.trim();

  if (ref === undefined || ref.length === 0) {
    return undefined;
  }

  return ref;
};

const inferSandboxName = (input: {
  readonly repository: string;
  readonly tag: string;
  readonly spec: WorkspaceBuildJobRequestPayload;
  readonly fallbackId: string;
}): string => {
  const repositoryToken = deriveRepositoryNameToken(input.repository);
  const tagToken = toTitleToken(input.tag);
  const sourceRef = deriveSourceRef(input.spec);
  const refToken = sourceRef === undefined ? "" : toTitleToken(sourceRef);
  const name = sanitizeSandboxName(
    [repositoryToken, tagToken, refToken].filter((segment) => segment.length > 0).join(" "),
  );

  if (name.length > 0) {
    return name;
  }

  return `Sandbox ${input.fallbackId.slice(0, 8)}`;
};

const resolveStoredSandboxName = (sandbox: Pick<SandboxRecord, "id" | "name">): string => {
  const sanitized = sanitizeSandboxName(sandbox.name);

  if (sanitized.length > 0) {
    return sanitized;
  }

  return `Sandbox ${sandbox.id.slice(0, 8)}`;
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
    name: `Sandbox ${attempt.id.slice(0, 8)}`,
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
    name: resolveStoredSandboxName(sandbox),
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
  attemptSnapshot: SandboxAttemptSnapshotRecord,
): z.infer<typeof sandboxDetailsSchema> => {
  const summary = mapSandboxSummary(sandbox, attempt, latestJob, runtimeInstance);
  const userSpec = attemptSnapshot?.userSpecPayload ?? latestJob?.requestPayload;

  return {
    ...summary,
    ...(userSpec === undefined ? {} : { spec: userSpec }),
    ...(attemptSnapshot === undefined ? {} : { blueprint: attemptSnapshot.blueprintPayload }),
  };
};

const acceptedSandboxResponse = (
  sandboxId: string,
  name: string,
  input: {
    readonly registryId: string;
    readonly repository: string;
    readonly tag: string;
  },
) => {
  return {
    sandboxId,
    name,
    status: "queued" as const,
    registryId: input.registryId,
    repository: input.repository,
    tag: input.tag,
  };
};

const parseRequestedPackageIds = (spec: WorkspaceBuildJobRequestPayload): string[] => {
  const requests = spec.tooling?.packages ?? spec.packages ?? [];

  return requests.map((pkg) => {
    return typeof pkg === "string" ? pkg : pkg.id;
  });
};

const parseRequestedOsFamily = (
  spec: WorkspaceBuildJobRequestPayload,
): "auto" | "arch" | "fedora" | "nix" => {
  const targetOs = spec.target?.os ?? spec.os;

  if (targetOs === undefined) {
    return "auto";
  }

  if (typeof targetOs === "string") {
    return targetOs;
  }

  return targetOs.family ?? "auto";
};

const dedupePackageNames = (input: readonly string[]): string[] => {
  const deduped = new Set<string>();

  for (const value of input) {
    const normalized = value.trim();

    if (normalized.length === 0) {
      continue;
    }

    deduped.add(normalized);
  }

  return [...deduped];
};

const standardizeRequestedPackages = async (
  c: Context<AppBindings>,
  spec: WorkspaceBuildJobRequestPayload,
): Promise<{ spec: WorkspaceBuildJobRequestPayload; errors: readonly string[] }> => {
  const requestedPackages = parseRequestedPackageIds(spec);

  if (requestedPackages.length === 0) {
    return {
      spec,
      errors: [],
    };
  }

  const targetOs = parseRequestedOsFamily(spec);

  if (targetOs === "auto") {
    return {
      spec,
      errors: [
        "Package validation requires an explicit target OS. Set spec.os to arch, fedora, or nix for this request.",
      ],
    };
  }

  const standardizedPackageNames: string[] = [];
  const errors: string[] = [];

  for (const requested of requestedPackages) {
    const resolution = await c.get("packageStandardizer").resolvePackage({
      query: requested,
      targetOs,
    });
    const osSupport = resolution.osSupport[targetOs];

    if (!osSupport.supported || osSupport.packageName === undefined) {
      errors.push(
        `Package '${requested}' is not available for ${targetOs}. Resolution status: ${resolution.status}.`,
      );
      continue;
    }

    standardizedPackageNames.push(osSupport.packageName);
  }

  if (errors.length > 0) {
    return {
      spec,
      errors,
    };
  }

  const nextSpec: Record<string, unknown> = {
    ...spec,
    packages: dedupePackageNames(standardizedPackageNames),
  };

  delete nextSpec.tooling;

  return {
    spec: workspaceBuildJobRequestPayloadSchema.parse(nextSpec),
    errors: [],
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
          acceptedSandboxResponse(existingSandbox.id, resolveStoredSandboxName(existingSandbox), {
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
  const packageStandardization = await standardizeRequestedPackages(c, body.spec);

  if (packageStandardization.errors.length > 0) {
    console.error("[sandboxes.create] package standardization failed", {
      sandboxId,
      ownerUserId: body.ownerUserId,
      errors: packageStandardization.errors,
      requestedPackages: parseRequestedPackageIds(body.spec),
      targetOs: parseRequestedOsFamily(body.spec),
    });

    return c.json(
      {
        message: packageStandardization.errors[0],
      },
      400,
    );
  }

  const resolvedSpec = packageStandardization.spec;
  const blueprintPayload = normalizeUserWorkspaceSpec(resolvedSpec);
  const sandboxName =
    body.name === undefined
      ? inferSandboxName({
          repository: body.repository,
          tag: body.tag,
          spec: resolvedSpec,
          fallbackId: sandboxId,
        })
      : sanitizeSandboxName(body.name);

  try {
    const sandbox = await sandboxes.createSandbox({
      id: sandboxId,
      name: sandboxName,
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
      resolvedSpecPayload: resolvedSpec,
      blueprintPayload,
    });

    await workspaceBuildJobs.insertQueuedJob({
      id: jobId,
      runId: attempt.id,
      registryId: body.registryId,
      repository: body.repository,
      tag: body.tag,
      requestPayload: resolvedSpec,
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
            acceptedSandboxResponse(existingSandbox.id, resolveStoredSandboxName(existingSandbox), {
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
    acceptedSandboxResponse(sandboxId, sandboxName, {
      registryId: body.registryId,
      repository: body.repository,
      tag: body.tag,
    }),
    202,
  );
};

export const renameSandbox = async (c: Context<AppBindings>) => {
  const { sandboxId } = c.req.param() as {
    sandboxId: string;
  };
  const body = (
    c.req as typeof c.req & {
      valid(target: "json"): z.infer<typeof renameSandboxRequestSchema>;
    }
  ).valid("json");
  const sandbox = await c.get("sandboxRepository").setSandboxName({
    id: sandboxId,
    name: sanitizeSandboxName(body.name),
  });

  if (sandbox === null) {
    return c.json(
      {
        message: `Sandbox not found: ${sandboxId}`,
      },
      404,
    );
  }

  const response: z.infer<typeof renameSandboxResponseSchema> = {
    sandboxId: sandbox.id,
    name: resolveStoredSandboxName(sandbox),
    updatedAt: sandbox.updatedAt.toISOString(),
  };

  return c.json(response);
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
    return c.json(mapSandboxDetails(sandbox, undefined, undefined, undefined, undefined));
  }

  const attempt = await c.get("sandboxAttemptRepository").getAttemptById(sandbox.latestRunId);
  const attemptSnapshot = await c
    .get("sandboxAttemptRepository")
    .getAttemptSnapshotByRunId(sandbox.latestRunId);
  const latestJob = await c
    .get("workspaceBuildJobRepository")
    .getLatestJobByRunId(sandbox.latestRunId);
  const runtimeInstance = await c
    .get("sandboxRuntimeInstanceRepository")
    .getRuntimeInstanceByRunId(sandbox.latestRunId);

  return c.json(mapSandboxDetails(sandbox, attempt, latestJob, runtimeInstance, attemptSnapshot));
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
