---
title: Issue Workflow Lifecycle
slug: /architecture/issue-workflow-lifecycle
status: draft
owner: engineering
updated: 2026-03-31
---

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
- `@sealant/issues`
  - normalizes imported GitHub and Linear issues into issue workflow records
  - provides board ordering helpers for product surfaces
- `apps/web`
  - owns the current one-click Linear OAuth importer and issue workflow board interaction
  - keeps Linear tokens server-side while returning normalized issue records to the client board

### 2) Source and auth context

- `@sealant/source-integrations`
  - resolves provider data and access details (GitHub support today)
  - supports repository selection/reference handling used by workflow execution

### 3) Environment composition and build

- `@sealant/validators`
  - defines shared execution environment contracts
- `@sealant/rabbitmq`
  - provides queue transport primitives for execution orchestration
- `@sealant/sandboxes`
  - provides compile/publish/runtime infrastructure reused by issue workflow execution

### 4) Harness and execution tooling

- `@sealant/sandboxes`
  - contains harness integration logic used by sandbox and issue workflow execution paths

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
- `apps/docs/contents/packages/issues.md`
- `apps/docs/contents/packages/validators.md`
- `apps/docs/contents/packages/source-integrations.md`
- `apps/docs/contents/packages/rabbitmq.md`
- `apps/docs/contents/packages/sandboxes.md`
