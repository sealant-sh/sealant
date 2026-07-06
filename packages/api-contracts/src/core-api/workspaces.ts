import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

import { runCommandSchema, runSchema } from "./runs.js";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const workspaceStatusSchema = Schema.Literals([
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
]);
export type WorkspaceStatus = typeof workspaceStatusSchema.Type;

export const workspaceRuntimeSchema = Schema.Struct({
  adapter: Schema.Literals(["docker", "k8s", "k3s"]),
  resourceId: NonEmptyString,
  reference: NonEmptyString,
  status: Schema.Literals(["pending", "running", "ready", "failed", "stopped"]),
  endpoint: Schema.optional(Schema.String),
});
export type WorkspaceRuntime = typeof workspaceRuntimeSchema.Type;

export const workspaceSshTargetSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  attemptId: NonEmptyString,
  runtime: Schema.Struct({
    adapter: Schema.Literals(["docker", "k8s", "k3s"]),
    resourceId: NonEmptyString,
    reference: NonEmptyString,
    status: Schema.Literals(["pending", "running", "ready", "failed", "stopped"]),
    endpoint: Schema.String,
  }),
});
export type WorkspaceSshTarget = typeof workspaceSshTargetSchema.Type;

export const workspacePublishedImageSchema = Schema.Struct({
  reference: NonEmptyString,
  digestReference: NonEmptyString,
  digest: NonEmptyString,
});

export const workspaceErrorSchema = Schema.Struct({
  message: Schema.String,
  code: Schema.optional(NonEmptyString),
});

export const githubWorkspaceSourceSelectionSchema = Schema.Struct({
  provider: Schema.Literal("github"),
  installationId: NonEmptyString,
  installationRepositoryId: NonEmptyString,
  ref: Schema.optional(NonEmptyString),
});
export type GitHubWorkspaceSourceSelection = typeof githubWorkspaceSourceSelectionSchema.Type;

// Connected-account selection (mirrors `newWorkspaceCredentialsSchema` in @sealant/validators):
// values are connected-account ids ("cacc_…") or per-provider account names; explicit per-provider
// entries win over the profile's bindings. Resolved server-side into opaque blueprint
// `credentialRefs` — no secret material ever appears in the request or the blueprint.
export const createWorkspaceCredentialsSchema = Schema.Struct({
  profileId: Schema.optional(NonEmptyString),
  claude: Schema.optional(NonEmptyString),
  codex: Schema.optional(NonEmptyString),
  github: Schema.optional(NonEmptyString),
});
export type CreateWorkspaceCredentials = typeof createWorkspaceCredentialsSchema.Type;

export const createWorkspaceRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  registryId: NonEmptyString,
  repository: NonEmptyString,
  tag: NonEmptyString,
  name: Schema.optional(NonEmptyString),
  sourceSelection: Schema.optional(githubWorkspaceSourceSelectionSchema),
  dotfilesSelection: Schema.optional(githubWorkspaceSourceSelectionSchema),
  credentials: Schema.optional(createWorkspaceCredentialsSchema),
  spec: Schema.Unknown,
});
export type CreateWorkspaceRequest = typeof createWorkspaceRequestSchema.Type;

export const createWorkspaceHeadersSchema = Schema.Struct({
  "idempotency-key": Schema.optional(NonEmptyString),
});
export type CreateWorkspaceHeaders = typeof createWorkspaceHeadersSchema.Type;

/**
 * The `harnessId` stamped on runs created by the deterministic-exec endpoint, so consumers can tell
 * check runs apart from harness runs when listing/reading runs.
 */
export const execRunHarnessId = "exec";

/**
 * Deterministic exec: run an ORDERED LIST of commands in the workspace, recorded as ONE run (a
 * "check run") — e.g. a causal proof `base fails · head passes · revert fails` as three commands
 * with three recorded exit codes.
 *
 * Semantics differ deliberately from harness runs: every command executes IN ORDER regardless of
 * exit codes (a nonzero exit is a check DATUM, not an execution failure), and the run completes iff
 * every command executed and was recorded. The run's `exitCode` is the LAST command's; per-command
 * exit codes live in the execution record (`processExited` events). The run FAILS only when the
 * execution machinery broke (workspace gone, transport dropped mid-command) — so `status` answers
 * "can I trust these exit codes", not "did the checks pass".
 */
export const execWorkspaceRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  /** Commands execute sequentially in the workspace, each recorded like any other process. */
  commands: Schema.Array(runCommandSchema).check(Schema.isNonEmpty(), Schema.isMaxLength(32)),
});
export type ExecWorkspaceRequest = typeof execWorkspaceRequestSchema.Type;

export const renameWorkspaceRequestSchema = Schema.Struct({
  name: NonEmptyString,
});
export type RenameWorkspaceRequest = typeof renameWorkspaceRequestSchema.Type;

