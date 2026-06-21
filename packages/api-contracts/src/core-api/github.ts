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
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";

export const GitHubAppInstallationDbInsertSchema = githubAppInstallationInsertSchema;
export const GitHubInstallationRepositoryDbInsertSchema = githubInstallationRepositoryInsertSchema;
export const GitHubWebhookDeliveryDbInsertSchema = githubWebhookDeliveryInsertSchema;

const GitHubInstallationAccountTypeSchema = Schema.Literals(githubInstallationAccountTypeValues);
const GitHubInstallationStatusSchema = Schema.Literals(githubInstallationStatusValues);
const GitHubInstallationRepositorySelectionSchema = Schema.Literals(
  githubInstallationRepositorySelectionValues,
);
const GitHubWebhookDeliveryStatusSchema = Schema.Literals(githubWebhookDeliveryStatusValues);

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

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
  syncedRepositoryCount: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  syncedAt: Schema.String,
});
export type SyncGitHubInstallationResponse = typeof syncGitHubInstallationResponseSchema.Type;

export const importGitHubInstallationResponseSchema = Schema.Struct({
  installation: githubInstallationSummarySchema,
  syncedRepositoryCount: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  syncedAt: Schema.String,
});
export type ImportGitHubInstallationResponse = typeof importGitHubInstallationResponseSchema.Type;

export const githubWebhookResponseSchema = Schema.Struct({
  deliveryId: NonEmptyString,
  status: GitHubWebhookDeliveryStatusSchema,
});
export type GitHubWebhookResponse = typeof githubWebhookResponseSchema.Type;

export class GitHubBadRequestError extends Schema.TaggedErrorClass<GitHubBadRequestError>()(
  "GitHubBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class GitHubUnauthorizedError extends Schema.TaggedErrorClass<GitHubUnauthorizedError>()(
  "GitHubUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {}

export class GitHubForbiddenError extends Schema.TaggedErrorClass<GitHubForbiddenError>()(
  "GitHubForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

export class GitHubNotFoundError extends Schema.TaggedErrorClass<GitHubNotFoundError>()(
  "GitHubNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class GitHubServiceUnavailableError extends Schema.TaggedErrorClass<GitHubServiceUnavailableError>()(
  "GitHubServiceUnavailableError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class GitHubInternalServerError extends Schema.TaggedErrorClass<GitHubInternalServerError>()(
  "GitHubInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

const installationIdParams = Schema.Struct({ installationId: NonEmptyString });

export const GitHubGroup = HttpApiGroup.make("github")
  .add(
    HttpApiEndpoint.get("listInstallations", "/installations", {
      query: githubInstallationsQuerySchema,
      success: listGitHubInstallationsResponseSchema,
      error: [GitHubServiceUnavailableError, GitHubInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "listInstallationRepositories",
      "/installations/:installationId/repositories",
      {
        params: installationIdParams,
        query: githubInstallationRepositoriesQuerySchema,
        success: listGitHubInstallationRepositoriesResponseSchema,
        error: [
          GitHubForbiddenError,
          GitHubNotFoundError,
          GitHubServiceUnavailableError,
          GitHubInternalServerError,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("importInstallation", "/installations/import", {
      payload: importGitHubInstallationRequestSchema,
      success: importGitHubInstallationResponseSchema,
      error: [GitHubNotFoundError, GitHubServiceUnavailableError, GitHubInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("syncInstallation", "/installations/:installationId/sync", {
      params: installationIdParams,
      query: syncGitHubInstallationQuerySchema,
      success: syncGitHubInstallationResponseSchema,
      error: [
        GitHubForbiddenError,
        GitHubNotFoundError,
        GitHubServiceUnavailableError,
        GitHubInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("handleWebhook", "/webhooks", {
      headers: githubWebhookHeadersSchema,
      payload: Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/json" })),
      success: githubWebhookResponseSchema.pipe(HttpApiSchema.status(202)),
      error: [
        GitHubBadRequestError,
        GitHubUnauthorizedError,
        GitHubServiceUnavailableError,
        GitHubInternalServerError,
      ],
    }),
  )
  .annotate(OpenApi.Description, "GitHub App installation and webhook control-plane operations.");

export const GitHubApi = HttpApi.make("sealantGitHubApi")
  .add(GitHubGroup)
  .annotate(OpenApi.Title, "Sealant Control Plane API - GitHub")
  .annotate(OpenApi.Version, "0.0.0");
