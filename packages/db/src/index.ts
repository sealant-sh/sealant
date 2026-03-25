export {
  closeDatabaseClient,
  createDatabaseClient,
  createDatabaseClientFromEnv,
  createSqliteConnection,
} from "./client.js";

export { databaseEnv, databaseEnvSchema, parseDatabaseEnv } from "./env.js";

export {
  createGitHubInstallationRepository,
  type GitHubInstallationRepository,
  type GrantGitHubInstallationToUserInput,
  type ListGitHubInstallationsForUserInput,
  type RevokeGitHubInstallationGrantInput,
  type SetGitHubInstallationStatusInput,
  type UpsertGitHubInstallationInput,
} from "./repositories/github-installations.js";

export {
  createGitHubInstallationRepositoryCacheRepository,
  type GitHubInstallationRepositoryCacheRepository,
  type ListGitHubInstallationRepositoriesInput,
  type ListGitHubRepositoriesForUserInput,
  type UpsertGitHubInstallationRepositoryInput,
} from "./repositories/github-installation-repositories.js";

export {
  createGitHubWebhookDeliveryRepository,
  type CreateGitHubWebhookDeliveryInput,
  type GitHubWebhookDeliveryRepository,
} from "./repositories/github-webhook-deliveries.js";

export {
  createIssueWorkflowRepository,
  type CreateIssueWorkflowExecutionInput,
  type CreateIssueWorkflowInput,
  type IssueWorkflowExecutionPullRequestRecord,
  type IssueWorkflowRepository,
  type LinkIssuePullRequestInput,
  type LinkIssueWorkflowExecutionPullRequestInput,
  type UpsertIssueInput,
  type UpsertPullRequestInput,
} from "./repositories/issue-workflows.js";

export {
  createProfileRepository,
  type CreateProfileInput,
  type CreateProfileRevisionGraphInput,
  type ListProfilesByOwnerInput,
  type ProfileRepository,
  type ProfileRevisionEnvVarInput,
  type ProfileRevisionGraph,
  type ProfileRevisionSecretBindingInput,
  type ProfileRevisionSshKeyBindingInput,
  type ProfileRevisionSshSettingsInput,
  type SetActiveProfileRevisionInput,
} from "./repositories/profiles.js";

export {
  createRepositoryProfileRepository,
  type CreateRepositoryProfileInput,
  type CreateRepositoryProfileRevisionInput,
  type ListRepositoryProfilesInput,
  type ReplaceRepositoryProfileLinksInput,
  type RepositoryProfileRepository,
  type RepositoryProfileRevisionBundle,
  type SetActiveRepositoryProfileRevisionInput,
  type UpsertRepositoryInput,
} from "./repositories/repository-profiles.js";

export {
  createPackageResolutionCacheRepository,
  type PackageResolutionCacheRepository,
  type UpsertPackageResolutionCacheEntryInput,
} from "./repositories/package-resolution-cache.js";

export {
  createSandboxRepository,
  type CreateSandboxInput,
  type LinkSandboxAttemptInput,
  type ListSandboxesInput,
  type SetSandboxNameInput,
  type SandboxRepository,
  type SetSandboxStatusInput,
} from "./repositories/sandboxes.js";

export {
  createIssueWorkflowExecutionRepository,
  type AppendIssueWorkflowExecutionEventInput,
  type InsertIssueWorkflowExecutionArtifactInput,
  type IssueWorkflowExecutionDetailBundle,
  type IssueWorkflowExecutionRepository,
  type ReplaceIssueWorkflowExecutionDiffFileInput,
  type ReplaceIssueWorkflowExecutionValidationResultInput,
  type UpsertIssueWorkflowExecutionSummaryInput,
} from "./repositories/issue-workflow-executions.js";

export {
  createSandboxRuntimeInstanceRepository,
  type SandboxRuntimeInstanceRepository,
  type UpsertSandboxRuntimeInstanceInput,
} from "./repositories/sandbox-runtime-instances.js";

export {
  createSandboxAttemptRepository,
  type CreateQueuedSandboxAttemptInput,
  type ListSandboxAttemptsInput,
  type MarkSandboxAttemptCancelledInput,
  type MarkSandboxAttemptFailedInput,
  type MarkSandboxAttemptRunningInput,
  type MarkSandboxAttemptSucceededInput,
  type SandboxAttemptRepository,
  type SetSandboxAttemptSnapshotInput,
} from "./repositories/sandbox-attempts.js";

export {
  createWorkspaceBuildJobRepository,
  type ClaimWorkspaceBuildJobByIdInput,
  type ClaimNextWorkspaceBuildJobInput,
  type EnqueueWorkspaceBuildJobInput,
  type MarkWorkspaceBuildJobFailedInput,
  type MarkWorkspaceBuildJobRunningInput,
  type MarkWorkspaceBuildJobSucceededInput,
  type WorkspaceBuildJobRepository,
} from "./repositories/workspace-build-jobs.js";

export {
  workspaceBuildJobRequestPayloadSchema,
  workspaceBuildJobResultPayloadSchema,
  workspaceBuildJobRuntimeResultPayloadSchema,
  type WorkspaceBuildJobRequestPayload,
  type WorkspaceBuildJobResultPayload,
  type WorkspaceBuildJobRuntimeResultPayload,
} from "./payloads.js";

