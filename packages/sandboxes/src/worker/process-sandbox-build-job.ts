import {
  createGitHubInstallationRepository,
  createGitHubInstallationRepositoryCacheRepository,
  createSandboxAttemptRepository,
  createSandboxRuntimeInstanceRepository,
  createWorkspaceBuildJobRepository,
  type GitHubInstallationRepository,
  type GitHubInstallationRepositoryCacheRepository,
  type DatabaseClient,
} from "@sealant/db";
import {
  parseGitHubInstallationRepositoryAuthRef,
  type GitHubSourceIntegration,
} from "@sealant/source-integrations";
import {
  workspaceBuildJobRequestPayloadSchema,
  type WorkspaceBuildJobRequestPayload,
  type WorkspaceBuildJobResultPayload,
} from "@sealant/validators";

import { compileSandboxBuildSpec } from "../buildkit/index.js";
import type { RegistryClient } from "../registry/index.js";
import {
  selectRuntimeAdapter,
  type PublishedImage,
  type RuntimeAdapter,
  type RuntimeAdapterId,
  type WorkspaceCloneAuth,
} from "../runtime/index.js";

export interface ProcessSandboxBuildJobOptions {
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly dbClient: DatabaseClient;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  readonly defaultRuntimeAdapterId: RuntimeAdapterId;
  readonly registryClient: RegistryClient;
  readonly gitHubSourceIntegration?: GitHubSourceIntegration;
  readonly compileSandboxSpec?: (
    spec: WorkspaceBuildJobRequestPayload,
  ) => Promise<WorkspaceBuildJobResultPayload>;
}

const createWorkerError = (code: string, message: string) => {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
};

const isPublishableOciImageArtifact = (
  artifact: WorkspaceBuildJobResultPayload["artifacts"][number],
): artifact is WorkspaceBuildJobResultPayload["artifacts"][number] & {
  kind: "oci-image";
  path: string;
  loader: "docker-load";
} => {
  return (
    artifact.kind === "oci-image" &&
    artifact.path !== undefined &&
    artifact.loader === "docker-load"
  );
};

const selectPublishableImageArtifact = (compileResult: WorkspaceBuildJobResultPayload) => {
  const artifact = compileResult.artifacts.find(isPublishableOciImageArtifact);

  if (artifact === undefined) {
    throw new Error("The compiler did not return a publishable OCI image artifact.");
  }

  return artifact;
};

const launchPublishedImage = async (input: {
  readonly spec: WorkspaceBuildJobRequestPayload;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  readonly defaultRuntimeAdapterId: RuntimeAdapterId;
  readonly publishedImage: PublishedImage;
  readonly workspaceCloneAuth?: WorkspaceCloneAuth;
}) => {
  const selectedAdapter = selectRuntimeAdapter({
    blueprint: input.spec,
    adapters: input.runtimeAdapters,
    defaultAdapterId: input.defaultRuntimeAdapterId,
  });

  return selectedAdapter.adapter.launch({
    blueprint: input.spec,
    publishedImage: input.publishedImage,
    ...(input.workspaceCloneAuth === undefined
      ? {}
      : { workspaceCloneAuth: input.workspaceCloneAuth }),
  });
};

const toErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : "Workspace build job failed.";
};

const toErrorCode = (error: unknown) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
};

