---
title: User Workspace Spec
slug: /packages/workspace-composition/user-workspace-spec
status: draft
owner: engineering
updated: 2026-03-28
---

# User Workspace Spec

`UserWorkspaceSpec` is the ergonomic input contract for sandbox composition.

It accepts shorthand forms that product surfaces can submit easily, then normalization produces a
strict `WorkspaceBlueprint`.

## Accepted shorthand forms

- workspace source aliases:
  - `source`
  - `repo`
  - `sources.workspace`
- harness shorthand:
  - `harness: "opencode"`
- SSH shorthand:
  - `ssh: true`
- package shorthand:
  - `packages: ["nodejs", "pnpm"]`
- lifecycle shorthand:
  - `setup: ["pnpm install"]`
  - `startup: "pnpm dev"`
- target shorthand:
  - `os: "fedora"`
  - `target.runtime: "docker"`

## Alias conflict rules

The schema rejects ambiguous duplicate spellings. Examples:

- `source` + `repo`
- `inputs` + `sources.inputs`
- `ssh` + `access.ssh`
- `packages` + `tooling.packages`
- `setup` + `lifecycle.setup`
- `startup` + `lifecycle.startup`
- `env` + `runtime.env`
- `os` + `target.os`

## Required input guarantees

- exactly one workspace source must be present via `source`, `repo`, or `sources.workspace`
- `harness` is required

## What normalization does

`normalizeUserWorkspaceSpec(input)` performs these conversions:

- infers source provider from URL when provider is omitted
  - GitHub URLs -> `github`
  - GitLab URLs -> `gitlab`
  - everything else -> `generic`
- converts shorthand values into structured objects
- generates stable ids for input sources when omitted
- deduplicates package requests by package id
- applies runtime and lifecycle defaults
- validates final output against `workspaceBlueprintSchema`

## Entry points

- `parseUserWorkspaceSpec(input)`
- `normalizeUserWorkspaceSpec(input)`

## Source

- `packages/workspace-composition/src/user-workspace-spec.ts`
