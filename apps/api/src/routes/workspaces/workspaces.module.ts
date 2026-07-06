import { randomUUID, timingSafeEqual } from "node:crypto";

import {
  WorkspaceBadGatewayError,
  WorkspaceBadRequestError,
  WorkspaceConflictError,
  WorkspaceForbiddenError,
  WorkspaceInternalServerError,
  WorkspaceNotFoundError,
  WorkspaceServiceUnavailableError,
  WorkspaceUnauthorizedError,
  type CreateWorkspaceHeaders,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResponse,
  type GitHubWorkspaceSourceSelection,
  type ListWorkspaceAttemptsQuery,
  type ListWorkspaceAttemptsResponse,
  type ListWorkspaceEventsQuery,
  type ListWorkspaceEventsResponse,
  type ListWorkspacesQuery,
  type ListWorkspacesResponse,
  type RenameWorkspaceRequest,
  type RenameWorkspaceResponse,
  execRunHarnessId,
  type ExecWorkspaceRequest,
  type WorkspaceAttemptSummary,
  type WorkspaceDetails,
  type WorkspaceEvent,
  type WorkspaceEventType,
  type WorkspaceGatewayHeaders,
  type WorkspaceSshTarget,
  type WorkspaceSummary,
} from "@sealant/api-contracts";
import { connectedAccountProviders, createConnectedAccountRef } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  GitHubInstallationRepo,
  GitHubInstallationRepositoryCacheRepo,
  ProfileRepo,
  RunRepo,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccount,
} from "@sealant/db";
import {
  GitHubSourceIntegrationService,
  createGitHubInstallationRepositoryAuthRef,
} from "@sealant/source-integrations";
import { newWorkspaceSchema, type NewWorkspace } from "@sealant/validators";
import {
  resolveWorkspaceError,
  resolveWorkspacePublishedImage,
  resolveWorkspaceRuntime,
  resolveWorkspaceStatus,
  type WorkspaceSshGatewayConfig,
} from "@sealant/workspaces";
import { Context, Effect, Result } from "effect";

import { resolveWorkspaceSshGatewayConfig } from "../../lib/workspace-ssh-gateway.js";
import { env } from "../../runtime-env.js";
import {
  PackageStandardizerService,
  RunExecPublisherService,
  WorkspaceBuildJobPublisherService,
} from "../../services/control-plane-capabilities.js";
import { mapRun } from "../runs/runs.module.js";

interface WorkspaceEventDraft {
  readonly workspaceId: string;
  readonly attemptId?: string;
  readonly type: WorkspaceEventType;
  readonly occurredAt: Date;
  readonly message?: string;
  readonly data?: Record<string, unknown>;
}

type WorkspaceRepoService = Context.Service.Shape<typeof WorkspaceRepo>;
type WorkspaceAttemptRepoService = Context.Service.Shape<typeof WorkspaceAttemptRepo>;
type WorkspaceBuildJobRepoService = Context.Service.Shape<typeof WorkspaceBuildJobRepo>;
type WorkspaceRuntimeInstanceRepoService = Context.Service.Shape<
  typeof WorkspaceRuntimeInstanceRepo
>;

type WorkspaceRecord = NonNullable<
  Effect.Success<ReturnType<WorkspaceRepoService["getWorkspaceById"]>>
>;
type WorkspaceAttemptRecord = NonNullable<
  Effect.Success<ReturnType<WorkspaceAttemptRepoService["getAttemptById"]>>
>;
type WorkspaceBuildJobRecord = Effect.Success<
  ReturnType<WorkspaceBuildJobRepoService["getLatestJobByRunId"]>
>;
type WorkspaceRuntimeInstanceRecord = Effect.Success<
  ReturnType<WorkspaceRuntimeInstanceRepoService["getRuntimeInstanceByRunId"]>
>;
type WorkspaceAttemptSnapshotRecord = Effect.Success<
  ReturnType<WorkspaceAttemptRepoService["getAttemptSnapshotByRunId"]>
>;
type WorkspaceRunLinkRecord = Effect.Success<
  ReturnType<WorkspaceRepoService["listWorkspaceAttemptLinks"]>
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

const parseWorkspaceSpec = (spec: unknown) => {
  const parsed = newWorkspaceSchema.safeParse(spec);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]?.message;
    return Effect.fail(
      new WorkspaceBadRequestError({
        message: firstIssue ?? "Workspace spec is invalid.",
      }),
    );
  }

  return Effect.succeed(parsed.data);
};

const readIdempotencyKey = (headers: CreateWorkspaceHeaders): string | undefined => {
  return headers["idempotency-key"];
};

const readGatewayToken = (headers: WorkspaceGatewayHeaders): string | undefined => {
  return headers["x-sealant-gateway-token"];
};

