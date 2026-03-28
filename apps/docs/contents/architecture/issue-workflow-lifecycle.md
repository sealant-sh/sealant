---
title: Issue Workflow Lifecycle
slug: /architecture/issue-workflow-lifecycle
status: draft
owner: engineering
updated: 2026-03-28
---

# Issue Workflow Lifecycle

This page describes how issue workflow execution is modeled and processed in Sealant.

## Goal

Run issue-to-PR work in isolated environments while keeping lifecycle, events, artifacts, and
reporting reproducible.

## High-level flow

1. A product/API surface submits issue workflow context and execution preferences.
2. The control plane validates inputs and persists workflow + execution state.
3. The system composes execution environment requirements (shared with sandbox composition model).
4. Worker-side execution runs the workflow and records lifecycle events.
5. Outputs such as summaries, diff metadata, and pull-request links are persisted.
6. Product surfaces read structured state for progress and reporting.

## Package responsibilities by phase

### 1) Workflow state model

- `@sealant/db`
  - persists issue workflow entities and execution lineage
  - stores execution events, validation results, diff files, summaries, artifacts, and PR links

### 2) Source and auth context

- `@sealant/source-integrations`
  - resolves provider data and access details (GitHub support today)
  - supports repository selection/reference handling used by workflow execution

### 3) Environment composition and build

- `@sealant/workspace-composition`
  - normalizes execution environment intent
- `@sealant/os-integration-buildkit`
  - compiles environment image artifacts
- `@sealant/workspace-build-queue`
  - queues build jobs when an execution requires image build orchestration
- `@sealant/registry-integration`
  - publishes resulting OCI images
- `@sealant/runtime-adapters-api`
  - launches isolated runtime sessions for workflow execution

### 4) Harness and execution tooling

- `@sealant/ai-harness-integrations`
  - provides harness install/launch contracts used when execution runs in a harness-driven sandbox

## Persisted execution reporting

Issue workflow persistence (in `@sealant/db`) includes:

- workflow and execution status
- event timeline
- validation results
- diff file metadata
- produced artifacts and summaries
- issue/pr linkage and execution-level PR link relations

This is the core of auditability and reproducibility for issue workflows.

## Current status notes

- Database-level issue workflow modeling is already substantial.
- Runtime and worker orchestration for end-to-end issue workflows is still evolving.
- The architecture is intentionally shared with sandbox lifecycle to reduce duplicated execution
  plumbing.

## Related docs

- `apps/docs/contents/packages/db.md`
- `apps/docs/contents/packages/workspace-composition.md`
- `apps/docs/contents/packages/source-integrations.md`
- `apps/docs/contents/packages/workspace-build-queue.md`
- `apps/docs/contents/packages/registry-integration.md`
- `apps/docs/contents/packages/runtime-adapters-api.md`
