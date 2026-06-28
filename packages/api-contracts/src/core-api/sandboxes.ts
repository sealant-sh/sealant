import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const sandboxStatusSchema = Schema.Literals([
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
]);
export type SandboxStatus = typeof sandboxStatusSchema.Type;

export const sandboxRuntimeSchema = Schema.Struct({
  adapter: Schema.Literals(["docker", "k8s", "k3s"]),
  resourceId: NonEmptyString,
  reference: NonEmptyString,
  status: Schema.Literals(["pending", "running", "ready", "failed", "stopped"]),
  endpoint: Schema.optional(Schema.String),
});
export type SandboxRuntime = typeof sandboxRuntimeSchema.Type;

export const sandboxSshTargetSchema = Schema.Struct({
  sandboxId: NonEmptyString,
  attemptId: NonEmptyString,
  runtime: Schema.Struct({
    adapter: Schema.Literals(["docker", "k8s", "k3s"]),
    resourceId: NonEmptyString,
    reference: NonEmptyString,
    status: Schema.Literals(["pending", "running", "ready", "failed", "stopped"]),
    endpoint: Schema.String,
  }),
});
export type SandboxSshTarget = typeof sandboxSshTargetSchema.Type;

export const sandboxPublishedImageSchema = Schema.Struct({
  reference: NonEmptyString,
  digestReference: NonEmptyString,
  digest: NonEmptyString,
});

export const sandboxErrorSchema = Schema.Struct({
  message: Schema.String,
  code: Schema.optional(NonEmptyString),
});

export const githubSandboxSourceSelectionSchema = Schema.Struct({
  provider: Schema.Literal("github"),
  installationId: NonEmptyString,
  installationRepositoryId: NonEmptyString,
  ref: Schema.optional(NonEmptyString),
});
export type GitHubSandboxSourceSelection = typeof githubSandboxSourceSelectionSchema.Type;

export const createSandboxRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  registryId: NonEmptyString,
  repository: NonEmptyString,
  tag: NonEmptyString,
  name: Schema.optional(NonEmptyString),
  sourceSelection: Schema.optional(githubSandboxSourceSelectionSchema),
  dotfilesSelection: Schema.optional(githubSandboxSourceSelectionSchema),
  spec: Schema.Unknown,
});
export type CreateSandboxRequest = typeof createSandboxRequestSchema.Type;

export const createSandboxHeadersSchema = Schema.Struct({
  "idempotency-key": Schema.optional(NonEmptyString),
});
export type CreateSandboxHeaders = typeof createSandboxHeadersSchema.Type;

export const renameSandboxRequestSchema = Schema.Struct({
  name: NonEmptyString,
});
export type RenameSandboxRequest = typeof renameSandboxRequestSchema.Type;

export const renameSandboxResponseSchema = Schema.Struct({
  sandboxId: NonEmptyString,
  name: NonEmptyString,
  updatedAt: Schema.String,
});
export type RenameSandboxResponse = typeof renameSandboxResponseSchema.Type;

export const createSandboxResponseSchema = Schema.Struct({
  sandboxId: NonEmptyString,
  name: NonEmptyString,
  status: sandboxStatusSchema,
  registryId: NonEmptyString,
  repository: NonEmptyString,
  tag: NonEmptyString,
});
export type CreateSandboxResponse = typeof createSandboxResponseSchema.Type;

export const sandboxSummarySchema = Schema.Struct({
  sandboxId: NonEmptyString,
  name: NonEmptyString,
  ownerUserId: NonEmptyString,
  status: sandboxStatusSchema,
  registryId: Schema.optional(NonEmptyString),
  repository: Schema.optional(NonEmptyString),
  tag: Schema.optional(NonEmptyString),
  runtime: Schema.optional(sandboxRuntimeSchema),
  publishedImage: Schema.optional(sandboxPublishedImageSchema),
  error: Schema.optional(sandboxErrorSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
});
export type SandboxSummary = typeof sandboxSummarySchema.Type;

export const sandboxDetailsSchema = Schema.Struct({
  sandboxId: NonEmptyString,
  name: NonEmptyString,
  ownerUserId: NonEmptyString,
  status: sandboxStatusSchema,
  registryId: Schema.optional(NonEmptyString),
  repository: Schema.optional(NonEmptyString),
  tag: Schema.optional(NonEmptyString),
  runtime: Schema.optional(sandboxRuntimeSchema),
  publishedImage: Schema.optional(sandboxPublishedImageSchema),
  error: Schema.optional(sandboxErrorSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  spec: Schema.optional(Schema.Unknown),
});
export type SandboxDetails = typeof sandboxDetailsSchema.Type;

export const listSandboxesQuerySchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  status: Schema.optional(sandboxStatusSchema),
  limit: Schema.optional(NonEmptyString),
});
export type ListSandboxesQuery = typeof listSandboxesQuerySchema.Type;

export const listSandboxesResponseSchema = Schema.Struct({
  items: Schema.Array(sandboxSummarySchema),
});
export type ListSandboxesResponse = typeof listSandboxesResponseSchema.Type;

export const listSandboxAttemptsQuerySchema = Schema.Struct({
  limit: Schema.optional(NonEmptyString),
});
export type ListSandboxAttemptsQuery = typeof listSandboxAttemptsQuerySchema.Type;

