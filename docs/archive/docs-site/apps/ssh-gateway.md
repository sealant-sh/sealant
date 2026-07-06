---
title: "@sealant/ssh-gateway"
slug: /apps/ssh-gateway
status: draft
owner: engineering
updated: 2026-03-28
---

## Purpose

`@sealant/ssh-gateway` is the SSH routing gateway for workspace access.

It gives users a single SSH entrypoint and resolves the active internal workspace runtime target via
the API.

## What it solves

- stable SSH gateway host instead of one exposed port per workspace
- reduced port-collision risk
- central location for auth/policy controls over workspace SSH access

## High-level flow

1. User connects as `<prefix>-<workspaceId>@<gateway-host>`.
2. Gateway authenticates the user key: static allowlist file first (operator break-glass), then
   `POST /v1/ssh-keys/resolve-principal` to match the key against user-registered keys (`ssh_keys`
   table). The resolved principal must own the workspace.
3. Gateway asks API `GET /v1/workspaces/{workspaceId}/ssh-target` for the runtime endpoint.
4. Gateway opens the workspace's sealantd control connection and maps SSH channels onto it.

## Key files

- `apps/ssh-gateway/src/gateway-server.ts`
- `apps/ssh-gateway/src/workspace-target.ts`
- `apps/ssh-gateway/src/principal-resolver.ts`
- `apps/ssh-gateway/src/authorized-keys.ts`
- `apps/ssh-gateway/src/env.ts`

## Environment highlights

Env contract includes:

- gateway bind host/port/banner and key files
- API base URL + required internal token for `ssh-target` lookups
- upstream private key + readiness timeout
- strict-host-key-checking toggle for upstream SSH

See `apps/ssh-gateway/src/env.ts` for complete details.

## Runtime scripts

- `pnpm --filter @sealant/ssh-gateway dev`
- `pnpm --filter @sealant/ssh-gateway test`
- `pnpm --filter @sealant/ssh-gateway typecheck`
