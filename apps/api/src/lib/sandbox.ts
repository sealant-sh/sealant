import type { SandboxRuntimeInstance, WorkspaceBuildJob } from "@sealant/db";

export type SandboxStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export interface SandboxRuntimeDetails {
  readonly adapter: "docker" | "k8s" | "k3s";
  readonly resourceId: string;
  readonly reference: string;
  readonly status: "pending" | "running" | "failed" | "stopped";
  readonly endpoint?: string;
}

export interface SandboxSshGatewayConfig {
  readonly host: string;
  readonly port?: number;
  readonly usernamePrefix?: string;
}

export interface SandboxPublishedImage {
  readonly reference: string;
  readonly digestReference: string;
  readonly digest: string;
}

export interface SandboxErrorDetails {
  readonly message: string;
  readonly code?: string;
}

export const resolveSandboxStatus = (input: {
  readonly attempt: {
    readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  };
  readonly latestJob?: WorkspaceBuildJob;
  readonly runtimeInstance?: SandboxRuntimeInstance;
}): SandboxStatus => {
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
    runtimeInstance?.status === "running"
  ) {
    return "ready";
  }

  if (attempt.status === "running" || latestJob?.status === "running") {
    return "running";
  }

  return "queued";
};

export const resolveSandboxRuntime = (
  runtimeInstance: SandboxRuntimeInstance | undefined,
  options: {
    readonly sandboxId?: string;
    readonly sshGateway?: SandboxSshGatewayConfig;
  } = {},
): SandboxRuntimeDetails | undefined => {
  if (
    runtimeInstance === undefined ||
    runtimeInstance.adapter === null ||
    runtimeInstance.resourceId === null ||
    runtimeInstance.reference === null
  ) {
    return undefined;
  }

  const gatewayHost = options.sshGateway?.host.trim();
  const shouldUseGateway =
    runtimeInstance.endpoint !== null &&
    options.sandboxId !== undefined &&
    gatewayHost !== undefined &&
    gatewayHost.length > 0;
  const gatewayPort = options.sshGateway?.port ?? 22;
  const gatewayUsernamePrefix = options.sshGateway?.usernamePrefix?.trim() || "sbx";
  const gatewayUsername =
    options.sandboxId === undefined ? undefined : `${gatewayUsernamePrefix}-${options.sandboxId}`;
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

export const resolveSandboxPublishedImage = (
  latestJob: WorkspaceBuildJob | undefined,
): SandboxPublishedImage | undefined => {
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

export const resolveSandboxError = (
  latestJob: WorkspaceBuildJob | undefined,
): SandboxErrorDetails | undefined => {
  if (latestJob?.errorMessage === null || latestJob === undefined) {
    return undefined;
  }

  return {
    message: latestJob.errorMessage,
    ...(latestJob.errorCode === null ? {} : { code: latestJob.errorCode }),
  };
};