const resolveWorkspaceCloneAuth = async (input: {
  readonly spec: WorkspaceBuildJobRequestPayload;
  readonly dbClient: DatabaseClient;
  readonly gitHubSourceIntegration?: GitHubSourceIntegration;
}): Promise<WorkspaceCloneAuth | undefined> => {
  const installationRepositoryId = parseGitHubInstallationRepositoryAuthRef(
    input.spec.sources.workspace.authRef,
  );

  if (installationRepositoryId === undefined) {
    return undefined;
  }

  if (
    input.gitHubSourceIntegration === undefined ||
    !input.gitHubSourceIntegration.isConfigured()
  ) {
    throw createWorkerError(
      "github-integration-unavailable",
      "GitHub source integration is not configured for GitHub-backed sandbox launches.",
    );
  }

  const installationRepositoryCache: GitHubInstallationRepositoryCacheRepository =
    createGitHubInstallationRepositoryCacheRepository(input.dbClient);
  const installationRepository: GitHubInstallationRepository = createGitHubInstallationRepository(
    input.dbClient,
  );
  const installationRepositoryRecord =
    await installationRepositoryCache.getInstallationRepositoryById(installationRepositoryId);

  if (
    installationRepositoryRecord === undefined ||
    installationRepositoryRecord.removedAt !== null
  ) {
    throw createWorkerError(
      "github-installation-repository-unavailable",
      `GitHub installation repository '${installationRepositoryId}' is not available for clone auth resolution.`,
    );
  }

  const installation = await installationRepository.getInstallationById(
    installationRepositoryRecord.installationId,
  );

  if (installation === undefined) {
    throw createWorkerError(
      "github-installation-missing",
      `GitHub installation '${installationRepositoryRecord.installationId}' could not be resolved for clone auth.`,
    );
  }

  if (installation.status !== "active") {
    throw createWorkerError(
      "github-installation-inactive",
      `GitHub installation '${installation.id}' is not active for clone auth resolution.`,
    );
  }

  const accessToken = await input.gitHubSourceIntegration.createInstallationAccessToken(
    installation.externalInstallationId,
  );

  return {
    type: "http-token",
    username: "x-access-token",
    token: accessToken.token,
  };
};

const resolveDotfilesRuntimeEnv = async (input: {
  readonly spec: WorkspaceBuildJobRequestPayload;
  readonly dbClient: DatabaseClient;
  readonly gitHubSourceIntegration?: GitHubSourceIntegration;
}): Promise<Record<string, string>> => {
  const dotfilesSource = input.spec.sources.inputs.find((source) => source.purpose === "dotfiles");
  const installationRepositoryId = parseGitHubInstallationRepositoryAuthRef(
    dotfilesSource?.authRef,
  );

  if (installationRepositoryId === undefined) {
    return {};
  }

  if (
    input.gitHubSourceIntegration === undefined ||
    !input.gitHubSourceIntegration.isConfigured()
  ) {
    throw createWorkerError(
      "github-integration-unavailable",
      "GitHub source integration is not configured for GitHub-backed dotfiles config repos.",
    );
  }

  const installationRepositoryCache: GitHubInstallationRepositoryCacheRepository =
    createGitHubInstallationRepositoryCacheRepository(input.dbClient);
  const installationRepository: GitHubInstallationRepository = createGitHubInstallationRepository(
    input.dbClient,
  );
  const installationRepositoryRecord =
    await installationRepositoryCache.getInstallationRepositoryById(installationRepositoryId);

  if (
    installationRepositoryRecord === undefined ||
    installationRepositoryRecord.removedAt !== null
  ) {
    throw createWorkerError(
      "github-installation-repository-unavailable",
      `GitHub installation repository '${installationRepositoryId}' is not available for dotfiles auth resolution.`,
    );
  }

  const installation = await installationRepository.getInstallationById(
    installationRepositoryRecord.installationId,
  );

  if (installation === undefined) {
    throw createWorkerError(
      "github-installation-missing",
      `GitHub installation '${installationRepositoryRecord.installationId}' could not be resolved for dotfiles auth.`,
    );
  }

  if (installation.status !== "active") {
    throw createWorkerError(
      "github-installation-inactive",
      `GitHub installation '${installation.id}' is not active for dotfiles auth resolution.`,
    );
  }

  const accessToken = await input.gitHubSourceIntegration.createInstallationAccessToken(
    installation.externalInstallationId,
  );

  return {
    SEALANT_DOTFILES_HTTP_USERNAME: "x-access-token",
    SEALANT_DOTFILES_HTTP_TOKEN: accessToken.token,
  };
};

