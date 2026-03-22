# Control-Plane Schema Map

This folder defines the durable database schema used by Sealant.

Product-facing language is centered on two domains:

- sandboxes
- issue workflows

Some tables still use internal execution vocabulary (`attempt`, `execution`, `job`) because they
model orchestration and reporting internals.

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

## Package resolution cache table

- `package_resolution_cache_entries`: cache of standardized package-resolution responses keyed by
  normalized package query.

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
- `ssh_keys`: manag id, ownerUserId, repositoryId, templateId/revisionId, profileRevisionId, status,
  activeRunId, createdAt, updatedAt, archivedAt
- sandbox_run_links (history): sandboxId, runed SSH public-key records and private-key secret
  references.

## Issue workflow and SCM lineage tables

- `issues`: synchronized issue records from source providers.
- `pull_requests`: synchronized pull request records from source providers.
- `issue_workflows`: primary issue workflow product object anchored to an issue.
- `issue_workflow_executions`: concrete executions of an issue workflow.
- `issue_workflow_execution_pull_request_links`: pull request lineage for workflow executions.
- `issue_pull_request_links`: direct issue-to-pull-request lineage links.

## Issue workflow execution reporting tables

- `issue_workflow_execution_events`: ordered execution event stream per workflow execution.
- `issue_workflow_execution_validation_results`: structured validation outcomes per workflow
  execution.
- `issue_workflow_execution_diff_files`: structured changed-file metadata per workflow execution.
- `issue_workflow_execution_artifacts`: artifact references and inline payloads per workflow
  execution.
- `issue_workflow_execution_summaries`: synthesized execution summaries.
