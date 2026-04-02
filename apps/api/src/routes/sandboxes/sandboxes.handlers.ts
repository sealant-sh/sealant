import type {
  SandboxAttemptRepository,
  SandboxRepository,
  SandboxRuntimeInstanceRepository,
  NewSandbox,
  SandboxBuildJobRepository,
} from "@sealant/db";
import {
  resolveSandboxError,
  resolveSandboxPublishedImage,
  resolveSandboxRuntime,
  resolveSandboxStatus,
  type SandboxSshGatewayConfig,
} from "@sealant/sandboxes";
import { createGitHubInstallationRepositoryAuthRef } from "@sealant/source-integrations";
import {
  createSandboxRequestSchema,
  listSandboxAttemptsQuerySchema,
  listSandboxEventsQuerySchema,
  listSandboxesQuerySchema,
  newSandboxSchema,
  renameSandboxRequestSchema,
  renameSandboxResponseSchema,
  sandboxAttemptSummarySchema,
  sandboxDetailsSchema,
  sandboxEventSchema,
  sandboxSshTargetSchema,
  sandboxSummarySchema,
} from "@sealant/validators";
import type { AppEnv } from "@sealant/validators/env";
import type { Context } from "hono";
import type { z } from "zod";

import type { AppBindings } from "../../lib/types.js";

const getRuntime = (c: Context<AppBindings>) => {
  return c.get("runtime");
};

type SandboxAttemptRecord = NonNullable<
  Awaited<ReturnType<SandboxAttemptRepository["getAttemptById"]>>
>;
type SandboxRecord = NonNullable<Awaited<ReturnType<SandboxRepository["getSandboxById"]>>>;
type SandboxBuildJobRecord = Awaited<ReturnType<SandboxBuildJobRepository["getLatestJobByRunId"]>>;
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
type GitHubSourceSelection = z.infer<typeof createSandboxRequestSchema>["sourceSelection"];
type GitHubDotfilesSelection = z.infer<typeof createSandboxRequestSchema>["dotfilesSelection"];

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
  return error instanceof Error ? error.message : "Failed to enqueue sandbox build job.";
};

const readGatewayToken = (c: Context<AppBindings>): string | undefined => {
  // Dedicated header used only for gateway -> API internal calls.
  const token = c.req.header("x-sealant-gateway-token")?.trim();

  if (token === undefined || token.length === 0) {
    return undefined;
  }

  return token;
};

const resolveSandboxSshGatewayConfig = (env: AppEnv): SandboxSshGatewayConfig | undefined => {
  // Optional user-facing endpoint rewrite configuration.
  // When unset, clients receive raw runtime endpoint values.
  const host = env.SANDBOX_SSH_GATEWAY_HOST?.trim();

  if (host === undefined || host.length === 0) {
    return undefined;
  }

  return {
    host,
    ...(env.SANDBOX_SSH_GATEWAY_PORT === undefined ? {} : { port: env.SANDBOX_SSH_GATEWAY_PORT }),
    ...(env.SANDBOX_SSH_GATEWAY_USERNAME_PREFIX === undefined
      ? {}
      : { usernamePrefix: env.SANDBOX_SSH_GATEWAY_USERNAME_PREFIX }),
  };
};

const isForeignKeyConstraintError = (error: unknown): boolean => {
  return error instanceof Error && error.message.includes("FOREIGN KEY constraint failed");
};

const isUniqueConstraintError = (error: unknown): boolean => {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
};

const gitHubUnavailableResponse = (c: Context<AppBindings>) => {
  return c.json(
    {
      message: "GitHub integration is not configured.",
    },
    503,
  );
};

const cloneSpecForSourceSelection = (spec: NewSandbox): NewSandbox => {
  return structuredClone(spec);
};

const buildGitHubSandboxSource = (input: {
  readonly installationRepositoryId: string;
  readonly fullName: string;
  readonly ref: string;
}): NewSandbox["sources"]["sandbox"] => {
  return {
    kind: "git",
    provider: "github",
    url: `https://github.com/${input.fullName}.git`,
    ref: input.ref,
    authRef: createGitHubInstallationRepositoryAuthRef(input.installationRepositoryId),
  };
};