export {
  githubAppInstallations,
  githubInstallationAccountTypeValues,
  githubInstallationRepositories,
  githubInstallationRepositorySelectionValues,
  githubInstallationStatusValues,
  githubInstallationUserGrants,
  githubWebhookDeliveries,
  githubWebhookDeliveryStatusValues,
  issueWorkflowExecutionArtifactKindValues,
  issueWorkflowExecutionArtifactStorageBackendValues,
  issueWorkflowExecutionArtifacts,
  issueWorkflowExecutionDiffChangeTypeValues,
  issueWorkflowExecutionDiffFiles,
  issueWorkflowExecutionEventLevelValues,
  issueWorkflowExecutionEvents,
  issueWorkflowExecutions,
  issueWorkflowExecutionPullRequestLinkRelationValues,
  issueWorkflowExecutionPullRequestLinks,
  issueWorkflowExecutionStatusValues,
  issueWorkflowExecutionSummaries,
  issueWorkflowExecutionTriggerTypeValues,
  issueWorkflowExecutionValidationResults,
  issueWorkflowExecutionValidationStatusValues,
  issueWorkflows,
  issueWorkflowStatusValues,
  packageResolutionCacheEntries,
  sandboxAttempts,
  sandboxAttemptStatusValues,
  sandboxAttemptTriggerTypeValues,
  sandboxAttemptSnapshots,
  ociImageBuildJobs,
  ociImageBuildJobStatusValues,
  sandboxRuntimeInstances,
  sandboxRuntimeInstanceStatusValues,
  workspaceBuildJobs,
  workspaceBuildJobStatusValues,
  account,
  session,
  user,
  verification,
  type AuthAccount,
  type AuthSession,
  type AuthUser,
  type AuthVerification,
  type GitHubAppInstallation,
  type GitHubInstallationAccountType,
  type GitHubInstallationRepository as GitHubInstallationRepositoryRecord,
  type GitHubInstallationRepositorySelection,
  type GitHubInstallationStatus,
  type GitHubInstallationUserGrant,
  type GitHubWebhookDelivery,
  type GitHubWebhookDeliveryStatus,
  type NewAuthAccount,
  type NewAuthSession,
  type NewAuthUser,
  type NewAuthVerification,
  type NewGitHubAppInstallation,
  type NewGitHubInstallationRepository,
  type NewGitHubInstallationUserGrant,
  type NewGitHubWebhookDelivery,
  type NewIssueWorkflow,
  type NewIssueWorkflowExecution,
  type NewIssueWorkflowExecutionArtifact,
  type NewIssueWorkflowExecutionDiffFile,
  type NewIssueWorkflowExecutionEvent,
  type NewIssueWorkflowExecutionPullRequestLink,
  type NewIssueWorkflowExecutionSummary,
  type NewIssueWorkflowExecutionValidationResult,
  type NewPackageResolutionCacheEntry,
  type NewSandboxAttempt,
  type NewSandboxAttemptSnapshot,
  type NewOciImageBuildJob,
  type NewSandboxRuntimeInstance,
  type NewWorkspaceBuildJob,
  type OciImageBuildJob,
  type OciImageBuildJobStatus,
  type IssueWorkflow,
  type IssueWorkflowExecution,
  type IssueWorkflowExecutionArtifact,
  type IssueWorkflowExecutionArtifactKind,
  type IssueWorkflowExecutionArtifactStorageBackend,
  type IssueWorkflowExecutionDiffChangeType,
  type IssueWorkflowExecutionDiffFile,
  type IssueWorkflowExecutionEvent,
  type IssueWorkflowExecutionEventLevel,
  type IssueWorkflowExecutionPullRequestLink,
  type IssueWorkflowExecutionPullRequestLinkRelation,
  type IssueWorkflowExecutionStatus,
  type IssueWorkflowExecutionSummary,
  type IssueWorkflowExecutionTriggerType,
  type IssueWorkflowExecutionValidationResult,
  type IssueWorkflowExecutionValidationStatus,
  type IssueWorkflowStatus,
  type PackageResolutionCacheEntry,
  type SandboxAttempt,
  type SandboxAttemptSnapshot,
  type SandboxAttemptStatus,
  type SandboxAttemptTriggerType,
  type SandboxRuntimeInstance,
  type SandboxRuntimeInstanceStatus,
  type WorkspaceBuildJob,
  type WorkspaceBuildJobStatus,
} from "./schema.js";

export * as schema from "./schema/index.js";

export { runMigrations } from "./migrate.js";

export {
  issueStateSchema,
  issueWorkflowExecutionInsertSchema,
  issueWorkflowExecutionSelectSchema,
  issueWorkflowExecutionStatusSchema,
  issueWorkflowExecutionTriggerTypeSchema,
  issueWorkflowInsertSchema,
  issueWorkflowSelectSchema,
  issueWorkflowStatusSchema,
  profileStatusSchema,
  pullRequestStateSchema,
  sandboxInsertSchema,
  sandboxAttemptInsertSchema,
  sandboxAttemptSelectSchema,
  sandboxAttemptStatusSchema,
  sandboxAttemptTriggerTypeSchema,
  sandboxSelectSchema,
  sandboxStatusSchema,
  workspaceBuildJobInsertSchema,
  workspaceBuildJobSelectSchema,
  workspaceBuildJobStatusSchema,
} from "./validation.js";

export type { DatabaseClient, DatabaseClientOptions, SealantDatabase } from "./client.js";

export type { DatabaseEnv } from "./env.js";
