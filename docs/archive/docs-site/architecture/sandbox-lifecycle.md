---
title: Sandbox Lifecycle
slug: /architecture/sandbox-lifecycle
status: draft
owner: engineering
updated: 2026-03-31
---

This page describes how a sandbox request moves through the current Sealant architecture.

## Goal

Turn user intent into an isolated, reproducible coding sandbox with clear lifecycle state.

## High-level flow

1. A product surface submits a sandbox request.
2. The control plane validates and normalizes request inputs into a sandbox blueprint.
3. A sandbox build job is enqueued and claimed by a worker.
4. BuildKit compiles the blueprint, and the image is published to the registry.
5. A runtime adapter launches the sandbox runtime.
6. Lifecycle state is persisted and surfaced back to product UI/reporting.

## Package responsibilities by phase

### 1) Input normalization

- `@sealant/validators`
  - defines request/response schemas and sandbox blueprint contracts
- `@sealant/api`
  - validates request payloads and persists initial sandbox records

### 2) Queue orchestration

- `@sealant/rabbitmq`
  - provides shared transport primitives and queue prefetch/env contract
- `@sealant/sandboxes`
  - defines sandbox queue topology and message helpers

### 3) Build and publish

- `@sealant/sandboxes`
  - compiles a sandbox blueprint with BuildKit
  - resolves harness/package/runtime planning
  - publishes OCI image artifacts and returns canonical references

### 4) Runtime launch

- `@sealant/sandboxes`
  - selects runtime adapter and launches sandbox runtime
  - maps launch results into persisted lifecycle state

- `@sealant/db`
  - persists sandbox build jobs and status transitions
  - persists sandbox, attempt, runtime, and publish state

### 5) Source access

- `@sealant/source-integrations`
  - manages provider-specific source auth and repository metadata (GitHub today)
  - supports clone/auth flows used in sandbox startup

## State and persistence

Primary persisted entities live in `@sealant/db`:

- sandbox records
- sandbox attempts and snapshots
- sandbox build jobs
- sandbox runtime instances

This allows clear status reporting and reproducible audit trails.

## Current constraints

- BuildKit compile currently supports only dotfiles as additional input sources.
- BuildKit compile currently does not support package version pinning.
- Docker runtime is the default adapter when runtime target family is `auto`.

## Related docs

- `apps/docs/contents/packages/sandboxes.md`
- `apps/docs/contents/packages/rabbitmq.md`
- `apps/docs/contents/packages/validators.md`
- `apps/docs/contents/packages/db.md`
