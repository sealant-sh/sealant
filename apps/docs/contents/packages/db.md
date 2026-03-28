---
title: "@sealant/db"
slug: /packages/db
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/db

## Purpose

`@sealant/db` is the shared SQLite + Drizzle package for control-plane persistence.

It stores lifecycle state for the two product domains:

- sandboxes
- issue workflows

## Why this package exists

- Keep data contracts and repository access patterns centralized.
- Ensure API, workers, and other services share the same schema and typed data access.
- Provide migration and validation primitives for control-plane state.

## What it provides

- database client creation helpers
- schema exports and generated types
- repository constructors for major domains, including:
  - sandbox lifecycle and attempts
  - workspace build jobs and runtime instances
  - issue workflows and workflow executions
  - profile and repository profile state
  - GitHub installations and webhook deliveries
  - package resolution cache
- Zod validation schemas derived from table definitions
- migration entrypoints

Core exports are defined in `packages/db/src/index.ts`.

## Module map

- `src/client.ts`
  - SQLite/libSQL client creation and lifecycle helpers
- `src/env.ts`
  - database env parsing and default path resolution
- `src/schema.ts` and `src/schema/*`
  - Drizzle table definitions and value enums
- `src/repositories/*`
  - typed repository constructors per domain
- `src/payloads.ts`
  - workspace build job request/result payload schemas
- `src/validation.ts`
  - Drizzle-derived insert/select schemas and enum schemas
- `src/migrate.ts` / `src/run-migrations.ts`
  - migration entrypoints

## Data domains

### Auth

- `user`
- `session`
- `account`
- `verification`

### Sandboxes

- `sandboxes`
- `sandbox_attempts`
- `sandbox_attempt_snapshots`
- `sandbox_runtime_instances`
- `sandbox_run_links`

### Workspace build jobs

- `workspace_build_jobs`
- `oci_image_build_jobs`

### Issue workflows

- `issue_workflows`
- `issue_workflow_executions`
- `issue_workflow_execution_events`
- `issue_workflow_execution_validation_results`
- `issue_workflow_execution_diff_files`
- `issue_workflow_execution_artifacts`
- `issue_workflow_execution_summaries`
- `issue_workflow_execution_pull_request_links`
- `issues`
- `pull_requests`
- `issue_pull_request_links`

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

- `workspaceBuildJobRequestPayloadSchema`: raw `UserWorkspaceSpec` payload
- `workspaceBuildJobRuntimeResultPayloadSchema`: compile result + runtime adapter launch result
- `workspaceBuildJobResultPayloadSchema`: compile result payload

## Repository surfaces

- sandbox lifecycle: repositories for sandboxes, attempts, runtime instances, and snapshots
- issue workflow lifecycle: repositories for workflow state, executions, events, artifacts, and
  validation
- source/provider sync: repositories for GitHub installations, repositories, and webhook delivery
  records
- profile management: repositories for profiles and repository-scoped templates
- job orchestration: repositories for workspace build job queues and status transitions

## Environment

- `DATABASE_FILE_PATH` (default: `packages/db/.data/sealant-control-plane.sqlite`)
- `DATABASE_BUSY_TIMEOUT_MS` (default: `5000`)

## Schema docs

- package overview: `packages/db/README.md`
- per-table purpose notes: `packages/db/src/schema/README.md`

## Internal dependencies

- Internal package dependencies: `@sealant/workspace-composition`
- External runtime dependencies: `@libsql/client`, `drizzle-orm`, `drizzle-zod`, `zod`

## Schema docs

- `packages/db/README.md`
- `packages/db/src/schema/README.md`

## Typical call flow

1. Control plane validates request and creates/updates records.
2. Worker claims jobs and writes execution state transitions.
3. API/UI surfaces read typed records for sandbox and issue workflow reporting.

## Scripts

- `pnpm --filter @sealant/db db:generate`
- `pnpm --filter @sealant/db db:migrate`
- `pnpm --filter @sealant/db lint`
- `pnpm --filter @sealant/db typecheck`