export const sandboxAttemptSummarySchema = Schema.Struct({
  attemptId: NonEmptyString,
  relation: Schema.Literals(["launch", "rebuild", "retry", "resume"]),
  status: sandboxStatusSchema,
  triggerType: Schema.Literals(["manual", "issue", "schedule", "api", "retry"]),
  triggerRef: Schema.optional(NonEmptyString),
  runtime: Schema.optional(sandboxRuntimeSchema),
  publishedImage: Schema.optional(sandboxPublishedImageSchema),
  error: Schema.optional(sandboxErrorSchema),
  spec: Schema.optional(Schema.Unknown),
  queuedAt: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  linkedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type SandboxAttemptSummary = typeof sandboxAttemptSummarySchema.Type;

export const listSandboxAttemptsResponseSchema = Schema.Struct({
  items: Schema.Array(sandboxAttemptSummarySchema),
});
export type ListSandboxAttemptsResponse = typeof listSandboxAttemptsResponseSchema.Type;

export const listSandboxEventsQuerySchema = Schema.Struct({
  limit: Schema.optional(NonEmptyString),
});
export type ListSandboxEventsQuery = typeof listSandboxEventsQuerySchema.Type;

export const sandboxEventTypeSchema = Schema.Literals([
  "sandbox.created",
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
export type SandboxEventType = typeof sandboxEventTypeSchema.Type;

export const sandboxEventSchema = Schema.Struct({
  eventId: NonEmptyString,
  sandboxId: NonEmptyString,
  attemptId: Schema.optional(NonEmptyString),
  type: sandboxEventTypeSchema,
  occurredAt: Schema.String,
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
});
export type SandboxEvent = typeof sandboxEventSchema.Type;

export const listSandboxEventsResponseSchema = Schema.Struct({
  items: Schema.Array(sandboxEventSchema),
});
export type ListSandboxEventsResponse = typeof listSandboxEventsResponseSchema.Type;

export const sandboxGatewayHeadersSchema = Schema.Struct({
  // Authenticates the gateway as a trusted caller of this internal endpoint.
  "x-sealant-gateway-token": Schema.optional(NonEmptyString),
  // Identifies the client principal (the SSH key's owner). The API authorizes principal x sandbox
  // before returning a control target (gateway-spec §3.4).
  "x-sealant-principal-id": Schema.optional(NonEmptyString),
});
export type SandboxGatewayHeaders = typeof sandboxGatewayHeadersSchema.Type;

export class SandboxBadRequestError extends Schema.TaggedErrorClass<SandboxBadRequestError>()(
  "SandboxBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class SandboxUnauthorizedError extends Schema.TaggedErrorClass<SandboxUnauthorizedError>()(
  "SandboxUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {}

export class SandboxForbiddenError extends Schema.TaggedErrorClass<SandboxForbiddenError>()(
  "SandboxForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

export class SandboxNotFoundError extends Schema.TaggedErrorClass<SandboxNotFoundError>()(
  "SandboxNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class SandboxConflictError extends Schema.TaggedErrorClass<SandboxConflictError>()(
  "SandboxConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class SandboxBadGatewayError extends Schema.TaggedErrorClass<SandboxBadGatewayError>()(
  "SandboxBadGatewayError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {}

export class SandboxServiceUnavailableError extends Schema.TaggedErrorClass<SandboxServiceUnavailableError>()(
  "SandboxServiceUnavailableError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class SandboxInternalServerError extends Schema.TaggedErrorClass<SandboxInternalServerError>()(
  "SandboxInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

const sandboxIdParams = Schema.Struct({ sandboxId: NonEmptyString });

export const SandboxesGroup = HttpApiGroup.make("sandboxes")
  .add(
    HttpApiEndpoint.post("createSandbox", "/", {
      headers: createSandboxHeadersSchema,
      payload: createSandboxRequestSchema,
      success: createSandboxResponseSchema.pipe(HttpApiSchema.status(202)),
      error: [
        SandboxBadRequestError,
        SandboxForbiddenError,
        SandboxNotFoundError,
        SandboxBadGatewayError,
        SandboxServiceUnavailableError,
        SandboxInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.patch("renameSandbox", "/:sandboxId/name", {
      params: sandboxIdParams,
      payload: renameSandboxRequestSchema,
      success: renameSandboxResponseSchema,
      error: [SandboxNotFoundError, SandboxInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listSandboxes", "/", {
      query: listSandboxesQuerySchema,
      success: listSandboxesResponseSchema,
      error: [SandboxBadRequestError, SandboxInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getSandbox", "/:sandboxId", {
      params: sandboxIdParams,
      success: sandboxDetailsSchema,
      error: [SandboxNotFoundError, SandboxInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listSandboxAttempts", "/:sandboxId/attempts", {
      params: sandboxIdParams,
      query: listSandboxAttemptsQuerySchema,
      success: listSandboxAttemptsResponseSchema,
      error: [SandboxBadRequestError, SandboxNotFoundError, SandboxInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listSandboxEvents", "/:sandboxId/events", {
      params: sandboxIdParams,
      query: listSandboxEventsQuerySchema,
      success: listSandboxEventsResponseSchema,
      error: [SandboxBadRequestError, SandboxNotFoundError, SandboxInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getSandboxSshTarget", "/:sandboxId/ssh-target", {
      params: sandboxIdParams,
      headers: sandboxGatewayHeadersSchema,
      success: sandboxSshTargetSchema,
      error: [
        SandboxUnauthorizedError,
        SandboxNotFoundError,
        SandboxConflictError,
        SandboxServiceUnavailableError,
        SandboxInternalServerError,
      ],
    }),
  )
  .annotate(
    OpenApi.Description,
    "Sandbox lifecycle, attempts, events, and runtime routing endpoints.",
  );
