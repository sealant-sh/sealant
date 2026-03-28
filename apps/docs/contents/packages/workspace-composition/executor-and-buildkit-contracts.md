---
title: Executor and BuildKit Contracts
slug: /packages/workspace-composition/executor-and-buildkit-contracts
status: draft
owner: engineering
updated: 2026-03-28
---

# Executor and BuildKit Contracts

This page covers the shared executor interface and the BuildKit-specific schema extensions.

## Shared executor contract

`OsExecutor` defines behavior that every OS integration must implement:

- `id`
- `osFamily`
- `supports(input)`
- `compile(input)`

## Shared data schemas

From `src/executor.ts`:

- `osExecutorIdSchema`: `nix | fedora | arch`
- `concreteWorkspaceTargetOsFamilySchema`: excludes `auto`
- `osExecutorSupportSchema`: typed support success/failure
- `osExecutorCompileInputSchema`: `{ blueprint }`
- `buildArtifactSchema`: standardized artifacts
- `osExecutorCompileResultSchema`: executor identity + artifacts + optional metadata

## Standard artifact vocabulary

- `oci-image`
- `filesystem-closure`
- `manifest`
- `metadata`

This is the stable handoff shape between composition and downstream runtime/publish layers.

## BuildKit-specialized contracts

From `src/buildkit.ts`:

- `resolvedImagePlanSchema`
  - resolved package-manager + package mapping plan
  - dotfiles plan
  - build/runtime secret references
  - image/runtime env maps
- `buildkitBuildSpecSchema`
  - context directory
  - Containerfile path
  - image reference
  - build args + secret mounts
- `buildkitOsExecutorCompileResultSchema`
  - extends shared compile result with `buildkit.imagePlan` and `buildkit.spec`

## Why these extensions exist

The shared contract keeps executor outputs uniform across OS integrations.

The BuildKit extension carries details needed by BuildKit-backed implementations without leaking
those details into all executor consumers.

## Sources

- `packages/workspace-composition/src/executor.ts`
- `packages/workspace-composition/src/buildkit.ts`
