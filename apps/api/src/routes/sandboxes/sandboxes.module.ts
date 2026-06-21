import { randomUUID } from "node:crypto";

import {
  SandboxBadGatewayError,
  SandboxBadRequestError,
  SandboxConflictError,
  SandboxForbiddenError,
  SandboxInternalServerError,
  SandboxNotFoundError,
  SandboxServiceUnavailableError,
  SandboxUnauthorizedError,
  type CreateSandboxHeaders,
  type CreateSandboxRequest,
  type CreateSandboxResponse,
  type GitHubSandboxSourceSelection,
  type ListSandboxAttemptsQuery,
  type ListSandboxAttemptsResponse,
  type ListSandboxEventsQuery,
  type ListSandboxEventsResponse,
  type ListSandboxesQuery,
  type ListSandboxesResponse,
  type RenameSandboxRequest,
  type RenameSandboxResponse,
  type SandboxAttemptSummary,
  type SandboxDetails,
  type SandboxEvent,
  type SandboxEventType,
  type SandboxGatewayHeaders,
  type SandboxSshTarget,
  type SandboxSummary,
} from "@sealant/api-contracts";
import {
  GitHubInstallationRepo,
  GitHubInstallationRepositoryCacheRepo,
  SandboxAttemptRepo,
  SandboxBuildJobRepo,
  SandboxRepo,
  SandboxRuntimeInstanceRepo,
} from "@sealant/db";
import {
  resolveSandboxError,
  resolveSandboxPublishedImage,
  resolveSandboxRuntime,
  resolveSandboxStatus,
  type SandboxSshGatewayConfig,
} from "@sealant/sandboxes";
import {
  GitHubSourceIntegrationService,
  createGitHubInstallationRepositoryAuthRef,
} from "@sealant/source-integrations";
import { newSandboxSchema, type NewSandbox } from "@sealant/validators";
import { Context, Effect, Result } from "effect";

import { env } from "../../runtime-env.js";
import {
  PackageStandardizerService,
  SandboxBuildJobPublisherService,
} from "../../services/control-plane-capabilities.js";

interface SandboxEventDraft {
  readonly sandboxId: string;
  readonly attemptId?: string;
  readonly type: SandboxEventType;
  readonly occurredAt: Date;
  readonly message?: string;
  readonly data?: Record<string, unknown>;
}

type SandboxRepoService = Context.Service.Shape<typeof SandboxRepo>;
type SandboxAttemptRepoService = Context.Service.Shape<typeof SandboxAttemptRepo>;
type SandboxBuildJobRepoService = Context.Service.Shape<typeof SandboxBuildJobRepo>;
type SandboxRuntimeInstanceRepoService = Context.Service.Shape<typeof SandboxRuntimeInstanceRepo>;

type SandboxRecord = NonNullable<
  Effect.Success<ReturnType<SandboxRepoService["getSandboxById"]>>
>;
type SandboxAttemptRecord = NonNullable<
  Effect.Success<ReturnType<SandboxAttemptRepoService["getAttemptById"]>>
>;
type SandboxBuildJobRecord = Effect.Success<
  ReturnType<SandboxBuildJobRepoService["getLatestJobByRunId"]>
>;
type SandboxRuntimeInstanceRecord = Effect.Success<
  ReturnType<SandboxRuntimeInstanceRepoService["getRuntimeInstanceByRunId"]>
>;
type SandboxAttemptSnapshotRecord = Effect.Success<
  ReturnType<SandboxAttemptRepoService["getAttemptSnapshotByRunId"]>
>;
type SandboxRunLinkRecord = Effect.Success<
  ReturnType<SandboxRepoService["listSandboxAttemptLinks"]>
>[number];

const gitHubUnavailableMessage = "GitHub integration is not configured.";

const toErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

const randomId = Effect.sync(() => randomUUID());

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

const isObjectWithCause = (value: unknown): value is { readonly cause: unknown } => {
  return typeof value === "object" && value !== null && "cause" in value;
};

const errorIncludes = (error: unknown, token: string): boolean => {
  if (error instanceof Error && error.message.includes(token)) {
    return true;
  }

  if (isObjectWithCause(error)) {
    return errorIncludes(error.cause, token);
  }

  return false;
};

const isForeignKeyConstraintError = (error: unknown): boolean => {
  return errorIncludes(error, "FOREIGN KEY constraint failed");
};

const isUniqueConstraintError = (error: unknown): boolean => {
  return errorIncludes(error, "UNIQUE constraint failed");
};