const buildGitHubDotfilesInput = (input: {
  readonly installationRepositoryId: string;
  readonly fullName: string;
  readonly ref: string;
}) => {
  return {
    id: `dotfiles-${input.installationRepositoryId}`,
    kind: "git" as const,
    purpose: "dotfiles" as const,
    provider: "github" as const,
    url: `https://github.com/${input.fullName}.git`,
    ref: input.ref,
    authRef: createGitHubInstallationRepositoryAuthRef(input.installationRepositoryId),
  };
};

const upsertDotfilesSourceInput = (
  spec: NewSandbox,
  dotfilesInput: ReturnType<typeof buildGitHubDotfilesInput>,
): NewSandbox => {
  const nextSpec = structuredClone(spec);
  const existingInputs = nextSpec.sources.inputs;
  const nextInputs = existingInputs
    .filter((input) => {
      return input.purpose !== "dotfiles";
    })
    .concat(dotfilesInput);

  nextSpec.sources = {
    ...nextSpec.sources,
    inputs: nextInputs,
  };

  return newSandboxSchema.parse(nextSpec);
};

const resolveGitHubSourceSelection = async (
  c: Context<AppBindings>,
  input: {
    readonly ownerUserId: string;
    readonly spec: NewSandbox;
    readonly sourceSelection: GitHubSourceSelection;
  },
): Promise<
  | {
      readonly repositoryId?: string;
      readonly spec: NewSandbox;
    }
  | { readonly response: Response }
> => {
  const runtime = getRuntime(c);
  const sourceSelection = input.sourceSelection;

  if (sourceSelection === undefined) {
    return {
      spec: input.spec,
    };
  }

  const gitHubInstallationRepository = runtime.gitHubInstallationRepository;
  const gitHubInstallationRepositoryCacheRepository =
    runtime.gitHubInstallationRepositoryCacheRepository;

  if (
    gitHubInstallationRepository === undefined ||
    gitHubInstallationRepositoryCacheRepository === undefined
  ) {
    return { response: gitHubUnavailableResponse(c) };
  }

  const installationRepositoryRecord =
    await gitHubInstallationRepositoryCacheRepository.getInstallationRepositoryById(
      sourceSelection.installationRepositoryId,
    );

  if (installationRepositoryRecord === undefined) {
    return {
      response: c.json(
        {
          message: `GitHub installation repository not found: ${sourceSelection.installationRepositoryId}`,
        },
        404,
      ),
    };
  }

  if (installationRepositoryRecord.removedAt !== null) {
    return {
      response: c.json(
        {
          message: `GitHub installation repository ${sourceSelection.installationRepositoryId} is no longer available.`,
        },
        404,
      ),
    };
  }

  if (installationRepositoryRecord.installationId !== sourceSelection.installationId) {
    return {
      response: c.json(
        {
          message: "GitHub source selection did not match the selected installation.",
        },
        400,
      ),
    };
  }

  const installation = await gitHubInstallationRepository.getInstallationById(
    sourceSelection.installationId,
  );

  if (installation === undefined) {
    return {
      response: c.json(
        {
          message: `GitHub installation not found: ${sourceSelection.installationId}`,
        },
        404,
      ),
    };
  }

  if (installation.status !== "active") {
    return {
      response: c.json(
        {
          message: `GitHub installation ${installation.id} is not active.`,
        },
        403,
      ),
    };
  }

  const hasGrant = await gitHubInstallationRepository.userHasInstallationGrant({
    installationId: installation.id,
    userId: input.ownerUserId,
  });

  if (!hasGrant) {
    return {
      response: c.json(
        {
          message: `User ${input.ownerUserId} does not have access to GitHub installation ${installation.id}.`,
        },
        403,
      ),
    };
  }

  const effectiveSpec = cloneSpecForSourceSelection(input.spec);
  const sandboxSource = buildGitHubSandboxSource({
    installationRepositoryId: installationRepositoryRecord.id,
    fullName: installationRepositoryRecord.fullName,
    ref: sourceSelection.ref ?? installationRepositoryRecord.defaultBranch,
  });

  effectiveSpec.sources = {
    ...effectiveSpec.sources,
    sandbox: sandboxSource,
  };

  return {
    repositoryId: installationRepositoryRecord.repositoryId,
    spec: newSandboxSchema.parse(effectiveSpec),
  };
};

