import { randomUUID, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";

import {
  type InspectWorkspaceImageRequest,
  type InspectWorkspaceImageResponse,
  PROCESS_USER_UNSUPPORTED_CODE,
  type BindWorkspaceRequest,
  type FlushWorkspaceCaptureRequest,
  type GetWorkspaceCaptureStatusQuery,
  type ReplanWorkspaceCaptureRequest,
  WorkspaceBadGatewayError,
  isOciRepository,
  isOciTag,
  OCI_REPOSITORY_MESSAGE,
  WorkspaceBadRequestError,
  WorkspaceDockerServiceUnsupportedError,
  WorkspaceRuntimeEnvReferencesUnsupportedError,
  WorkspaceConflictError,
  WorkspaceForbiddenError,
  WorkspaceInternalServerError,
  WorkspaceNotFoundError,
  WorkspaceServiceUnavailableError,
  WorkspaceUnauthorizedError,
  type CreateWorkspaceHeaders,
  type CreateWorkspaceRequest,
  type CancelWorkspaceCreateRequest,
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
  type ClearWorkspaceSshUserQuery,
  type ClearWorkspaceSshUserResponse,
  execRunHarnessId,
  type ExecWorkspaceRequest,
  type ExpireWorkspaceRequest,
  type ExpireWorkspaceResponse,
  type RecoverWorkspaceRequest,
  type RecoverWorkspaceResponse,
  type RestartWorkspaceRequest,
  type RestartWorkspaceResponse,
  type StopWorkspaceRequest,
  type StopWorkspaceResponse,
  type WorkspaceCreateState,
  type WorkspaceAttemptSummary,
  type WorkspaceCaptureDrain,
  type WorkspaceDetails,
  type WorkspaceEvent,
  type WorkspaceEventType,
  type WorkspaceGatewayHeaders,
  type WorkspaceSshTarget,
  type WorkspaceSummary,
} from "@sealant/api-contracts";
import {
  CAPTURE_OWNER_MAP_ENV,
  encodeCaptureOwnerMap,
} from "@sealant/api-contracts/capture-owner-map";
import {
  CAPTURE_TOKEN_SECRET_ENV_NAME,
  formatWorkspaceEnvIssue,
  parseWorkspaceSecretEnv,
} from "@sealant/api-contracts/workspace-environment";
import {
  connectedAccountProviders,
  createConnectedAccountRef,
  CredentialCipher,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  GitHubInstallationRepo,
  GitHubInstallationRepositoryCacheRepo,
  ProfileRepo,
  RunRepo,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceCaptureDrainRepo,
  WorkspaceCreateReservationRepo,
  DatabaseTransaction,
  executorOriginFromStored,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccount,
  type WorkspaceCaptureDrain as WorkspaceCaptureDrainRecord,
} from "@sealant/db";
import {
  GitHubSourceIntegrationService,
  createGitHubInstallationRepositoryAuthRef,
} from "@sealant/source-integrations";
import {
  type RuntimeAdapterId,
  newWorkspaceSchema,
  workspaceBindSchema,
  workspaceDotfilesArchiveSchema,
  type NewWorkspace,
} from "@sealant/validators";
import {
  personLayoutCapability,
  PROCESS_USER_RANGE_RULE,
  processUserCapability,
  processUserProblem,
  type ProcessUserChannel,
  planWorkspaceImageBuild,
  type PersonLayoutContext,
  homePathProblem,
  attestationCoversObservations,
  captureFlushAnswer,
  captureStatusAnswer,
  CaptureObservationUnrecordedError,
  OBSERVATION_FENCE_MARGIN_MS,
  type CaptureObservationRecorder,
  observedCaptureFromStored,
  storedCaptureStatus,
  bindRootMountPath,
  runtimeRestartsRetainedExecutors,
  UnknownWorkspacePackageError,
  unknownWorkspacePackageIds,
  SealantRuntime,
  type CaptureFlushRequest,
  type SealantError,
  type SealantSession,
  type SealantTarget,
  resolveWorkspaceError,
  resolveWorkspacePublishedImage,
  resolveWorkspaceRuntime,
  resolveWorkspacePhase,
  resolveWorkspaceStatus,
  executorIsRetained,
  type WorkspaceSshGatewayConfig,
} from "@sealant/workspaces";
import { Cause, type Context, Effect, Result } from "effect";
import { z } from "zod";

import { resolveWorkspaceSshGatewayConfig } from "../../lib/workspace-ssh-gateway.js";
import { env } from "../../runtime-env.js";
import {
  RunExecPublisherService,
  WorkspaceBuildJobPublisherService,
  WorkspaceLifecyclePublisherService,
} from "../../services/control-plane-capabilities.js";
import { requireLiveWorkspaceRoom, spendOwnerLaunch } from "../../services/owner-budgets.js";
import { OWNER_REQUIRED_HINT, resolveOwnerScope, scopeAdmits } from "../../services/owner-scope.js";
import {
  checkProcessUser,
  processUserNameRefusal,
  processUserOnLegacyRoute,
} from "../process-user.js";
import { mapRun } from "../runs/runs.module.js";
import { resolveDaemonInstance, resolveDaemonTarget } from "../sessions/sessions.module.js";
import { validateClientSuppliedAuthRefs } from "./client-authrefs.js";
import { resolveSelectedConnectedAccount } from "./connected-account-selection.js";
import {
  captureDestinationRefusal,
  gitHubWebHostOf,
  parseAllowedCaptureOrigins,
} from "./credential-destinations.js";

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

/**
 * Every error the chain holds: each `cause`, and each failure and defect of an Effect `Cause` on
 * the way (a Drizzle query error carries the driver's error inside one).
 */
const errorChain = (error: unknown, depth = 0): readonly unknown[] => {
  if (depth > 12 || typeof error !== "object" || error === null) {
    return [error];
  }
  const nested: unknown[] = [];
  if (Cause.isCause(error)) {
    for (const reason of error.reasons) {
      if (Cause.isFailReason(reason)) nested.push(reason.error);
      if (Cause.isDieReason(reason)) nested.push(reason.defect);
    }
  } else if (isObjectWithCause(error)) {
    nested.push(error.cause);
  }
  return [error, ...nested.flatMap((next) => errorChain(next, depth + 1))];
};

/** Whether a Postgres error with this SQLSTATE is anywhere in the cause chain. */
const errorHasSqlState = (error: unknown, code: string): boolean =>
  errorChain(error).some(
    (entry) =>
      typeof entry === "object" && entry !== null && "code" in entry && entry.code === code,
  );

const isForeignKeyConstraintError = (error: unknown): boolean => {
  return (
    errorHasSqlState(error, "23503") ||
    errorIncludes(error, "FOREIGN KEY constraint failed") ||
    errorIncludes(error, "violates foreign key constraint")
  );
};

/** A unique index refused the write: Postgres `23505`, or SQLite's wording. */
export const isUniqueConstraintError = (error: unknown): boolean => {
  return (
    errorHasSqlState(error, "23505") ||
    errorIncludes(error, "UNIQUE constraint failed") ||
    errorIncludes(error, "duplicate key value violates unique constraint")
  );
};

/** The runtime an image's per-person capability is answered for, and its ACL support. */
const personLayoutContext = (
  /** The workspace's own runtime when it has one; the deployment's default otherwise. */
  adapter?: RuntimeAdapterId | null,
): PersonLayoutContext => ({
  runtime: adapter ?? env.DEFAULT_RUNTIME_ADAPTER,
  acl: env.SEALANT_WORKSPACE_ACLS,
});

export const parseWorkspaceSpec = (spec: unknown) => {
  const parsed = newWorkspaceSchema.safeParse(spec);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]?.message;
    return Effect.fail(
      new WorkspaceBadRequestError({
        message: firstIssue ?? "Workspace spec is invalid.",
      }),
    );
  }

  // A launch's logins go into its credentialsHome (§6d): the same rules as any home, on a runtime
  // that can write them there (not Cloudflare, whose bridge writes at $HOME only).
  const credentialsHome = parsed.data.runtime.credentialsHome;
  const family =
    parsed.data.target.runtime.family === "auto"
      ? env.DEFAULT_RUNTIME_ADAPTER
      : parsed.data.target.runtime.family;
  if (credentialsHome !== undefined && family === "cloudflare") {
    return Effect.fail(
      new WorkspaceBadRequestError({
        message:
          "credentialsHome is not available on the Cloudflare runtime: its bridge writes logins at $HOME only.",
      }),
    );
  }
  // An owner map makes the executor a per-person one; only the capture source states it, and only
  // where its people's sudo can work and an image can report that its daemon applies it: not
  // Cloudflare's sandboxes, not Kubernetes Pods (no-new-privileges enforced by the kubelet).
  const source = parsed.data.sources.workspace;
  if (source.kind === "capture" && source.ownerMap !== undefined && family === "cloudflare") {
    return Effect.fail(
      new WorkspaceBadRequestError({
        message:
          "source.ownerMap is not available on the Cloudflare runtime: its sandboxes record no per-person capability.",
      }),
    );
  }
  if (
    source.kind === "capture" &&
    source.ownerMap !== undefined &&
    (family === "k8s" || family === "k3s")
  ) {
    return Effect.fail(
      new WorkspaceBadRequestError({
        message: `source.ownerMap is not available on the ${family} runtime: workspace Pods run with allowPrivilegeEscalation: false, so the kubelet sets no-new-privileges and no person's sudo could work.`,
      }),
    );
  }
  if (Object.hasOwn(parsed.data.runtime.env, CAPTURE_OWNER_MAP_ENV)) {
    return Effect.fail(
      new WorkspaceBadRequestError({
        message: `runtime.env may not name ${CAPTURE_OWNER_MAP_ENV}: the owner map is source.ownerMap on a capture source.`,
      }),
    );
  }
  const homeProblem =
    credentialsHome === undefined ? undefined : homePathProblem(credentialsHome.path);
  if (credentialsHome !== undefined && homeProblem !== undefined) {
    return Effect.fail(
      new WorkspaceBadRequestError({
        message: `credentialsHome '${credentialsHome.path}': ${homeProblem}`,
      }),
    );
  }

  return Effect.succeed(parsed.data);
};

/**
 * The spec as the attempt snapshot records it. The snapshot backs sync-backs and the workspace
 * detail view; the dotfiles archive payloads (multi-MB base64 of the caller's shell configs)
 * belong only in the build job payload the worker consumes, not in the durable, API-visible
 * snapshot.
 */
const snapshotSpecOf = (spec: NewWorkspace): NewWorkspace =>
  spec.runtime.dotfilesArchives.length === 0
    ? spec
    : { ...spec, runtime: { ...spec.runtime, dotfilesArchives: [] } };

const recordedDotfilesArchivesSchema = z.object({
  runtime: z
    .object({ dotfilesArchives: z.array(workspaceDotfilesArchiveSchema).default([]) })
    .prefault({}),
});

/**
 * The dotfiles archives a previous launch carried, read from its build job payload: the one
 * place they are kept (see `snapshotSpecOf`). Only this field is read, so an unrelated change to
 * the spec schema since that launch cannot cost a relaunch its dotfiles.
 */
const recordedDotfilesArchives = (workspaceId: string, jobPayload: unknown) => {
  const parsed = recordedDotfilesArchivesSchema.safeParse(jobPayload);
  if (!parsed.success) {
    return Effect.fail(
      new WorkspaceConflictError({
        message: `Workspace ${workspaceId} cannot be restarted: the dotfiles archives its last launch recorded do not parse (${parsed.error.issues[0]?.message ?? "invalid"}).`,
      }),
    );
  }
  return Effect.succeed(parsed.data.runtime.dotfilesArchives);
};

/**
 * A capture source's session channel must be a destination this install hands a session token
 * to: an approved origin when the operator pinned any, and a transport the daemon will dial.
 */
const validateCaptureDestination = (spec: NewWorkspace) =>
  Effect.gen(function* () {
    const source = spec.sources.workspace;
    if (source.kind !== "capture") return;
    const allowedOrigins = parseAllowedCaptureOrigins(env.SEALANT_CAPTURE_ALLOWED_ENDPOINTS);
    if (allowedOrigins === null) {
      return yield* new WorkspaceInternalServerError({
        message:
          "SEALANT_CAPTURE_ALLOWED_ENDPOINTS must be comma-separated http(s) origins with no path.",
      });
    }
    if (source.transport !== undefined && env.DEFAULT_RUNTIME_ADAPTER === "cloudflare") {
      // The adapter refuses it at launch, after the token is sealed and an image is built.
      return yield* new WorkspaceBadRequestError({
        message:
          "The cloudflare runtime dials the capture channel over https with the public roots; source.transport is not supported.",
      });
    }
    const refusal = captureDestinationRefusal({
      endpoint: source.endpoint,
      plaintext: source.transport?.plaintext === true,
      allowedOrigins,
      refusePlaintext: env.SEALANT_CAPTURE_REFUSE_PLAINTEXT,
    });
    if (refusal !== null) {
      return yield* new WorkspaceForbiddenError({ message: refusal });
    }
  });

