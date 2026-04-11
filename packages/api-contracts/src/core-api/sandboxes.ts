import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform";
import { Schema } from "effect";

const NonEmptyString = Schema.NonEmptyTrimmedString;

export const sandboxStatusSchema = Schema.Literal(
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
);
export type SandboxStatus = typeof sandboxStatusSchema.Type;

export const sandboxRuntimeSchema = Schema.Struct({
  adapter: Schema.Literal("docker", "k8s", "k3s"),
  resourceId: NonEmptyString,
  reference: NonEmptyString,
  status: Schema.Literal("pending", "running", "failed", "stopped"),
  endpoint: Schema.optional(Schema.String),
});
export type SandboxRuntime = typeof sandboxRuntimeSchema.Type;

export const sandboxSshTargetSchema = Schema.Struct({
  sandboxId: NonEmptyString,
  attemptId: NonEmptyString,
  runtime: Schema.Struct({
    adapter: Schema.Literal("docker", "k8s", "k3s"),
    resourceId: NonEmptyString,
    reference: NonEmptyString,
    status: Schema.Literal("pending", "running", "failed", "stopped"),
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
  relation: Schema.Literal("launch", "rebuild", "retry", "resume"),
  status: sandboxStatusSchema,
  triggerType: Schema.Literal("manual", "issue", "schedule", "api", "retry"),
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
  durationMs: Schema.optional(Schema.NonNegative),
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

export const sandboxEventTypeSchema = Schema.Literal(
  "sandbox.created",
  "attempt.queued",
  "attempt.running",
  "attempt.succeeded",
  "attempt.failed",
  "attempt.cancelled",
  "image.published",
  "runtime.pending",
  "runtime.running",
  "runtime.failed",
  "runtime.stopped",
);
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
  "x-sealant-gateway-token": Schema.optional(NonEmptyString),
});
export type SandboxGatewayHeaders = typeof sandboxGatewayHeadersSchema.Type;

export class SandboxBadRequestError extends Schema.TaggedError<SandboxBadRequestError>(
  "SandboxBadRequestError",
)(
  "SandboxBadRequestError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class SandboxUnauthorizedError extends Schema.TaggedError<SandboxUnauthorizedError>(
  "SandboxUnauthorizedError",
)(
  "SandboxUnauthorizedError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class SandboxForbiddenError extends Schema.TaggedError<SandboxForbiddenError>(
  "SandboxForbiddenError",
)(
  "SandboxForbiddenError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class SandboxNotFoundError extends Schema.TaggedError<SandboxNotFoundError>(
  "SandboxNotFoundError",
)(
  "SandboxNotFoundError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class SandboxConflictError extends Schema.TaggedError<SandboxConflictError>(
  "SandboxConflictError",
)(
  "SandboxConflictError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 409 }),
) {}

export class SandboxBadGatewayError extends Schema.TaggedError<SandboxBadGatewayError>(
  "SandboxBadGatewayError",
)(
  "SandboxBadGatewayError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 502 }),
) {}

export class SandboxServiceUnavailableError extends Schema.TaggedError<SandboxServiceUnavailableError>(
  "SandboxServiceUnavailableError",
)(
  "SandboxServiceUnavailableError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 503 }),
) {}

export class SandboxInternalServerError extends Schema.TaggedError<SandboxInternalServerError>(
  "SandboxInternalServerError",
)(
  "SandboxInternalServerError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}

const sandboxId = HttpApiSchema.param("sandboxId", NonEmptyString);

export const SandboxesGroup = HttpApiGroup.make("sandboxes")
  .add(
    HttpApiEndpoint.post("createSandbox", "/")
      .setHeaders(createSandboxHeadersSchema)
      .setPayload(createSandboxRequestSchema)
      .addSuccess(createSandboxResponseSchema, { status: 202 })
      .addError(SandboxBadRequestError)
      .addError(SandboxForbiddenError)
      .addError(SandboxNotFoundError)
      .addError(SandboxBadGatewayError)
      .addError(SandboxServiceUnavailableError)
      .addError(SandboxInternalServerError),
  )
  .add(
    HttpApiEndpoint.patch("renameSandbox")`/${sandboxId}/name`
      .setPayload(renameSandboxRequestSchema)
      .addSuccess(renameSandboxResponseSchema)
      .addError(SandboxNotFoundError)
      .addError(SandboxInternalServerError),
  )
  .add(
    HttpApiEndpoint.get("listSandboxes", "/")
      .setUrlParams(listSandboxesQuerySchema)
      .addSuccess(listSandboxesResponseSchema)
      .addError(SandboxBadRequestError)
      .addError(SandboxInternalServerError),
  )
  .add(
    HttpApiEndpoint.get("getSandbox")`/${sandboxId}`
      .addSuccess(sandboxDetailsSchema)
      .addError(SandboxNotFoundError)
      .addError(SandboxInternalServerError),
  )
  .add(
    HttpApiEndpoint.get("listSandboxAttempts")`/${sandboxId}/attempts`
      .setUrlParams(listSandboxAttemptsQuerySchema)
      .addSuccess(listSandboxAttemptsResponseSchema)
      .addError(SandboxBadRequestError)
      .addError(SandboxNotFoundError)
      .addError(SandboxInternalServerError),
  )
  .add(
    HttpApiEndpoint.get("listSandboxEvents")`/${sandboxId}/events`
      .setUrlParams(listSandboxEventsQuerySchema)
      .addSuccess(listSandboxEventsResponseSchema)
      .addError(SandboxBadRequestError)
      .addError(SandboxNotFoundError)
      .addError(SandboxInternalServerError),
  )
  .add(
    HttpApiEndpoint.get("getSandboxSshTarget")`/${sandboxId}/ssh-target`
      .setHeaders(sandboxGatewayHeadersSchema)
      .addSuccess(sandboxSshTargetSchema)
      .addError(SandboxUnauthorizedError)
      .addError(SandboxNotFoundError)
      .addError(SandboxConflictError)
      .addError(SandboxServiceUnavailableError)
      .addError(SandboxInternalServerError),
  )
  .annotate(
    OpenApi.Description,
    "Sandbox lifecycle, attempts, events, and runtime routing endpoints.",
  );
