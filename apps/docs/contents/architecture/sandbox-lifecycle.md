---
title: Sandbox Lifecycle
slug: /architecture/sandbox-lifecycle
status: draft
owner: engineering
updated: 2026-03-28
---

# Sandbox Lifecycle

This page describes how a sandbox request moves through the current Sealant architecture.

## Goal

Turn user intent into an isolated, reproducible coding sandbox with clear lifecycle state.

## High-level flow

1. A product surface submits a sandbox request.
2. The control plane normalizes request inputs into a workspace blueprint.
3. An OS integration compiles the blueprint into build artifacts.
4. Registry integration publishes the image artifact and returns canonical references.
5. A runtime adapter launches the sandbox runtime.
6. Lifecycle state is persisted and surfaced back to product UI/reporting.

## Package responsibilities by phase

### 1) Input normalization

- `@sealant/workspace-composition`
  - parses/normalizes input (`UserWorkspaceSpec` -> `WorkspaceBlueprint`)
  - defines target/runtime/customization contracts used downstream

### 2) Build compile

- `@sealant/os-integration-buildkit`
  - checks support for target OS and harness constraints
  - resolves package/tooling/install plans
  - compiles to BuildKit artifacts (`oci-image` + metadata)

- `@sealant/ai-harness-integrations`
  - provides harness install/launch metadata consumed during build planning

- `@sealant/package-standardization` (when integrated in request prep)
  - resolves package naming differences across Arch/Fedora/Nix

### 3) Build-job orchestration

- `@sealant/workspace-build-queue`
  - queues durable `workspace-build-job.requested` messages
  - gives API/worker a shared topology + message contract

- `@sealant/db`
  - persists build-job records and state transitions
  - persists sandbox and attempt lifecycle records

### 4) Artifact publish

- `@sealant/registry-integration`
  - publishes image artifacts into Zot
  - returns stable tag/digest references for launch

### 5) Runtime launch

- `@sealant/runtime-adapters-api`
  - selects concrete runtime adapter
  - executes launch via Docker adapter (current) or scaffolded k8s/k3s adapters

### 6) Source access

- `@sealant/source-integrations`
  - manages provider-specific source auth and repository metadata (GitHub today)
  - supports clone/auth flows used in sandbox startup

## State and persistence

Primary persisted entities live in `@sealant/db`:

- sandbox records
- sandbox attempts and snapshots
- workspace build jobs
- sandbox runtime instances

This allows clear status reporting and reproducible audit trails.

## Current constraints (important)

- BuildKit executor currently supports only dotfiles as additional input sources.
- BuildKit executor currently does not support package version pinning.
- Docker-assisted image publish is an implementation bridge in current registry flow.

## Related docs

- `apps/docs/contents/packages/workspace-composition.md`
- `apps/docs/contents/packages/os-integration-buildkit.md`
- `apps/docs/contents/packages/registry-integration.md`
- `apps/docs/contents/packages/runtime-adapters-api.md`
- `apps/docs/contents/packages/workspace-build-queue.md`
- `apps/docs/contents/packages/db.md`