/** Constant-time shared-token comparison; length mismatch still returns false. */
const gatewayTokenMatches = (provided: string | undefined, expected: string): boolean => {
  if (provided === undefined) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

const readPrincipalId = (headers: WorkspaceGatewayHeaders): string | undefined => {
  return headers["x-sealant-principal-id"];
};

const sanitizeWorkspaceName = (name: string): string => {
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

  return token.length > 0 ? token : "Workspace";
};

const deriveSourceRef = (spec: NewWorkspace): string | undefined => {
  const ref = spec.sources.workspace.ref.trim();
  return ref.length > 0 ? ref : undefined;
};

const inferWorkspaceName = (input: {
  readonly repository: string;
  readonly tag: string;
  readonly spec: NewWorkspace;
  readonly fallbackId: string;
}): string => {
  const repositoryToken = deriveRepositoryNameToken(input.repository);
  const tagToken = toTitleToken(input.tag);
  const sourceRef = deriveSourceRef(input.spec);
  const refToken = sourceRef === undefined ? "" : toTitleToken(sourceRef);
  const name = sanitizeWorkspaceName(
    [repositoryToken, tagToken, refToken].filter((segment) => segment.length > 0).join(" "),
  );

  if (name.length > 0) {
    return name;
  }

  return `Workspace ${input.fallbackId.slice(0, 8)}`;
};

const resolveStoredWorkspaceName = (workspace: Pick<WorkspaceRecord, "id" | "name">): string => {
  const sanitized = sanitizeWorkspaceName(workspace.name);

  if (sanitized.length > 0) {
    return sanitized;
  }

  return `Workspace ${workspace.id.slice(0, 8)}`;
};

const mapStoredWorkspaceStatus = (
  status: WorkspaceRecord["status"],
): WorkspaceSummary["status"] => {
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

const mapAttemptStatusToWorkspaceStatus = (
  status: WorkspaceAttemptRecord["status"],
): WorkspaceRecord["status"] => {
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
      new WorkspaceBadRequestError({
        message: `${input.name} must be an integer between 1 and ${input.max}.`,
      }),
    );
  }

  return Effect.succeed(value);
};

const parseRequestedPackageIds = (spec: NewWorkspace): string[] => {
  return spec.tooling.packages.map((pkg) => pkg.id);
};

const parseRequestedOsFamily = (spec: NewWorkspace): "auto" | "arch" | "fedora" | "nix" => {
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

const standardizeRequestedPackages = (spec: NewWorkspace) => {
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
              new WorkspaceInternalServerError({
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

    const nextSpec: NewWorkspace = {
      ...spec,
      tooling: {
        ...spec.tooling,
        packages: dedupePackageNames(standardizedPackageNames).map((id) => ({ id })),
      },
    };

    const parsedNextSpec = yield* parseWorkspaceSpec(nextSpec);
    const emptyErrors: string[] = [];

    return {
      spec: parsedNextSpec,
      errors: emptyErrors,
    };
  });
};

const cloneSpecForSourceSelection = (spec: NewWorkspace): NewWorkspace => {
  return structuredClone(spec);
};

const buildGitHubWorkspaceSource = (input: {
  readonly installationRepositoryId: string;
  readonly fullName: string;
  readonly ref: string;
}): NewWorkspace["sources"]["workspace"] => {
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
}): NewWorkspace["sources"]["inputs"][number] => {
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
  spec: NewWorkspace,
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

  return parseWorkspaceSpec(nextSpec);
};

const withInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) => {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new WorkspaceInternalServerError({
          message: toErrorMessage(error, fallback),
        }),
    ),
  );
};

