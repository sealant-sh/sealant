import type { WorkspaceRuntimeInstance, WorkspaceBuildJob } from "@sealant/db";

export type WorkspaceStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export interface WorkspaceRuntimeDetails {
  readonly adapter: "docker" | "k8s" | "k3s";
  readonly resourceId: string;
  readonly reference: string;
  readonly status: "pending" | "running" | "ready" | "failed" | "stopped";
  readonly endpoint?: string;
}

export interface WorkspaceSshGatewayConfig {
  readonly host: string;
  readonly port?: number;
  readonly usernamePrefix?: string;
}

export interface WorkspacePublishedImage {
  readonly reference: string;
  readonly digestReference: string;
  readonly digest: string;
}

export interface WorkspaceErrorDetails {
  readonly message: string;
  readonly code?: string;
}

export const resolveWorkspaceStatus = (input: {
  readonly attempt: {
    readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  };
  readonly latestJob?: WorkspaceBuildJob;
  readonly runtimeInstance?: WorkspaceRuntimeInstance;
}): WorkspaceStatus => {
  const { attempt, latestJob, runtimeInstance } = input;

  if (attempt.status === "cancelled") {
    return "cancelled";
  }

  if (attempt.status === "failed" || latestJob?.status === "failed") {
    return "failed";
  }

  if (runtimeInstance?.status === "failed") {
    return "failed";
  }

  if (
    attempt.status === "succeeded" &&
    (latestJob === undefined || latestJob.status === "succeeded") &&
    runtimeInstance?.status === "ready"
  ) {
    // Coarse "ready" is gated on the runtime being "ready" (control socket accepting), NOT merely
    // "running" (container up). This closes the readiness TOCTOU: the SDK's ready() trusts this.
    return "ready";
  }

  if (attempt.status === "running" || latestJob?.status === "running") {
    return "running";
  }

  return "queued";
};

export const resolveWorkspaceRuntime = (
  runtimeInstance: WorkspaceRuntimeInstance | undefined,
  options: {
    readonly workspaceId?: string;
    readonly sshGateway?: WorkspaceSshGatewayConfig;
  } = {},
): WorkspaceRuntimeDetails | undefined => {
  // If runtime metadata is incomplete we omit runtime from API response.
  if (
    runtimeInstance === undefined ||
    runtimeInstance.adapter === null ||
    runtimeInstance.resourceId === null ||
    runtimeInstance.reference === null
  ) {
    return undefined;
  }

  const gatewayHost = options.sshGateway?.host.trim();
  // If gateway config is present, we intentionally mask the raw runtime endpoint and
  // return a stable gateway address instead. This avoids exposing per-workspace IP/port
  // details and gives clients a consistent connection target.
  const shouldUseGateway =
    runtimeInstance.endpoint !== null &&
    options.workspaceId !== undefined &&
    gatewayHost !== undefined &&
    gatewayHost.length > 0;
  const gatewayPort = options.sshGateway?.port ?? 22;
  const gatewayUsernamePrefix = options.sshGateway?.usernamePrefix?.trim() || "ws";
  const gatewayUsername =
    options.workspaceId === undefined
      ? undefined
      : `${gatewayUsernamePrefix}-${options.workspaceId}`;
  const formattedGatewayHost =
    gatewayHost === undefined || !gatewayHost.includes(":") ? gatewayHost : `[${gatewayHost}]`;
  const endpoint =
    shouldUseGateway && gatewayUsername !== undefined && formattedGatewayHost !== undefined
      ? `ssh://${gatewayUsername}@${formattedGatewayHost}:${gatewayPort}`
      : runtimeInstance.endpoint;

  return {
    adapter: runtimeInstance.adapter,
    resourceId: runtimeInstance.resourceId,
    reference: runtimeInstance.reference,
    status: runtimeInstance.status,
    ...(endpoint === null || endpoint === undefined ? {} : { endpoint }),
  };
};

export const resolveWorkspacePublishedImage = (
  latestJob: WorkspaceBuildJob | undefined,
): WorkspacePublishedImage | undefined => {
  if (latestJob === undefined) {
    return undefined;
  }

  if (
    latestJob.publishedReference === null ||
    latestJob.publishedDigestReference === null ||
    latestJob.publishedDigest === null
  ) {
    return undefined;
  }

  return {
    reference: latestJob.publishedReference,
    digestReference: latestJob.publishedDigestReference,
    digest: latestJob.publishedDigest,
  };
};

export const resolveWorkspaceError = (
  latestJob: WorkspaceBuildJob | undefined,
): WorkspaceErrorDetails | undefined => {
  if (latestJob?.errorMessage === null || latestJob === undefined) {
    return undefined;
  }

  return {
    message: latestJob.errorMessage,
    ...(latestJob.errorCode === null ? {} : { code: latestJob.errorCode }),
  };
};