export const renameWorkspaceResponseSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  name: NonEmptyString,
  updatedAt: Schema.String,
});
export type RenameWorkspaceResponse = typeof renameWorkspaceResponseSchema.Type;

export const createWorkspaceResponseSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  name: NonEmptyString,
  status: workspaceStatusSchema,
  registryId: NonEmptyString,
  repository: NonEmptyString,
  tag: NonEmptyString,
});
export type CreateWorkspaceResponse = typeof createWorkspaceResponseSchema.Type;

export const workspaceSummarySchema = Schema.Struct({
  workspaceId: NonEmptyString,
  name: NonEmptyString,
  ownerUserId: NonEmptyString,
  status: workspaceStatusSchema,
  registryId: Schema.optional(NonEmptyString),
  repository: Schema.optional(NonEmptyString),
  tag: Schema.optional(NonEmptyString),
  runtime: Schema.optional(workspaceRuntimeSchema),
  publishedImage: Schema.optional(workspacePublishedImageSchema),
  error: Schema.optional(workspaceErrorSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
});
export type WorkspaceSummary = typeof workspaceSummarySchema.Type;

export const workspaceDetailsSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  name: NonEmptyString,
  ownerUserId: NonEmptyString,
  status: workspaceStatusSchema,
  registryId: Schema.optional(NonEmptyString),
  repository: Schema.optional(NonEmptyString),
  tag: Schema.optional(NonEmptyString),
  runtime: Schema.optional(workspaceRuntimeSchema),
  publishedImage: Schema.optional(workspacePublishedImageSchema),
  error: Schema.optional(workspaceErrorSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  spec: Schema.optional(Schema.Unknown),
});
export type WorkspaceDetails = typeof workspaceDetailsSchema.Type;

export const listWorkspacesQuerySchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  status: Schema.optional(workspaceStatusSchema),
  limit: Schema.optional(NonEmptyString),
});
export type ListWorkspacesQuery = typeof listWorkspacesQuerySchema.Type;

export const listWorkspacesResponseSchema = Schema.Struct({
  items: Schema.Array(workspaceSummarySchema),
});
export type ListWorkspacesResponse = typeof listWorkspacesResponseSchema.Type;

export const listWorkspaceAttemptsQuerySchema = Schema.Struct({
  limit: Schema.optional(NonEmptyString),
});
export type ListWorkspaceAttemptsQuery = typeof listWorkspaceAttemptsQuerySchema.Type;

