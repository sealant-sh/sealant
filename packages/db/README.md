# DB Package

`@sealant/db` is the shared SQLite database package for Sealant control-plane state.

It currently provides:

- Better Auth core tables for `user`, `session`, `account`, and `verification`
- a Drizzle schema for workspace image build jobs
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
- `workspace_build_jobs`, which is intended to back the future API + worker flow for queued image builds

`workspace_build_jobs` stores:

- durable job status (`queued`, `running`, `succeeded`, `failed`)
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