/**
 * The capture source's session credential (sealantd ADR-0015) is the one secret the create request
 * carries outside `secretEnv`: required exactly when the workspace source is `capture`, and sealed
 * into the same channel under its platform-owned name. Pairing is enforced here so a token can
 * never be sealed for a source that would not consume it, and a capture source never launches
 * without one (the daemon would fail boot with no channel credential, late and unreadable).
 */
const resolveCaptureSecretEnv = (input: {
  readonly spec: NewWorkspace;
  readonly captureToken: string | undefined;
}) =>
  Effect.gen(function* () {
    const isCapture = input.spec.sources.workspace.kind === "capture";
    if (isCapture && input.captureToken === undefined) {
      return yield* new WorkspaceBadRequestError({
        message:
          "A capture-sourced workspace needs `captureToken`: the session credential the daemon registers with.",
      });
    }
    if (!isCapture && input.captureToken !== undefined) {
      return yield* new WorkspaceBadRequestError({
        message: "`captureToken` applies only to a capture workspace source.",
      });
    }
    return input.captureToken === undefined
      ? {}
      : { [CAPTURE_TOKEN_SECRET_ENV_NAME]: input.captureToken };
  });

/**
 * Validate and seal the create-request `secretEnv` (the transient secret channel) together with
 * the platform-owned entries the control plane adds beside it. Rejections carry the policy's
 * value-free wording; nothing to seal yields undefined. Sealing uses the same credential cipher
 * as connected accounts, so the row is unreadable without the install's key.
 */
const sealSecretEnv = (
  secretEnv: Readonly<Record<string, string>> | undefined,
  platformSecretEnv: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    let callerEnv: Readonly<Record<string, string>> = {};
    if (secretEnv !== undefined && Object.keys(secretEnv).length > 0) {
      const parsed = parseWorkspaceSecretEnv(secretEnv);
      if (!parsed.ok) {
        return yield* new WorkspaceBadRequestError({
          message: `secretEnv was rejected: ${parsed.issues.map(formatWorkspaceEnvIssue).join("; ")}`,
        });
      }
      callerEnv = parsed.env;
    }
    const merged = { ...callerEnv, ...platformSecretEnv };
    if (Object.keys(merged).length === 0) {
      return undefined;
    }
    const cipher = yield* CredentialCipher;
    const sealed = yield* cipher.encrypt(JSON.stringify(merged)).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceInternalServerError({
            message: `Could not seal secretEnv for launch: ${error.message}`,
          }),
      ),
    );
    return sealed.sealed;
  });

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
  const source = spec.sources.workspace;
  if (source.kind !== "git") {
    return undefined;
  }
  const ref = source.ref?.trim() ?? "";
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
      return "stopped";
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

const parseRequestedOsFamily = (
  spec: NewWorkspace,
): "auto" | "arch" | "fedora" | "nix" | "ubuntu" | "custom" => {
  return spec.target.os.family;
};

/**
 * A managed family needs a named target for its packages. The ids themselves are checked against
 * the catalog when the request arrives and stay catalog ids in the spec: the image planner maps
 * each one to its family's own names. Rewriting them here to one family's names (`python3`, `gh`)
 * handed the planner names the catalog does not know, and every nix, Fedora and Ubuntu image that
 * asked for `python` or `github-cli` failed to build (alpha, 2026-09-25).
 */
const packageTargetRefusal = (spec: NewWorkspace): string | undefined =>
  parseRequestedPackageIds(spec).length > 0 && parseRequestedOsFamily(spec) === "auto"
    ? "Package validation requires an explicit target OS. Set spec.target.os.family to arch, fedora, nix, or ubuntu for this request."
    : undefined;

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
    // The same host `validateClientSuppliedAuthRefs` binds the ref to, so a rerun that resubmits
    // this minted spec passes on GitHub Enterprise Server as it does on github.com.
    url: `https://${gitHubWebHostOf(env.GITHUB_API_BASE_URL)}/${input.fullName}.git`,
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
    // The same host `validateClientSuppliedAuthRefs` binds the ref to, so a rerun that resubmits
    // this minted spec passes on GitHub Enterprise Server as it does on github.com.
    url: `https://${gitHubWebHostOf(env.GITHUB_API_BASE_URL)}/${input.fullName}.git`,
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

// Mirrors the daemon's `is_proper_descendant`: component-boundary prefix, equality rejected —
// mounting an entire store root as a workspace is always a configuration error. Both sides are
// schema-guaranteed absolute + normalized (no "..", no "//", no trailing slash).
const isProperDescendant = (path: string, root: string): boolean =>
  path !== root && path.startsWith(`${root}/`);

// Container paths an extra mount must never shadow: the working directory (the reviewable work
// product lands there; docker would also create root-owned dirs inside the caller-owned primary
// mount) and the daemon's control-socket dir. Overlap in either direction is rejected.
const pathsOverlap = (a: string, b: string): boolean =>
  a === b || isProperDescendant(a, b) || isProperDescendant(b, a);

const SEALANTD_CONTROL_DIR = "/run/sealant";

/**
 * Mount policy gate — the primary mount source and the additional `sources.mounts` alike. Mounts
 * bind a caller-named HOST path into the container, which is an escalation surface — so every host
 * path must be a proper descendant of an operator-configured allowlist root
 * (`SEALANT_MOUNT_ALLOWED_STORE_ROOTS`, the same knob the in-container daemon re-enforces at boot
 * for the primary mount). No allowlist configured = every mount is rejected. Mirrors the
 * credentialRefs rule: the caller's spec is never trusted on its own. Extra mounts additionally
 * carry a caller-named CONTAINER path, checked here against the resolved working directory.
 * A capture harness home is executor-local rather than mounted, but it is checked here against the
 * working directory, daemon control directory, and extra mount targets. Only the parsed spec knows
 * the runtime defaults needed for those checks.
 */