export const processSandboxBuildJob = async (options: ProcessSandboxBuildJobOptions) => {
  const jobs = createWorkspaceBuildJobRepository(options.dbClient);
  const runtimeInstances = createSandboxRuntimeInstanceRepository(options.dbClient);
  const attempts = createSandboxAttemptRepository(options.dbClient);
  const job = await jobs.claimJobById({
    id: options.jobId,
    workerId: options.workerId,
    leaseDurationMs: options.leaseDurationMs,
  });

  if (job === null) {
    return null;
  }

  let buildSucceeded = false;

  try {
    if (job.runId !== null) {
      await attempts.markAttemptRunning({ id: job.runId }).catch(() => null);
    }

    const spec = workspaceBuildJobRequestPayloadSchema.parse(job.requestPayload);
    const compileSpec =
      options.compileSandboxSpec ??
      (async (
        inputSpec: WorkspaceBuildJobRequestPayload,
      ): Promise<WorkspaceBuildJobResultPayload> => {
        return compileSandboxBuildSpec({ blueprint: inputSpec });
      });
    const compileResult = await compileSpec(spec);
    const imageArtifact = selectPublishableImageArtifact(compileResult);
    const publishedImage = await options.registryClient.publishOciImage({
      artifactPath: imageArtifact.path,
      repository: job.repository,
      tag: job.tag,
      ...(imageArtifact.reference === undefined
        ? {}
        : { sourceReference: imageArtifact.reference }),
    });
    const resultPayload: WorkspaceBuildJobResultPayload = compileResult;

    await jobs.markJobSucceeded({
      id: job.id,
      executorId: compileResult.executor.id,
      resultPayload,
      publishedReference: publishedImage.reference,
      publishedDigestReference: publishedImage.digestReference,
      publishedDigest: publishedImage.digest,
    });
    buildSucceeded = true;

    if (job.runId !== null) {
      await runtimeInstances.upsertRuntimeInstance({
        runId: job.runId,
        status: "pending",
      });
    }

    const workspaceCloneAuth = await resolveWorkspaceCloneAuth({
      spec,
      dbClient: options.dbClient,
      ...(options.gitHubSourceIntegration === undefined
        ? {}
        : { gitHubSourceIntegration: options.gitHubSourceIntegration }),
    });
    const dotfilesRuntimeEnv = await resolveDotfilesRuntimeEnv({
      spec,
      dbClient: options.dbClient,
      ...(options.gitHubSourceIntegration === undefined
        ? {}
        : { gitHubSourceIntegration: options.gitHubSourceIntegration }),
    });
    const runtimeSpec: WorkspaceBuildJobRequestPayload =
      Object.keys(dotfilesRuntimeEnv).length === 0
        ? spec
        : {
            ...spec,
            runtime: {
              ...spec.runtime,
              env: {
                ...spec.runtime.env,
                ...dotfilesRuntimeEnv,
              },
            },
          };

    const runtimeLaunchResult = await launchPublishedImage({
      spec: runtimeSpec,
      runtimeAdapters: options.runtimeAdapters,
      defaultRuntimeAdapterId: options.defaultRuntimeAdapterId,
      publishedImage,
      ...(workspaceCloneAuth === undefined ? {} : { workspaceCloneAuth }),
    });

    if (job.runId !== null) {
      await runtimeInstances.upsertRuntimeInstance({
        runId: job.runId,
        status: runtimeLaunchResult.status,
        adapter: runtimeLaunchResult.adapter,
        resourceId: runtimeLaunchResult.resourceId,
        reference: runtimeLaunchResult.reference,
        ...(runtimeLaunchResult.endpoint === undefined
          ? {}
          : { endpoint: runtimeLaunchResult.endpoint }),
        launchedAt: new Date(),
      });
    }

    if (job.runId !== null) {
      await attempts.markAttemptSucceeded({ id: job.runId }).catch(() => null);
    }

    return publishedImage;
  } catch (error) {
    const errorCode = toErrorCode(error);

    if (job.runId !== null) {
      await runtimeInstances.upsertRuntimeInstance({
        runId: job.runId,
        status: "failed",
        ...(errorCode === undefined ? {} : { errorCode }),
        errorMessage: toErrorMessage(error),
        finishedAt: new Date(),
      });
    }

    await Promise.allSettled([
      ...(buildSucceeded
        ? []
        : [
            jobs.markJobFailed({
              id: job.id,
              errorMessage: toErrorMessage(error),
              ...(errorCode === undefined ? {} : { errorCode }),
            }),
          ]),
      ...(job.runId === null ? [] : [attempts.markAttemptFailed({ id: job.runId })]),
    ]);

    throw error;
  }
};

export const processWorkspaceBuildJob = processSandboxBuildJob;