export const workspaceAttemptSummarySchema = Schema.Struct({
  attemptId: NonEmptyString,
  relation: Schema.Literals(["launch", "rebuild", "retry", "resume"]),
  status: workspaceStatusSchema,
  triggerType: Schema.Literals(["manual", "schedule", "api", "retry"]),
  triggerRef: Schema.optional(NonEmptyString),
  runtime: Schema.optional(workspaceRuntimeSchema),
  publishedImage: Schema.optional(workspacePublishedImageSchema),
  error: Schema.optional(workspaceErrorSchema),
  spec: Schema.optional(Schema.Unknown),
  queuedAt: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  linkedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type WorkspaceAttemptSummary = typeof workspaceAttemptSummarySchema.Type;

export const listWorkspaceAttemptsResponseSchema = Schema.Struct({
  items: Schema.Array(workspaceAttemptSummarySchema),
});
export type ListWorkspaceAttemptsResponse = typeof listWorkspaceAttemptsResponseSchema.Type;

export const listWorkspaceEventsQuerySchema = Schema.Struct({
  limit: Schema.optional(NonEmptyString),
});
export type ListWorkspaceEventsQuery = typeof listWorkspaceEventsQuerySchema.Type;

export const workspaceEventTypeSchema = Schema.Literals([
  "workspace.created",
  "attempt.queued",
  "attempt.running",
  "attempt.succeeded",
  "attempt.failed",
  "attempt.cancelled",
  "image.published",
  "runtime.pending",
  "runtime.running",
  "runtime.ready",
  "runtime.failed",
  "runtime.stopped",
]);
export type WorkspaceEventType = typeof workspaceEventTypeSchema.Type;

export const workspaceEventSchema = Schema.Struct({
  eventId: NonEmptyString,
  workspaceId: NonEmptyString,
  attemptId: Schema.optional(NonEmptyString),
  type: workspaceEventTypeSchema,
  occurredAt: Schema.String,
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
});
export type WorkspaceEvent = typeof workspaceEventSchema.Type;

export const listWorkspaceEventsResponseSchema = Schema.Struct({
  items: Schema.Array(workspaceEventSchema),
});
export type ListWorkspaceEventsResponse = typeof listWorkspaceEventsResponseSchema.Type;

export const workspaceGatewayHeadersSchema = Schema.Struct({
  // Authenticates the gateway as a trusted caller of this internal endpoint.
  "x-sealant-gateway-token": Schema.optional(NonEmptyString),
  // Identifies the client principal (the SSH key's owner). The API authorizes principal x workspace
  // before returning a control target (gateway-spec §3.4).
  "x-sealant-principal-id": Schema.optional(NonEmptyString),
});
export type WorkspaceGatewayHeaders = typeof workspaceGatewayHeadersSchema.Type;

export class WorkspaceBadRequestError extends Schema.TaggedErrorClass<WorkspaceBadRequestError>()(
  "WorkspaceBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class WorkspaceUnauthorizedError extends Schema.TaggedErrorClass<WorkspaceUnauthorizedError>()(
  "WorkspaceUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {}

export class WorkspaceForbiddenError extends Schema.TaggedErrorClass<WorkspaceForbiddenError>()(
  "WorkspaceForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

export class WorkspaceNotFoundError extends Schema.TaggedErrorClass<WorkspaceNotFoundError>()(
  "WorkspaceNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class WorkspaceConflictError extends Schema.TaggedErrorClass<WorkspaceConflictError>()(
  "WorkspaceConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class WorkspaceBadGatewayError extends Schema.TaggedErrorClass<WorkspaceBadGatewayError>()(
  "WorkspaceBadGatewayError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {}

export class WorkspaceServiceUnavailableError extends Schema.TaggedErrorClass<WorkspaceServiceUnavailableError>()(
  "WorkspaceServiceUnavailableError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class WorkspaceInternalServerError extends Schema.TaggedErrorClass<WorkspaceInternalServerError>()(
  "WorkspaceInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

const workspaceIdParams = Schema.Struct({ workspaceId: NonEmptyString });

export const WorkspacesGroup = HttpApiGroup.make("workspaces")
  .add(
    HttpApiEndpoint.post("createWorkspace", "/", {
      headers: createWorkspaceHeadersSchema,
      payload: createWorkspaceRequestSchema,
      success: createWorkspaceResponseSchema.pipe(HttpApiSchema.status(202)),
      error: [
        WorkspaceBadRequestError,
        WorkspaceForbiddenError,
        WorkspaceNotFoundError,
        // Selected connected account exists but is not usable (status "invalid").
        WorkspaceConflictError,
        WorkspaceBadGatewayError,
        WorkspaceServiceUnavailableError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .add(
    // Async like createWorkspace: 202 + the queued run resource; poll `GET /v1/runs/:runId` to
    // completion, then read exit codes / scrollback from the run record.
    HttpApiEndpoint.post("execWorkspace", "/:workspaceId/exec", {
      params: workspaceIdParams,
      payload: execWorkspaceRequestSchema,
      success: runSchema.pipe(HttpApiSchema.status(202)),
      error: [
        WorkspaceBadRequestError,
        WorkspaceNotFoundError,
        // The workspace has never launched a runtime — nothing to exec in yet.
        WorkspaceConflictError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.patch("renameWorkspace", "/:workspaceId/name", {
      params: workspaceIdParams,
      payload: renameWorkspaceRequestSchema,
      success: renameWorkspaceResponseSchema,
      error: [WorkspaceNotFoundError, WorkspaceInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listWorkspaces", "/", {
      query: listWorkspacesQuerySchema,
      success: listWorkspacesResponseSchema,
      error: [WorkspaceBadRequestError, WorkspaceInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getWorkspace", "/:workspaceId", {
      params: workspaceIdParams,
      success: workspaceDetailsSchema,
      error: [WorkspaceNotFoundError, WorkspaceInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listWorkspaceAttempts", "/:workspaceId/attempts", {
      params: workspaceIdParams,
      query: listWorkspaceAttemptsQuerySchema,
      success: listWorkspaceAttemptsResponseSchema,
      error: [WorkspaceBadRequestError, WorkspaceNotFoundError, WorkspaceInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listWorkspaceEvents", "/:workspaceId/events", {
      params: workspaceIdParams,
      query: listWorkspaceEventsQuerySchema,
      success: listWorkspaceEventsResponseSchema,
      error: [WorkspaceBadRequestError, WorkspaceNotFoundError, WorkspaceInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getWorkspaceSshTarget", "/:workspaceId/ssh-target", {
      params: workspaceIdParams,
      headers: workspaceGatewayHeadersSchema,
      success: workspaceSshTargetSchema,
      error: [
        WorkspaceUnauthorizedError,
        WorkspaceNotFoundError,
        WorkspaceConflictError,
        WorkspaceServiceUnavailableError,
        WorkspaceInternalServerError,
      ],
    }),
  )
  .annotate(
    OpenApi.Description,
    "Workspace lifecycle, attempts, events, and runtime routing endpoints.",
  );