const resolveGitHubDotfilesSelection = async (
  c: Context<AppBindings>,
  input: {
    readonly ownerUserId: string;
    readonly spec: NewSandbox;
    readonly dotfilesSelection: GitHubDotfilesSelection;
  },
): Promise<
  | {
      readonly spec: NewSandbox;
    }
  | { readonly response: Response }
> => {
  const runtime = getRuntime(c);
  const dotfilesSelection = input.dotfilesSelection;

  if (dotfilesSelection === undefined) {
    return {
      spec: input.spec,
    };
  }

  const gitHubInstallationRepository = runtime.gitHubInstallationRepository;
  const gitHubInstallationRepositoryCacheRepository =
    runtime.gitHubInstallationRepositoryCacheRepository;

  if (
    gitHubInstallationRepository === undefined ||
    gitHubInstallationRepositoryCacheRepository === undefined
  ) {
    return { response: gitHubUnavailableResponse(c) };
  }

  const installationRepositoryRecord =
    await gitHubInstallationRepositoryCacheRepository.getInstallationRepositoryById(
      dotfilesSelection.installationRepositoryId,
    );

  if (installationRepositoryRecord === undefined) {
    return {
      response: c.json(
        {
          message: `GitHub installation repository not found: ${dotfilesSelection.installationRepositoryId}`,
        },
        404,
      ),
    };
  }

  if (installationRepositoryRecord.removedAt !== null) {
    return {
      response: c.json(
        {
          message: `GitHub installation repository ${dotfilesSelection.installationRepositoryId} is no longer available.`,
        },
        404,
      ),
    };
  }

  if (installationRepositoryRecord.installationId !== dotfilesSelection.installationId) {
    return {
      response: c.json(
        {
          message: "Dotfiles GitHub selection did not match the selected installation.",
        },
        400,
      ),
    };
  }

  const installation = await gitHubInstallationRepository.getInstallationById(
    dotfilesSelection.installationId,
  );

  if (installation === undefined) {
    return {
      response: c.json(
        {
          message: `GitHub installation not found: ${dotfilesSelection.installationId}`,
        },
        404,
      ),
    };
  }

  if (installation.status !== "active") {
    return {
      response: c.json(
        {
          message: `GitHub installation ${installation.id} is not active.`,
        },
        403,
      ),
    };
  }

  const hasGrant = await gitHubInstallationRepository.userHasInstallationGrant({
    installationId: installation.id,
    userId: input.ownerUserId,
  });

  if (!hasGrant) {
    return {
      response: c.json(
        {
          message: `User ${input.ownerUserId} does not have access to GitHub installation ${installation.id}.`,
        },
        403,
      ),
    };
  }

  const dotfilesInput = buildGitHubDotfilesInput({
    installationRepositoryId: installationRepositoryRecord.id,
    fullName: installationRepositoryRecord.fullName,
    ref: dotfilesSelection.ref ?? installationRepositoryRecord.defaultBranch,
  });

  return {
    spec: upsertDotfilesSourceInput(input.spec, dotfilesInput),
  };
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

const deriveSourceRef = (spec: NewSandbox): string | undefined => {
  const ref = spec.sources.sandbox.ref.trim();

  if (ref.length === 0) {
    return undefined;
  }

  return ref;
};

const inferSandboxName = (input: {
  readonly repository: string;
  readonly tag: string;
  readonly spec: NewSandbox;
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
  latestJob: SandboxBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
  sshGatewayConfig: SandboxSshGatewayConfig | undefined,
): z.infer<typeof sandboxAttemptSummarySchema> => {
  const runtime = resolveSandboxRuntime(runtimeInstance, {
    sandboxId: link.sandboxId,
    ...(sshGatewayConfig === undefined ? {} : { sshGateway: sshGatewayConfig }),
  });
  const publishedImage = resolveSandboxPublishedImage(latestJob);
  const error = resolveSandboxError(latestJob);
  const startedAt = attempt.startedAt ?? latestJob?.startedAt;
  const finishedAt = attempt.finishedAt ?? latestJob?.finishedAt;

  return {
    attemptId: attempt.id,
    relation: link.relation,
    status: resolveSandboxStatus({
      attempt,
      ...(latestJob === undefined ? {} : { latestJob }),
      ...(runtimeInstance === undefined ? {} : { runtimeInstance }),
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
  idGenerator: AppBindings["Variables"]["runtime"]["idGenerator"],
): Promise<SandboxRecord> => {
  const existing = await sandboxRepository.getSandboxByAttemptId(attempt.id);

  if (existing !== undefined) {
    return existing;
  }

  const sandbox = await sandboxRepository.createSandbox({
    id: idGenerator.randomUuid(),
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
  latestJob: SandboxBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
  sshGatewayConfig: SandboxSshGatewayConfig | undefined,
): z.infer<typeof sandboxSummarySchema> => {
  const runtime = resolveSandboxRuntime(runtimeInstance, {
    sandboxId: sandbox.id,
    ...(sshGatewayConfig === undefined ? {} : { sshGateway: sshGatewayConfig }),
  });
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
          ...(latestJob === undefined ? {} : { latestJob }),
          ...(runtimeInstance === undefined ? {} : { runtimeInstance }),
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
  latestJob: SandboxBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
  attemptSnapshot: SandboxAttemptSnapshotRecord,
  sshGatewayConfig: SandboxSshGatewayConfig | undefined,
): z.infer<typeof sandboxDetailsSchema> => {
  const summary = mapSandboxSummary(sandbox, attempt, latestJob, runtimeInstance, sshGatewayConfig);
  const userSpec = attemptSnapshot?.userSpecPayload ?? latestJob?.requestPayload;

  return {
    ...summary,
    ...(userSpec === undefined ? {} : { spec: userSpec }),
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

const parseRequestedPackageIds = (spec: NewSandbox): string[] => {
  const requests = spec.tooling.packages;

  return requests.map((pkg) => {
    return pkg.id;
  });
};

const parseRequestedOsFamily = (spec: NewSandbox): "auto" | "arch" | "fedora" | "nix" => {
  return spec.target.os.family;
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
  spec: NewSandbox,
): Promise<{ spec: NewSandbox; errors: readonly string[] }> => {
  const runtime = getRuntime(c);
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
        "Package validation requires an explicit target OS. Set spec.target.os.family to arch, fedora, or nix for this request.",
      ],
    };
  }

  const standardizedPackageNames: string[] = [];
  const errors: string[] = [];

  for (const requested of requestedPackages) {
    const resolution = await runtime.packageStandardizer.resolvePackage({
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

  const nextSpec: NewSandbox = {
    ...spec,
    tooling: {
      ...spec.tooling,
      packages: dedupePackageNames(standardizedPackageNames).map((id) => ({ id })),
    },
  };

  return {
    spec: newSandboxSchema.parse(nextSpec),
    errors: [],
  };
};

export const createSandbox = async (c: Context<AppBindings>) => {
  const runtime = getRuntime(c);
  const body = (
    c.req as typeof c.req & {
      valid(target: "json"): z.infer<typeof createSandboxRequestSchema>;
    }
  ).valid("json");
  const env = runtime.env;

  if (body.registryId !== env.REGISTRY_NAME) {
    return c.json(
      {
        message: `Unknown registry: ${body.registryId}`,
      },
      404,
    );
  }

  const idempotencyKey = readIdempotencyKey(c);
  const sandboxes = runtime.sandboxRepository;
  const sandboxBuildJobs = runtime.sandboxBuildJobRepository;
  const sandboxAttempts = runtime.sandboxAttemptRepository;

  if (idempotencyKey !== undefined) {
    const existingJob = await sandboxBuildJobs.getJobByIdempotencyKey(idempotencyKey);

    if (existingJob !== undefined && existingJob.runId !== null) {
      const existingRun = await sandboxAttempts.getAttemptById(existingJob.runId);

      if (existingRun !== undefined) {
        const existingSandbox = await ensureSandboxForAttempt(
          sandboxes,
          existingRun,
          runtime.idGenerator,
        );

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

  const sourceSelectionResult = await resolveGitHubSourceSelection(c, {
    ownerUserId: body.ownerUserId,
    spec: body.spec,
    sourceSelection: body.sourceSelection,
  });

  if ("response" in sourceSelectionResult) {
    return sourceSelectionResult.response;
  }

  const dotfilesSelectionResult = await resolveGitHubDotfilesSelection(c, {
    ownerUserId: body.ownerUserId,
    spec: sourceSelectionResult.spec,
    dotfilesSelection: body.dotfilesSelection,
  });

  if ("response" in dotfilesSelectionResult) {
    return dotfilesSelectionResult.response;
  }

  const sandboxId = runtime.idGenerator.randomUuid();
  const runId = runtime.idGenerator.randomUuid();
  const jobId = runtime.idGenerator.randomUuid();
  const packageStandardization = await standardizeRequestedPackages(
    c,
    dotfilesSelectionResult.spec,
  );

  if (packageStandardization.errors.length > 0) {
    runtime.logger.error("[sandboxes.create] package standardization failed", {
      sandboxId,
      ownerUserId: body.ownerUserId,
      errors: packageStandardization.errors,
      requestedPackages: parseRequestedPackageIds(dotfilesSelectionResult.spec),
      targetOs: parseRequestedOsFamily(dotfilesSelectionResult.spec),
    });

    return c.json(
      {
        message: packageStandardization.errors[0],
      },
      400,
    );
  }

  const resolvedSpec = packageStandardization.spec;
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
      ...(body.sourceSelection === undefined
        ? {}
        : { repositoryId: sourceSelectionResult.repositoryId }),
      requestedByUserId: body.ownerUserId,
      status: "queued",
    });

    const attempt = await sandboxAttempts.createQueuedAttempt({
      id: runId,
      ownerUserId: body.ownerUserId,
      ...(body.sourceSelection === undefined
        ? {}
        : { repositoryId: sourceSelectionResult.repositoryId }),
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
      specPayload: resolvedSpec,
    });

    await sandboxBuildJobs.insertQueuedJob({
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
      const existingJob = await sandboxBuildJobs.getJobByIdempotencyKey(idempotencyKey);

      if (existingJob !== undefined && existingJob.runId !== null) {
        const existingRun = await sandboxAttempts.getAttemptById(existingJob.runId);

        if (existingRun !== undefined) {
          const existingSandbox = await ensureSandboxForAttempt(
            sandboxes,
            existingRun,
            runtime.idGenerator,
          );

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
    await runtime.sandboxBuildJobPublisher.publishRequested({
      jobId,
    });
  } catch (error) {
    await Promise.all([
      sandboxBuildJobs.markJobFailed({
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
  const runtime = getRuntime(c);
  const { sandboxId } = c.req.param() as {
    sandboxId: string;
  };
  const body = (
    c.req as typeof c.req & {
      valid(target: "json"): z.infer<typeof renameSandboxRequestSchema>;
    }
  ).valid("json");
  const sandbox = await runtime.sandboxRepository.setSandboxName({
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
  const runtime = getRuntime(c);
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): z.infer<typeof listSandboxesQuerySchema>;
    }
  ).valid("query");

  const sandboxLimit = query.status === undefined ? query.limit : Math.min(query.limit * 4, 100);
  const sandboxes = await runtime.sandboxRepository.listSandboxes({
    ownerUserId: query.ownerUserId,
    limit: sandboxLimit,
  });
  const latestRunIds = sandboxes.flatMap((sandbox) => {
    return sandbox.latestRunId === null ? [] : [sandbox.latestRunId];
  });
  const attempts = await Promise.all(
    latestRunIds.map(async (runId) => {
      return [runId, await runtime.sandboxAttemptRepository.getAttemptById(runId)] as const;
    }),
  );
  const attemptsByRunId = new Map(
    attempts.flatMap(([runId, attempt]) => {
      return attempt === undefined ? [] : [[runId, attempt] as const];
    }),
  );
  const latestJobsByRunId =
    await runtime.sandboxBuildJobRepository.listLatestJobsByRunIds(latestRunIds);
  const runtimeInstancesByRunId =
    await runtime.sandboxRuntimeInstanceRepository.listRuntimeInstancesByRunIds(latestRunIds);
  const sshGatewayConfig = resolveSandboxSshGatewayConfig(runtime.env);

  const items = sandboxes
    .map((sandbox) => {
      const runId = sandbox.latestRunId ?? undefined;

      return mapSandboxSummary(
        sandbox,
        runId === undefined ? undefined : attemptsByRunId.get(runId),
        runId === undefined ? undefined : latestJobsByRunId.get(runId),
        runId === undefined ? undefined : runtimeInstancesByRunId.get(runId),
        sshGatewayConfig,
      );
    })
    .filter((item) => (query.status === undefined ? true : item.status === query.status))
    .slice(0, query.limit);

  return c.json({
    items,
  });
};

export const getSandbox = async (c: Context<AppBindings>) => {
  const runtime = getRuntime(c);
  const { sandboxId } = c.req.param() as {
    sandboxId: string;
  };
  const sandbox = await runtime.sandboxRepository.getSandboxById(sandboxId);

  if (sandbox === undefined) {
    return c.json(
      {
        message: `Sandbox not found: ${sandboxId}`,
      },
      404,
    );
  }

  const sshGatewayConfig = resolveSandboxSshGatewayConfig(runtime.env);

  if (sandbox.latestRunId === null) {
    return c.json(
      mapSandboxDetails(sandbox, undefined, undefined, undefined, undefined, sshGatewayConfig),
    );
  }

  const attempt = await runtime.sandboxAttemptRepository.getAttemptById(sandbox.latestRunId);
  const attemptSnapshot = await runtime.sandboxAttemptRepository.getAttemptSnapshotByRunId(
    sandbox.latestRunId,
  );
  const latestJob = await runtime.sandboxBuildJobRepository.getLatestJobByRunId(
    sandbox.latestRunId,
  );
  const runtimeInstance = await runtime.sandboxRuntimeInstanceRepository.getRuntimeInstanceByRunId(
    sandbox.latestRunId,
  );

  return c.json(
    mapSandboxDetails(
      sandbox,
      attempt,
      latestJob,
      runtimeInstance,
      attemptSnapshot,
      sshGatewayConfig,
    ),
  );
};

export const getSandboxSshTarget = async (c: Context<AppBindings>) => {
  const runtime = getRuntime(c);
  const { sandboxId } = c.req.param() as {
    sandboxId: string;
  };
  const expectedGatewayToken = runtime.env.SANDBOX_SSH_GATEWAY_TOKEN?.trim();

  // The ssh-target route is intentionally private. It should only be callable by
  // a trusted gateway process, not by regular browser/API clients.
  if (expectedGatewayToken === undefined || expectedGatewayToken.length === 0) {
    return c.json(
      {
        message: "Sandbox SSH gateway token is not configured.",
      },
      503,
    );
  }

  if (readGatewayToken(c) !== expectedGatewayToken) {
    return c.json(
      {
        message: "Invalid sandbox SSH gateway token.",
      },
      401,
    );
  }

  const sandbox = await runtime.sandboxRepository.getSandboxById(sandboxId);

  if (sandbox === undefined) {
    return c.json(
      {
        message: `Sandbox not found: ${sandboxId}`,
      },
      404,
    );
  }

  if (sandbox.latestRunId === null) {
    return c.json(
      {
        message: `Sandbox ${sandboxId} has no active attempt with runtime metadata.`,
      },
      409,
    );
  }

  const runtimeInstance = await runtime.sandboxRuntimeInstanceRepository.getRuntimeInstanceByRunId(
    sandbox.latestRunId,
  );

  if (
    runtimeInstance === undefined ||
    runtimeInstance.endpoint === null ||
    runtimeInstance.adapter === null ||
    runtimeInstance.resourceId === null ||
    runtimeInstance.reference === null ||
    runtimeInstance.status !== "running"
  ) {
    // Gateway can only route to running runtimes with full endpoint metadata.
    return c.json(
      {
        message: `Sandbox ${sandboxId} runtime SSH target is not available.`,
      },
      409,
    );
  }

  const response: z.infer<typeof sandboxSshTargetSchema> = {
    // Return raw internal runtime endpoint here; gateway performs the final SSH hop.
    // User-facing API routes can still expose rewritten public gateway endpoints.
    sandboxId: sandbox.id,
    attemptId: sandbox.latestRunId,
    runtime: {
      adapter: runtimeInstance.adapter,
      resourceId: runtimeInstance.resourceId,
      reference: runtimeInstance.reference,
      status: runtimeInstance.status,
      endpoint: runtimeInstance.endpoint,
    },
  };

  return c.json(response);
};

export const listSandboxAttempts = async (c: Context<AppBindings>) => {
  const runtime = getRuntime(c);
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): z.infer<typeof listSandboxAttemptsQuerySchema>;
    }
  ).valid("query");
  const { sandboxId } = c.req.param() as {
    sandboxId: string;
  };
  const sandbox = await runtime.sandboxRepository.getSandboxById(sandboxId);

  if (sandbox === undefined) {
    return c.json(
      {
        message: `Sandbox not found: ${sandboxId}`,
      },
      404,
    );
  }

  const links = await runtime.sandboxRepository.listSandboxAttemptLinks(sandbox.id, query.limit);
  const runIds = links.map((link) => link.runId);
  const attempts = await Promise.all(
    runIds.map(async (runId) => {
      return [runId, await runtime.sandboxAttemptRepository.getAttemptById(runId)] as const;
    }),
  );
  const attemptsByRunId = new Map(
    attempts.flatMap(([runId, attempt]) => {
      return attempt === undefined ? [] : [[runId, attempt] as const];
    }),
  );
  const latestJobsByRunId = await runtime.sandboxBuildJobRepository.listLatestJobsByRunIds(runIds);
  const runtimeInstancesByRunId =
    await runtime.sandboxRuntimeInstanceRepository.listRuntimeInstancesByRunIds(runIds);
  const sshGatewayConfig = resolveSandboxSshGatewayConfig(runtime.env);

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
        sshGatewayConfig,
      ),
    ];
  });

  return c.json({
    items,
  });
};

export const listSandboxEvents = async (c: Context<AppBindings>) => {
  const runtime = getRuntime(c);
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): z.infer<typeof listSandboxEventsQuerySchema>;
    }
  ).valid("query");
  const { sandboxId } = c.req.param() as {
    sandboxId: string;
  };
  const sandbox = await runtime.sandboxRepository.getSandboxById(sandboxId);

  if (sandbox === undefined) {
    return c.json(
      {
        message: `Sandbox not found: ${sandboxId}`,
      },
      404,
    );
  }

  const links = await runtime.sandboxRepository.listSandboxAttemptLinks(sandbox.id, query.limit);
  const runIds = links.map((link) => link.runId);
  const attempts = await Promise.all(
    runIds.map(async (runId) => {
      return [runId, await runtime.sandboxAttemptRepository.getAttemptById(runId)] as const;
    }),
  );
  const attemptsByRunId = new Map(
    attempts.flatMap(([runId, attempt]) => {
      return attempt === undefined ? [] : [[runId, attempt] as const];
    }),
  );
  const latestJobsByRunId = await runtime.sandboxBuildJobRepository.listLatestJobsByRunIds(runIds);
  const runtimeInstancesByRunId =
    await runtime.sandboxRuntimeInstanceRepository.listRuntimeInstancesByRunIds(runIds);
  const sshGatewayConfig = resolveSandboxSshGatewayConfig(runtime.env);

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
    const runtimeEndpoint = resolveSandboxRuntime(runtimeInstance, {
      sandboxId: sandbox.id,
      ...(sshGatewayConfig === undefined ? {} : { sshGateway: sshGatewayConfig }),
    })?.endpoint;

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
        message: "Sandbox image published.",
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
          ...(runtimeEndpoint === undefined ? {} : { endpoint: runtimeEndpoint }),
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
    .toSorted((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .slice(0, query.limit)
    .map(toEventResponse);

  return c.json({
    items,
  });
};