const parseSandboxSpec = (spec: unknown) => {
  const parsed = newSandboxSchema.safeParse(spec);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]?.message;
    return Effect.fail(
      new SandboxBadRequestError({
        message: firstIssue ?? "Sandbox spec is invalid.",
      }),
    );
  }

  return Effect.succeed(parsed.data);
};

const resolveSandboxSshGatewayConfig = (): SandboxSshGatewayConfig | undefined => {
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

const readIdempotencyKey = (headers: CreateSandboxHeaders): string | undefined => {
  return headers["idempotency-key"];
};

const readGatewayToken = (headers: SandboxGatewayHeaders): string | undefined => {
  return headers["x-sealant-gateway-token"];
};

const readPrincipalId = (headers: SandboxGatewayHeaders): string | undefined => {
  return headers["x-sealant-principal-id"];
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

  return token.length > 0 ? token : "Sandbox";
};

const deriveSourceRef = (spec: NewSandbox): string | undefined => {
  const ref = spec.sources.sandbox.ref.trim();
  return ref.length > 0 ? ref : undefined;
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

const mapStoredSandboxStatus = (status: SandboxRecord["status"]): SandboxSummary["status"] => {
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

const parseLimit = (input: {
  readonly raw: string | undefined;
  readonly fallback: number;
  readonly max: number;
  readonly name: string;
}) => {
  if (input.raw === undefined) {
    return Effect.succeed(input.fallback);
  }

  const value = Number.parseInt(input.raw, 10);

  if (!Number.isInteger(value) || value < 1 || value > input.max) {
    return Effect.fail(
      new SandboxBadRequestError({
        message: `${input.name} must be an integer between 1 and ${input.max}.`,
      }),
    );
  }

  return Effect.succeed(value);
};

const parseRequestedPackageIds = (spec: NewSandbox): string[] => {
  return spec.tooling.packages.map((pkg) => pkg.id);
};

const parseRequestedOsFamily = (spec: NewSandbox): "auto" | "arch" | "fedora" | "nix" => {
  return spec.target.os.family;
};

const dedupePackageNames = (values: readonly string[]): string[] => {
  const deduped = new Set<string>();

  for (const value of values) {
    const normalized = value.trim();

    if (normalized.length > 0) {
      deduped.add(normalized);
    }
  }

  return [...deduped];
};

const standardizeRequestedPackages = (spec: NewSandbox) => {
  return Effect.gen(function* () {
    const packageStandardizer = yield* PackageStandardizerService;
    const requestedPackages = parseRequestedPackageIds(spec);

    if (requestedPackages.length === 0) {
      const noRequestedErrors: string[] = [];

      return {
        spec,
        errors: noRequestedErrors,
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
    const packageErrors: string[] = [];

    for (const requested of requestedPackages) {
      const resolution = yield* packageStandardizer
        .resolvePackage({
          query: requested,
          targetOs,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SandboxInternalServerError({
                message: toErrorMessage(error, "Package resolution failed."),
              }),
          ),
        );

      const osSupport = resolution.osSupport[targetOs];

      if (!osSupport.supported || osSupport.packageName === undefined) {
        packageErrors.push(
          `Package '${requested}' is not available for ${targetOs}. Resolution status: ${resolution.status}.`,
        );
        continue;
      }

      standardizedPackageNames.push(osSupport.packageName);
    }

    if (packageErrors.length > 0) {
      return {
        spec,
        errors: packageErrors,
      };
    }

    const nextSpec: NewSandbox = {
      ...spec,
      tooling: {
        ...spec.tooling,
        packages: dedupePackageNames(standardizedPackageNames).map((id) => ({ id })),
      },
    };

    const parsedNextSpec = yield* parseSandboxSpec(nextSpec);
    const emptyErrors: string[] = [];

    return {
      spec: parsedNextSpec,
      errors: emptyErrors,
    };
  });
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
}): NewSandbox["sources"]["inputs"][number] => {
  return {
    id: `dotfiles-${input.installationRepositoryId}`,
    kind: "git",
    purpose: "dotfiles",
    provider: "github",
    url: `https://github.com/${input.fullName}.git`,
    ref: input.ref,
    authRef: createGitHubInstallationRepositoryAuthRef(input.installationRepositoryId),
  };
};

const upsertDotfilesSourceInput = (
  spec: NewSandbox,
  dotfilesInput: ReturnType<typeof buildGitHubDotfilesInput>,
) => {
  const nextSpec = structuredClone(spec);
  const nextInputs = nextSpec.sources.inputs
    .filter((input) => {
      return input.purpose !== "dotfiles";
    })
    .concat(dotfilesInput);

  nextSpec.sources = {
    ...nextSpec.sources,
    inputs: nextInputs,
  };

  return parseSandboxSpec(nextSpec);
};

const withInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) => {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new SandboxInternalServerError({
          message: toErrorMessage(error, fallback),
        }),
    ),
  );
};

const resolveGitHubSourceSelection = (input: {
  readonly ownerUserId: string;
  readonly spec: NewSandbox;
  readonly sourceSelection: GitHubSandboxSourceSelection | undefined;
}) => {
  return Effect.gen(function* () {
    if (input.sourceSelection === undefined) {
      return {
        spec: input.spec,
      };
    }

    const gitHubSourceIntegration = yield* GitHubSourceIntegrationService;
    if (!gitHubSourceIntegration.isConfigured()) {
      return yield* new SandboxServiceUnavailableError({ message: gitHubUnavailableMessage });
    }

    const gitHubInstallationRepository = yield* GitHubInstallationRepo;
    const gitHubInstallationRepositoryCacheRepository =
      yield* GitHubInstallationRepositoryCacheRepo;

    const installationRepositoryRecord = yield* withInternalError(
      gitHubInstallationRepositoryCacheRepository.getInstallationRepositoryById(
        input.sourceSelection.installationRepositoryId,
      ),
      "Failed to load GitHub installation repository.",
    );

    if (installationRepositoryRecord === undefined) {
      return yield* new SandboxNotFoundError({
        message: `GitHub installation repository not found: ${input.sourceSelection.installationRepositoryId}`,
      });
    }

    if (installationRepositoryRecord.removedAt !== null) {
      return yield* new SandboxNotFoundError({
        message: `GitHub installation repository ${input.sourceSelection.installationRepositoryId} is no longer available.`,
      });
    }

    if (installationRepositoryRecord.installationId !== input.sourceSelection.installationId) {
      return yield* new SandboxBadRequestError({
        message: "GitHub source selection did not match the selected installation.",
      });
    }

    const installation = yield* withInternalError(
      gitHubInstallationRepository.getInstallationById(input.sourceSelection.installationId),
      "Failed to load GitHub installation.",
    );

    if (installation === undefined) {
      return yield* new SandboxNotFoundError({
        message: `GitHub installation not found: ${input.sourceSelection.installationId}`,
      });
    }

    if (installation.status !== "active") {
      return yield* new SandboxForbiddenError({
        message: `GitHub installation ${installation.id} is not active.`,
      });
    }

    const hasGrant = yield* withInternalError(
      gitHubInstallationRepository.userHasInstallationGrant({
        installationId: installation.id,
        userId: input.ownerUserId,
      }),
      "Failed to verify GitHub installation access.",
    );

    if (!hasGrant) {
      return yield* new SandboxForbiddenError({
        message: `User ${input.ownerUserId} does not have access to GitHub installation ${installation.id}.`,
      });
    }

    const effectiveSpec = cloneSpecForSourceSelection(input.spec);
    const sandboxSource = buildGitHubSandboxSource({
      installationRepositoryId: installationRepositoryRecord.id,
      fullName: installationRepositoryRecord.fullName,
      ref: input.sourceSelection.ref ?? installationRepositoryRecord.defaultBranch,
    });

    effectiveSpec.sources = {
      ...effectiveSpec.sources,
      sandbox: sandboxSource,
    };

    const parsedSpec = yield* parseSandboxSpec(effectiveSpec);

    return {
      repositoryId: installationRepositoryRecord.repositoryId,
      spec: parsedSpec,
    };
  });
};

const resolveGitHubDotfilesSelection = (input: {
  readonly ownerUserId: string;
  readonly spec: NewSandbox;
  readonly dotfilesSelection: GitHubSandboxSourceSelection | undefined;
}) => {
  return Effect.gen(function* () {
    if (input.dotfilesSelection === undefined) {
      return {
        spec: input.spec,
      };
    }

    const gitHubSourceIntegration = yield* GitHubSourceIntegrationService;
    if (!gitHubSourceIntegration.isConfigured()) {
      return yield* new SandboxServiceUnavailableError({ message: gitHubUnavailableMessage });
    }

    const gitHubInstallationRepository = yield* GitHubInstallationRepo;
    const gitHubInstallationRepositoryCacheRepository =
      yield* GitHubInstallationRepositoryCacheRepo;

    const installationRepositoryRecord = yield* withInternalError(
      gitHubInstallationRepositoryCacheRepository.getInstallationRepositoryById(
        input.dotfilesSelection.installationRepositoryId,
      ),
      "Failed to load GitHub installation repository.",
    );

    if (installationRepositoryRecord === undefined) {
      return yield* new SandboxNotFoundError({
        message: `GitHub installation repository not found: ${input.dotfilesSelection.installationRepositoryId}`,
      });
    }

    if (installationRepositoryRecord.removedAt !== null) {
      return yield* new SandboxNotFoundError({
        message: `GitHub installation repository ${input.dotfilesSelection.installationRepositoryId} is no longer available.`,
      });
    }

    if (installationRepositoryRecord.installationId !== input.dotfilesSelection.installationId) {
      return yield* new SandboxBadRequestError({
        message: "Dotfiles GitHub selection did not match the selected installation.",
      });
    }

    const installation = yield* withInternalError(
      gitHubInstallationRepository.getInstallationById(input.dotfilesSelection.installationId),
      "Failed to load GitHub installation.",
    );

    if (installation === undefined) {
      return yield* new SandboxNotFoundError({
        message: `GitHub installation not found: ${input.dotfilesSelection.installationId}`,
      });
    }

    if (installation.status !== "active") {
      return yield* new SandboxForbiddenError({
        message: `GitHub installation ${installation.id} is not active.`,
      });
    }

    const hasGrant = yield* withInternalError(
      gitHubInstallationRepository.userHasInstallationGrant({
        installationId: installation.id,
        userId: input.ownerUserId,
      }),
      "Failed to verify GitHub installation access.",
    );

    if (!hasGrant) {
      return yield* new SandboxForbiddenError({
        message: `User ${input.ownerUserId} does not have access to GitHub installation ${installation.id}.`,
      });
    }

    const dotfilesInput = buildGitHubDotfilesInput({
      installationRepositoryId: installationRepositoryRecord.id,
      fullName: installationRepositoryRecord.fullName,
      ref: input.dotfilesSelection.ref ?? installationRepositoryRecord.defaultBranch,
    });

    const parsedSpec = yield* upsertDotfilesSourceInput(input.spec, dotfilesInput);

    return {
      spec: parsedSpec,
    };
  });
};

const mapSandboxAttemptSummary = (
  link: SandboxRunLinkRecord,
  attempt: SandboxAttemptRecord,
  latestJob: SandboxBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
  sshGatewayConfig: SandboxSshGatewayConfig | undefined,
): SandboxAttemptSummary => {
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

const toEventResponse = (input: SandboxEventDraft): SandboxEvent => {
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

const ensureSandboxForAttempt = (attempt: SandboxAttemptRecord) => {
  return Effect.gen(function* () {
    const sandboxRepository = yield* SandboxRepo;

    const existing = yield* withInternalError(
      sandboxRepository.getSandboxByAttemptId(attempt.id),
      "Failed to load sandbox by attempt id.",
    );

    if (existing !== undefined) {
      return existing;
    }

    const sandbox = yield* withInternalError(
      sandboxRepository.createSandbox({
        id: yield* randomId,
        name: `Sandbox ${attempt.id.slice(0, 8)}`,
        ownerUserId: attempt.ownerUserId,
        ...(attempt.repositoryId === null ? {} : { repositoryId: attempt.repositoryId }),
        ...(attempt.repositoryProfileRevisionId === null
          ? {}
          : { repositoryProfileRevisionId: attempt.repositoryProfileRevisionId }),
        ...(attempt.profileRevisionId === null
          ? {}
          : { profileRevisionId: attempt.profileRevisionId }),
        ...(attempt.requestedByUserId === null
          ? {}
          : { requestedByUserId: attempt.requestedByUserId }),
        status: mapAttemptStatusToSandboxStatus(attempt.status),
      }),
      "Failed to create sandbox for existing attempt.",
    );

    yield* withInternalError(
      sandboxRepository.linkSandboxAttempt({
        sandboxId: sandbox.id,
        attemptId: attempt.id,
        relation: "launch",
      }),
      "Failed to link sandbox attempt.",
    );

    return sandbox;
  });
};

const mapSandboxSummary = (
  sandbox: SandboxRecord,
  attempt: SandboxAttemptRecord | undefined,
  latestJob: SandboxBuildJobRecord,
  runtimeInstance: SandboxRuntimeInstanceRecord,
  sshGatewayConfig: SandboxSshGatewayConfig | undefined,
): SandboxSummary => {
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
): SandboxDetails => {
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
): CreateSandboxResponse => {
  return {
    sandboxId,
    name,
    status: "queued",
    registryId: input.registryId,
    repository: input.repository,
    tag: input.tag,
  };
};

const maybeReturnExistingIdempotentSandbox = (idempotencyKey: string) => {
  return Effect.gen(function* () {
    const sandboxBuildJobs = yield* SandboxBuildJobRepo;
    const sandboxAttempts = yield* SandboxAttemptRepo;

    const existingJob = yield* withInternalError(
      sandboxBuildJobs.getJobByIdempotencyKey(idempotencyKey),
      "Failed to load existing sandbox build job by idempotency key.",
    );

    if (existingJob === undefined || existingJob.runId === null) {
      return undefined;
    }

    const existingRun = yield* withInternalError(
      sandboxAttempts.getAttemptById(existingJob.runId),
      "Failed to load existing sandbox attempt.",
    );

    if (existingRun === undefined) {
      return undefined;
    }

    const existingSandbox = yield* ensureSandboxForAttempt(existingRun);

    return acceptedSandboxResponse(existingSandbox.id, resolveStoredSandboxName(existingSandbox), {
      registryId: existingJob.registryId,
      repository: existingJob.repository,
      tag: existingJob.tag,
    });
  });
};

export const createSandbox = (input: {
  readonly payload: CreateSandboxRequest;
  readonly headers: CreateSandboxHeaders;
}) => {
  return Effect.gen(function* () {
    const body = input.payload;
    const idempotencyKey = readIdempotencyKey(input.headers);

    if (body.registryId !== env.REGISTRY_NAME) {
      return yield* new SandboxNotFoundError({
        message: `Unknown registry: ${body.registryId}`,
      });
    }

    if (idempotencyKey !== undefined) {
      const existing = yield* maybeReturnExistingIdempotentSandbox(idempotencyKey);
      if (existing !== undefined) {
        return existing;
      }
    }

    const parsedSpec = yield* parseSandboxSpec(body.spec);

    const sourceSelectionResult = yield* resolveGitHubSourceSelection({
      ownerUserId: body.ownerUserId,
      spec: parsedSpec,
      sourceSelection: body.sourceSelection,
    });

    const dotfilesSelectionResult = yield* resolveGitHubDotfilesSelection({
      ownerUserId: body.ownerUserId,
      spec: sourceSelectionResult.spec,
      dotfilesSelection: body.dotfilesSelection,
    });

    const sandboxId = yield* randomId;
    const runId = yield* randomId;
    const jobId = yield* randomId;

    const packageStandardization = yield* standardizeRequestedPackages(
      dotfilesSelectionResult.spec,
    );

    if (packageStandardization.errors.length > 0) {
      return yield* new SandboxBadRequestError({
        message: packageStandardization.errors[0] ?? "Package standardization failed.",
      });
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

    const sandboxes = yield* SandboxRepo;
    const sandboxBuildJobs = yield* SandboxBuildJobRepo;
    const sandboxAttempts = yield* SandboxAttemptRepo;

    const persistenceResult = yield* Effect.result(
      Effect.gen(function* () {
        const sandbox = yield* sandboxes.createSandbox({
          id: sandboxId,
          name: sandboxName,
          ownerUserId: body.ownerUserId,
          ...(body.sourceSelection === undefined
            ? {}
            : { repositoryId: sourceSelectionResult.repositoryId }),
          requestedByUserId: body.ownerUserId,
          status: "queued",
        });

        const attempt = yield* sandboxAttempts.createQueuedAttempt({
          id: runId,
          ownerUserId: body.ownerUserId,
          ...(body.sourceSelection === undefined
            ? {}
            : { repositoryId: sourceSelectionResult.repositoryId }),
          triggerType: "api",
          requestedByUserId: body.ownerUserId,
        });

        yield* sandboxes.linkSandboxAttempt({
          sandboxId: sandbox.id,
          attemptId: attempt.id,
          relation: "launch",
        });

        yield* sandboxAttempts.setAttemptSnapshot({
          runId: attempt.id,
          specPayload: resolvedSpec,
        });

        yield* sandboxBuildJobs.insertQueuedJob({
          id: jobId,
          runId: attempt.id,
          registryId: body.registryId,
          repository: body.repository,
          tag: body.tag,
          requestPayload: resolvedSpec,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
      }),
    );

    if (Result.isFailure(persistenceResult)) {
      const persistenceError = persistenceResult.failure;

      if (isForeignKeyConstraintError(persistenceError)) {
        return yield* new SandboxNotFoundError({
          message: `Unknown owner user: ${body.ownerUserId}`,
        });
      }

      if (idempotencyKey !== undefined && isUniqueConstraintError(persistenceError)) {
        const existing = yield* maybeReturnExistingIdempotentSandbox(idempotencyKey);

        if (existing !== undefined) {
          return existing;
        }
      }

      return yield* new SandboxInternalServerError({
        message: toErrorMessage(persistenceError, "Failed to create sandbox."),
      });
    }

    const sandboxBuildJobPublisher = yield* SandboxBuildJobPublisherService;

    yield* Effect.tryPromise({
      try: () =>
        sandboxBuildJobPublisher.publishRequested({
          jobId,
        }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.all(
            [
              sandboxBuildJobs.markJobFailed({
                id: jobId,
                errorCode: "queue_publish_failed",
                errorMessage: toErrorMessage(error, "Failed to enqueue sandbox build job."),
              }),
              sandboxAttempts.markAttemptFailed({
                id: runId,
              }),
              sandboxes.setSandboxStatus({
                id: sandboxId,
                status: "failed",
              }),
            ],
            {
              concurrency: "unbounded",
            },
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Sandbox ${sandboxId} rollback writes failed after queue publish failure; state may be inconsistent.`,
                cause,
              ),
            ),
          );

          return yield* new SandboxBadGatewayError({
            message: `Sandbox ${sandboxId} was recorded but could not be queued.`,
          });
        }),
      ),
    );

    return acceptedSandboxResponse(sandboxId, sandboxName, {
      registryId: body.registryId,
      repository: body.repository,
      tag: body.tag,
    });
  });
};

export const renameSandbox = (input: {
  readonly sandboxId: string;
  readonly payload: RenameSandboxRequest;
}) => {
  return Effect.gen(function* () {
    const sandboxes = yield* SandboxRepo;
    const sandbox = yield* withInternalError(
      sandboxes.setSandboxName({
        id: input.sandboxId,
        name: sanitizeSandboxName(input.payload.name),
      }),
      "Failed to rename sandbox.",
    );

    if (sandbox === null) {
      return yield* new SandboxNotFoundError({
        message: `Sandbox not found: ${input.sandboxId}`,
      });
    }

    return {
      sandboxId: sandbox.id,
      name: resolveStoredSandboxName(sandbox),
      updatedAt: sandbox.updatedAt.toISOString(),
    } satisfies RenameSandboxResponse;
  });
};

export const listSandboxes = (query: ListSandboxesQuery) => {
  return Effect.gen(function* () {
    const sandboxLimit = yield* parseLimit({
      raw: query.limit,
      fallback: 25,
      max: 100,
      name: "limit",
    });

    const effectiveSandboxLimit =
      query.status === undefined ? sandboxLimit : Math.min(sandboxLimit * 4, 100);

    const sandboxes = yield* withInternalError(
      (yield* SandboxRepo).listSandboxes({
        ownerUserId: query.ownerUserId,
        limit: effectiveSandboxLimit,
      }),
      "Failed to list sandboxes.",
    );

    const latestRunIds = sandboxes.flatMap((sandbox) => {
      return sandbox.latestRunId === null ? [] : [sandbox.latestRunId];
    });

    const sandboxAttempts = yield* SandboxAttemptRepo;
    const sandboxBuildJobs = yield* SandboxBuildJobRepo;
    const sandboxRuntimeInstances = yield* SandboxRuntimeInstanceRepo;

    const attempts = yield* withInternalError(
      Effect.forEach(latestRunIds, (runId) =>
        sandboxAttempts.getAttemptById(runId).pipe(
          Effect.map((attempt): readonly [string, SandboxAttemptRecord | undefined] => {
            return [runId, attempt];
          }),
        ),
      ),
      "Failed to load sandbox attempts.",
    );

    const attemptsByRunId = new Map(
      attempts.flatMap(([runId, attempt]) => {
        if (attempt === undefined) {
          return [];
        }

        return [[runId, attempt]];
      }),
    );

    const latestJobsByRunId = yield* withInternalError(
      sandboxBuildJobs.listLatestJobsByRunIds(latestRunIds),
      "Failed to load latest sandbox build jobs.",
    );

    const runtimeInstancesByRunId = yield* withInternalError(
      sandboxRuntimeInstances.listRuntimeInstancesByRunIds(latestRunIds),
      "Failed to load sandbox runtime instances.",
    );

    const sshGatewayConfig = resolveSandboxSshGatewayConfig();

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
      .slice(0, sandboxLimit);

    return {
      items,
    } satisfies ListSandboxesResponse;
  });
};

export const getSandbox = (sandboxId: string) => {
  return Effect.gen(function* () {
    const sandboxRepo = yield* SandboxRepo;
    const sandbox = yield* withInternalError(
      sandboxRepo.getSandboxById(sandboxId),
      "Failed to load sandbox.",
    );

    if (sandbox === undefined) {
      return yield* new SandboxNotFoundError({
        message: `Sandbox not found: ${sandboxId}`,
      });
    }

    const sshGatewayConfig = resolveSandboxSshGatewayConfig();

    if (sandbox.latestRunId === null) {
      return mapSandboxDetails(
        sandbox,
        undefined,
        undefined,
        undefined,
        undefined,
        sshGatewayConfig,
      );
    }

    const sandboxAttemptRepo = yield* SandboxAttemptRepo;
    const sandboxBuildJobRepo = yield* SandboxBuildJobRepo;
    const sandboxRuntimeInstanceRepo = yield* SandboxRuntimeInstanceRepo;

    const attempt = yield* withInternalError(
      sandboxAttemptRepo.getAttemptById(sandbox.latestRunId),
      "Failed to load sandbox attempt.",
    );
    const attemptSnapshot = yield* withInternalError(
      sandboxAttemptRepo.getAttemptSnapshotByRunId(sandbox.latestRunId),
      "Failed to load sandbox attempt snapshot.",
    );
    const latestJob = yield* withInternalError(
      sandboxBuildJobRepo.getLatestJobByRunId(sandbox.latestRunId),
      "Failed to load latest sandbox build job.",
    );
    const runtimeInstance = yield* withInternalError(
      sandboxRuntimeInstanceRepo.getRuntimeInstanceByRunId(sandbox.latestRunId),
      "Failed to load sandbox runtime instance.",
    );

    return mapSandboxDetails(
      sandbox,
      attempt,
      latestJob,
      runtimeInstance,
      attemptSnapshot,
      sshGatewayConfig,
    );
  });
};

export const getSandboxSshTarget = (input: {
  readonly sandboxId: string;
  readonly headers: SandboxGatewayHeaders;
}) => {
  return Effect.gen(function* () {
    const expectedGatewayToken = env.SANDBOX_SSH_GATEWAY_TOKEN?.trim();

    if (expectedGatewayToken === undefined || expectedGatewayToken.length === 0) {
      return yield* new SandboxServiceUnavailableError({
        message: "Sandbox SSH gateway token is not configured.",
      });
    }

    if (readGatewayToken(input.headers) !== expectedGatewayToken) {
      return yield* new SandboxUnauthorizedError({
        message: "Invalid sandbox SSH gateway token.",
      });
    }

    // The gateway token proves *the gateway* is a trusted caller; the principal id scopes *what it may
    // resolve* (gateway-spec §3.4). Per-sandbox authorization lives here at the API, not the daemon.
    const principalId = readPrincipalId(input.headers);

    if (principalId === undefined || principalId.length === 0) {
      return yield* new SandboxUnauthorizedError({
        message: "Missing client principal for sandbox SSH target.",
      });
    }

    const sandbox = yield* withInternalError(
      (yield* SandboxRepo).getSandboxById(input.sandboxId),
      "Failed to load sandbox.",
    );

    if (sandbox === undefined) {
      return yield* new SandboxNotFoundError({
        message: `Sandbox not found: ${input.sandboxId}`,
      });
    }

    // Owner-scoped authorization (ACL extension deferred): the principal must own this sandbox.
    if (sandbox.ownerUserId !== principalId) {
      return yield* new SandboxUnauthorizedError({
        message: "Principal is not authorized for this sandbox.",
      });
    }

    if (sandbox.latestRunId === null) {
      return yield* new SandboxConflictError({
        message: `Sandbox ${input.sandboxId} has no active attempt with runtime metadata.`,
      });
    }

    const runtimeInstance = yield* withInternalError(
      (yield* SandboxRuntimeInstanceRepo).getRuntimeInstanceByRunId(sandbox.latestRunId),
      "Failed to load sandbox runtime instance.",
    );

    if (
      runtimeInstance === undefined ||
      runtimeInstance.endpoint === null ||
      runtimeInstance.adapter === null ||
      runtimeInstance.resourceId === null ||
      runtimeInstance.reference === null ||
      runtimeInstance.status !== "running"
    ) {
      return yield* new SandboxConflictError({
        message: `Sandbox ${input.sandboxId} runtime SSH target is not available.`,
      });
    }

    return {
      sandboxId: sandbox.id,
      attemptId: sandbox.latestRunId,
      runtime: {
        adapter: runtimeInstance.adapter,
        resourceId: runtimeInstance.resourceId,
        reference: runtimeInstance.reference,
        status: runtimeInstance.status,
        endpoint: runtimeInstance.endpoint,
      },
    } satisfies SandboxSshTarget;
  });
};

export const listSandboxAttempts = (input: {
  readonly sandboxId: string;
  readonly query: ListSandboxAttemptsQuery;
}) => {
  return Effect.gen(function* () {
    const limit = yield* parseLimit({
      raw: input.query.limit,
      fallback: 25,
      max: 100,
      name: "limit",
    });

    const sandboxRepo = yield* SandboxRepo;
    const sandbox = yield* withInternalError(
      sandboxRepo.getSandboxById(input.sandboxId),
      "Failed to load sandbox.",
    );

    if (sandbox === undefined) {
      return yield* new SandboxNotFoundError({
        message: `Sandbox not found: ${input.sandboxId}`,
      });
    }

    const links = yield* withInternalError(
      sandboxRepo.listSandboxAttemptLinks(sandbox.id, limit),
      "Failed to load sandbox attempt links.",
    );
    const runIds = links.map((link) => link.runId);

    const sandboxAttemptRepo = yield* SandboxAttemptRepo;
    const sandboxBuildJobRepo = yield* SandboxBuildJobRepo;
    const sandboxRuntimeInstanceRepo = yield* SandboxRuntimeInstanceRepo;

    const attempts = yield* withInternalError(
      Effect.forEach(runIds, (runId) =>
        sandboxAttemptRepo.getAttemptById(runId).pipe(
          Effect.map((attempt): readonly [string, SandboxAttemptRecord | undefined] => {
            return [runId, attempt];
          }),
        ),
      ),
      "Failed to load sandbox attempts.",
    );
    const attemptsByRunId = new Map(
      attempts.flatMap(([runId, attempt]) => {
        if (attempt === undefined) {
          return [];
        }

        return [[runId, attempt]];
      }),
    );

    const latestJobsByRunId = yield* withInternalError(
      sandboxBuildJobRepo.listLatestJobsByRunIds(runIds),
      "Failed to load latest sandbox build jobs.",
    );
    const runtimeInstancesByRunId = yield* withInternalError(
      sandboxRuntimeInstanceRepo.listRuntimeInstancesByRunIds(runIds),
      "Failed to load sandbox runtime instances.",
    );
    const sshGatewayConfig = resolveSandboxSshGatewayConfig();

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

    return {
      items,
    } satisfies ListSandboxAttemptsResponse;
  });
};

export const listSandboxEvents = (input: {
  readonly sandboxId: string;
  readonly query: ListSandboxEventsQuery;
}) => {
  return Effect.gen(function* () {
    const limit = yield* parseLimit({
      raw: input.query.limit,
      fallback: 50,
      max: 200,
      name: "limit",
    });

    const sandboxRepo = yield* SandboxRepo;
    const sandbox = yield* withInternalError(
      sandboxRepo.getSandboxById(input.sandboxId),
      "Failed to load sandbox.",
    );

    if (sandbox === undefined) {
      return yield* new SandboxNotFoundError({
        message: `Sandbox not found: ${input.sandboxId}`,
      });
    }

    const links = yield* withInternalError(
      sandboxRepo.listSandboxAttemptLinks(sandbox.id, limit),
      "Failed to load sandbox attempt links.",
    );
    const runIds = links.map((link) => link.runId);

    const sandboxAttemptRepo = yield* SandboxAttemptRepo;
    const sandboxBuildJobRepo = yield* SandboxBuildJobRepo;
    const sandboxRuntimeInstanceRepo = yield* SandboxRuntimeInstanceRepo;

    const attempts = yield* withInternalError(
      Effect.forEach(runIds, (runId) =>
        sandboxAttemptRepo.getAttemptById(runId).pipe(
          Effect.map((attempt): readonly [string, SandboxAttemptRecord | undefined] => {
            return [runId, attempt];
          }),
        ),
      ),
      "Failed to load sandbox attempts.",
    );
    const attemptsByRunId = new Map(
      attempts.flatMap(([runId, attempt]) => {
        if (attempt === undefined) {
          return [];
        }

        return [[runId, attempt]];
      }),
    );
    const latestJobsByRunId = yield* withInternalError(
      sandboxBuildJobRepo.listLatestJobsByRunIds(runIds),
      "Failed to load latest sandbox build jobs.",
    );
    const runtimeInstancesByRunId = yield* withInternalError(
      sandboxRuntimeInstanceRepo.listRuntimeInstancesByRunIds(runIds),
      "Failed to load sandbox runtime instances.",
    );
    const sshGatewayConfig = resolveSandboxSshGatewayConfig();

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
          ...(attempt.cancelReason === null
            ? {}
            : { data: { cancelReason: attempt.cancelReason } }),
        });
      }
    }

    const items = [...events]
      .toSorted((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
      .slice(0, limit)
      .map(toEventResponse);

    return {
      items,
    } satisfies ListSandboxEventsResponse;
  });
};
