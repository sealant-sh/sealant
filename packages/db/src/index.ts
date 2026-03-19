export {
  closeDatabaseClient,
  createDatabaseClient,
  createDatabaseClientFromEnv,
  createSqliteConnection,
} from "./client.js";

export { databaseEnv, databaseEnvSchema, parseDatabaseEnv } from "./env.js";

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
  type WorkspaceBuildJobRequestPayload,
  type WorkspaceBuildJobResultPayload,
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
  workspaceBuildJobInsertSchema,
  workspaceBuildJobSelectSchema,
  workspaceBuildJobStatusSchema,
} from "./validation.js";

export type { DatabaseClient, DatabaseClientOptions, SealantDatabase } from "./client.js";

export type { DatabaseEnv } from "./env.js";