const validateWorkspaceMounts = (input: {
  readonly spec: NewWorkspace;
  readonly sourceSelection: GitHubWorkspaceSourceSelection | undefined;
}) => {
  return Effect.gen(function* () {
    const source = input.spec.sources.workspace;
    const extraMounts = input.spec.sources.mounts;
    if (source.kind !== "git" && input.sourceSelection !== undefined) {
      return yield* new WorkspaceBadRequestError({
        message:
          "A mount-, standby- or capture-sourced workspace cannot also carry a GitHub source selection.",
      });
    }
    const workingDirectory = input.spec.runtime.workingDirectory;
    const normalizedWorkingDirectory = posix.normalize(workingDirectory).replace(/\/+$/, "") || "/";
    if (source.kind === "capture" && source.harnessHome !== undefined) {
      const harnessHome = source.harnessHome;
      if (pathsOverlap(harnessHome, normalizedWorkingDirectory)) {
        return yield* new WorkspaceBadRequestError({
          message: `Capture harness home overlaps the working directory (${workingDirectory}): ${harnessHome}`,
        });
      }
      if (pathsOverlap(harnessHome, SEALANTD_CONTROL_DIR)) {
        return yield* new WorkspaceBadRequestError({
          message: `Capture harness home overlaps the daemon control dir (${SEALANTD_CONTROL_DIR}): ${harnessHome}`,
        });
      }
      const overlappingMountTarget = extraMounts
        .flatMap((mount) =>
          mount.bindable
            ? [mount.mountPath, bindRootMountPath(mount.mountPath)]
            : [mount.mountPath],
        )
        .find((mountPath) => pathsOverlap(harnessHome, mountPath));
      if (overlappingMountTarget !== undefined) {
        return yield* new WorkspaceBadRequestError({
          message: `Capture harness home overlaps an extra mount target (${overlappingMountTarget}): ${harnessHome}`,
        });
      }
    }
    // A standby root (sealantd ADR-0014) is a caller-owned host directory like any mount: the same
    // allowlist applies, and the daemon re-checks it at boot. Git and capture sources name no host
    // path at all, so with no extra mounts there is nothing for the allowlist to gate.
    const hostPaths = [
      ...(source.kind === "mount" ? [source.hostPath] : []),
      ...(source.kind === "standby" ? [source.rootPath] : []),
      ...extraMounts.map((mount) => mount.hostPath),
    ];
    if (hostPaths.length === 0) {
      return;
    }
    const allowedRoots = (env.SEALANT_MOUNT_ALLOWED_STORE_ROOTS ?? "")
      .split(":")
      .map((root) => root.trim())
      .filter((root) => root.length > 0);
    if (allowedRoots.length === 0) {
      return yield* new WorkspaceForbiddenError({
        message:
          "Workspace mounts are not enabled on this install (set SEALANT_MOUNT_ALLOWED_STORE_ROOTS).",
      });
    }
    const invalidRoot = allowedRoots.find(
      (root) => !root.startsWith("/") || root.split("/").some((s) => s === "." || s === ".."),
    );
    if (invalidRoot !== undefined) {
      return yield* new WorkspaceInternalServerError({
        message: `SEALANT_MOUNT_ALLOWED_STORE_ROOTS contains an invalid root: ${invalidRoot}`,
      });
    }
    for (const hostPath of hostPaths) {
      if (!allowedRoots.some((root) => isProperDescendant(hostPath, root.replace(/\/+$/, "")))) {
        return yield* new WorkspaceForbiddenError({
          message: `Mount path is not a proper descendant of an allowed store root: ${hostPath}`,
        });
      }
    }
    const seenMountPaths = new Set<string>();
    for (const mount of extraMounts) {
      if (pathsOverlap(mount.mountPath, normalizedWorkingDirectory)) {
        return yield* new WorkspaceBadRequestError({
          message: `Extra mount path overlaps the working directory (${workingDirectory}): ${mount.mountPath}`,
        });
      }
      if (pathsOverlap(mount.mountPath, SEALANTD_CONTROL_DIR)) {
        return yield* new WorkspaceBadRequestError({
          message: `Extra mount path overlaps the daemon control dir (${SEALANTD_CONTROL_DIR}): ${mount.mountPath}`,
        });
      }
      if (seenMountPaths.has(mount.mountPath)) {
        return yield* new WorkspaceBadRequestError({
          message: `Duplicate extra mount path: ${mount.mountPath}`,
        });
      }
      seenMountPaths.add(mount.mountPath);
    }
  });
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

      if (explicit === undefined) {
        const bound = profileBound.get(provider);

        // A binding pointing at an unusable account (archived, or invalidated by a 401) is
        // effectively disconnected — skip it rather than fail every launch that uses this profile
        // (surfaces show it as "needs reconnect"). Only an explicitly-named account hard-fails.
        if (bound === undefined || bound.archivedAt !== null || bound.status !== "active") {
          continue;
        }

        account = bound;
      } else {
        // Explicit selection: uniform 404 for an account the caller cannot name, 409 for a
        // broken one (shared with the credential switch).
        account = yield* resolveSelectedConnectedAccount({
          ownerUserId: input.ownerUserId,
          provider,
          selection: explicit,
        });
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
  retained: boolean,
): WorkspaceAttemptSummary => {
  const runtime = resolveWorkspaceRuntime(runtimeInstance, {
    workspaceId: link.workspaceId,
    ...(sshGatewayConfig === undefined ? {} : { sshGateway: sshGatewayConfig }),
    retained,
  });
  const publishedImage = resolveWorkspacePublishedImage(
    latestJob,
    personLayoutContext(runtimeInstance?.adapter),
  );
  const error = resolveWorkspaceError(latestJob, runtimeInstance);
  const startedAt = attempt.startedAt ?? latestJob?.startedAt;
  const finishedAt = attempt.finishedAt ?? latestJob?.finishedAt;

  return {
    attemptId: attempt.id,
    relation: link.relation,
    status: resolveWorkspaceStatus({
      attempt,
      ...(latestJob === undefined ? {} : { latestJob }),
      ...(runtimeInstance === undefined ? {} : { runtimeInstance }),
      retained,
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
  /** `executorIsRetained` for the latest run: status and runtime read `retained`. */
  retained: boolean,
): WorkspaceSummary => {
  const resolvedRuntime = resolveWorkspaceRuntime(runtimeInstance, {
    workspaceId: workspace.id,
    ...(sshGatewayConfig === undefined ? {} : { sshGateway: sshGatewayConfig }),
    retained,
  });
  // The executor carries the launch identity its create named (recorded on its attempt).
  const launchId =
    attempt !== undefined && attempt.id === runtimeInstance?.runId ? attempt.launchId : null;
  const runtime =
    resolvedRuntime === undefined || launchId === null
      ? resolvedRuntime
      : { ...resolvedRuntime, launchId };
  const publishedImage = resolveWorkspacePublishedImage(
    latestJob,
    personLayoutContext(runtimeInstance?.adapter),
  );
  // From the sealantd of the image the latest launch built; the exec or session asks the daemon.
  const processUser =
    latestJob === undefined
      ? undefined
      : processUserCapability(
          latestJob.resultPayload?.metadata?.imageProbe,
          runtimeInstance?.adapter ?? env.DEFAULT_RUNTIME_ADAPTER,
        );
  const error = resolveWorkspaceError(latestJob, runtimeInstance);
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
          retained,
        });
  const phase = resolveWorkspacePhase({
    status,
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
    ...(processUser === undefined ? {} : { processUser }),
    ...(error === undefined ? {} : { error }),
    ...(phase === undefined ? {} : { phase }),
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    ...(toIsoString(startedAt) === undefined ? {} : { startedAt: toIsoString(startedAt) }),
    ...(toIsoString(finishedAt) === undefined ? {} : { finishedAt: toIsoString(finishedAt) }),
    ...(workspace.expiresAt === null ? {} : { expiresAt: workspace.expiresAt.toISOString() }),
  };
};

const mapWorkspaceDetails = (
  workspace: WorkspaceRecord,
  attempt: WorkspaceAttemptRecord | undefined,
  latestJob: WorkspaceBuildJobRecord,
  runtimeInstance: WorkspaceRuntimeInstanceRecord,
  attemptSnapshot: WorkspaceAttemptSnapshotRecord,
  sshGatewayConfig: WorkspaceSshGatewayConfig | undefined,
  retained: boolean,
): WorkspaceDetails => {
  const summary = mapWorkspaceSummary(
    workspace,
    attempt,
    latestJob,
    runtimeInstance,
    sshGatewayConfig,
    retained,
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

/**
 * The answer to a create that repeats an earlier one's idempotency key: that workspace, as it is
 * now — its status, its latest run, and its executor once one exists — marked `replayed`.
 */
const replayedWorkspaceResponse = (workspace: WorkspaceRecord) => {
  return Effect.gen(function* () {
    const runId = workspace.latestRunId ?? undefined;
    const attempt =
      runId === undefined
        ? undefined
        : yield* withInternalError(
            (yield* WorkspaceAttemptRepo).getAttemptById(runId),
            "Failed to load the workspace attempt.",
          );
    const latestJob =
      runId === undefined
        ? undefined
        : yield* withInternalError(
            (yield* WorkspaceBuildJobRepo).getLatestJobByRunId(runId),
            "Failed to load the workspace build job.",
          );
    const runtimeInstance =
      runId === undefined
        ? undefined
        : yield* withInternalError(
            (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(runId),
            "Failed to load the workspace runtime.",
          );
    const drain =
      runId === undefined
        ? undefined
        : yield* withInternalError(
            (yield* WorkspaceCaptureDrainRepo).getByRunId(runId),
            "Failed to load the workspace capture drain.",
          );
    const summary = mapWorkspaceSummary(
      workspace,
      attempt,
      latestJob,
      runtimeInstance,
      resolveWorkspaceSshGatewayConfig(),
      executorIsRetained({ runtimeInstance, retainedAt: drain?.retainedAt }),
    );
    const response: CreateWorkspaceResponse = {
      workspaceId: workspace.id,
      name: summary.name,
      status: summary.status,
      registryId: latestJob?.registryId ?? env.REGISTRY_NAME,
      repository: latestJob?.repository ?? summary.repository ?? workspace.id,
      tag: latestJob?.tag ?? summary.tag ?? "latest",
      ...(runId === undefined ? {} : { runId }),
      ...(summary.runtime === undefined ? {} : { runtime: summary.runtime }),
      replayed: true,
    };
    return response;
  });
};

/**
 * Whether a workspace an idempotent create made finished its create: it names a latest run and
 * that run has its launch job. A create commits the workspace, its attempt, the link, the
 * snapshot and the job in one transaction, so only a workspace from before that (a create that
 * died between its separate writes) can be half-made.
 */
const workspaceCreateFinished = (workspace: WorkspaceRecord) =>
  Effect.gen(function* () {
    const runId = workspace.latestRunId;
    if (runId === null) {
      return false;
    }
    const job = yield* withInternalError(
      (yield* WorkspaceBuildJobRepo).getLatestJobByRunId(runId),
      "Failed to load the workspace build job.",
    );
    return job !== undefined;
  });

/**
 * A replay finds the create committed. Its launch job may still be `queued` because the process
 * died between the commit and the queue publish: publishing again is safe (the worker claims a
 * job once) and is the only thing that moves it.
 */
const republishQueuedLaunch = (workspace: WorkspaceRecord) =>
  Effect.gen(function* () {
    const runId = workspace.latestRunId;
    if (runId === null) {
      return;
    }
    const job = yield* withInternalError(
      (yield* WorkspaceBuildJobRepo).getLatestJobByRunId(runId),
      "Failed to load the workspace build job.",
    );
    if (job === undefined || job.status !== "queued") {
      return;
    }
    const publisher = yield* WorkspaceBuildJobPublisherService;
    yield* Effect.tryPromise(() => publisher.publishRequested({ jobId: job.id })).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Workspace ${workspace.id}: publishing its queued launch job ${job.id} again on a replayed create failed; the next replay retries.`,
          cause,
        ),
      ),
    );
  });

/**
 * The owner's workspace an earlier create with this idempotency key made, as a replayed answer —
 * or, when that create never finished (a half-made workspace from before creates were atomic),
 * the workspace to finish (`resume`). Keys are scoped to the owner: another owner's workspace is
 * never returned. A workspace made before keys were stored on it is found through its launch
 * job, and only when the owner matches.
 */
const findIdempotentWorkspace = (idempotencyKey: string, ownerUserId: string) => {
  return Effect.gen(function* () {
    const byKey = yield* withInternalError(
      (yield* WorkspaceRepo).getWorkspaceByIdempotencyKey({ ownerUserId, idempotencyKey }),
      "Failed to load the workspace by idempotency key.",
    );
    if (byKey !== undefined) {
      if (!(yield* workspaceCreateFinished(byKey))) {
        return { resume: byKey } as const;
      }
      yield* republishQueuedLaunch(byKey);
      return { replay: yield* replayedWorkspaceResponse(byKey) } as const;
    }

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
    if (existingRun === undefined || existingRun.ownerUserId !== ownerUserId) {
      return undefined;
    }
    const existingWorkspace = yield* ensureWorkspaceForAttempt(existingRun);
    return { replay: yield* replayedWorkspaceResponse(existingWorkspace) } as const;
  });
};

/** The replayed answer of a committed create, or `undefined` when there is none (yet). */
const maybeReturnExistingIdempotentWorkspace = (idempotencyKey: string, ownerUserId: string) =>
  findIdempotentWorkspace(idempotencyKey, ownerUserId).pipe(
    Effect.map((found) => (found !== undefined && "replay" in found ? found.replay : undefined)),
  );

/** The refusal of a create whose key the owner cancelled. */
const createCancelledError = (idempotencyKey: string) =>
  new WorkspaceConflictError({
    message: `The create with idempotency key ${idempotencyKey} was cancelled; no create with that key launches. Create with a new key.`,
    code: "create-cancelled",
  });

/** A create's key stopped being pending before its transaction committed. */
class CreateReservationLost extends Error {
  public override readonly name = "CreateReservationLost";
}

/**
 * Pure create-time gate for Kubernetes-only requests (cluster-env-sources design): cluster env
 * sources and a workspace service account only resolve where workspaces run as Pods. The refusal
 * happens HERE, synchronously — no workspace row, no build job, no failure minutes later — and
 * the adapters keep their own refusal as belt. Returns the refusal message naming every
 * unresolvable input, or null when the request is fine.
 */
export const runtimeEnvReferencesRefusal = (
  spec: {
    readonly runtime: {
      readonly envFrom: readonly { readonly kind: string; readonly name: string }[];
      readonly kubernetes: { readonly serviceAccountName?: string | undefined };
    };
    readonly target: { readonly runtime: { readonly family: string } };
  },
  defaultAdapterFamily: string,
): string | null => {
  const bindings = spec.runtime.envFrom;
  const serviceAccount = spec.runtime.kubernetes.serviceAccountName;
  if (bindings.length === 0 && serviceAccount === undefined) {
    return null;
  }
  const family =
    spec.target.runtime.family === "auto" ? defaultAdapterFamily : spec.target.runtime.family;
  if (family === "k8s" || family === "k3s") {
    return null;
  }
  const names = [
    ...bindings.map((binding) => `${binding.kind}/${binding.name}`),
    ...(serviceAccount === undefined ? [] : [`serviceAccount ${serviceAccount}`]),
  ].join(", ");
  return `This deployment runs workspaces on the '${family}' runtime, which cannot resolve cluster env references: ${names}. Remove them, or run against a Kubernetes deployment.`;
};

/**
 * Pure create-time gate for `tooling.services.docker`. Docker always serves it. Kubernetes needs
 * its rootless sidecar enabled. MicroVM needs the operator to allow it, because the image built for
 * such a workspace is created with the elevated OS capability. Refuse here synchronously and keep the
 * adapter's own refusal as a second check.
 */
export const dockerServiceRefusal = (
  spec: {
    readonly tooling: {
      readonly services?:
        | { readonly docker?: { readonly enabled: boolean } | undefined }
        | undefined;
    };
    readonly target: { readonly runtime: { readonly family: string } };
  },
  install: {
    readonly defaultAdapterFamily: string;
    readonly kubernetesDockerEnabled: boolean;
    readonly microvmDockerEnabled: boolean;
  },
): string | null => {
  if (spec.tooling.services?.docker?.enabled !== true) {
    return null;
  }
  const family =
    spec.target.runtime.family === "auto"
      ? install.defaultAdapterFamily
      : spec.target.runtime.family;
  if (family === "docker") {
    return null;
  }
  if (family === "k8s" || family === "k3s") {
    return install.kubernetesDockerEnabled
      ? null
      : "This deployment runs workspaces on Kubernetes without workspace-scoped Docker enabled (SEALANT_K8S_DOCKER_ENABLED / chart value workspaces.docker.enabled). Turn Docker off for this workspace, or ask the operator to enable it.";
  }
  if (family === "microvm") {
    return install.microvmDockerEnabled
      ? null
      : "This deployment runs workspaces on Lambda MicroVMs without workspace-scoped Docker enabled (SEALANT_MICROVM_DOCKER_ENABLED). Turn Docker off for this workspace, or ask the operator to enable it.";
  }
  return `This deployment runs workspaces on the '${family}' runtime, which has no workspace-scoped Docker. Turn Docker off for this workspace.`;
};

export const createWorkspace = (input: {
  readonly payload: CreateWorkspaceRequest;
  readonly headers: CreateWorkspaceHeaders;
}) => {
  return Effect.gen(function* () {
    const body = input.payload;
    const idempotencyKey = body.idempotencyKey ?? readIdempotencyKey(input.headers);

    if (body.registryId !== env.REGISTRY_NAME) {
      return yield* new WorkspaceNotFoundError({
        message: `Unknown registry: ${body.registryId}`,
      });
    }
    // An idempotent create: a committed one replays; a cancelled key refuses; a create from
    // before creates were atomic that left its workspace half-made is finished (`resuming`). The
    // key is reserved (`pending`) before anything is written, and committed with everything the
    // create writes, in one transaction.
    let resuming: WorkspaceRecord | undefined;
    const reservations = yield* WorkspaceCreateReservationRepo;
    if (idempotencyKey !== undefined) {
      const found = yield* findIdempotentWorkspace(idempotencyKey, body.ownerUserId);
      if (found !== undefined && "replay" in found) {
        return found.replay;
      }
      resuming = found?.resume;
      const reservation = yield* withInternalError(
        reservations.reserve({
          ownerUserId: body.ownerUserId,
          idempotencyKey,
          ...(body.launchId === undefined ? {} : { launchId: body.launchId }),
        }),
        "Failed to reserve the create's idempotency key.",
      );
      if (reservation.state === "cancelled") {
        return yield* createCancelledError(idempotencyKey);
      }
      if (reservation.state === "created") {
        // Committed by a create that raced this one past the lookup above.
        const committed = yield* maybeReturnExistingIdempotentWorkspace(
          idempotencyKey,
          body.ownerUserId,
        );
        if (committed !== undefined) {
          return committed;
        }
        return yield* new WorkspaceConflictError({
          message: `The create with idempotency key ${idempotencyKey} finished, and its workspace no longer exists.`,
        });
      }
    }

    // The image name becomes registry URL segments and `docker` arguments in the worker. Refuse
    // one outside the OCI grammar here, as a 400, not an hour later as a failed build.
    if (!isOciRepository(body.repository.trim()) || !isOciTag(body.tag.trim())) {
      return yield* new WorkspaceBadRequestError({
        message: `repository ${OCI_REPOSITORY_MESSAGE}; tag must match [A-Za-z0-9_][A-Za-z0-9._-]{0,127}.`,
      });
    }

    const parsedSpec = yield* parseWorkspaceSpec(body.spec);
    // The owner's own Linux user, never one the caller names (Mend ADR 0016, decision 10): the
    // uid of the home Core writes and holds the owner's logins in.
    const sshUser = body.sshAsOwner === true ? yield* ownerSshUser(parsedSpec) : undefined;

    // A managed family installs the catalog's packages only. Refuse an unknown id here, as a 400
    // naming it, rather than minutes later as a failed build. A custom base image takes any
    // name its own package manager knows.
    const unknownPackages =
      parsedSpec.target.os.family === "custom"
        ? []
        : unknownWorkspacePackageIds(parseRequestedPackageIds(parsedSpec));
    if (unknownPackages.length > 0) {
      return yield* new WorkspaceBadRequestError({
        message: new UnknownWorkspacePackageError(unknownPackages).message,
      });
    }

    const envReferencesRefusal = runtimeEnvReferencesRefusal(
      parsedSpec,
      env.DEFAULT_RUNTIME_ADAPTER,
    );
    if (envReferencesRefusal !== null) {
      return yield* new WorkspaceRuntimeEnvReferencesUnsupportedError({
        message: envReferencesRefusal,
        code: "runtime-env-references-unsupported",
      });
    }

    const dockerRefusal = dockerServiceRefusal(parsedSpec, {
      defaultAdapterFamily: env.DEFAULT_RUNTIME_ADAPTER,
      kubernetesDockerEnabled: env.SEALANT_K8S_DOCKER_ENABLED,
      microvmDockerEnabled: env.SEALANT_MICROVM_DOCKER_ENABLED,
    });
    if (dockerRefusal !== null) {
      return yield* new WorkspaceDockerServiceUnsupportedError({
        message: dockerRefusal,
        code: "workspace-docker-unsupported",
      });
    }

    // Validate BEFORE the selection resolvers so what we check is exactly what the caller sent;
    // the refs the resolvers mint afterwards are server-owned.
    yield* validateClientSuppliedAuthRefs({
      ownerUserId: body.ownerUserId,
      spec: parsedSpec,
    });

    yield* validateWorkspaceMounts({
      spec: parsedSpec,
      sourceSelection: body.sourceSelection,
    });

    // The capture token goes to the endpoint the caller names (CORE-05): check the destination
    // before the token is sealed for a launch.
    yield* validateCaptureDestination(parsedSpec);

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

    const workspaceId = resuming?.id ?? (yield* randomId);
    const runId = yield* randomId;
    const jobId = yield* randomId;

    const packageRefusal = packageTargetRefusal(dotfilesSelectionResult.spec);
    if (packageRefusal !== undefined) {
      return yield* new WorkspaceBadRequestError({ message: packageRefusal });
    }

    // Budgets last among the refusals (CORE-04): a request that was never going to launch spends
    // nothing, and nothing has been created yet, so a refusal leaves no effect behind. Two creates
    // that race past the ceiling together both pass it: the ceiling can be overshot by the
    // number in flight, never by more.
    yield* requireLiveWorkspaceRoom(body.ownerUserId);
    yield* spendOwnerLaunch(body.ownerUserId);

    const resolvedSpec = dotfilesSelectionResult.spec;

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

    // The transient secret channel. Validated with the public policy (same messages the SDK
    // showed client-side), then SEALED for the job row only: never the spec, never the attempt
    // snapshot, never a read response. The worker decrypts just before launch and the row is
    // cleared once the launch phase settles.
    const captureSecretEnv = yield* resolveCaptureSecretEnv({
      spec: resolvedSpec,
      captureToken: body.captureToken,
    });
    const secretEnvSealed = yield* sealSecretEnv(body.secretEnv, captureSecretEnv);
    // The create-payload `credentials` key is now fully lowered into `runtime.credentialRefs` —
    // strip it before the spec is persisted for the build job: the worker's blueprint schema is
    // strict, and a spec that keeps the key fails every build at `parseWorkspaceBlueprint`
    // ("Unrecognized key: credentials" — hit by every mount+credentials create on 0.7.0).
    delete resolvedSpec.credentials;

    const workspaceName =
      resuming !== undefined
        ? resolveStoredWorkspaceName(resuming)
        : body.name === undefined
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
    const transaction = yield* DatabaseTransaction;

    // Everything a create writes commits together, with its key's reservation: a create that
    // dies part-way leaves nothing behind (its key stays `pending`, and a repeat of the create
    // finishes it), never a workspace with no launch to replay forever.
    const persistenceResult = yield* Effect.result(
      Effect.gen(function* () {
        // TTL: per-create override wins; otherwise the install-wide default (if configured).
        const ttlSeconds = body.ttlSeconds ?? env.SEALANT_WORKSPACE_DEFAULT_TTL_SECONDS;

        const workspace =
          resuming ??
          (yield* workspaces.createWorkspace({
            id: workspaceId,
            name: workspaceName,
            ownerUserId: body.ownerUserId,
            ...(body.sourceSelection === undefined
              ? {}
              : { repositoryId: sourceSelectionResult.repositoryId }),
            requestedByUserId: body.ownerUserId,
            status: "queued",
            ...(ttlSeconds === undefined
              ? {}
              : { expiresAt: new Date(Date.now() + ttlSeconds * 1000) }),
            // The workspace row is written first: a racing create with the same key fails here,
            // on the owner-scoped unique index, before anything else of it exists.
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
            ...(sshUser === undefined ? {} : { sshUser }),
          }));

        const attempt = yield* workspaceAttempts.createQueuedAttempt({
          id: runId,
          ownerUserId: body.ownerUserId,
          ...(body.sourceSelection === undefined
            ? {}
            : { repositoryId: sourceSelectionResult.repositoryId }),
          triggerType: "api",
          requestedByUserId: body.ownerUserId,
          ...(body.launchId === undefined ? {} : { launchId: body.launchId }),
        });

        yield* workspaces.linkWorkspaceAttempt({
          workspaceId: workspace.id,
          attemptId: attempt.id,
          relation: "launch",
        });

        yield* workspaceAttempts.setAttemptSnapshot({
          runId: attempt.id,
          specPayload: snapshotSpecOf(resolvedSpec),
        });

        yield* workspaceBuildJobs.insertQueuedJob({
          id: jobId,
          runId: attempt.id,
          registryId: body.registryId,
          repository: body.repository,
          tag: body.tag,
          requestPayload: resolvedSpec,
          ...(secretEnvSealed === undefined ? {} : { secretEnvSealed }),
        });

        // The commit point of an idempotent create: only while its key is still pending (not
        // cancelled, not committed by another create). Otherwise nothing above commits.
        if (idempotencyKey !== undefined) {
          const committed = yield* reservations.markCreated({
            ownerUserId: body.ownerUserId,
            idempotencyKey,
            workspaceId: workspace.id,
          });
          if (!committed) {
            return yield* Effect.fail(
              new CreateReservationLost(
                `The create's idempotency key ${idempotencyKey} is no longer pending.`,
              ),
            );
          }
        }
        if (resuming !== undefined) {
          // A half-made workspace is finished: it is queued again, like a new one.
          yield* workspaces.setWorkspaceStatus({ id: workspace.id, status: "queued" });
        }
      }).pipe(transaction.run),
    );

    if (Result.isFailure(persistenceResult)) {
      const persistenceError = persistenceResult.failure;

      if (idempotencyKey !== undefined && persistenceError instanceof CreateReservationLost) {
        // Cancelled, or committed by another create, while this one was writing.
        const standing = yield* withInternalError(
          reservations.get({ ownerUserId: body.ownerUserId, idempotencyKey }),
          "Failed to read the create's idempotency key.",
        );
        if (standing?.state === "cancelled") {
          return yield* createCancelledError(idempotencyKey);
        }
        const committed = yield* maybeReturnExistingIdempotentWorkspace(
          idempotencyKey,
          body.ownerUserId,
        );
        if (committed !== undefined) {
          return committed;
        }
      }

      if (isForeignKeyConstraintError(persistenceError)) {
        return yield* new WorkspaceNotFoundError({
          message: `Unknown owner user: ${body.ownerUserId}`,
        });
      }

      if (idempotencyKey !== undefined && isUniqueConstraintError(persistenceError)) {
        const existing = yield* maybeReturnExistingIdempotentWorkspace(
          idempotencyKey,
          body.ownerUserId,
        );

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

    return {
      ...acceptedWorkspaceResponse(workspaceId, workspaceName, {
        registryId: body.registryId,
        repository: body.repository,
        tag: body.tag,
      }),
      runId,
      ...(body.launchId === undefined ? {} : { launchId: body.launchId }),
    } satisfies CreateWorkspaceResponse;
  });
};

