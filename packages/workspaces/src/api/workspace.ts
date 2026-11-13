import type { WorkspacePublication as PublicWorkspacePublication } from "@sealant/api-contracts";
import {
  LAUNCH_RETAINED_ERROR_CODE,
  type WorkspaceRuntimeInstance,
  type WorkspaceBuildJob,
} from "@sealant/db";
import { parsePersistedWorkspacePublication, type RuntimeAdapterId } from "@sealant/validators";

import { boatFailureInMessage, type BoatFailure } from "../runtime/boat/failure.js";
import {
  personLayoutCapability,
  type PersonLayoutCapability,
  type PersonLayoutContext,
} from "./person-layout.js";

export type WorkspaceStatus =
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "cancelled"
  | "stopped"
  | "retained";

export interface WorkspaceRuntimeDetails {
  readonly adapter: RuntimeAdapterId;
  readonly resourceId: string;
  readonly reference: string;
  readonly status: "pending" | "running" | "ready" | "failed" | "stopped" | "retained";
  readonly endpoint?: string;
  /**
   * ISO-8601 instant the runtime itself ends the executor (a Lambda MicroVM's maximum duration);
   * null where the runtime imposes no lifetime.
   */
  readonly deadline: string | null;
  /** The run (launch attempt) this executor belongs to. */
  readonly runId: string;
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
  /** Whether the image can run Mend's per-person layout here (see `personLayoutCapability`). */
  readonly personLayout?: PersonLayoutCapability;
}

export interface WorkspaceErrorDetails {
  readonly message: string;
  readonly code?: string;
  /** Why Boat refused the call that failed a Boat launch or image build (see `BoatFailure`). */
  readonly boat?: BoatFailure;
}

const withBoatFailure = (details: WorkspaceErrorDetails): WorkspaceErrorDetails => {
  const boat = boatFailureInMessage(details.message);
  return boat === undefined ? details : { ...details, boat };
};

/**
 * Whether the run's executor is RETAINED: kept, with its disk, because it holds work not
 * confirmed saved — it ended without a complete final flush (the drain record's `retained_at`),
 * or its capture launch failed after it started (`LAUNCH_RETAINED_ERROR_CODE`). The platform
 * still drains or recovers it with the capture token it was launched with; a caller must keep
 * what that needs (the session's lease and token) until the retention ends — the executor is
 * removed (saved, attested, discarded) or reported lost, and the status reads `stopped` or
 * `failed` again.
 */
export const executorIsRetained = (input: {
  readonly runtimeInstance?: WorkspaceRuntimeInstance | undefined;
  /** The run's `workspace_capture_drains.retained_at`. */
  readonly retainedAt?: Date | null | undefined;
  /** The run's `workspace_capture_drains.state`: what its last stop observed. */
  readonly captureDrainState?: string | null | undefined;
}): boolean => {
  const instance = input.runtimeInstance;
  if (instance === undefined || instance.resourceId === null) {
    return false;
  }
  if (input.retainedAt !== null && input.retainedAt !== undefined) {
    return true;
  }
  if (instance.status === "failed" && instance.errorCode === LAUNCH_RETAINED_ERROR_CODE) {
    return true;
  }
  return stopIsHeld({ runtimeInstance: instance, captureDrainState: input.captureDrainState });
};

/**
 * Whether a stop of the run was requested and its executor is still there, kept by the control
 * plane: its last stop ended without removing it (`kept`: its FINAL flush is not confirmed
 * complete, so it is kept until that is, or its owner discards it) or with its removal not
 * finished (`stop-failed`: its work is saved, and the runtime has not finished removing it, or
 * refused to). Reported as `retained`: such a workspace is not live (nothing new is admitted to
 * it) and not stopped (its executor exists, and is paid for). `captureDrain` says which, and
 * since when it was last observed.
 *
 * A stop that is still draining never reads this way: its record says `draining`, then `saved`,
 * then `stopped`, and neither `kept` nor `stop-failed` in between.
 *
 * For Boat only. Every other runtime reads a stop-requested executor as it always has (its own
 * status until it ends, `retained` once its retention is recorded).
 */
