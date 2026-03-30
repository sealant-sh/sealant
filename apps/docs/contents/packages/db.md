---
title: "@sealant/db"
slug: /packages/db
status: draft
owner: engineering
updated: 2026-03-31
---

## Purpose

`@sealant/db` is the shared SQLite + Drizzle package for control-plane persistence.

It stores durable state for Sealant's two core product domains:

- sandboxes
- issue workflows

## Why this package exists

- Keep schema and repositories centralized.
- Ensure API and worker use one typed persistence contract.
- Provide migration and env parsing utilities in one place.

## What it provides

- database client creation and lifecycle helpers
- Drizzle schema exports and inferred table types
- domain repositories for sandbox lifecycle, issue workflows, source integrations, and profiles
- payload schema re-exports from `@sealant/validators`
- migration entrypoints and helper scripts

Core exports are defined in `packages/db/src/index.ts`.

## Key schema groups

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

### Sandbox build jobs

- `oci_image_build_jobs`

Note: repository and type exports still include compatibility aliases such as `sandboxBuildJobs`
while migration to the `oci_image_build_jobs` table name is completed.

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

`packages/db/src/payloads.ts` re-exports shared sandbox payload schemas and types from
`@sealant/validators`:

- `newSandboxSchema` / `NewSandbox`
- `sandboxBuildSchema` / `SandboxBuild`
- `sandboxLaunchSchema` / `SandboxLaunch`

## Environment

- `DATABASE_FILE_PATH` (default: `packages/db/.data/sealant-control-plane.sqlite`)
- `DATABASE_BUSY_TIMEOUT_MS` (default: `5000`)

## Scripts

- `pnpm --filter @sealant/db db:generate`
- `pnpm --filter @sealant/db db:migrate`
- `pnpm --filter @sealant/db lint`
- `pnpm --filter @sealant/db typecheck`