/**
 * The Linux user a workspace's SSH sessions run as, for `sshAsOwner`: its owner's own, the uid of
 * the spec's `credentialsHome` (the home Core writes and holds the owner's logins in), never a user
 * the caller names, so an owner cannot pick another person's identity. In range and never root
 * (`processUserProblem`, as for the as-user routes); whether the user exists and is one of the
 * executor's people, the executor's sealantd decides when a session opens, and until then the
 * gateway refuses the session rather than run it as root.
 */
const ownerSshUser = (spec: {
  readonly runtime: { readonly credentialsHome?: { readonly uid: number } | undefined };
}) => {
  const home = spec.runtime.credentialsHome;
  if (home === undefined) {
    return Effect.fail(
      new WorkspaceBadRequestError({
        message:
          "sshAsOwner needs runtime.credentialsHome: SSH sessions run as the owner's user, the uid of the home their logins are written to.",
      }),
    );
  }
  const user = String(home.uid);
  const problem = processUserProblem(user);
  return problem === undefined
    ? Effect.succeed(user)
    : Effect.fail(
        new WorkspaceBadRequestError({
          message: `sshAsOwner: the owner's uid ${user} is refused: ${problem.detail}; ${PROCESS_USER_RANGE_RULE}.`,
        }),
      );
};

