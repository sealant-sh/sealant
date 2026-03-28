---
title: "@sealant/ai-harness-integrations"
slug: /packages/ai-harness-integrations
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/ai-harness-integrations

## Purpose

`@sealant/ai-harness-integrations` is the shared harness catalog for sandbox startup.

It defines known harness ids and the install/launch commands that OS integration packages need when
building sandbox images.

## Why this package exists

- Keep harness support centralized and typed.
- Avoid duplicating install/launch command logic across executors.
- Provide a single contract for validating harness ids in composition and build flows.

## Public surface

- `HarnessId` union: `"opencode" | "codex" | "claude-code"`
- `HarnessIntegration` contract:
  - `id`
  - `installPackages`
  - `installCommand`
  - `launchCommand`
- `isHarnessId(value)`
- `listHarnessIntegrations()`
- `getHarnessIntegration(harnessId)`

Exports are defined in `packages/ai-harness-integrations/src/index.ts`.

## Module map

- `src/index.ts`
  - harness id union
  - static integration registry
  - lookup/validation helpers

## Current integrations

- `opencode`
  - install packages: `nodejs`
  - install command: `npm install -g opencode-ai@latest`
  - launch command: `opencode`
- `codex`
  - install packages: `nodejs`
  - install command: `npm install -g @openai/codex@latest`
  - launch command: `codex`
- `claude-code`
  - install packages: `nodejs`
  - install command: `npm install -g @anthropic-ai/claude-code@latest`
  - launch command: `claude`

## Behavior

- `isHarnessId(value)` is the type guard used to validate harness ids.
- `listHarnessIntegrations()` returns the full built-in registry.
- `getHarnessIntegration(harnessId)` returns `undefined` for unknown ids instead of throwing.

## Built-in harness entries

- `opencode`: install `opencode-ai`, launch `opencode`
- `codex`: install `@openai/codex`, launch `codex`
- `claude-code`: install `@anthropic-ai/claude-code`, launch `claude`

## Internal dependencies

- External runtime dependencies: none
- Internal package dependencies: none

## Typical call flow

1. Workspace blueprint selects a harness id.
2. OS executor resolves harness via `getHarnessIntegration(...)`.
3. Executor adds harness install packages and install command to image build plan.
4. Runtime entrypoint uses harness launch command for interactive startup.

## Cross-package dependency

- `@sealant/workspace-composition` uses this package to validate harness support.
- `@sealant/os-integration-buildkit` uses this package when generating build plans.

## Scripts

- `pnpm --filter @sealant/ai-harness-integrations lint`
- `pnpm --filter @sealant/ai-harness-integrations test`
- `pnpm --filter @sealant/ai-harness-integrations typecheck`
