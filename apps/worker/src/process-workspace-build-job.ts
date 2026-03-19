import {
  createWorkspaceBuildJobRepository,
  workspaceBuildJobRequestPayloadSchema,
  type DatabaseClient,
} from "@sealant/db";
import type { NixOsExecutor } from "@sealant/os-integration-nix";
import type { RegistryClient } from "@sealant/registry-integration";
import type {
  OciImageBuildArtifact,
  OsExecutorCompileResult,
} from "@sealant/workspace-composition";
import { normalizeUserWorkspaceSpec } from "@sealant/workspace-composition";

export interface ProcessWorkspaceBuildJobOptions {
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly dbClient: DatabaseClient;
  readonly executor: NixOsExecutor;
  readonly registryClient: RegistryClient;
}

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
    const requestPayload = workspaceBuildJobRequestPayloadSchema.parse(job.requestPayload);
    const blueprint = normalizeUserWorkspaceSpec(requestPayload);
    const compileResult = await options.executor.compile({ blueprint });
    const imageArtifact = selectPublishableImageArtifact(compileResult);
    const publishedImage = await options.registryClient.publishOciImage({
      artifactPath: imageArtifact.path,
      repository: job.repository,
      tag: job.tag,
      ...(imageArtifact.reference === undefined
        ? {}
        : { sourceReference: imageArtifact.reference }),
    });

    await jobs.markJobSucceeded({
      id: job.id,
      executorId: compileResult.executor.id,
      resultPayload: compileResult,
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