/** `DELETE /v1/workspaces/:id/ssh-user`: the owner sets the workspace's SSH sessions to root. */
export const clearWorkspaceSshUser = (input: {
  readonly workspaceId: string;
  readonly query: ClearWorkspaceSshUserQuery;
}) => {
  return Effect.gen(function* () {
    yield* requireScopedWorkspace(input.workspaceId, input.query.ownerUserId);
    const workspace = yield* withInternalError(
      (yield* WorkspaceRepo).setWorkspaceSshUser({ id: input.workspaceId, sshUser: null }),
      "Failed to clear the workspace's SSH user.",
    );
    if (workspace === null) {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${input.workspaceId}`,
      });
    }
    return { workspaceId: workspace.id, sshUser: null } satisfies ClearWorkspaceSshUserResponse;
  });
};

export const renameWorkspace = (input: {
  readonly workspaceId: string;
  readonly payload: RenameWorkspaceRequest;
}) => {
  return Effect.gen(function* () {
    // Rename was addressed by id alone: any caller could rename any owner's workspace.
    yield* requireScopedWorkspace(input.workspaceId, input.payload.ownerUserId);
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

    // By idempotency key: the owner's one workspace a create with that key made, or none.
    const workspaces =
      query.idempotencyKey === undefined
        ? yield* withInternalError(
            (yield* WorkspaceRepo).listWorkspaces({
              ownerUserId: query.ownerUserId,
              limit: effectiveWorkspaceLimit,
            }),
            "Failed to list workspaces.",
          )
        : yield* withInternalError(
            (yield* WorkspaceRepo)
              .getWorkspaceByIdempotencyKey({
                ownerUserId: query.ownerUserId,
                idempotencyKey: query.idempotencyKey,
              })
              .pipe(Effect.map((workspace) => (workspace === undefined ? [] : [workspace]))),
            "Failed to find the workspace by idempotency key.",
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
    const drainsByRunId = yield* withInternalError(
      (yield* WorkspaceCaptureDrainRepo).listByRunIds(latestRunIds),
      "Failed to load workspace capture drains.",
    );

    const sshGatewayConfig = resolveWorkspaceSshGatewayConfig();

    const items = workspaces
      .map((workspace) => {
        const runId = workspace.latestRunId ?? undefined;
        const runtimeInstance =
          runId === undefined ? undefined : runtimeInstancesByRunId.get(runId);

        return mapWorkspaceSummary(
          workspace,
          runId === undefined ? undefined : attemptsByRunId.get(runId),
          runId === undefined ? undefined : latestJobsByRunId.get(runId),
          runtimeInstance,
          sshGatewayConfig,
          executorIsRetained({
            runtimeInstance,
            retainedAt: runId === undefined ? undefined : drainsByRunId.get(runId)?.retainedAt,
          }),
        );
      })
      .filter((item) => (query.status === undefined ? true : item.status === query.status))
      .slice(0, workspaceLimit);

    return {
      items,
    } satisfies ListWorkspacesResponse;
  });
};

/**
 * The workspace, when it belongs to the owner the caller named (CORE-03). A call that names no
 * owner finds nothing, before any lookup; a mismatch answers the same 404, so an id never reveals
 * that it exists for someone else.
 */
const requireScopedWorkspace = (workspaceId: string, ownerUserId: string | undefined) => {
  return Effect.gen(function* () {
    const scope = resolveOwnerScope(ownerUserId);
    if (scope.kind === "missing") {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${workspaceId} (${OWNER_REQUIRED_HINT})`,
      });
    }
    const workspace = yield* withInternalError(
      (yield* WorkspaceRepo).getWorkspaceById(workspaceId),
      "Failed to load workspace.",
    );
    if (workspace === undefined || !scopeAdmits(scope, workspace.ownerUserId)) {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${workspaceId}`,
      });
    }
    return workspace;
  });
};

export const getWorkspace = (workspaceId: string, ownerUserId: string | undefined) => {
  return Effect.gen(function* () {
    const workspace = yield* requireScopedWorkspace(workspaceId, ownerUserId);

    const sshGatewayConfig = resolveWorkspaceSshGatewayConfig();

    if (workspace.latestRunId === null) {
      return mapWorkspaceDetails(
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        sshGatewayConfig,
        false,
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
    const captureDrain = yield* withInternalError(
      (yield* WorkspaceCaptureDrainRepo).getByRunId(workspace.latestRunId),
      "Failed to load workspace capture drain.",
    );

    const details = mapWorkspaceDetails(
      workspace,
      attempt,
      latestJob,
      runtimeInstance,
      attemptSnapshot,
      sshGatewayConfig,
      executorIsRetained({ runtimeInstance, retainedAt: captureDrain?.retainedAt }),
    );
    const observed = mapWorkspaceCaptureDrain(
      captureDrain,
      runtimeInstance === undefined
        ? undefined
        : {
            ...runtimeInstance,
            // The launch identity the create named, recorded on this executor's attempt.
            launchId: attempt?.id === runtimeInstance.runId ? attempt.launchId : null,
          },
    );
    return observed === undefined ? details : { ...details, captureDrain: observed };
  });
};

/**
 * The drain as last observed, for `WorkspaceDetails.captureDrain`: only what the worker
 * recorded (a state it observed, a schedule it planned), never an inference from a stop request.
 */
export const mapWorkspaceCaptureDrain = (
  row: WorkspaceCaptureDrainRecord | undefined,
  /** The run's executor: who the observation is about, and whether it can be restarted. */
  executor?: {
    readonly runId: string;
    readonly adapter: string | null;
    readonly resourceId: string | null;
    readonly reference: string | null;
    readonly launchId?: string | null;
  },
): WorkspaceCaptureDrain | undefined => {
  if (row === undefined || row.state === null) {
    return undefined;
  }
  const adapter = executor?.adapter;
  return {
    ...(executor === undefined || executor.adapter === null || executor.resourceId === null
      ? {}
      : {
          executor: {
            runId: executor.runId,
            adapter: executor.adapter,
            resourceId: executor.resourceId,
            ...(executor.reference === null ? {} : { reference: executor.reference }),
            ...(executor.launchId === null || executor.launchId === undefined
              ? {}
              : { launchId: executor.launchId }),
          },
        }),
    state: row.state,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.observedAt === null ? {} : { observedAt: row.observedAt.toISOString() }),
    ...(row.preservationStartsAt === null
      ? {}
      : { preservationStartsAt: row.preservationStartsAt.toISOString() }),
    ...(row.discardRequestedAt === null || row.discardRequestedBy === null
      ? {}
      : {
          discard: {
            requestedBy: row.discardRequestedBy,
            requestedAt: row.discardRequestedAt.toISOString(),
          },
        }),
    ...(row.retainedAt === null || row.retainedAt === undefined
      ? {}
      : {
          retained: {
            since: row.retainedAt.toISOString(),
            reason: row.retainedReason ?? "not recorded",
            recoverable: runtimeRestartsRetainedExecutors(adapter),
            recoveryAttempts: row.recoveryAttempts ?? 0,
            ...(row.nextRecoveryAt === null || row.nextRecoveryAt === undefined
              ? {}
              : { nextRecoveryAt: row.nextRecoveryAt.toISOString() }),
            ...(row.lastRecoveryError === null || row.lastRecoveryError === undefined
              ? {}
              : { lastRecoveryError: row.lastRecoveryError }),
          },
        }),
    ...(row.completionExecutorId === null ||
    row.completionExecutorId === undefined ||
    row.completionEpoch === null ||
    row.completionEpoch === undefined ||
    row.completionCaptureN === null ||
    row.completionCaptureN === undefined ||
    row.completionAttestedAt === null ||
    row.completionAttestedAt === undefined
      ? {}
      : {
          completion: {
            executorId: row.completionExecutorId,
            epoch: row.completionEpoch,
            captureN: row.completionCaptureN,
            attestedAt: row.completionAttestedAt.toISOString(),
            ...(row.completionLaunchId === null || row.completionLaunchId === undefined
              ? {}
              : { launchId: row.completionLaunchId }),
            ...(row.completionSealedAt === null || row.completionSealedAt === undefined
              ? {}
              : { sealedAt: row.completionSealedAt.toISOString() }),
            ...(executorOriginFromStored(row.completionOrigin) === undefined
              ? {}
              : { origin: executorOriginFromStored(row.completionOrigin) }),
          },
        }),
  };
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

    // A workspace whose sessions run as a user goes only to a gateway that runs them so: an older
    // gateway would drop `user` and run the session as root.
    if (workspace.sshUser !== null && input.headers["x-sealant-gateway-ssh-user"] !== "1") {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} runs its SSH sessions as a user, which this SSH gateway cannot: upgrade the gateway with the API.`,
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
      sessionUser: workspace.sshUser,
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

    const workspace = yield* requireScopedWorkspace(input.workspaceId, input.query.ownerUserId);
    const workspaceRepo = yield* WorkspaceRepo;

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
    const drainsByRunId = yield* withInternalError(
      (yield* WorkspaceCaptureDrainRepo).listByRunIds(runIds),
      "Failed to load workspace capture drains.",
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
          executorIsRetained({
            runtimeInstance: runtimeInstancesByRunId.get(link.runId),
            retainedAt: drainsByRunId.get(link.runId)?.retainedAt,
          }),
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

    const workspace = yield* requireScopedWorkspace(input.workspaceId, input.query.ownerUserId);
    const workspaceRepo = yield* WorkspaceRepo;

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
  /** For tests; defaults to the live channel (asked only for an exec as a user). */
  readonly processUserChannel?: ProcessUserChannel;
  /**
   * The request came on `POST /v1/workspaces/:id/exec-as-user`. `user` is honoured only there: on
   * `/exec` it is refused, so a client never learns to send it to a route an older control plane
   * would accept and ignore.
   */
  readonly asUser?: boolean;
}) => {
  return Effect.gen(function* () {
    const workspace = yield* requireOwnedWorkspace(input.workspaceId, input.payload.ownerUserId);
    const user = input.payload.user;
    if (user !== undefined && input.asUser !== true) {
      return yield* new WorkspaceConflictError({
        message: processUserOnLegacyRoute(user, `POST /v1/workspaces/${workspace.id}/exec-as-user`),
        code: PROCESS_USER_UNSUPPORTED_CODE,
      });
    }
    // Set once the user is checked: the run goes to the as-user queue, never the legacy one.
    let asUserRun: { readonly user: string; readonly checkedExecutorRunId: string } | undefined;
    if (user !== undefined) {
      const refused = processUserNameRefusal(workspace.id, user);
      if (refused !== undefined) {
        return yield* new WorkspaceConflictError({
          message: refused,
          code: PROCESS_USER_UNSUPPORTED_CODE,
        });
      }
    }
    if (workspace.latestRunId === null) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has no launched runtime to exec in yet; wait for it to become ready.`,
      });
    }
    // An exec as a person: only where the running executor's daemon starts one as that user, for
    // a person in Mend's range. Asked before the run exists, so a refusal leaves nothing behind.
    if (user !== undefined) {
      const resolved = yield* resolveDaemonInstance(workspace.id).pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceInternalServerError({
              message: toErrorMessage(error, "Failed to load the workspace runtime."),
            }),
        ),
      );
      if (resolved === undefined) {
        return yield* new WorkspaceConflictError({
          message: `Workspace ${input.workspaceId} has no running executor to run a process as '${user}' in.`,
          code: "workspace-not-running",
        });
      }
      const verdict = yield* checkProcessUser({
        workspaceId: workspace.id,
        instance: resolved.instance,
        target: resolved.target,
        user,
        ...(input.processUserChannel === undefined ? {} : { channel: input.processUserChannel }),
      });
      if (verdict.kind === "refused") {
        return yield* new WorkspaceConflictError({
          message: verdict.message,
          code: PROCESS_USER_UNSUPPORTED_CODE,
        });
      }
      if (verdict.kind === "unanswered") {
        return yield* new WorkspaceBadGatewayError({ message: verdict.message });
      }
      asUserRun = { user, checkedExecutorRunId: resolved.instance.runId };
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
        ...(asUserRun === undefined ? {} : { processUser: asUserRun.user }),
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
          ...asUserRun,
        }),
      catch: (error) =>
        new WorkspaceInternalServerError({
          message: toErrorMessage(error, "Failed to enqueue the exec run."),
        }),
    });

    return mapRun(run);
  });
};

/**
 * Bind (sealantd ADR-0014): point a standby workspace's working directory, or a bindable extra
 * mount, at one subdirectory of its root. Synchronous over the daemon's control connection; the
 * resulting set of live bindings is recorded on the workspace so every relaunch re-applies it.
 */
export const bindWorkspace = (input: {
  readonly workspaceId: string;
  readonly payload: BindWorkspaceRequest;
}) => {
  return Effect.gen(function* () {
    const workspace = yield* requireOwnedWorkspace(input.workspaceId, input.payload.ownerUserId);
    if (workspace.latestRunId === null) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has no launched runtime to bind in yet; wait for it to become ready.`,
      });
    }
    const spec = yield* loadRecordedSpec(workspace.id, workspace.latestRunId);
    const mountPath = input.payload.mountPath ?? spec.runtime.workingDirectory;
    const bindable =
      (spec.sources.workspace.kind === "standby" && mountPath === spec.runtime.workingDirectory) ||
      spec.sources.mounts.some((mount) => mount.bindable && mount.mountPath === mountPath);
    if (!bindable) {
      return yield* new WorkspaceBadRequestError({
        message: `${mountPath} is not a bindable mount of workspace ${input.workspaceId}: only a standby working directory or a mount declared bindable can be bound.`,
      });
    }
    const subpath = input.payload.subpath.trim();
    if (subpath !== "") {
      const parsed = workspaceBindSchema.safeParse({ mountPath, subpath });
      if (!parsed.success) {
        return yield* new WorkspaceBadRequestError({
          message: `Invalid bind: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        });
      }
    }
    const target = yield* resolveDaemonTarget(workspace.id).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (target === undefined) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has no ready runtime to bind in.`,
      });
    }
    const runtime = yield* SealantRuntime;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* runtime.connect(target);
        yield* daemon.bindMount(mountPath, subpath);
      }),
    ).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceConflictError({
            message: `The workspace runtime refused the bind: ${error.message}`,
          }),
      ),
    );
    const binds = [
      ...workspace.binds.filter((bind) => bind.mountPath !== mountPath),
      ...(subpath === "" ? [] : [{ mountPath, subpath }]),
    ];
    const workspaces = yield* WorkspaceRepo;
    yield* withInternalError(
      workspaces.setWorkspaceBinds({ id: workspace.id, binds }),
      "Failed to record the workspace bindings.",
    );
    return { binds };
  });
};

