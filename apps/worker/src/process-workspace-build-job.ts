import {
  createWorkspaceBuildJobRepository,
  workspaceBuildJobRequestPayloadSchema,
  type WorkspaceBuildJobRequestPayload,
  type WorkspaceBuildJobResultPayload,
  type DatabaseClient,
} from "@sealant/db";
import type { RegistryClient } from "@sealant/registry-integration";
import {
  selectRuntimeAdapter,
  type PublishedImage,
  type RuntimeAdapter,
  type RuntimeAdapterId,
} from "@sealant/runtime-adapters-api";
import type {
  ConcreteWorkspaceTargetOsFamily,
  OciImageBuildArtifact,
  OsExecutor,
  OsExecutorCompileResult,
  WorkspaceBlueprint,
} from "@sealant/workspace-composition";
import { normalizeUserWorkspaceSpec } from "@sealant/workspace-composition";

export interface ProcessWorkspaceBuildJobOptions {
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly dbClient: DatabaseClient;
  readonly executors: readonly OsExecutor[];
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  readonly defaultRuntimeAdapterId: RuntimeAdapterId;
  readonly defaultStartupMode: "idle" | "harness";
  readonly defaultIdleCommand: string;
  readonly defaultSshEnabled: boolean;
  readonly defaultSshListenPort: number;
  readonly registryClient: RegistryClient;
}

const autoTargetFallbackOsFamily = "nix" satisfies ConcreteWorkspaceTargetOsFamily;

const createWorkerError = (code: string, message: string) => {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
};

const resolveRequestedOsFamily = (
  blueprint: WorkspaceBlueprint,
): ConcreteWorkspaceTargetOsFamily => {
  return blueprint.target.os.family === "auto"
    ? autoTargetFallbackOsFamily
    : blueprint.target.os.family;
};

const selectExecutorForBlueprint = (
  blueprint: WorkspaceBlueprint,
  executors: readonly OsExecutor[],
): OsExecutor => {
  const requestedOsFamily = resolveRequestedOsFamily(blueprint);
  const executor = executors.find((candidate) => candidate.osFamily === requestedOsFamily);

  if (executor === undefined) {
    throw createWorkerError(
      "unsupported-os",
      `No executor is registered for target.os.family '${requestedOsFamily}'.`,
    );
  }

  const support = executor.supports({ blueprint });
  if (!support.supported) {
    throw createWorkerError(support.reason, support.message);
  }

  return executor;
};

const isPublishableOciImageArtifact = (
  artifact: OsExecutorCompileResult["artifacts"][number],
): artifact is OciImageBuildArtifact & { path: string; loader: "docker-load" } => {
  return (
    artifact.kind === "oci-image" &&
    artifact.path !== undefined &&
    artifact.loader === "docker-load"
  );
};

const selectPublishableImageArtifact = (compileResult: OsExecutorCompileResult) => {
  const artifact = compileResult.artifacts.find(isPublishableOciImageArtifact);

  if (artifact === undefined) {
    throw new Error("The executor did not return a publishable OCI image artifact.");
  }

  return artifact;
};

const launchPublishedImage = async (input: {
  readonly blueprint: WorkspaceBlueprint;
  readonly runtimeAdapters: readonly RuntimeAdapter[];
  readonly defaultRuntimeAdapterId: RuntimeAdapterId;
  readonly publishedImage: PublishedImage;
}) => {
  const selectedAdapter = selectRuntimeAdapter({
    blueprint: input.blueprint,
    adapters: input.runtimeAdapters,
    defaultAdapterId: input.defaultRuntimeAdapterId,
  });

  return selectedAdapter.adapter.launch({
    blueprint: input.blueprint,
    publishedImage: input.publishedImage,
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

const hasExplicitStartup = (requestPayload: WorkspaceBuildJobRequestPayload): boolean => {
  return requestPayload.startup !== undefined || requestPayload.lifecycle?.startup !== undefined;
};

const hasExplicitSsh = (requestPayload: WorkspaceBuildJobRequestPayload): boolean => {
  return requestPayload.ssh !== undefined || requestPayload.access?.ssh !== undefined;
};

const applyRuntimeDefaults = (
  requestPayload: WorkspaceBuildJobRequestPayload,
  options: Pick<
    ProcessWorkspaceBuildJobOptions,
    "defaultStartupMode" | "defaultIdleCommand" | "defaultSshEnabled" | "defaultSshListenPort"
  >,
): WorkspaceBuildJobRequestPayload => {
  const nextPayload: Record<string, unknown> = {
    ...requestPayload,
  };

  if (!hasExplicitStartup(requestPayload) && options.defaultStartupMode === "idle") {
    nextPayload.startup = options.defaultIdleCommand;
  }

  if (!hasExplicitSsh(requestPayload) && options.defaultSshEnabled) {
    nextPayload.ssh = {
      enabled: true,
      listenPort: options.defaultSshListenPort,
    };
  }

  return workspaceBuildJobRequestPayloadSchema.parse(nextPayload);
};

export const processWorkspaceBuildJob = async (options: ProcessWorkspaceBuildJobOptions) => {
  const jobs = createWorkspaceBuildJobRepository(options.dbClient);
  const job = await jobs.claimJobById({
    id: options.jobId,
    workerId: options.workerId,
    leaseDurationMs: options.leaseDurationMs,
  });

  if (job === null) {
    return null;
  }

  try {
    const parsedRequestPayload = workspaceBuildJobRequestPayloadSchema.parse(job.requestPayload);
    const requestPayload = applyRuntimeDefaults(parsedRequestPayload, options);
    const blueprint = normalizeUserWorkspaceSpec(requestPayload);
    const executor = selectExecutorForBlueprint(blueprint, options.executors);
    const compileResult = await executor.compile({ blueprint });
    const imageArtifact = selectPublishableImageArtifact(compileResult);
    const publishedImage = await options.registryClient.publishOciImage({
      artifactPath: imageArtifact.path,
      repository: job.repository,
      tag: job.tag,
      ...(imageArtifact.reference === undefined
        ? {}
        : { sourceReference: imageArtifact.reference }),
    });
    const runtimeLaunchResult = await launchPublishedImage({
      blueprint,
      runtimeAdapters: options.runtimeAdapters,
      defaultRuntimeAdapterId: options.defaultRuntimeAdapterId,
      publishedImage,
    });
    const resultPayload: WorkspaceBuildJobResultPayload = {
      compile: compileResult,
      runtime: runtimeLaunchResult,
    };

    await jobs.markJobSucceeded({
      id: job.id,
      executorId: compileResult.executor.id,
      resultPayload,
      publishedReference: publishedImage.reference,
      publishedDigestReference: publishedImage.digestReference,
      publishedDigest: publishedImage.digest,
    });

    return publishedImage;
  } catch (error) {
    const errorCode = toErrorCode(error);

    await jobs.markJobFailed({
      id: job.id,
      errorMessage: toErrorMessage(error),
      ...(errorCode === undefined ? {} : { errorCode }),
    });

    throw error;
  }
};
