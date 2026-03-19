export {
  closeDatabaseClient,
  createDatabaseClient,
  createDatabaseClientFromEnv,
  createSqliteConnection,
} from "./client.js";

export { databaseEnv, databaseEnvSchema, parseDatabaseEnv } from "./env.js";

export {
  createWorkspaceBuildJobRepository,
  type ClaimNextWorkspaceBuildJobInput,
  type EnqueueWorkspaceBuildJobInput,
  type MarkWorkspaceBuildJobFailedInput,
  type MarkWorkspaceBuildJobRunningInput,
  type MarkWorkspaceBuildJobSucceededInput,
  type WorkspaceBuildJobRepository,
} from "./repositories/workspace-build-jobs.js";

export {
  workspaceBuildJobs,
  workspaceBuildJobStatusValues,
  type NewWorkspaceBuildJob,
  type WorkspaceBuildJob,
  type WorkspaceBuildJobStatus,
} from "./schema.js";

export { runMigrations } from "./migrate.js";

export type { DatabaseClient, DatabaseClientOptions, SealantDatabase } from "./client.js";

export type { DatabaseEnv } from "./env.js";
