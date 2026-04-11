import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform";
import {
  githubAppInstallationInsertSchema,
  githubInstallationAccountTypeValues,
  githubInstallationRepositoryInsertSchema,
  githubInstallationRepositorySelectionValues,
  githubInstallationStatusValues,
  githubWebhookDeliveryInsertSchema,
  githubWebhookDeliveryStatusValues,
} from "@sealant/db";
import { Schema } from "effect";

export const GitHubAppInstallationDbInsertSchema = githubAppInstallationInsertSchema;
export const GitHubInstallationRepositoryDbInsertSchema = githubInstallationRepositoryInsertSchema;
export const GitHubWebhookDeliveryDbInsertSchema = githubWebhookDeliveryInsertSchema;

const GitHubInstallationAccountTypeSchema = Schema.Literal(...githubInstallationAccountTypeValues);
const GitHubInstallationStatusSchema = Schema.Literal(...githubInstallationStatusValues);
const GitHubInstallationRepositorySelectionSchema = Schema.Literal(
  ...githubInstallationRepositorySelectionValues,
);
const GitHubWebhookDeliveryStatusSchema = Schema.Literal(...githubWebhookDeliveryStatusValues);

const NonEmptyString = Schema.NonEmptyTrimmedString;

export const messageResponseSchema = Schema.Struct({
  message: Schema.String,
});

export const githubInstallationsQuerySchema = Schema.Struct({
  userId: NonEmptyString,
});
export type GitHubInstallationsQuery = typeof githubInstallationsQuerySchema.Type;

export const githubInstallationRepositoriesQuerySchema = Schema.Struct({
  userId: NonEmptyString,
  search: Schema.optional(NonEmptyString),
});
export type GitHubInstallationRepositoriesQuery =
  typeof githubInstallationRepositoriesQuerySchema.Type;

export const syncGitHubInstallationQuerySchema = Schema.Struct({
  userId: NonEmptyString,
});
export type SyncGitHubInstallationQuery = typeof syncGitHubInstallationQuerySchema.Type;

export const importGitHubInstallationRequestSchema = Schema.Struct({
  userId: NonEmptyString,
  externalInstallationId: NonEmptyString,
});
export type ImportGitHubInstallationRequest = typeof importGitHubInstallationRequestSchema.Type;

export const githubWebhookHeadersSchema = Schema.Struct({
  "x-github-delivery": Schema.optional(NonEmptyString),
  "x-github-event": Schema.optional(NonEmptyString),
  "x-hub-signature-256": Schema.optional(NonEmptyString),
});
export type GitHubWebhookHeaders = typeof githubWebhookHeadersSchema.Type;

export const githubInstallationSummarySchema = Schema.Struct({
  installationId: NonEmptyString,
  externalInstallationId: NonEmptyString,
  accountLogin: NonEmptyString,
  accountType: GitHubInstallationAccountTypeSchema,
  status: GitHubInstallationStatusSchema,
  repositorySelection: GitHubInstallationRepositorySelectionSchema,
  lastSyncedAt: Schema.optional(Schema.String),
});
export type GitHubInstallationSummary = typeof githubInstallationSummarySchema.Type;

export const githubInstallationRepositorySummarySchema = Schema.Struct({
  installationRepositoryId: NonEmptyString,
  installationId: NonEmptyString,
  repositoryId: NonEmptyString,
  externalRepositoryId: NonEmptyString,
  owner: NonEmptyString,
  name: NonEmptyString,
  fullName: NonEmptyString,
  defaultBranch: NonEmptyString,
  isPrivate: Schema.Boolean,
  isArchived: Schema.Boolean,
  lastSyncedAt: Schema.optional(Schema.String),
});
export type GitHubInstallationRepositorySummary =
  typeof githubInstallationRepositorySummarySchema.Type;

export const listGitHubInstallationsResponseSchema = Schema.Struct({
  items: Schema.Array(githubInstallationSummarySchema),
});
export type ListGitHubInstallationsResponse = typeof listGitHubInstallationsResponseSchema.Type;

export const listGitHubInstallationRepositoriesResponseSchema = Schema.Struct({
  items: Schema.Array(githubInstallationRepositorySummarySchema),
});
export type ListGitHubInstallationRepositoriesResponse =
  typeof listGitHubInstallationRepositoriesResponseSchema.Type;

