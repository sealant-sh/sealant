# DB Package

`@sealant/db` is the shared SQLite database package for Sealant control-plane state.

It currently provides:

- Better Auth core tables for `user`, `session`, `account`, and `verification`
- a Drizzle schema for workspace image build jobs
- control-plane tables for repositories, profiles, profile revisions, runs, and issue/PR lineage
- a local SQLite client with `WAL` and `busy_timeout` enabled
- a small repository for enqueueing, claiming, and updating workspace build jobs
- generated Zod schemas from the Drizzle table plus typed payload schemas for request and result JSON
- a Drizzle config and migration entrypoint for committed SQL migrations

## Environment

- `DATABASE_FILE_PATH`: SQLite database file path; defaults to `packages/db/.data/sealant-control-plane.sqlite`
- `DATABASE_BUSY_TIMEOUT_MS`: SQLite busy timeout in milliseconds; defaults to `5000`

## Package scripts

```bash
pnpm --filter @sealant/db db:generate
pnpm --filter @sealant/db db:migrate
```

## Current schema

The package now includes:

- Better Auth core tables: `user`, `session`, `account`, and `verification`
- `workspace_build_jobs`, which backs queued image build work for API + worker handoff
- repository catalog tables: `repositories`, `issues`, `pull_requests`, and link tables
- profile and secret tables: `profiles`, `profile_revisions`, `profile_env_vars`, `secrets`, `secret_versions`, `profile_secret_bindings`, `ssh_keys`, `profile_ssh_settings`, and `profile_ssh_key_bindings`
- repository-scoped run setup tables: `repository_profiles`, `repository_profile_revisions`, and `repository_profile_profile_links`
- run execution and reporting tables: `workspace_runs`, `run_input_snapshots`, `run_events`, `run_validation_results`, `run_diff_files`, `run_summaries`, and `run_artifacts`

`workspace_build_jobs` stores:

- durable job status (`queued`, `running`, `succeeded`, `failed`)
- optional linkage to a parent run (`run_id`) so queue activity can be traced to run history
- requested registry target metadata
- serialized request payloads and optional result payloads
- worker claim/lease fields for future queue processing
- published image references and digests
- terminal error metadata and timestamps

## Usage

```ts
import { createDatabaseClientFromEnv, createWorkspaceBuildJobRepository } from "@sealant/db";

const client = await createDatabaseClientFromEnv();
const jobs = createWorkspaceBuildJobRepository(client);

const job = await jobs.insertQueuedJob({
  id: "job_123",
  registryId: "default",
  repository: "sealant/workspaces/demo",
  tag: "opencode",
  requestPayload: {
    source: "https://github.com/example/repo",
  },
});
```