export const stopIsHeld = (input: {
  readonly runtimeInstance?: WorkspaceRuntimeInstance | undefined;
  readonly captureDrainState?: string | null | undefined;
}): boolean => {
  const instance = input.runtimeInstance;
  return (
    instance?.adapter === "boat" &&
    instance.resourceId !== null &&
    instance.stopReason !== null &&
    instance.status !== "stopped" &&
    (input.captureDrainState === "kept" || input.captureDrainState === "stop-failed")
  );
};

export const resolveWorkspaceStatus = (input: {
  readonly attempt: {
    readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  };
  readonly latestJob?: WorkspaceBuildJob;
  readonly runtimeInstance?: WorkspaceRuntimeInstance;
  /** `executorIsRetained` for the run: reported as `retained`, whatever else ended. */
  readonly retained?: boolean;
}): WorkspaceStatus => {
  const { attempt, latestJob, runtimeInstance } = input;

  // A RETAINED executor is not dead and not stopped: it is kept with its disk, and the platform
  // drains or recovers it (with the session's capture token) until its work is saved. Checked
  // first — its runtime row may already read `stopped` (a planned stop that ended incomplete) or
  // `failed` (an exit, a failed launch) — so no caller takes it for ended and lets go of what the
  // recovery needs.
  if (input.retained === true) {
    return "retained";
  }

  // A stopped runtime is terminal regardless of how the attempt ended: the container is gone
  // (user stop, TTL expiry, or a failure-path stop), so the workspace is "stopped". Checked
  // FIRST so a stop on a failed/cancelled attempt still resolves "stopped" — the SDK's blocking
  // stop() polls for exactly this value.
  if (runtimeInstance?.status === "stopped") {
    return "stopped";
  }

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

/** Where a launch that is not ready yet is (the wire's `workspacePhaseSchema`). */
export interface WorkspacePhaseDetails {
  readonly name: "queued" | "image-build" | "boot";
  readonly since?: string;
  readonly imageBuild?: {
    readonly step?: number;
    readonly steps?: number;
    readonly stepName?: string;
    readonly progressAt: string;
    readonly stallTimeoutMs?: number;
  };
}

/** `{ since }` from a row's instant, or nothing: a phase never fails a workspace read. */
const sinceOf = (instant: Date | null | undefined): { readonly since?: string } =>
  instant instanceof Date && !Number.isNaN(instant.getTime())
    ? { since: instant.toISOString() }
    : {};

/**
 * The launch phase of a workspace whose status is `queued` or `running`: waiting for a worker,
 * building its image (with the build's progress, when the builder reports it), or booting the
 * executor on a built image. Undefined for any other status: a ready or ended workspace is in no
 * launch phase.
 */
export const resolveWorkspacePhase = (input: {
  readonly status: WorkspaceStatus;
  readonly latestJob?: WorkspaceBuildJob;
  readonly runtimeInstance?: WorkspaceRuntimeInstance;
}): WorkspacePhaseDetails | undefined => {
  const { status, latestJob, runtimeInstance } = input;
  if (status !== "queued" && status !== "running") return undefined;
  if (latestJob === undefined || latestJob.status === "queued") {
    return {
      name: "queued",
      ...sinceOf(latestJob?.createdAt),
    };
  }
  if (latestJob.status === "running") {
    const progress = latestJob.progress ?? null;
    return {
      name: "image-build",
      ...sinceOf(latestJob.claimedAt ?? latestJob.startedAt),
      ...(progress === null
        ? {}
        : {
            imageBuild: {
              ...(progress.step === undefined ? {} : { step: progress.step }),
              ...(progress.steps === undefined ? {} : { steps: progress.steps }),
              ...(progress.stepName === undefined ? {} : { stepName: progress.stepName }),
              progressAt: progress.progressAt,
              ...(progress.stallTimeoutMs === undefined
                ? {}
                : { stallTimeoutMs: progress.stallTimeoutMs }),
            },
          }),
    };
  }
  // The image is built (the job succeeded): the executor is booting.
  return {
    name: "boot",
    ...sinceOf(runtimeInstance?.createdAt ?? latestJob.finishedAt),
  };
};

export const resolveWorkspaceRuntime = (
  runtimeInstance: WorkspaceRuntimeInstance | undefined,
  options: {
    readonly workspaceId?: string;
    readonly sshGateway?: WorkspaceSshGatewayConfig;
    /** `executorIsRetained` for the run: the runtime reads `retained`. */
    readonly retained?: boolean;
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
    status: options.retained === true ? "retained" : runtimeInstance.status,
    ...(endpoint === null || endpoint === undefined ? {} : { endpoint }),
    deadline: runtimeInstance.runtimeDeadlineAt?.toISOString() ?? null,
    runId: runtimeInstance.runId,
  };
};

/** Public publication facts omit private installation receipts and raw probe evidence. */
export const resolveWorkspacePublication = (
  job: WorkspaceBuildJob | undefined,
): PublicWorkspacePublication | undefined => {
  if (job === undefined) return undefined;
  const publication =
    job.publication ??
    parsePersistedWorkspacePublication({
      ...job,
      publication: null,
      evidence: job.resultPayload?.metadata ?? {},
    });
  if (publication === null) return undefined;
  if (publication.kind === "oci")
    return { kind: "oci", publicationId: publication.publicationId, image: publication.image };
  if (publication.kind === "microvm")
    return { kind: "microvm", publicationId: publication.publicationId, image: publication.image };
  const { recipeHash, receiptHash, assetsHash, runtime, daemonRecovery, executorRecovery } =
    publication.evidence;
  return {
    kind: "boat-native",
    publicationId: publication.publicationId,
    snapshot: {
      kind: "boat-saved-snapshot",
      owner: publication.snapshot.owner,
      build: publication.snapshot.build,
      recipeHash: publication.snapshot.recipeHash,
      receiptHash: publication.snapshot.receiptHash,
      identity: publication.snapshot.identity,
    },
    evidence: { recipeHash, receiptHash, assetsHash, runtime, daemonRecovery, executorRecovery },
  };
};

/** Legacy image coordinates are exposed only for real OCI publications. */
export const resolveWorkspacePublishedImage = (
  latestJob: WorkspaceBuildJob | undefined,
  /** Given, the image's per-person capability is derived for this runtime. */
  personLayout?: PersonLayoutContext,
): WorkspacePublishedImage | undefined => {
  const publication = resolveWorkspacePublication(latestJob);
  if (publication?.kind !== "oci") return undefined;

  return {
    reference: publication.image.reference,
    digestReference: publication.image.digestReference,
    digest: publication.image.digest,
    ...(personLayout === undefined
      ? {}
      : {
          personLayout: personLayoutCapability(
            latestJob?.resultPayload?.metadata?.imageProbe,
            personLayout,
          ),
        }),
  };
};

/**
 * The error a workspace read carries. The build job's error wins (it explains a launch that never
 * got a runtime); otherwise a runtime instance that ended `failed` after it was ready — the exit
 * the worker's reconciler observed — supplies its own, so the exit code reaches the caller.
 */
export const resolveWorkspaceError = (
  latestJob: WorkspaceBuildJob | undefined,
  runtimeInstance?: WorkspaceRuntimeInstance,
): WorkspaceErrorDetails | undefined => {
  if (latestJob !== undefined && latestJob.errorMessage !== null) {
    return withBoatFailure({
      message: latestJob.errorMessage,
      ...(latestJob.errorCode === null ? {} : { code: latestJob.errorCode }),
    });
  }

  if (runtimeInstance?.status === "failed" && runtimeInstance.errorMessage !== null) {
    return withBoatFailure({
      message: runtimeInstance.errorMessage,
      ...(runtimeInstance.errorCode === null ? {} : { code: runtimeInstance.errorCode }),
    });
  }

  return undefined;
};