const resolveGitHubSourceSelection = (input: {
  readonly ownerUserId: string;
  readonly spec: NewWorkspace;
  readonly sourceSelection: GitHubWorkspaceSourceSelection | undefined;
}) => {
  return Effect.gen(function* () {
    if (input.sourceSelection === undefined) {
      return {
        spec: input.spec,
      };
    }

    const gitHubSourceIntegration = yield* GitHubSourceIntegrationService;
    if (!gitHubSourceIntegration.isConfigured()) {
      return yield* new WorkspaceServiceUnavailableError({ message: gitHubUnavailableMessage });
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
      return yield* new WorkspaceNotFoundError({
        message: `GitHub installation repository not found: ${input.sourceSelection.installationRepositoryId}`,
      });
    }

    if (installationRepositoryRecord.removedAt !== null) {
      return yield* new WorkspaceNotFoundError({
        message: `GitHub installation repository ${input.sourceSelection.installationRepositoryId} is no longer available.`,
      });
    }

    if (installationRepositoryRecord.installationId !== input.sourceSelection.installationId) {
      return yield* new WorkspaceBadRequestError({
        message: "GitHub source selection did not match the selected installation.",
      });
    }

    const installation = yield* withInternalError(
      gitHubInstallationRepository.getInstallationById(input.sourceSelection.installationId),
      "Failed to load GitHub installation.",
    );

    if (installation === undefined) {
      return yield* new WorkspaceNotFoundError({
        message: `GitHub installation not found: ${input.sourceSelection.installationId}`,
      });
    }

    if (installation.status !== "active") {
      return yield* new WorkspaceForbiddenError({
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
      return yield* new WorkspaceForbiddenError({
        message: `User ${input.ownerUserId} does not have access to GitHub installation ${installation.id}.`,
      });
    }

    const effectiveSpec = cloneSpecForSourceSelection(input.spec);
    const workspaceSource = buildGitHubWorkspaceSource({
      installationRepositoryId: installationRepositoryRecord.id,
      fullName: installationRepositoryRecord.fullName,
      ref: input.sourceSelection.ref ?? installationRepositoryRecord.defaultBranch,
    });

    effectiveSpec.sources = {
      ...effectiveSpec.sources,
      workspace: workspaceSource,
    };

    const parsedSpec = yield* parseWorkspaceSpec(effectiveSpec);

    return {
      repositoryId: installationRepositoryRecord.repositoryId,
      spec: parsedSpec,
    };
  });
};

const resolveGitHubDotfilesSelection = (input: {
  readonly ownerUserId: string;
  readonly spec: NewWorkspace;
  readonly dotfilesSelection: GitHubWorkspaceSourceSelection | undefined;
}) => {
  return Effect.gen(function* () {
    if (input.dotfilesSelection === undefined) {
      return {
        spec: input.spec,
      };
    }

    const gitHubSourceIntegration = yield* GitHubSourceIntegrationService;
    if (!gitHubSourceIntegration.isConfigured()) {
      return yield* new WorkspaceServiceUnavailableError({ message: gitHubUnavailableMessage });
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
      return yield* new WorkspaceNotFoundError({
        message: `GitHub installation repository not found: ${input.dotfilesSelection.installationRepositoryId}`,
      });
    }

    if (installationRepositoryRecord.removedAt !== null) {
      return yield* new WorkspaceNotFoundError({
        message: `GitHub installation repository ${input.dotfilesSelection.installationRepositoryId} is no longer available.`,
      });
    }

    if (installationRepositoryRecord.installationId !== input.dotfilesSelection.installationId) {
      return yield* new WorkspaceBadRequestError({
        message: "Dotfiles GitHub selection did not match the selected installation.",
      });
    }

    const installation = yield* withInternalError(
      gitHubInstallationRepository.getInstallationById(input.dotfilesSelection.installationId),
      "Failed to load GitHub installation.",
    );

    if (installation === undefined) {
      return yield* new WorkspaceNotFoundError({
        message: `GitHub installation not found: ${input.dotfilesSelection.installationId}`,
      });
    }

    if (installation.status !== "active") {
      return yield* new WorkspaceForbiddenError({
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
      return yield* new WorkspaceForbiddenError({
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

type WorkspaceCredentialRef = NewWorkspace["runtime"]["credentialRefs"][number];

/**
 * Resolve the connected-account selection into opaque blueprint `credentialRefs`
 * (`connected-account:<id>`). Explicit per-provider entries win over the profile's bindings.
 * Values starting with "cacc_" are account ids; anything else is a per-provider account name.
 * No secret material is resolved here — the worker decrypts just before launch.
 */
const resolveWorkspaceCredentialRefs = (input: {
  readonly ownerUserId: string;
  readonly credentials: CreateWorkspaceRequest["credentials"];
}) => {
  return Effect.gen(function* () {
    const credentials = input.credentials;
    const refs: WorkspaceCredentialRef[] = [];

    if (credentials === undefined) {
      return refs;
    }

    const connectedAccountRepo = yield* ConnectedAccountRepo;
    const profileBound = new Map<ConnectedAccount["provider"], ConnectedAccount>();

    if (credentials.profileId !== undefined) {
      const profileRepo = yield* ProfileRepo;

      const profile = yield* withInternalError(
        profileRepo.getProfileById(credentials.profileId),
        "Failed to load profile.",
      );

      // Uniform 404: unknown profile and someone else's profile look identical.
      if (profile === undefined || profile.ownerUserId !== input.ownerUserId) {
        return yield* new WorkspaceNotFoundError({
          message: `Profile not found: ${credentials.profileId}`,
        });
      }

      const bindings = yield* withInternalError(
        connectedAccountRepo.getBindingsForProfileWithAccounts(profile.id),
        "Failed to load profile credential bindings.",
      );

      for (const { binding, account } of bindings) {
        profileBound.set(binding.provider, account);
      }
    }

    for (const provider of connectedAccountProviders) {
      const explicit = credentials[provider];
      let account: ConnectedAccount | undefined;

      if (explicit !== undefined) {
        account = explicit.startsWith("cacc_")
          ? yield* withInternalError(
              connectedAccountRepo.getById(explicit),
              "Failed to load connected account.",
            )
          : yield* withInternalError(
              connectedAccountRepo.getByOwnerProviderName({
                ownerUserId: input.ownerUserId,
                provider,
                name: explicit,
              }),
              "Failed to load connected account.",
            );

        // Uniform 404: unknown, someone else's, wrong-provider, and archived accounts all look
        // identical to the caller.
        if (
          account === undefined ||
          account.ownerUserId !== input.ownerUserId ||
          account.provider !== provider ||
          account.archivedAt !== null
        ) {
          return yield* new WorkspaceNotFoundError({
            message: `No ${provider} connected account matches "${explicit}".`,
          });
        }

        // Explicit selection: the caller named this account, so a broken one is a hard error
        // rather than a silent omission.
        if (account.status !== "active") {
          return yield* new WorkspaceConflictError({
            message: `Connected ${provider} account "${account.name}" is invalid — reconnect it.`,
          });
        }
      } else {
        const bound = profileBound.get(provider);

        // A binding pointing at an unusable account (archived, or invalidated by a 401) is
        // effectively disconnected — skip it rather than fail every launch that uses this profile
        // (surfaces show it as "needs reconnect"). Only an explicitly-named account hard-fails.
        if (bound === undefined || bound.archivedAt !== null || bound.status !== "active") {
          continue;
        }

        account = bound;
      }

      refs.push({ provider, ref: createConnectedAccountRef(account.id) });
    }

    return refs;
  });
};

const mapWorkspaceAttemptSummary = (
  link: WorkspaceRunLinkRecord,
  attempt: WorkspaceAttemptRecord,
  latestJob: WorkspaceBuildJobRecord,
  runtimeInstance: WorkspaceRuntimeInstanceRecord,
  sshGatewayConfig: WorkspaceSshGatewayConfig | undefined,
): WorkspaceAttemptSummary => {
  const runtime = resolveWorkspaceRuntime(runtimeInstance, {
    workspaceId: link.workspaceId,
    ...(sshGatewayConfig === undefined ? {} : { sshGateway: sshGatewayConfig }),
  });
  const publishedImage = resolveWorkspacePublishedImage(latestJob);
  const error = resolveWorkspaceError(latestJob);
  const startedAt = attempt.startedAt ?? latestJob?.startedAt;
  const finishedAt = attempt.finishedAt ?? latestJob?.finishedAt;

  return {
    attemptId: attempt.id,
    relation: link.relation,
    status: resolveWorkspaceStatus({
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
  readonly workspaceId: string;
  readonly attemptId?: string;
  readonly type: WorkspaceEventType;
  readonly occurredAt: Date;
}): string => {
  return [
    input.workspaceId,
    input.attemptId ?? "workspace",
    input.type,
    input.occurredAt.getTime(),
  ].join(":");
};

const toEventResponse = (input: WorkspaceEventDraft): WorkspaceEvent => {
  return {
    eventId: toEventId(input),
    workspaceId: input.workspaceId,
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    type: input.type,
    occurredAt: input.occurredAt.toISOString(),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.data === undefined ? {} : { data: input.data }),
  };
};

const ensureWorkspaceForAttempt = (attempt: WorkspaceAttemptRecord) => {
  return Effect.gen(function* () {
    const workspaceRepository = yield* WorkspaceRepo;

    const existing = yield* withInternalError(
      workspaceRepository.getWorkspaceByAttemptId(attempt.id),
      "Failed to load workspace by attempt id.",
    );

    if (existing !== undefined) {
      return existing;
    }

    const workspace = yield* withInternalError(
      workspaceRepository.createWorkspace({
        id: yield* randomId,
        name: `Workspace ${attempt.id.slice(0, 8)}`,
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
        status: mapAttemptStatusToWorkspaceStatus(attempt.status),
      }),
      "Failed to create workspace for existing attempt.",
    );

    yield* withInternalError(
      workspaceRepository.linkWorkspaceAttempt({
        workspaceId: workspace.id,
        attemptId: attempt.id,
        relation: "launch",
      }),
      "Failed to link workspace attempt.",
    );

    return workspace;
  });
};

const mapWorkspaceSummary = (
  workspace: WorkspaceRecord,
  attempt: WorkspaceAttemptRecord | undefined,
  latestJob: WorkspaceBuildJobRecord,
  runtimeInstance: WorkspaceRuntimeInstanceRecord,
  sshGatewayConfig: WorkspaceSshGatewayConfig | undefined,
): WorkspaceSummary => {
  const runtime = resolveWorkspaceRuntime(runtimeInstance, {
    workspaceId: workspace.id,
    ...(sshGatewayConfig === undefined ? {} : { sshGateway: sshGatewayConfig }),
  });
  const publishedImage = resolveWorkspacePublishedImage(latestJob);
  const error = resolveWorkspaceError(latestJob);
  const updatedAt = latestDate(
    workspace.updatedAt,
    attempt?.updatedAt,
    latestJob?.updatedAt,
    runtimeInstance?.updatedAt,
  );
  const startedAt = attempt?.startedAt ?? latestJob?.startedAt;
  const finishedAt = attempt?.finishedAt ?? latestJob?.finishedAt;
  const status =
    attempt === undefined
      ? mapStoredWorkspaceStatus(workspace.status)
      : resolveWorkspaceStatus({
          attempt,
          ...(latestJob === undefined ? {} : { latestJob }),
          ...(runtimeInstance === undefined ? {} : { runtimeInstance }),
        });

  return {
    workspaceId: workspace.id,
    name: resolveStoredWorkspaceName(workspace),
    ownerUserId: workspace.ownerUserId,
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
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    ...(toIsoString(startedAt) === undefined ? {} : { startedAt: toIsoString(startedAt) }),
    ...(toIsoString(finishedAt) === undefined ? {} : { finishedAt: toIsoString(finishedAt) }),
  };
};

const mapWorkspaceDetails = (
  workspace: WorkspaceRecord,
  attempt: WorkspaceAttemptRecord | undefined,
  latestJob: WorkspaceBuildJobRecord,
  runtimeInstance: WorkspaceRuntimeInstanceRecord,
  attemptSnapshot: WorkspaceAttemptSnapshotRecord,
  sshGatewayConfig: WorkspaceSshGatewayConfig | undefined,
): WorkspaceDetails => {
  const summary = mapWorkspaceSummary(
    workspace,
    attempt,
    latestJob,
    runtimeInstance,
    sshGatewayConfig,
  );
  const userSpec = attemptSnapshot?.userSpecPayload ?? latestJob?.requestPayload;

  return {
    ...summary,
    ...(userSpec === undefined ? {} : { spec: userSpec }),
  };
};

const acceptedWorkspaceResponse = (
  workspaceId: string,
  name: string,
  input: {
    readonly registryId: string;
    readonly repository: string;
    readonly tag: string;
  },
): CreateWorkspaceResponse => {
  return {
    workspaceId,
    name,
    status: "queued",
    registryId: input.registryId,
    repository: input.repository,
    tag: input.tag,
  };
};

const maybeReturnExistingIdempotentWorkspace = (idempotencyKey: string) => {
  return Effect.gen(function* () {
    const workspaceBuildJobs = yield* WorkspaceBuildJobRepo;
    const workspaceAttempts = yield* WorkspaceAttemptRepo;

    const existingJob = yield* withInternalError(
      workspaceBuildJobs.getJobByIdempotencyKey(idempotencyKey),
      "Failed to load existing workspace build job by idempotency key.",
    );

    if (existingJob === undefined || existingJob.runId === null) {
      return undefined;
    }

    const existingRun = yield* withInternalError(
      workspaceAttempts.getAttemptById(existingJob.runId),
      "Failed to load existing workspace attempt.",
    );

    if (existingRun === undefined) {
      return undefined;
    }

    const existingWorkspace = yield* ensureWorkspaceForAttempt(existingRun);

    return acceptedWorkspaceResponse(
      existingWorkspace.id,
      resolveStoredWorkspaceName(existingWorkspace),
      {
        registryId: existingJob.registryId,
        repository: existingJob.repository,
        tag: existingJob.tag,
      },
    );
  });
};

export const createWorkspace = (input: {
  readonly payload: CreateWorkspaceRequest;
  readonly headers: CreateWorkspaceHeaders;
}) => {
  return Effect.gen(function* () {
    const body = input.payload;
    const idempotencyKey = readIdempotencyKey(input.headers);

    if (body.registryId !== env.REGISTRY_NAME) {
      return yield* new WorkspaceNotFoundError({
        message: `Unknown registry: ${body.registryId}`,
      });
    }

    if (idempotencyKey !== undefined) {
      const existing = yield* maybeReturnExistingIdempotentWorkspace(idempotencyKey);
      if (existing !== undefined) {
        return existing;
      }
    }

    const parsedSpec = yield* parseWorkspaceSpec(body.spec);

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

    const workspaceId = yield* randomId;
    const runId = yield* randomId;
    const jobId = yield* randomId;

    const packageStandardization = yield* standardizeRequestedPackages(
      dotfilesSelectionResult.spec,
    );

    if (packageStandardization.errors.length > 0) {
      return yield* new WorkspaceBadRequestError({
        message: packageStandardization.errors[0] ?? "Package standardization failed.",
      });
    }

    const resolvedSpec = packageStandardization.spec;

    // Connected-account selection -> opaque blueprint credentialRefs. The contract-level
    // `credentials` field wins over one embedded in the spec (newWorkspaceSchema allows both).
    // Always replace any client-supplied `runtime.credentialRefs`: the only refs that may reach
    // the worker are ones we just resolved through ownership/status checks. A caller could
    // otherwise embed `runtime.credentialRefs` pointing at another user's account id and have the
    // worker decrypt and inject it (the refs are opaque `connected-account:<id>` pointers).
    const credentialRefs = yield* resolveWorkspaceCredentialRefs({
      ownerUserId: body.ownerUserId,
      credentials: body.credentials ?? resolvedSpec.credentials,
    });

    resolvedSpec.runtime = { ...resolvedSpec.runtime, credentialRefs };

    const workspaceName =
      body.name === undefined
        ? inferWorkspaceName({
            repository: body.repository,
            tag: body.tag,
            spec: resolvedSpec,
            fallbackId: workspaceId,
          })
        : sanitizeWorkspaceName(body.name);

    const workspaces = yield* WorkspaceRepo;
    const workspaceBuildJobs = yield* WorkspaceBuildJobRepo;
    const workspaceAttempts = yield* WorkspaceAttemptRepo;

    const persistenceResult = yield* Effect.result(
      Effect.gen(function* () {
        const workspace = yield* workspaces.createWorkspace({
          id: workspaceId,
          name: workspaceName,
          ownerUserId: body.ownerUserId,
          ...(body.sourceSelection === undefined
            ? {}
            : { repositoryId: sourceSelectionResult.repositoryId }),
          requestedByUserId: body.ownerUserId,
          status: "queued",
        });

        const attempt = yield* workspaceAttempts.createQueuedAttempt({
          id: runId,
          ownerUserId: body.ownerUserId,
          ...(body.sourceSelection === undefined
            ? {}
            : { repositoryId: sourceSelectionResult.repositoryId }),
          triggerType: "api",
          requestedByUserId: body.ownerUserId,
        });

        yield* workspaces.linkWorkspaceAttempt({
          workspaceId: workspace.id,
          attemptId: attempt.id,
          relation: "launch",
        });

        yield* workspaceAttempts.setAttemptSnapshot({
          runId: attempt.id,
          specPayload: resolvedSpec,
        });

        yield* workspaceBuildJobs.insertQueuedJob({
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
        return yield* new WorkspaceNotFoundError({
          message: `Unknown owner user: ${body.ownerUserId}`,
        });
      }

      if (idempotencyKey !== undefined && isUniqueConstraintError(persistenceError)) {
        const existing = yield* maybeReturnExistingIdempotentWorkspace(idempotencyKey);

        if (existing !== undefined) {
          return existing;
        }
      }

      return yield* new WorkspaceInternalServerError({
        message: toErrorMessage(persistenceError, "Failed to create workspace."),
      });
    }

    const workspaceBuildJobPublisher = yield* WorkspaceBuildJobPublisherService;

    yield* Effect.tryPromise({
      try: () =>
        workspaceBuildJobPublisher.publishRequested({
          jobId,
        }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.all(
            [
              workspaceBuildJobs.markJobFailed({
                id: jobId,
                errorCode: "queue_publish_failed",
                errorMessage: toErrorMessage(error, "Failed to enqueue workspace build job."),
              }),
              workspaceAttempts.markAttemptFailed({
                id: runId,
              }),
              workspaces.setWorkspaceStatus({
                id: workspaceId,
                status: "failed",
              }),
            ],
            {
              concurrency: "unbounded",
            },
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Workspace ${workspaceId} rollback writes failed after queue publish failure; state may be inconsistent.`,
                cause,
              ),
            ),
          );

          return yield* new WorkspaceBadGatewayError({
            message: `Workspace ${workspaceId} was recorded but could not be queued.`,
          });
        }),
      ),
    );

    return acceptedWorkspaceResponse(workspaceId, workspaceName, {
      registryId: body.registryId,
      repository: body.repository,
      tag: body.tag,
    });
  });
};

export const renameWorkspace = (input: {
  readonly workspaceId: string;
  readonly payload: RenameWorkspaceRequest;
}) => {
  return Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const workspace = yield* withInternalError(
      workspaces.setWorkspaceName({
        id: input.workspaceId,
        name: sanitizeWorkspaceName(input.payload.name),
      }),
      "Failed to rename workspace.",
    );

    if (workspace === null) {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${input.workspaceId}`,
      });
    }

    return {
      workspaceId: workspace.id,
      name: resolveStoredWorkspaceName(workspace),
      updatedAt: workspace.updatedAt.toISOString(),
    } satisfies RenameWorkspaceResponse;
  });
};

export const listWorkspaces = (query: ListWorkspacesQuery) => {
  return Effect.gen(function* () {
    const workspaceLimit = yield* parseLimit({
      raw: query.limit,
      fallback: 25,
      max: 100,
      name: "limit",
    });

    const effectiveWorkspaceLimit =
      query.status === undefined ? workspaceLimit : Math.min(workspaceLimit * 4, 100);

    const workspaces = yield* withInternalError(
      (yield* WorkspaceRepo).listWorkspaces({
        ownerUserId: query.ownerUserId,
        limit: effectiveWorkspaceLimit,
      }),
      "Failed to list workspaces.",
    );

    const latestRunIds = workspaces.flatMap((workspace) => {
      return workspace.latestRunId === null ? [] : [workspace.latestRunId];
    });

    const workspaceAttempts = yield* WorkspaceAttemptRepo;
    const workspaceBuildJobs = yield* WorkspaceBuildJobRepo;
    const workspaceRuntimeInstances = yield* WorkspaceRuntimeInstanceRepo;

    const attempts = yield* withInternalError(
      Effect.forEach(latestRunIds, (runId) =>
        workspaceAttempts.getAttemptById(runId).pipe(
          Effect.map((attempt): readonly [string, WorkspaceAttemptRecord | undefined] => {
            return [runId, attempt];
          }),
        ),
      ),
      "Failed to load workspace attempts.",
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
      workspaceBuildJobs.listLatestJobsByRunIds(latestRunIds),
      "Failed to load latest workspace build jobs.",
    );

    const runtimeInstancesByRunId = yield* withInternalError(
      workspaceRuntimeInstances.listRuntimeInstancesByRunIds(latestRunIds),
      "Failed to load workspace runtime instances.",
    );

    const sshGatewayConfig = resolveWorkspaceSshGatewayConfig();

    const items = workspaces
      .map((workspace) => {
        const runId = workspace.latestRunId ?? undefined;

        return mapWorkspaceSummary(
          workspace,
          runId === undefined ? undefined : attemptsByRunId.get(runId),
          runId === undefined ? undefined : latestJobsByRunId.get(runId),
          runId === undefined ? undefined : runtimeInstancesByRunId.get(runId),
          sshGatewayConfig,
        );
      })
      .filter((item) => (query.status === undefined ? true : item.status === query.status))
      .slice(0, workspaceLimit);

    return {
      items,
    } satisfies ListWorkspacesResponse;
  });
};

export const getWorkspace = (workspaceId: string) => {
  return Effect.gen(function* () {
    const workspaceRepo = yield* WorkspaceRepo;
    const workspace = yield* withInternalError(
      workspaceRepo.getWorkspaceById(workspaceId),
      "Failed to load workspace.",
    );

    if (workspace === undefined) {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${workspaceId}`,
      });
    }

    const sshGatewayConfig = resolveWorkspaceSshGatewayConfig();

    if (workspace.latestRunId === null) {
      return mapWorkspaceDetails(
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        sshGatewayConfig,
      );
    }

    const workspaceAttemptRepo = yield* WorkspaceAttemptRepo;
    const workspaceBuildJobRepo = yield* WorkspaceBuildJobRepo;
    const workspaceRuntimeInstanceRepo = yield* WorkspaceRuntimeInstanceRepo;

    const attempt = yield* withInternalError(
      workspaceAttemptRepo.getAttemptById(workspace.latestRunId),
      "Failed to load workspace attempt.",
    );
    const attemptSnapshot = yield* withInternalError(
      workspaceAttemptRepo.getAttemptSnapshotByRunId(workspace.latestRunId),
      "Failed to load workspace attempt snapshot.",
    );
    const latestJob = yield* withInternalError(
      workspaceBuildJobRepo.getLatestJobByRunId(workspace.latestRunId),
      "Failed to load latest workspace build job.",
    );
    const runtimeInstance = yield* withInternalError(
      workspaceRuntimeInstanceRepo.getRuntimeInstanceByRunId(workspace.latestRunId),
      "Failed to load workspace runtime instance.",
    );

    return mapWorkspaceDetails(
      workspace,
      attempt,
      latestJob,
      runtimeInstance,
      attemptSnapshot,
      sshGatewayConfig,
    );
  });
};

export const getWorkspaceSshTarget = (input: {
  readonly workspaceId: string;
  readonly headers: WorkspaceGatewayHeaders;
}) => {
  return Effect.gen(function* () {
    const expectedGatewayToken = env.WORKSPACE_SSH_GATEWAY_TOKEN?.trim();

    if (expectedGatewayToken === undefined || expectedGatewayToken.length === 0) {
      return yield* new WorkspaceServiceUnavailableError({
        message: "Workspace SSH gateway token is not configured.",
      });
    }

    if (!gatewayTokenMatches(readGatewayToken(input.headers), expectedGatewayToken)) {
      return yield* new WorkspaceUnauthorizedError({
        message: "Invalid workspace SSH gateway token.",
      });
    }

    // The gateway token proves *the gateway* is a trusted caller; the principal id scopes *what it may
    // resolve* (gateway-spec §3.4). Per-workspace authorization lives here at the API, not the daemon.
    const principalId = readPrincipalId(input.headers);

    if (principalId === undefined || principalId.length === 0) {
      return yield* new WorkspaceUnauthorizedError({
        message: "Missing client principal for workspace SSH target.",
      });
    }

    const workspace = yield* withInternalError(
      (yield* WorkspaceRepo).getWorkspaceById(input.workspaceId),
      "Failed to load workspace.",
    );

    if (workspace === undefined) {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${input.workspaceId}`,
      });
    }

    // Owner-scoped authorization (ACL extension deferred): the principal must own this workspace.
    if (workspace.ownerUserId !== principalId) {
      return yield* new WorkspaceUnauthorizedError({
        message: "Principal is not authorized for this workspace.",
      });
    }

    if (workspace.latestRunId === null) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has no active attempt with runtime metadata.`,
      });
    }

    const runtimeInstance = yield* withInternalError(
      (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(workspace.latestRunId),
      "Failed to load workspace runtime instance.",
    );

    if (
      runtimeInstance === undefined ||
      runtimeInstance.endpoint === null ||
      runtimeInstance.adapter === null ||
      runtimeInstance.resourceId === null ||
      runtimeInstance.reference === null ||
      // "ready" is the honest-readiness state (control socket accepting) — SSH-able, like "running".
      (runtimeInstance.status !== "running" && runtimeInstance.status !== "ready")
    ) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} runtime SSH target is not available.`,
      });
    }

    return {
      workspaceId: workspace.id,
      attemptId: workspace.latestRunId,
      runtime: {
        adapter: runtimeInstance.adapter,
        resourceId: runtimeInstance.resourceId,
        reference: runtimeInstance.reference,
        status: runtimeInstance.status,
        endpoint: runtimeInstance.endpoint,
      },
    } satisfies WorkspaceSshTarget;
  });
};

export const listWorkspaceAttempts = (input: {
  readonly workspaceId: string;
  readonly query: ListWorkspaceAttemptsQuery;
}) => {
  return Effect.gen(function* () {
    const limit = yield* parseLimit({
      raw: input.query.limit,
      fallback: 25,
      max: 100,
      name: "limit",
    });

    const workspaceRepo = yield* WorkspaceRepo;
    const workspace = yield* withInternalError(
      workspaceRepo.getWorkspaceById(input.workspaceId),
      "Failed to load workspace.",
    );

    if (workspace === undefined) {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${input.workspaceId}`,
      });
    }

    const links = yield* withInternalError(
      workspaceRepo.listWorkspaceAttemptLinks(workspace.id, limit),
      "Failed to load workspace attempt links.",
    );
    const runIds = links.map((link) => link.runId);

    const workspaceAttemptRepo = yield* WorkspaceAttemptRepo;
    const workspaceBuildJobRepo = yield* WorkspaceBuildJobRepo;
    const workspaceRuntimeInstanceRepo = yield* WorkspaceRuntimeInstanceRepo;

    const attempts = yield* withInternalError(
      Effect.forEach(runIds, (runId) =>
        workspaceAttemptRepo.getAttemptById(runId).pipe(
          Effect.map((attempt): readonly [string, WorkspaceAttemptRecord | undefined] => {
            return [runId, attempt];
          }),
        ),
      ),
      "Failed to load workspace attempts.",
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
      workspaceBuildJobRepo.listLatestJobsByRunIds(runIds),
      "Failed to load latest workspace build jobs.",
    );
    const runtimeInstancesByRunId = yield* withInternalError(
      workspaceRuntimeInstanceRepo.listRuntimeInstancesByRunIds(runIds),
      "Failed to load workspace runtime instances.",
    );
    const sshGatewayConfig = resolveWorkspaceSshGatewayConfig();

    const items = links.flatMap((link) => {
      const attempt = attemptsByRunId.get(link.runId);

      if (attempt === undefined) {
        return [];
      }

      return [
        mapWorkspaceAttemptSummary(
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
    } satisfies ListWorkspaceAttemptsResponse;
  });
};

export const listWorkspaceEvents = (input: {
  readonly workspaceId: string;
  readonly query: ListWorkspaceEventsQuery;
}) => {
  return Effect.gen(function* () {
    const limit = yield* parseLimit({
      raw: input.query.limit,
      fallback: 50,
      max: 200,
      name: "limit",
    });

    const workspaceRepo = yield* WorkspaceRepo;
    const workspace = yield* withInternalError(
      workspaceRepo.getWorkspaceById(input.workspaceId),
      "Failed to load workspace.",
    );

    if (workspace === undefined) {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${input.workspaceId}`,
      });
    }

    const links = yield* withInternalError(
      workspaceRepo.listWorkspaceAttemptLinks(workspace.id, limit),
      "Failed to load workspace attempt links.",
    );
    const runIds = links.map((link) => link.runId);

    const workspaceAttemptRepo = yield* WorkspaceAttemptRepo;
    const workspaceBuildJobRepo = yield* WorkspaceBuildJobRepo;
    const workspaceRuntimeInstanceRepo = yield* WorkspaceRuntimeInstanceRepo;

    const attempts = yield* withInternalError(
      Effect.forEach(runIds, (runId) =>
        workspaceAttemptRepo.getAttemptById(runId).pipe(
          Effect.map((attempt): readonly [string, WorkspaceAttemptRecord | undefined] => {
            return [runId, attempt];
          }),
        ),
      ),
      "Failed to load workspace attempts.",
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
      workspaceBuildJobRepo.listLatestJobsByRunIds(runIds),
      "Failed to load latest workspace build jobs.",
    );
    const runtimeInstancesByRunId = yield* withInternalError(
      workspaceRuntimeInstanceRepo.listRuntimeInstancesByRunIds(runIds),
      "Failed to load workspace runtime instances.",
    );
    const sshGatewayConfig = resolveWorkspaceSshGatewayConfig();

    const events: WorkspaceEventDraft[] = [
      {
        workspaceId: workspace.id,
        type: "workspace.created",
        occurredAt: workspace.createdAt,
        message: "Workspace created.",
      },
    ];

    for (const link of links) {
      const attempt = attemptsByRunId.get(link.runId);

      if (attempt === undefined) {
        continue;
      }

      const latestJob = latestJobsByRunId.get(link.runId);
      const runtimeInstance = runtimeInstancesByRunId.get(link.runId);
      const runtimeEndpoint = resolveWorkspaceRuntime(runtimeInstance, {
        workspaceId: workspace.id,
        ...(sshGatewayConfig === undefined ? {} : { sshGateway: sshGatewayConfig }),
      })?.endpoint;

      events.push({
        workspaceId: workspace.id,
        attemptId: attempt.id,
        type: "attempt.queued",
        occurredAt: attempt.queuedAt,
        message: "Workspace attempt queued.",
        data: {
          relation: link.relation,
          triggerType: attempt.triggerType,
        },
      });

      if (attempt.startedAt !== null) {
        events.push({
          workspaceId: workspace.id,
          attemptId: attempt.id,
          type: "attempt.running",
          occurredAt: attempt.startedAt,
          message: "Workspace attempt started.",
        });
      }

      if (
        latestJob !== undefined &&
        latestJob.publishedReference !== null &&
        latestJob.publishedDigestReference !== null &&
        latestJob.publishedDigest !== null
      ) {
        events.push({
          workspaceId: workspace.id,
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
          runtimeInstance.status === "running" || runtimeInstance.status === "ready"
            ? (runtimeInstance.launchedAt ?? runtimeInstance.updatedAt)
            : runtimeInstance.status === "pending"
              ? runtimeInstance.createdAt
              : (runtimeInstance.finishedAt ?? runtimeInstance.updatedAt);

        events.push({
          workspaceId: workspace.id,
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
          workspaceId: workspace.id,
          attemptId: attempt.id,
          type: "attempt.succeeded",
          occurredAt: attempt.finishedAt,
          message: "Workspace attempt completed successfully.",
        });
      }

      if (attempt.status === "failed" && attempt.finishedAt !== null) {
        events.push({
          workspaceId: workspace.id,
          attemptId: attempt.id,
          type: "attempt.failed",
          occurredAt: attempt.finishedAt,
          message: "Workspace attempt failed.",
        });
      }

      if (attempt.status === "cancelled" && attempt.finishedAt !== null) {
        events.push({
          workspaceId: workspace.id,
          attemptId: attempt.id,
          type: "attempt.cancelled",
          occurredAt: attempt.finishedAt,
          message: "Workspace attempt was cancelled.",
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
    } satisfies ListWorkspaceEventsResponse;
  });
};

/**
 * Deterministic exec — run an ordered command list in the workspace, recorded as ONE run (a "check
 * run") on the same run-exec pipeline as harness runs. The run is created with
 * `harnessId: "exec"` and executed asynchronously by the worker under EXEC framing (see
 * `execWorkspaceRequestSchema` for the completed-vs-failed semantics); callers poll
 * `GET /v1/runs/:runId` and read exit codes / output from the run record.
 */
export const execWorkspace = (input: {
  readonly workspaceId: string;
  readonly payload: ExecWorkspaceRequest;
}) => {
  return Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const workspace = yield* withInternalError(
      workspaces.getWorkspaceById(input.workspaceId),
      "Failed to load workspace.",
    );
    // Uniform 404 for unknown workspace AND foreign owner — do not leak existence.
    if (workspace === undefined || workspace.ownerUserId !== input.payload.ownerUserId) {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${input.workspaceId}`,
      });
    }
    if (workspace.latestRunId === null) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has no launched runtime to exec in yet; wait for it to become ready.`,
      });
    }

    const runs = yield* RunRepo;
    const runId = `run_${yield* randomId}`;
    const run = yield* withInternalError(
      runs.createRun({
        id: runId,
        workspaceId: workspace.id,
        ownerUserId: input.payload.ownerUserId,
        harnessId: execRunHarnessId,
        mode: "one-shot",
      }),
      "Failed to create the exec run.",
    );

    const publisher = yield* RunExecPublisherService;
    yield* Effect.tryPromise({
      try: () =>
        publisher.publishRequested({
          runId: run.id,
          commands: input.payload.commands.map((command) => ({
            executable: command.executable,
            args: [...command.args],
            ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
          })),
        }),
      catch: (error) =>
        new WorkspaceInternalServerError({
          message: toErrorMessage(error, "Failed to enqueue the exec run."),
        }),
    });

    return mapRun(run);
  });
};
