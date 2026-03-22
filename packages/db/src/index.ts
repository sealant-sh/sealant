export {
  closeDatabaseClient,
  createDatabaseClient,
  createDatabaseClientFromEnv,
  createSqliteConnection,
} from "./client.js";

export { databaseEnv, databaseEnvSchema, parseDatabaseEnv } from "./env.js";

export {
  createLineageRepository,
  type IssueRunRecord,
  type LineageRepository,
  type LinkIssuePullRequestInput,
  type LinkIssueRunInput,
  type LinkRunPullRequestInput,
  type RunPullRequestRecord,
  type UpsertIssueInput,
  type UpsertPullRequestInput,
} from "./repositories/lineage.js";

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
  createRunReportingRepository,
  type AppendRunEventInput,
  type InsertRunArtifactInput,
  type ReplaceRunDiffFileInput,
  type ReplaceRunValidationResultInput,
  type RunDetailBundle,
  type RunReportingRepository,
  type UpsertRunSummaryInput,
} from "./repositories/run-reporting.js";

export {
  createWorkspaceRunRepository,
  type CreateQueuedWorkspaceRunInput,
  type ListWorkspaceRunsInput,
  type MarkWorkspaceRunCancelledInput,
  type MarkWorkspaceRunFailedInput,
  type MarkWorkspaceRunRunningInput,
  type MarkWorkspaceRunSucceededInput,
  type SetRunInputSnapshotInput,
  type WorkspaceRunRepository,
} from "./repositories/workspace-runs.js";

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
  type NewAuthAccount,
  type NewAuthSession,
  type NewAuthUser,
  type NewAuthVerification,
  type NewWorkspaceBuildJob,
  type WorkspaceBuildJob,
  type WorkspaceBuildJobStatus,
} from "./schema.js";

export * as schema from "./schema/index.js";

export { runMigrations } from "./migrate.js";

export {
  issueStateSchema,
  profileStatusSchema,
  pullRequestStateSchema,
  workspaceBuildJobInsertSchema,
  workspaceBuildJobSelectSchema,
  workspaceBuildJobStatusSchema,
  workspaceRunInsertSchema,
  workspaceRunSelectSchema,
  workspaceRunStatusSchema,
  workspaceRunTriggerTypeSchema,
} from "./validation.js";

export type { DatabaseClient, DatabaseClientOptions, SealantDatabase } from "./client.js";

export type { DatabaseEnv } from "./env.js";