/**
 * Flush captures (sealantd ADR-0015): a capture, then ship and register everything staged.
 * Synchronous over the daemon's control connection; the reply is the daemon's capture status.
 * The caller's `kind` (default `suspend`), `deadlineMs` and `graceMs` go to the daemon as asked.
 */
export const flushWorkspaceCapture = (input: {
  readonly workspaceId: string;
  readonly payload: FlushWorkspaceCaptureRequest;
}) =>
  withCaptureTarget(
    { workspaceId: input.workspaceId, ownerUserId: input.payload.ownerUserId, verb: "flush" },
    // A FINAL's sweep closes the connection that carried it: its answer is read again over a new
    // one (and the FINAL asked again when the daemon is not at one), never the close reported.
    // Every answer is recorded as it arrives, and when a later one is lost the last received is
    // returned (review 6 #4).
    (target, runId) =>
      Effect.gen(function* () {
        const recorder = yield* apiObservationRecorder(runId);
        return yield* captureFlushAnswer(target, captureFlushRequestOf(input.payload), {
          recorder,
          roundTripTimeoutMs: API_CAPTURE_ROUND_TRIP_MS,
        });
      }),
  );

/** How long the API waits on one capture round trip; its observation fence outlives it. */
const API_CAPTURE_ROUND_TRIP_MS = 55 * 60_000;

/**
 * Every capture status Core relays from an executor is evidence about its disk (review 5 #3,
 * decision 14), recorded against the run's executor as it arrives, before anything else is asked
 * or the answer is returned — at stop, at attestation and at every deletion it counts, whoever
 * asked. Fenced (review 6 #5): the observation is marked in flight in the drain record BEFORE the
 * request is sent, so until its answer is durably recorded nothing Core holds of the executor
 * counts as current. A fence that cannot be opened: nothing is asked (the route fails). An answer
 * that cannot be recorded is still returned — the caller received it — and its fence stays open.
 */
const apiObservationRecorder = (runId: string) =>
  Effect.gen(function* () {
    const drains = yield* WorkspaceCaptureDrainRepo;
    return {
      open: Effect.gen(function* () {
        const token = randomUUID();
        const opened = yield* drains.openObservation({
          runId,
          token,
          ttlMs: API_CAPTURE_ROUND_TRIP_MS + OBSERVATION_FENCE_MARGIN_MS,
        });
        if ("refused" in opened) {
          // Its removal was authorized on the evidence as it stood (decision 21): nothing
          // asked after that is admitted.
          yield* Effect.logWarning(
            `Capture observation of run ${runId} refused: its executor ${opened.refused === "deleting" ? "is being removed" : "was removed"}; nothing is asked of its daemon.`,
          );
          return undefined;
        }
        return { token };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            `Capture observation of run ${runId} could not be marked in flight; nothing is asked of its daemon.`,
            cause,
          ).pipe(Effect.as(undefined)),
        ),
      ),
      record: (fence, report, atMs) =>
        drains
          .recordStatus({
            runId,
            status: storedCaptureStatus(report),
            observedAt: new Date(atMs),
            fence: fence.token,
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logError(
                `Capture observation of run ${runId} could not be recorded; the answer is returned, and its observation stays unresolved: nothing Core holds of this executor counts as current until a later one is recorded.`,
                cause,
              ).pipe(Effect.as(false)),
            ),
          ),
      close: (fence) =>
        drains
          .closeObservation({ runId, token: fence.token })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Capture observation of run ${runId} received nothing and could not be resolved; it stays in flight until a later observation resolves it.`,
                cause,
              ),
            ),
          ),
      end: (fence) =>
        drains
          .endObservation({ runId, token: fence.token })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Capture observation of run ${runId} could not be recorded, and ending it failed too; it stays in flight until it lapses and a later observation resolves it.`,
                cause,
              ),
            ),
          ),
    } satisfies CaptureObservationRecorder;
  });

/** The flush request → the daemon's: `suspend` unless the caller asked for `final`. */
const captureFlushRequestOf = (payload: FlushWorkspaceCaptureRequest): CaptureFlushRequest => ({
  kind: payload.kind ?? "suspend",
  ...(payload.deadlineMs === undefined ? {} : { deadlineMs: payload.deadlineMs }),
  ...(payload.graceMs === undefined ? {} : { graceMs: payload.graceMs }),
});

/**
 * Capture status (sealantd `capture.status`): the daemon's queue as it stands, nothing flushed.
 * Synchronous over the daemon's control connection; what a drain polls between flushes.
 */
export const getWorkspaceCaptureStatus = (input: {
  readonly workspaceId: string;
  readonly query: GetWorkspaceCaptureStatusQuery;
}) =>
  withCaptureTarget(
    { workspaceId: input.workspaceId, ownerUserId: input.query.ownerUserId, verb: "read" },
    (target, runId) =>
      Effect.gen(function* () {
        const recorder = yield* apiObservationRecorder(runId);
        return yield* captureStatusAnswer(target, recorder, API_CAPTURE_ROUND_TRIP_MS);
      }),
  );

/**
 * Re-plan captures (sealantd 0.15 `capture.replan`, the claim hook): the daemon re-fetches its
 * plan with no worktree named, delta-materialises it, and captures under the answered worktree
 * and epoch from then on. Synchronous over the daemon's control connection; idempotent.
 */
export const replanWorkspaceCapture = (input: {
  readonly workspaceId: string;
  readonly payload: ReplanWorkspaceCaptureRequest;
}) =>
  Effect.gen(function* () {
    const expected = input.payload.expectedOwnerMap;
    if (expected !== undefined) {
      yield* requireLaunchOwnerMap({
        workspaceId: input.workspaceId,
        ownerUserId: input.payload.ownerUserId,
        expected,
      });
    }
    return yield* withCaptureDaemon(
      { workspaceId: input.workspaceId, ownerUserId: input.payload.ownerUserId, verb: "re-plan" },
      (daemon) => daemon.captureReplan(),
    );
  });

/**
 * A claim (re-plan) that names the owner map it needs runs only on an executor launched with
 * exactly that map, "none" included: sealantd reads its map only at boot, so a standby restores
 * under the one it booted with. Compared as the daemon receives them (`encodeCaptureOwnerMap`,
 * people in id order), from the spec the workspace last launched from. Refused before the daemon
 * is reached.
 */
const requireLaunchOwnerMap = (input: {
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly expected: NonNullable<ReplanWorkspaceCaptureRequest["expectedOwnerMap"]> | null;
}) =>
  Effect.gen(function* () {
    const workspace = yield* requireOwnedWorkspace(input.workspaceId, input.ownerUserId);
    if (workspace.latestRunId === null) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has no launched runtime to re-plan yet; wait for it to become ready.`,
      });
    }
    const spec = yield* loadRecordedSpec(workspace.id, workspace.latestRunId);
    const source = spec.sources.workspace;
    const launched = source.kind === "capture" ? source.ownerMap : undefined;
    const want = input.expected === null ? "none" : encodeCaptureOwnerMap(input.expected);
    const have = launched === undefined ? "none" : encodeCaptureOwnerMap(launched);
    if (want !== have) {
      return yield* new WorkspaceConflictError({
        code: "owner-map-mismatch",
        message: `Workspace ${input.workspaceId} was launched with ${launched === undefined ? "no owner map" : `the owner map ${have}`}, not ${input.expected === null ? "none" : want}; its daemon reads the map only at boot, so a claim would restore under the wrong owners. Nothing was re-planned: launch an executor with the map this claim needs.`,
      });
    }
  });

/**
 * The shared gate of the synchronous capture commands: the workspace must be owned, launched,
 * capture-sourced and have a ready daemon; `use` then runs against that daemon inside one scoped
 * connection, and any runtime failure surfaces as a conflict naming the verb.
 */
const withCaptureDaemon = <A, R = never>(
  input: { readonly workspaceId: string; readonly ownerUserId: string; readonly verb: string },
  use: (daemon: SealantSession, runId: string) => Effect.Effect<A, SealantError, R>,
) =>
  withCaptureTarget(input, (target, runId) =>
    Effect.gen(function* () {
      const runtime = yield* SealantRuntime;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const daemon = yield* runtime.connect(target);
          return yield* use(daemon, runId);
        }),
      );
    }),
  );

/**
 * `withCaptureDaemon`, handing over the daemon's address for callers that connect themselves,
 * and the run whose executor that daemon is (its evidence is recorded against it).
 */
const withCaptureTarget = <A, R = never>(
  input: { readonly workspaceId: string; readonly ownerUserId: string; readonly verb: string },
  use: (
    target: SealantTarget,
    runId: string,
  ) => Effect.Effect<A, SealantError | CaptureObservationUnrecordedError, SealantRuntime | R>,
) => {
  return Effect.gen(function* () {
    const workspace = yield* requireOwnedWorkspace(input.workspaceId, input.ownerUserId);
    if (workspace.latestRunId === null) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has no launched runtime to ${input.verb} yet; wait for it to become ready.`,
      });
    }
    const runId = workspace.latestRunId;
    const spec = yield* loadRecordedSpec(workspace.id, runId);
    if (spec.sources.workspace.kind !== "capture") {
      return yield* new WorkspaceBadRequestError({
        message: `Workspace ${input.workspaceId} is not capture-sourced; only a capture workspace (sealantd ADR-0015) has captures to ${input.verb}.`,
      });
    }
    const target = yield* resolveDaemonTarget(workspace.id).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (target === undefined) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has no ready runtime to ${input.verb}.`,
      });
    }
    return yield* use(target, runId).pipe(
      Effect.mapError((error) =>
        error instanceof CaptureObservationUnrecordedError
          ? new WorkspaceInternalServerError({
              message: `Core could not record the ${input.verb}'s answer, so nothing was asked of the workspace runtime: ${error.message}`,
            })
          : new WorkspaceConflictError({
              message: `The workspace runtime refused the ${input.verb}: ${error.message}`,
            }),
      ),
    );
  });
};

/** The spec a workspace last launched from: the attempt snapshot, else the build job's request. */
const loadRecordedSpec = (workspaceId: string, runId: string) => {
  return Effect.gen(function* () {
    const workspaceAttempts = yield* WorkspaceAttemptRepo;
    const workspaceBuildJobs = yield* WorkspaceBuildJobRepo;
    const previousJob = yield* withInternalError(
      workspaceBuildJobs.getLatestJobByRunId(runId),
      "Failed to load the latest workspace build job.",
    );
    const snapshot = yield* withInternalError(
      workspaceAttempts.getAttemptSnapshotByRunId(runId),
      "Failed to load the workspace attempt snapshot.",
    );
    const specPayload =
      snapshot?.resolvedSpecPayload ?? snapshot?.userSpecPayload ?? previousJob?.requestPayload;
    if (specPayload === undefined) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${workspaceId} has no recorded spec.`,
      });
    }
    return yield* parseWorkspaceSpec(specPayload);
  });
};

/** Load an owner-scoped workspace with the uniform-404 idiom (existence is not leaked). */
const requireOwnedWorkspace = (workspaceId: string, ownerUserId: string) => {
  return Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const workspace = yield* withInternalError(
      workspaces.getWorkspaceById(workspaceId),
      "Failed to load workspace.",
    );
    if (workspace === undefined || workspace.ownerUserId !== ownerUserId) {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${workspaceId}`,
      });
    }
    return workspace;
  });
};

/**
 * Whether a completion attestation names THIS executor's launch (decision 5: a seal names the
 * immutable launch identity of the one physical executor that made it, and never transfers). When
 * the create named a launch (`launchId` on the attempt), the attestation must name the same one;
 * one that names none, or another, is ignored. When the create named none, an attestation that
 * names one cannot be matched to anything and is ignored too. Otherwise the executor match stands.
 */
