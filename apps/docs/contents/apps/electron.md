---
title: "@sealant/electron"
slug: /apps/electron
status: draft
owner: engineering
updated: 2026-03-28
---

## Purpose

`@sealant/electron` is the desktop application workspace for Sealant.

## Current status

- This app is currently a scaffold workspace.
- It includes package metadata and TypeScript configuration, but no runtime app implementation yet.
- Existing scripts are tooling-only (`lint`, `typecheck`).

## Runtime scripts

- `pnpm --filter @sealant/electron lint`
- `pnpm --filter @sealant/electron typecheck`

## Next implementation milestones

- define desktop product scope and primary user flows
- establish app process/runtime architecture
- add packaging and release workflow
