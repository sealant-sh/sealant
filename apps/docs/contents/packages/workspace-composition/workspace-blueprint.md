---
title: Workspace Blueprint
slug: /packages/workspace-composition/workspace-blueprint
status: draft
owner: engineering
updated: 2026-03-28
---

# Workspace Blueprint

`WorkspaceBlueprint` is the normalized, OS-agnostic handoff contract used after user input
normalization and before executor selection.

## Top-level shape

- `version`
- `sources`
- `harness`
- `access`
- `tooling`
- `customization`
- `lifecycle`
- `runtime`
- `target`

## Important defaults

- `version`: `"1"`
- `sources.workspace.ref`: `"main"`
- `sources.workspace.provider`: `"generic"`
- `sources.inputs`: `[]`
- `access.ssh.enabled`: `false`
- `access.ssh.listenPort`: `2222`
- `tooling.packages`: `[]`
- `customization.defaultShell`: `"bash"`
- `customization.dotfilesManager`: `"auto"`
- `customization.dotfilesTarget`: `"home"`
- `customization.applyDotfiles`: `true`
- `lifecycle.setup`: `[]`
- `lifecycle.startup.steps`: `[]`
- `lifecycle.startup.foreground.kind`: `"harness"`
- `runtime.workspaceRoot`: `"/workspace"`
- `runtime.workingDirectory`: `"/workspace/repo"`
- `runtime.persistence`: `"ephemeral"`
- `runtime.ociRuntime`: `"runc"`
- `runtime.network.outbound`: `true`
- `target.os.family`: `"auto"`
- `target.os.mode`: `"prefer"`
- `target.runtime.family`: `"auto"`
- `target.runtime.mode`: `"prefer"`

## Why this contract is intentionally narrow

`WorkspaceBlueprint` preserves cross-OS intent and excludes OS/runtime-specific implementation
details.

It does not include:

- distro-specific package manager details
- image publishing details
- runtime deployment settings

Those belong in integration packages and runtime adapters.

## Source

- `packages/workspace-composition/src/blueprint.ts`
