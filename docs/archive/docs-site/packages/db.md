---
title: "@sealant/db"
slug: /packages/db
status: draft
owner: engineering
updated: 2026-03-31
---

## Purpose

`@sealant/db` is the shared PostgreSQL + Drizzle package for control-plane persistence.

It stores durable state for Sealant's core product nouns: workspaces and runs.

## Why this package exists

- Keep schema and repositories centralized.
- Ensure API and worker use one typed persistence contract.
- Provide migration and env parsing utilities in one place.

## What it provides

- database client creation and lifecycle helpers
- Drizzle schema exports and inferred table types
- domain repositories for workspace lifecycle, source integrations, and profiles
- payload schema re-exports from `@sealant/validators`
- migration entrypoints and helper scripts

Core exports are defined in `packages/db/src/index.ts`.

## Key schema groups

### Auth

- `user`
- `session`
- `account`
- `verification`

### Workspaces and runs

- `workspaces`
- `runs`
- `workspace_attempts`
- `workspace_attempt_snapshots`
- `workspace_runtime_instances`
- `workspace_run_links`

### Workspace build jobs

- `oci_image_build_jobs`

Note: repository and type exports still include compatibility aliases such as `workspaceBuildJobs`
while migration to the `oci_image_build_jobs` table name is completed.

### Source/provider integration

- `repositories`
- `github_app_installations`
- `github_installation_repositories`
- `github_installation_user_grants`
- `github_webhook_deliveries`

### Profiles and secrets

- `profiles`
- `profile_revisions`
- `profile_env_vars`
- `profile_secret_bindings`
- `profile_ssh_settings`
- `profile_ssh_key_bindings`
- `repository_profiles`
- `repository_profile_revisions`
- `repository_profile_profile_links`
- `secrets`
- `secret_versions`
- `ssh_keys`

### Package resolution cache

- `package_resolution_cache_entries`

## Payload contracts

`packages/db/src/payloads.ts` re-exports shared workspace payload schemas and types from
`@sealant/validators`:

- `newWorkspaceSchema` / `NewWorkspace`
- `workspaceBuildSchema` / `WorkspaceBuild`
- `workspaceLaunchSchema` / `WorkspaceLaunch`

## Environment

- `DATABASE_URL` (default: `postgresql://sealant:sealant@127.0.0.1:5433/sealant_control_plane`)

## Scripts

- `pnpm --filter @sealant/db db:generate`
- `pnpm --filter @sealant/db db:migrate`
- `pnpm --filter @sealant/db lint`
- `pnpm --filter @sealant/db typecheck`

## Related docs

- [db-effect-service-layer.md](./db-effect-service-layer.md) - step-by-step walkthrough of the
  Effect service tag and live integration layer used for DB runtime composition.
- [db-effect-postgres-follow-up-plan.md](./db-effect-postgres-follow-up-plan.md) - incremental plan
  to migrate DB runtime wiring to Drizzle `connect-effect-postgres`.
