# Control-Plane Schema Map

This folder defines the durable database schema used by Sealant.

Product-facing language is centered on two domains:

- sandboxes
- issue workflows

Some tables still use internal execution vocabulary (`run`, `job`) because they model orchestration
and reporting internals.

## Auth tables

- `user`: user identity records used across all product surfaces.
- `session`: active authenticated sessions.
- `account`: external/provider account links for users.
- `verification`: verification tokens and related auth flows.

## Sandbox lifecycle tables

- `sandboxes`: primary sandbox product object and lifecycle anchor.
- `sandbox_run_links`: links sandbox records to execution attempts over time.

## Execution attempt tables (internal)

- `sandbox_attempts`: internal execution attempts used by worker orchestration and reporting.
- `sandbox_attempt_snapshots`: immutable input snapshots for each attempt (raw spec, resolved spec,
  normalized blueprint).

## Build and runtime orchestration tables

- `oci_image_build_jobs`: queue/worker state for OCI build and publish operations.
- `sandbox_runtime_instances`: runtime launch outcome and connectivity state per execution attempt.

## Repository and template-context tables

- `repositories`: known source repositories and sync metadata.
- `repository_profiles`: repository-scoped launch profile containers (template-like grouping).
- `repository_profile_revisions`: versioned repository launch templates and policy config.
- `repository_profile_profile_links`: links repository template revisions to profile revisions.

## Profile and secret tables

- `profiles`: user-owned reusable profile definitions.
- `profile_revisions`: versioned profile payloads.
- `profile_env_vars`: plain env var bindings attached to profile revisions.
- `profile_secret_bindings`: secret mappings attached to profile revisions.
- `profile_ssh_settings`: SSH behavior attached to profile revisions.
- `profile_ssh_key_bindings`: SSH key references attached to profile revisions.
- `secrets`: logical secret containers.
- `secret_versions`: encrypted secret value versions.
- `ssh_keys`: manag id, ownerUserId, repositoryId, templateId/revisionId, profileRevisionId, status, activeRunId, createdAt, updatedAt, archivedAt
- sandbox_run_links (history): sandboxId, runed SSH public-key records and private-key secret references.

## Issue workflow and SCM lineage tables

- `issues`: synchronized issue records from source providers.
- `pull_requests`: synchronized pull request records from source providers.
- `issue_run_links`: links issues to execution attempts.
- `run_pull_request_links`: links execution attempts to pull requests.
- `issue_pull_request_links`: direct issue-to-pull-request lineage links.

## Execution reporting tables (internal)

- `run_events`: ordered execution event stream per attempt.
- `run_validation_results`: structured validation outcomes per attempt.
- `run_diff_files`: structured changed-file metadata per attempt.
- `run_artifacts`: artifact references and inline payloads per attempt.
- `run_summaries`: synthesized execution summaries.
