import { Context, Effect, Schema } from "effect";

export interface GitHubSourceIntegrationOptions {
  readonly appId?: string;
  readonly privateKey?: string;
  readonly webhookSecret?: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export interface GitHubInstallationAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface GitHubRemoteInstallation {
  readonly externalInstallationId: string;
  readonly externalAccountId?: string;
  readonly accountLogin: string;
  readonly accountType: "organization" | "user";
  readonly targetType: "organization" | "user";
  readonly permissions: Record<string, string>;
  readonly repositorySelection: "all" | "selected";
  readonly suspendedAt?: Date;
}

export interface GitHubRemoteInstallationRepository {
  readonly externalRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  readonly pushedAt?: Date;
  readonly url: string;
}

export const gitHubSourceIntegrationOperationSchema = Schema.Literals([
  "createAppJwt",
  "createInstallationAccessToken",
  "getInstallation",
  "listInstallationRepositories",
]);

export type GitHubSourceIntegrationOperation = typeof gitHubSourceIntegrationOperationSchema.Type;

export class GitHubSourceIntegrationInvariantError extends Schema.TaggedErrorClass<GitHubSourceIntegrationInvariantError>()(
  "GitHubSourceIntegrationInvariantError",
  {
    operation: gitHubSourceIntegrationOperationSchema,
    message: Schema.String,
  },
) {}

export class GitHubSourceIntegrationHttpError extends Schema.TaggedErrorClass<GitHubSourceIntegrationHttpError>()(
  "GitHubSourceIntegrationHttpError",
  {
    operation: gitHubSourceIntegrationOperationSchema,
    statusCode: Schema.Number,
    message: Schema.String,
  },
) {}

export class GitHubSourceIntegrationUnexpectedError extends Schema.TaggedErrorClass<GitHubSourceIntegrationUnexpectedError>()(
  "GitHubSourceIntegrationUnexpectedError",
  {
    operation: gitHubSourceIntegrationOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const gitHubSourceIntegrationErrorSchema = Schema.Union([
  GitHubSourceIntegrationInvariantError,
  GitHubSourceIntegrationHttpError,
  GitHubSourceIntegrationUnexpectedError,
]);

export type GitHubSourceIntegrationError = typeof gitHubSourceIntegrationErrorSchema.Type;

export interface GitHubSourceIntegration {
  readonly isConfigured: () => boolean;
  readonly isWebhookVerificationConfigured: () => boolean;
  readonly createAppJwt: () => Effect.Effect<string, GitHubSourceIntegrationError>;
  readonly verifyWebhookSignature: (input: {
    readonly payload: string;
    readonly signature256: string | undefined;
  }) => boolean;
  readonly createInstallationAccessToken: (
    externalInstallationId: string,
  ) => Effect.Effect<GitHubInstallationAccessToken, GitHubSourceIntegrationError>;
  readonly getInstallation: (
    externalInstallationId: string,
  ) => Effect.Effect<GitHubRemoteInstallation, GitHubSourceIntegrationError>;
  readonly listInstallationRepositories: (
    externalInstallationId: string,
  ) => Effect.Effect<readonly GitHubRemoteInstallationRepository[], GitHubSourceIntegrationError>;
}

export class GitHubSourceIntegrationService extends Context.Service<
  GitHubSourceIntegrationService,
  GitHubSourceIntegration
>()("@sealant/source-integrations/GitHubSourceIntegrationService") {}

export class GitHubSourceIntegrationConfig extends Context.Service<
  GitHubSourceIntegrationConfig,
  GitHubSourceIntegrationOptions
>()("@sealant/source-integrations/GitHubSourceIntegrationConfig") {}