export const attestationCoversLaunch = (
  attestation: { readonly launchId?: string | undefined },
  recordedLaunchId: string | null,
  executorMatch: { readonly covers: true } | { readonly covers: false; readonly reason: string },
): { readonly covers: true } | { readonly covers: false; readonly reason: string } => {
  if (!executorMatch.covers) {
    return executorMatch;
  }
  if (recordedLaunchId !== null && attestation.launchId === undefined) {
    return {
      covers: false,
      reason: `the attestation names no launch, and this executor was launched as ${recordedLaunchId}`,
    };
  }
  if (attestation.launchId !== undefined && attestation.launchId !== recordedLaunchId) {
    return {
      covers: false,
      reason:
        recordedLaunchId === null
          ? `the attestation names launch ${attestation.launchId}, and this executor's create named none`
          : `the attestation names launch ${attestation.launchId}, not this executor's launch ${recordedLaunchId}`,
    };
  }
  return { covers: true };
};

/** The state of an idempotent create, by its key (see `workspaceCreateStateSchema`). */
const workspaceCreateState = (ownerUserId: string, idempotencyKey: string) =>
  Effect.gen(function* () {
    const reservation = yield* withInternalError(
      (yield* WorkspaceCreateReservationRepo).get({ ownerUserId, idempotencyKey }),
      "Failed to read the create's idempotency key.",
    );
    if (reservation?.state === "cancelled") {
      return { idempotencyKey, state: "cancelled" as const };
    }
    const workspace = yield* withInternalError(
      (yield* WorkspaceRepo).getWorkspaceByIdempotencyKey({ ownerUserId, idempotencyKey }),
      "Failed to load the workspace by idempotency key.",
    );
    if (workspace !== undefined) {
      const finished = yield* workspaceCreateFinished(workspace);
      const runId = workspace.latestRunId;
      const attempt =
        runId === null
          ? undefined
          : yield* withInternalError(
              (yield* WorkspaceAttemptRepo).getAttemptById(runId),
              "Failed to load the workspace attempt.",
            );
      return {
        idempotencyKey,
        state: finished ? ("found" as const) : ("pending" as const),
        workspaceId: workspace.id,
        ...(finished && runId !== null ? { runId } : {}),
        ...(finished && attempt?.launchId !== null && attempt?.launchId !== undefined
          ? { launchId: attempt.launchId }
          : {}),
      };
    }
    if (reservation === undefined) {
      return { idempotencyKey, state: "none" as const };
    }
    // Pending (a create in flight, or one that died before it committed), or created whose
    // workspace is gone: nothing launches from it now either way.
    return {
      idempotencyKey,
      state: reservation.state === "pending" ? ("pending" as const) : ("none" as const),
      ...(reservation.launchId === null ? {} : { launchId: reservation.launchId }),
    };
  });

/** `GET /v1/workspaces/idempotency-keys/:idempotencyKey`: what became of an idempotent create. */
export const getWorkspaceCreate = (input: {
  readonly idempotencyKey: string;
  readonly ownerUserId: string;
}) =>
  workspaceCreateState(input.ownerUserId, input.idempotencyKey).pipe(
    Effect.map((state): WorkspaceCreateState => state),
  );

/**
 * `POST /v1/workspaces/idempotency-keys/:idempotencyKey/cancel`: make sure the create with this
 * key never commits. A pending or unknown key becomes `cancelled` for good (a delayed request
 * with it is refused); a committed one answers `found`, and the caller stops that workspace.
 */
export const cancelWorkspaceCreate = (input: {
  readonly idempotencyKey: string;
  readonly payload: CancelWorkspaceCreateRequest;
}) =>
  Effect.gen(function* () {
    const ownerUserId = input.payload.ownerUserId;
    const idempotencyKey = input.idempotencyKey;
    // A committed create stays committed: cancelling it would refuse its own replays.
    const before = yield* workspaceCreateState(ownerUserId, idempotencyKey);
    if (before.state === "found") {
      return before satisfies WorkspaceCreateState;
    }
    const reservation = yield* withInternalError(
      (yield* WorkspaceCreateReservationRepo).cancel({ ownerUserId, idempotencyKey }),
      "Failed to cancel the create's idempotency key.",
    );
    if (reservation.state === "cancelled") {
      yield* Effect.logInfo(
        `Workspace create with idempotency key ${idempotencyKey} (owner ${ownerUserId}) cancelled; no create with it commits.`,
      );
      return { idempotencyKey, state: "cancelled" } satisfies WorkspaceCreateState;
    }
    // It committed between the read and the cancel.
    return (yield* workspaceCreateState(
      ownerUserId,
      idempotencyKey,
    )) satisfies WorkspaceCreateState;
  });

/**
 * Async stop (202): record the stop intent, then enqueue the teardown for the worker, which
 * removes the container via the runtime adapter and records the terminal "stopped" state.
 * Idempotent: stopping a workspace that is already stopped is a no-op 202.
 */
export const stopWorkspace = (input: {
  readonly workspaceId: string;
  readonly payload: StopWorkspaceRequest;
}) => {
  return Effect.gen(function* () {
    const workspace = yield* requireOwnedWorkspace(input.workspaceId, input.payload.ownerUserId);
    const discard = input.payload.discardUnsaved === true;
    const attestation = input.payload.completion;

    // A discard, or a completion attestation, is accepted on a workspace whose stop was already
    // recorded: that is exactly the workspace a drain keeps because its work is not confirmed
    // saved (the stop is enqueued again so the worker reconsiders it at once).
    if (workspace.status === "stopped" && !discard && attestation === undefined) {
      const response: StopWorkspaceResponse = { workspaceId: workspace.id, status: "stopped" };
      return response;
    }

    const latestRunId = workspace.latestRunId;
    if (latestRunId === null) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has no launched runtime to stop yet.`,
      });
    }

    // Stop targets a live runtime. Before its image is built there is none: the launch's build
    // job is cancelled instead (the worker building it stops at its next progress write, and its
    // fenced success can no longer land), and the run ends `cancelled`. Between the build and the
    // runtime's first row there is still nothing to stop: that is refused, as the launch would
    // race a recorded stop.
    const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
    const instance = yield* withInternalError(
      runtimeInstances.getRuntimeInstanceByRunId(latestRunId),
      "Failed to load the workspace runtime.",
    );
    if (instance === undefined) {
      const jobs = yield* WorkspaceBuildJobRepo;
      const latestJob = yield* withInternalError(
        jobs.getLatestJobByRunId(latestRunId),
        "Failed to load the workspace build job.",
      );
      const cancelled =
        latestJob === undefined || (latestJob.status !== "queued" && latestJob.status !== "running")
          ? null
          : yield* withInternalError(
              jobs.cancelUnbuiltJob({
                id: latestJob.id,
                errorCode: "launch-stopped",
                errorMessage:
                  "The workspace was stopped before its image was built; nothing was launched.",
              }),
              "Failed to cancel the workspace build job.",
            );
      if (cancelled !== null) {
        yield* withInternalError(
          (yield* WorkspaceAttemptRepo).markAttemptCancelled({
            id: latestRunId,
            cancelReason: "stopped before its image was built",
          }),
          "Failed to record the cancelled launch.",
        );
        yield* Effect.logInfo(
          `Workspace ${workspace.id}: ${input.payload.ownerUserId} stopped run ${latestRunId} before its image was built; its build job ${cancelled.id} was cancelled and nothing launches.`,
        );
        const response: StopWorkspaceResponse = { workspaceId: workspace.id, status: "cancelled" };
        return response;
      }
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} is still launching; stop it once the runtime is up.`,
      });
    }

    // The control plane that owns the capture store attests a sealed FINAL of the executor:
    // recorded only when it names THIS executor and nothing Core observed from it contradicts it
    // (an older epoch, a later capture, or a report that its work is not saved made after the
    // seal: received evidence beats stored evidence), and then it lets that executor's disk go
    // once it has ended.
    let completion: StopWorkspaceResponse["completion"];
    if (attestation !== undefined) {
      const drains = yield* WorkspaceCaptureDrainRepo;
      const existing = yield* withInternalError(
        drains.getByRunId(latestRunId),
        "Failed to load workspace capture drain.",
      );
      const attempt = yield* withInternalError(
        (yield* WorkspaceAttemptRepo).getAttemptById(latestRunId),
        "Failed to load the workspace attempt.",
      );
      const sealedAtMs =
        attestation.sealedAt === undefined ? undefined : Date.parse(attestation.sealedAt);
      const covers =
        sealedAtMs !== undefined && Number.isNaN(sealedAtMs)
          ? {
              covers: false as const,
              reason: `the attestation's seal time (${attestation.sealedAt ?? ""}) is not a time`,
            }
          : attestationCoversLaunch(
              attestation,
              attempt?.launchId ?? null,
              // The seal must cover every unsaved answer on record no later one covers, not
              // only the latest (review 9 #4).
              attestationCoversObservations(
                {
                  executorId: attestation.executorId,
                  epoch: attestation.epoch,
                  captureN: attestation.captureN,
                  sealedAtMs,
                  origin: attestation.origin,
                },
                {
                  runId: latestRunId,
                  resourceId: instance.resourceId,
                  reference: instance.reference,
                },
                observedCaptureFromStored(existing?.lastStatus, existing?.lastStatusAt?.getTime()),
                (existing?.unsavedStatuses ?? []).map((member) =>
                  observedCaptureFromStored(member.status, undefined),
                ),
              ),
            );
      if (covers.covers) {
        yield* withInternalError(
          drains.attestCompletion({
            runId: latestRunId,
            executorId: attestation.executorId,
            epoch: attestation.epoch,
            captureN: attestation.captureN,
            attestedBy: input.payload.ownerUserId,
            ...(attestation.launchId === undefined ? {} : { launchId: attestation.launchId }),
            ...(sealedAtMs === undefined ? {} : { sealedAt: new Date(sealedAtMs) }),
            ...(attestation.origin === undefined ? {} : { origin: { ...attestation.origin } }),
          }),
          "Failed to record the completion attestation.",
        );
        completion = { outcome: "accepted" };
        yield* Effect.logInfo(
          `Workspace ${workspace.id}: ${input.payload.ownerUserId} attested a sealed final capture of run ${latestRunId}'s executor ${attestation.executorId} (epoch ${String(attestation.epoch)}, capture ${String(attestation.captureN)}); recorded.`,
        );
      } else {
        completion = { outcome: "ignored", detail: covers.reason };
        yield* Effect.logWarning(
          `Workspace ${workspace.id}: a completion attestation for run ${latestRunId} was ignored: ${covers.reason}. The executor is kept until its work is confirmed saved.`,
        );
      }
    }

    if (discard) {
      // The audit, and the durable intent every stop path honours (the lifecycle stop, and the
      // reaper that re-drives a lost one): the owner asked to discard this runtime's unsaved
      // captures. This is the request; the worker records the termination once it happened.
      const drains = yield* WorkspaceCaptureDrainRepo;
      yield* withInternalError(
        drains.requestDiscard({ runId: latestRunId, requestedBy: input.payload.ownerUserId }),
        "Failed to record the discard of the workspace's unsaved captures.",
      );
      yield* Effect.logWarning(
        `Workspace ${workspace.id}: owner ${input.payload.ownerUserId} requested that the unsaved captures of run ${latestRunId} be discarded (discard requested); the stop is enqueued, and the worker ends the runtime without a drain.`,
      );
    }

    // Durable stop intent BEFORE the enqueue: the stored "stopped" status is the reaper's
    // convergence anchor. If the queue message is lost or dead-letters, the expiry reaper sees a
    // live container on a stopped workspace and re-drives the teardown — the container can never
    // outlive an acknowledged stop.
    const workspaces = yield* WorkspaceRepo;
    yield* withInternalError(
      workspaces.setWorkspaceStatus({ id: workspace.id, status: "stopped" }),
      "Failed to record the workspace stop.",
    );

    const publisher = yield* WorkspaceLifecyclePublisherService;
    yield* Effect.tryPromise({
      try: () =>
        publisher.publishStopRequested({
          workspaceId: workspace.id,
          runId: latestRunId,
          stopReason: "user",
        }),
      catch: (error) =>
        // The intent is already recorded, so even on 502 the reaper converges the container;
        // the error still surfaces because the broker being down is worth knowing about.
        new WorkspaceBadGatewayError({
          message: toErrorMessage(error, "Failed to enqueue the workspace stop."),
        }),
    });

    const response: StopWorkspaceResponse = {
      workspaceId: workspace.id,
      status: mapStoredWorkspaceStatus(workspace.status),
      ...(completion === undefined ? {} : { completion }),
    };
    return response;
  });
};