export const syncGitHubInstallationResponseSchema = Schema.Struct({
  installationId: NonEmptyString,
  syncedRepositoryCount: Schema.NonNegative,
  syncedAt: Schema.String,
});
export type SyncGitHubInstallationResponse = typeof syncGitHubInstallationResponseSchema.Type;

export const importGitHubInstallationResponseSchema = Schema.Struct({
  installation: githubInstallationSummarySchema,
  syncedRepositoryCount: Schema.NonNegative,
  syncedAt: Schema.String,
});
export type ImportGitHubInstallationResponse = typeof importGitHubInstallationResponseSchema.Type;

export const githubWebhookResponseSchema = Schema.Struct({
  deliveryId: NonEmptyString,
  status: GitHubWebhookDeliveryStatusSchema,
});
export type GitHubWebhookResponse = typeof githubWebhookResponseSchema.Type;

export class GitHubBadRequestError extends Schema.TaggedError<GitHubBadRequestError>(
  "GitHubBadRequestError",
)(
  "GitHubBadRequestError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class GitHubUnauthorizedError extends Schema.TaggedError<GitHubUnauthorizedError>(
  "GitHubUnauthorizedError",
)(
  "GitHubUnauthorizedError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class GitHubForbiddenError extends Schema.TaggedError<GitHubForbiddenError>(
  "GitHubForbiddenError",
)(
  "GitHubForbiddenError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class GitHubNotFoundError extends Schema.TaggedError<GitHubNotFoundError>(
  "GitHubNotFoundError",
)(
  "GitHubNotFoundError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class GitHubServiceUnavailableError extends Schema.TaggedError<GitHubServiceUnavailableError>(
  "GitHubServiceUnavailableError",
)(
  "GitHubServiceUnavailableError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 503 }),
) {}

export class GitHubInternalServerError extends Schema.TaggedError<GitHubInternalServerError>(
  "GitHubInternalServerError",
)(
  "GitHubInternalServerError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}

const installationId = HttpApiSchema.param("installationId", NonEmptyString);

export const GitHubGroup = HttpApiGroup.make("github")
  .add(
    HttpApiEndpoint.get("listInstallations", "/installations")
      .setUrlParams(githubInstallationsQuerySchema)
      .addSuccess(listGitHubInstallationsResponseSchema)
      .addError(GitHubServiceUnavailableError)
      .addError(GitHubInternalServerError),
  )
  .add(
    HttpApiEndpoint.get(
      "listInstallationRepositories",
    )`/installations/${installationId}/repositories`
      .setUrlParams(githubInstallationRepositoriesQuerySchema)
      .addSuccess(listGitHubInstallationRepositoriesResponseSchema)
      .addError(GitHubForbiddenError)
      .addError(GitHubNotFoundError)
      .addError(GitHubServiceUnavailableError)
      .addError(GitHubInternalServerError),
  )
  .add(
    HttpApiEndpoint.post("importInstallation", "/installations/import")
      .setPayload(importGitHubInstallationRequestSchema)
      .addSuccess(importGitHubInstallationResponseSchema)
      .addError(GitHubNotFoundError)
      .addError(GitHubServiceUnavailableError)
      .addError(GitHubInternalServerError),
  )
  .add(
    HttpApiEndpoint.post("syncInstallation")`/installations/${installationId}/sync`
      .setUrlParams(syncGitHubInstallationQuerySchema)
      .addSuccess(syncGitHubInstallationResponseSchema)
      .addError(GitHubForbiddenError)
      .addError(GitHubNotFoundError)
      .addError(GitHubServiceUnavailableError)
      .addError(GitHubInternalServerError),
  )
  .add(
    HttpApiEndpoint.post("handleWebhook", "/webhooks")
      .setHeaders(githubWebhookHeadersSchema)
      .setPayload(HttpApiSchema.Text({ contentType: "application/json" }))
      .addSuccess(githubWebhookResponseSchema, { status: 202 })
      .addError(GitHubBadRequestError)
      .addError(GitHubUnauthorizedError)
      .addError(GitHubServiceUnavailableError)
      .addError(GitHubInternalServerError),
  )
  .annotate(OpenApi.Description, "GitHub App installation and webhook control-plane operations.");

export const GitHubApi = HttpApi.make("sealantGitHubApi")
  .add(GitHubGroup)
  .annotate(OpenApi.Title, "Sealant Control Plane API - GitHub")
  .annotate(OpenApi.Version, "0.0.0");
