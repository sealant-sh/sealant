# DB Package

`@sealant/db` is the shared PostgreSQL package for Sealant control-plane state.

It models the primary product nouns: workspaces and the runs executed inside them.

## What this package provides

- Better Auth core tables for `user`, `session`, `account`, and `verification`
- Drizzle schema + migrations for workspace lifecycle and build/runtime orchestration
- typed repositories for workspace attempts, build jobs, runtime instances, profiles, and repository
  profiles
- generated Effect schemas from Drizzle tables
- payload schemas for job request/result JSON
- PostgreSQL client creation and lifecycle helpers

## Environment

- `DATABASE_URL`: PostgreSQL connection URL; defaults to
  `postgresql://sealant:sealant@127.0.0.1:5433/sealant_control_plane`

## Package scripts

```bash
pnpm --filter @sealant/db db:generate
pnpm --filter @sealant/db db:migrate
```

## Current schema

High-level table map:

- auth: `user`, `session`, `account`, `verification`
- workspace lifecycle: `workspaces`, `runs`, `workspace_attempts`, `workspace_attempt_snapshots`,
  `workspace_run_links`
- build/runtime orchestration: `oci_image_build_jobs`, `workspace_runtime_instances`
- package standardization cache: `package_resolution_cache_entries`
- repository/profile context: `repositories`, `repository_profiles`, `repository_profile_revisions`,
  `repository_profile_profile_links`, `profiles`, `profile_revisions`, `profile_env_vars`,
  `profile_secret_bindings`, `profile_ssh_settings`, `profile_ssh_key_bindings`, `secrets`,
  `secret_versions`, `ssh_keys`

For a per-table purpose summary, see `packages/db/src/schema/README.md`.

## Usage

```ts
import {
  createDatabaseClientFromEnv,
  createWorkspaceAttemptRepository,
  createWorkspaceBuildJobRepository,
} from "@sealant/db";

const client = await createDatabaseClientFromEnv();
const attempts = createWorkspaceAttemptRepository(client);
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

## Capture ledger contract (rolling deploys)

`workspace_capture_drains` has a trigger (`workspace_capture_drains_invariants`) that keeps the
ledger's invariants for a Core process from an older release still running during a rolling deploy.
The current writer marks each transaction with `sealant.capture_ledger = CAPTURE_LEDGER_CONTRACT`
(`src/repositories/workspace-capture-drains.ts`); the trigger trusts only that exact value and holds
every other writer, unset or an older version, to the old-writer guards.

Bump `CAPTURE_LEDGER_CONTRACT` whenever the ledger contract changes (a new invariant, a new column a
writer must keep, a changed transition), in the same change as a migration that recreates the
trigger to trust only the new value. If the marker stays the same, the previous release carries it
too and skips guards it doesn't implement.