/**
 * Async recover (202): make a recovery attempt of the workspace's RETAINED executor due now (its
 * disk holds work not confirmed saved). The worker restarts it on its own disk where the runtime
 * can (Docker), drains it with a FINAL flush and only then removes it; elsewhere it reports what
 * can be done. Nothing retained for the current run = `not-retained`, nothing done.
 */
export const recoverWorkspace = (input: {
  readonly workspaceId: string;
  readonly payload: RecoverWorkspaceRequest;
}) => {
  return Effect.gen(function* () {
    const workspace = yield* requireOwnedWorkspace(input.workspaceId, input.payload.ownerUserId);
    const latestRunId = workspace.latestRunId;
    if (latestRunId === null) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has never launched a runtime.`,
      });
    }
    const drains = yield* WorkspaceCaptureDrainRepo;
    const row = yield* withInternalError(
      drains.requestRecovery(latestRunId),
      "Failed to request the recovery of the workspace's retained executor.",
    );
    if (row === undefined) {
      const response: RecoverWorkspaceResponse = {
        workspaceId: workspace.id,
        state: "not-retained",
      };
      return response;
    }
    const runtimeInstances = yield* WorkspaceRuntimeInstanceRepo;
    const instance = yield* withInternalError(
      runtimeInstances.getRuntimeInstanceByRunId(latestRunId),
      "Failed to load the workspace runtime.",
    );
    const recoverable = runtimeRestartsRetainedExecutors(instance?.adapter);
    yield* Effect.logWarning(
      `Workspace ${workspace.id}: ${input.payload.ownerUserId} asked to recover run ${latestRunId}'s retained executor (${instance?.adapter ?? "unknown runtime"}); a recovery attempt is due now${recoverable ? "" : " (this runtime cannot restart it; it is reported and kept)"}.`,
    );
    const response: RecoverWorkspaceResponse = {
      workspaceId: workspace.id,
      state: "requested",
      recoverable,
    };
    return response;
  });
};

/**
 * Async restart (202): stop the current runtime (if any) and drive a fresh launch from the same
 * resolved spec — a new attempt, a new container, no filesystem carry-over. The stop is enqueued
 * FIRST so a failure leaves the workspace untouched; a failure after it leaves the workspace
 * stopped (honest state, retryable), never two live containers.
 */
export const restartWorkspace = (input: {
  readonly workspaceId: string;
  readonly payload: RestartWorkspaceRequest;
}) => {
  return Effect.gen(function* () {
    const workspace = yield* requireOwnedWorkspace(input.workspaceId, input.payload.ownerUserId);

    if (workspace.latestRunId === null) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has never launched; there is no recorded spec to relaunch from.`,
      });
    }
    const previousRunId = workspace.latestRunId;

    const workspaces = yield* WorkspaceRepo;
    const workspaceAttempts = yield* WorkspaceAttemptRepo;
    const workspaceBuildJobs = yield* WorkspaceBuildJobRepo;

    const previousAttempt = yield* withInternalError(
      workspaceAttempts.getAttemptById(previousRunId),
      "Failed to load the latest workspace attempt.",
    );
    if (previousAttempt?.status === "queued" || previousAttempt?.status === "running") {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} is mid-launch; wait for the current attempt to finish before restarting.`,
      });
    }

    const previousJob = yield* withInternalError(
      workspaceBuildJobs.getLatestJobByRunId(previousRunId),
      "Failed to load the latest workspace build job.",
    );
    const snapshot = yield* withInternalError(
      workspaceAttempts.getAttemptSnapshotByRunId(previousRunId),
      "Failed to load the workspace attempt snapshot.",
    );

    const specPayload =
      snapshot?.resolvedSpecPayload ?? snapshot?.userSpecPayload ?? previousJob?.requestPayload;
    if (previousJob === undefined || specPayload === undefined) {
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} has no recorded spec to relaunch from.`,
      });
    }
    const recordedSpec = yield* parseWorkspaceSpec(specPayload);
    // The snapshot never carries the dotfiles archive payloads (`snapshotSpecOf`); the previous
    // build job does. Relaunch with them, so the restarted workspace applies the same dotfiles
    // and its image plan keeps the managers they need (tar, chezmoi, stow).
    const dotfilesArchives =
      recordedSpec.runtime.dotfilesArchives.length > 0
        ? recordedSpec.runtime.dotfilesArchives
        : yield* recordedDotfilesArchives(workspace.id, previousJob.requestPayload);
    const spec: NewWorkspace = {
      ...recordedSpec,
      runtime: { ...recordedSpec.runtime, dotfilesArchives },
    };
    // A relaunch mints credentials again from the recorded spec, so the recorded spec is checked
    // like a submitted one. A spec stored before refs were bound to their URL (CORE-05) may name a
    // destination the ref was never issued for; it is refused here, not relaunched.
    yield* validateClientSuppliedAuthRefs({ ownerUserId: input.payload.ownerUserId, spec }).pipe(
      Effect.catchTags({
        WorkspaceForbiddenError: (error) =>
          Effect.fail(
            new WorkspaceConflictError({
              message: `Workspace ${input.workspaceId} cannot be restarted from its recorded spec: ${error.message}`,
            }),
          ),
      }),
    );
    if (spec.sources.workspace.kind === "capture") {
      // The session credential was sealed for the launch and cleared once it settled; a relaunch
      // would boot with no channel credential. Replacement is a new workspace with a fresh token.
      return yield* new WorkspaceConflictError({
        message: `Workspace ${input.workspaceId} is capture-sourced and cannot be restarted in place: its session credential is not retained. Create a replacement workspace with a fresh captureToken.`,
      });
    }

    // Budgets last among the refusals, as in create. A restart brings a settled workspace back to life: it needs room and spends a launch.
    if (
      workspace.status !== "queued" &&
      workspace.status !== "running" &&
      workspace.status !== "ready"
    ) {
      yield* requireLiveWorkspaceRoom(input.payload.ownerUserId);
    }
    yield* spendOwnerLaunch(input.payload.ownerUserId);

    // Stop the old runtime first (idempotent in the worker even if it already stopped/failed).
    const lifecyclePublisher = yield* WorkspaceLifecyclePublisherService;
    yield* Effect.tryPromise({
      try: () =>
        lifecyclePublisher.publishStopRequested({
          workspaceId: workspace.id,
          runId: previousRunId,
          stopReason: "user",
        }),
      catch: (error) =>
        new WorkspaceBadGatewayError({
          message: toErrorMessage(error, "Failed to enqueue the workspace stop for restart."),
        }),
    });

    const runId = yield* randomId;
    const jobId = yield* randomId;
    // A fresh tag per rebuild: re-pushing the previous tag would make the prior attempt's recorded
    // `publishedReference` resolve to a different digest than its recorded `publishedDigest`,
    // quietly corrupting that run's audit trail. Restarts of restarts replace the suffix instead
    // of compounding it.
    const restartTag = `${previousJob.tag.replace(/-r-[0-9a-f]{8}$/, "")}-r-${runId.slice(0, 8)}`;
    // Restart resets the TTL clock like a fresh create (otherwise restarting an EXPIRED workspace
    // hands the reaper a runtime that is already past its expiry and it dies on the next tick).
    const ttlSeconds = env.SEALANT_WORKSPACE_DEFAULT_TTL_SECONDS;
    const expiresAt = ttlSeconds === undefined ? null : new Date(Date.now() + ttlSeconds * 1000);

    const persistenceResult = yield* Effect.result(
      Effect.gen(function* () {
        const attempt = yield* workspaceAttempts.createQueuedAttempt({
          id: runId,
          ownerUserId: workspace.ownerUserId,
          ...(workspace.repositoryId === null ? {} : { repositoryId: workspace.repositoryId }),
          triggerType: "api",
          requestedByUserId: input.payload.ownerUserId,
        });

        yield* workspaces.linkWorkspaceAttempt({
          workspaceId: workspace.id,
          attemptId: attempt.id,
          relation: "rebuild",
        });

        yield* workspaceAttempts.setAttemptSnapshot({
          runId: attempt.id,
          specPayload: snapshotSpecOf(spec),
        });

        yield* workspaceBuildJobs.insertQueuedJob({
          id: jobId,
          runId: attempt.id,
          registryId: previousJob.registryId,
          repository: previousJob.repository,
          tag: restartTag,
          requestPayload: spec,
        });

        yield* workspaces.setWorkspaceExpiry({ id: workspace.id, expiresAt });
        yield* workspaces.setWorkspaceStatus({ id: workspace.id, status: "queued" });
      }),
    );

    if (Result.isFailure(persistenceResult)) {
      return yield* new WorkspaceInternalServerError({
        message: toErrorMessage(persistenceResult.failure, "Failed to record the restart."),
      });
    }

    const workspaceBuildJobPublisher = yield* WorkspaceBuildJobPublisherService;
    yield* Effect.tryPromise({
      try: () => workspaceBuildJobPublisher.publishRequested({ jobId }),
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
              workspaceAttempts.markAttemptFailed({ id: runId }),
              workspaces.setWorkspaceStatus({ id: workspace.id, status: "failed" }),
            ],
            { concurrency: "unbounded" },
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Workspace ${workspace.id} rollback writes failed after restart publish failure; state may be inconsistent.`,
                cause,
              ),
            ),
          );

          return yield* new WorkspaceBadGatewayError({
            message: `Workspace ${workspace.id} restart was recorded but could not be queued.`,
          });
        }),
      ),
    );

    const response: RestartWorkspaceResponse = {
      workspaceId: workspace.id,
      runId,
      status: "queued",
    };
    return response;
  });
};

/** Synchronous: set (ttlSeconds from now), clear (null), or trigger (omitted = now) the TTL. */
export const expireWorkspace = (input: {
  readonly workspaceId: string;
  readonly payload: ExpireWorkspaceRequest;
}) => {
  return Effect.gen(function* () {
    const workspace = yield* requireOwnedWorkspace(input.workspaceId, input.payload.ownerUserId);

    const ttlSeconds = input.payload.ttlSeconds;
    const expiresAt =
      ttlSeconds === null
        ? null
        : ttlSeconds === undefined
          ? new Date()
          : new Date(Date.now() + ttlSeconds * 1000);

    const workspaces = yield* WorkspaceRepo;
    yield* withInternalError(
      workspaces.setWorkspaceExpiry({ id: workspace.id, expiresAt }),
      "Failed to set the workspace expiry.",
    );

    const response: ExpireWorkspaceResponse = {
      workspaceId: workspace.id,
      expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
    };
    return response;
  });
};

/**
 * What a create would build, read before the create (Mend ADR 0016): the spec is planned exactly as
 * the build plans it, and the latest image published for that plan answers with its per-person
 * capability. The image's names are answered only to the owner who built it.
 */
export const inspectWorkspaceImage = (input: { readonly payload: InspectWorkspaceImageRequest }) =>
  Effect.gen(function* () {
    const body = input.payload;
    if (body.registryId !== env.REGISTRY_NAME) {
      return yield* new WorkspaceNotFoundError({ message: `Unknown registry: ${body.registryId}` });
    }
    const spec = yield* parseWorkspaceSpec(body.spec);
    const planned = yield* Effect.try({
      try: () => planWorkspaceImageBuild({ blueprint: spec }),
      catch: (error) =>
        new WorkspaceBadRequestError({
          message: `The spec does not plan an image: ${error instanceof Error ? error.message : "unknown error"}`,
        }),
    });
    const job = yield* withInternalError(
      (yield* WorkspaceBuildJobRepo).getLatestSucceededJobByPlanHash({
        registryId: body.registryId,
        planHash: planned.planHash,
      }),
      "Failed to look up the image for the plan.",
    );
    const attempt =
      job?.runId === null || job?.runId === undefined
        ? undefined
        : yield* withInternalError(
            (yield* WorkspaceAttemptRepo).getAttemptById(job.runId),
            "Failed to load the build's launch.",
          );
    const context = personLayoutContext();
    const image = resolveWorkspacePublishedImage(job, context);
    return {
      planHash: planned.planHash,
      ...(image === undefined || attempt?.ownerUserId !== body.ownerUserId
        ? {}
        : { publishedImage: image }),
      personLayout:
        image?.personLayout ??
        personLayoutCapability(job?.resultPayload?.metadata?.imageProbe, context),
    } satisfies InspectWorkspaceImageResponse;
  });
