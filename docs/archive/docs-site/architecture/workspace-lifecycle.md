---
title: Workspace Lifecycle
slug: /architecture/workspace-lifecycle
status: draft
owner: engineering
updated: 2026-03-31
---

This page describes how a workspace request moves through the current Sealant architecture.

## Goal

Turn user intent into an isolated, reproducible coding workspace with clear lifecycle state.

## High-level flow

1. A product surface submits a workspace request.
2. The control plane validates and normalizes request inputs into a workspace blueprint.
3. A workspace build job is enqueued and claimed by a worker.
4. BuildKit compiles the blueprint, and the image is published to the registry.
5. A runtime adapter launches the workspace runtime.
6. Lifecycle state is persisted and surfaced back to product UI/reporting.

## Package responsibilities by phase

### 1) Input normalization

- `@sealant/validators`
  - defines request/response schemas and workspace blueprint contracts
- `@sealant/api`
  - validates request payloads and persists initial workspace records

### 2) Queue orchestration

- `@sealant/rabbitmq`
  - provides shared transport primitives and queue prefetch/env contract
- `@sealant/workspaces`
  - defines workspace queue topology and message helpers

### 3) Build and publish

- `@sealant/workspaces`
  - compiles a workspace blueprint with BuildKit
  - resolves harness/package/runtime planning
  - publishes OCI image artifacts and returns canonical references

### 4) Runtime launch

- `@sealant/workspaces`
  - selects runtime adapter and launches workspace runtime
  - maps launch results into persisted lifecycle state

- `@sealant/db`
  - persists workspace build jobs and status transitions
  - persists workspace, attempt, runtime, and publish state

### 5) Source access

- `@sealant/source-integrations`
  - manages provider-specific source auth and repository metadata (GitHub today)
  - supports clone/auth flows used in workspace startup

## State and persistence

Primary persisted entities live in `@sealant/db`:

- workspace records
- workspace attempts and snapshots
- workspace build jobs
- workspace runtime instances

This allows clear status reporting and reproducible audit trails.

## Current constraints

- BuildKit compile currently supports only dotfiles as additional input sources.
- BuildKit compile currently does not support package version pinning.
- Docker runtime is the default adapter when runtime target family is `auto`.

## Related docs

- `apps/docs/contents/packages/workspaces.md`
- `apps/docs/contents/packages/rabbitmq.md`
- `apps/docs/contents/packages/validators.md`
- `apps/docs/contents/packages/db.md`
