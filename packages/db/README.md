# DB Package

`@sealant/db` is the shared SQLite package for Sealant control-plane state.

It models two primary product domains:

- sandboxes
- issue workflows

## What this package provides

- Better Auth core tables for `user`, `session`, `account`, and `verification`
- Drizzle schema + migrations for sandbox lifecycle, build/runtime orchestration, and issue workflow
  execution reporting
- typed repositories for sandbox attempts, build jobs, runtime instances, profiles, repository
  profiles, and issue workflow data
- generated Zod schemas from Drizzle tables
- payload schemas for job request/result JSON
- a local SQLite client with `WAL` and `busy_timeout` enabled

## Environment

- `DATABASE_FILE_PATH`: SQLite database file path; defaults to
  `packages/db/.data/sealant-control-plane.sqlite`
- `DATABASE_BUSY_TIMEOUT_MS`: SQLite busy timeout in milliseconds; defaults to `5000`

## Package scripts

```bash
pnpm --filter @sealant/db db:generate
pnpm --filter @sealant/db db:migrate
```

## Current schema

High-level table map:

- auth: `user`, `session`, `account`, `verification`
- sandbox lifecycle: `sandboxes`, `sandbox_attempts`, `sandbox_attempt_snapshots`,
  `sandbox_run_links`
- build/runtime orchestration: `oci_image_build_jobs`, `sandbox_runtime_instances`
- package standardization cache: `package_resolution_cache_entries`
- repository/profile context: `repositories`, `repository_profiles`, `repository_profile_revisions`,
  `repository_profile_profile_links`, `profiles`, `profile_revisions`, `profile_env_vars`,
  `profile_secret_bindings`, `profile_ssh_settings`, `profile_ssh_key_bindings`, `secrets`,
  `secret_versions`, `ssh_keys`
- issue workflows: `issue_workflows`, `issue_workflow_executions`,
  `issue_workflow_execution_events`, `issue_workflow_execution_validation_results`,
  `issue_workflow_execution_diff_files`, `issue_workflow_execution_artifacts`,
  `issue_workflow_execution_summaries`, `issue_workflow_execution_pull_request_links`, `issues`,
  `pull_requests`, `issue_pull_request_links`

For a per-table purpose summary, see `packages/db/src/schema/README.md`.

## Usage

```ts
import {
  createDatabaseClientFromEnv,
  createSandboxAttemptRepository,
  createWorkspaceBuildJobRepository,
} from "@sealant/db";

const client = await createDatabaseClientFromEnv();
const attempts = createSandboxAttemptRepository(client);
const jobs = createWorkspaceBuildJobRepository(client);

const attempt = await attempts.createQueuedAttempt({
  id: "attempt_123",
  ownerUserId: "user_123",
  triggerType: "api",
});

await jobs.insertQueuedJob({
  id: "job_123",
  runId: attempt.id,
  registryId: "default",
  repository: "sealant/workspaces/demo",
  tag: "opencode",
  requestPayload: {
    source: "https://github.com/example/repo",
  },
});
```
