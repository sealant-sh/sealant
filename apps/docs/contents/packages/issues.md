---
title: "@sealant/issues"
slug: /packages/issues
status: draft
owner: engineering
updated: 2026-06-20
---

## Purpose

`@sealant/issues` contains provider imports, normalization, and board state helpers for issue
workflow surfaces.

GitHub and Linear issue imports are the current provider implementations.

The authenticated web app owns the current one-click Linear OAuth importer under `/api/linear/*`. It
handles the redirect, callback, token refresh, and server-side GraphQL import before handing
normalized records to the board.

## Why this package exists

- Keep issue-provider payload mapping out of product components.
- Normalize GitHub and Linear issues into one issue workflow record shape.
- Share board ordering helpers between web surfaces and future API-backed workflow views.

## Module map

- `src/github.ts`
  - GitHub REST issue import and normalization
- `src/linear.ts`
  - Linear GraphQL issue import and normalization
- `src/board.ts`
  - issue workflow board ordering helpers
- `src/stage.ts`
  - workflow stage and priority inference
- `src/index.ts`
  - public exports

## Public surface

Provider imports:

- `importGitHubIssues(options)`
- `importLinearIssues(options)`
- `normalizeGitHubIssue(options)`
- `normalizeLinearIssue(options)`

Board helpers:

- `createIssueWorkflowBoardOrder(issues)`
- `moveIssueWorkflowBoardItem(order, movement)`
- `DEFAULT_ISSUE_WORKFLOW_COLUMNS`

Exports are defined in `packages/issues/src/index.ts`.

## Boundary

This package does not persist imported issues, own OAuth credential storage, or execute issue
workflows. API modules can compose it with `@sealant/db`, provider auth, and workflow execution
services.

The current web implementation stores Linear OAuth state and token payloads in encrypted HttpOnly
cookies scoped to `/api/linear`. A future API-backed workflow service can move that credential state
into database-backed workspace/user integration records without changing the package normalization
surface.

## Internal dependencies

- Internal package dependencies: none
- External runtime dependencies: `fetch`

## Scripts

- `pnpm --filter @sealant/issues lint`
- `pnpm --filter @sealant/issues test`
- `pnpm --filter @sealant/issues typecheck`
