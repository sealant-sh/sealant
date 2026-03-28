---
title: "@sealant/ssh-gateway"
slug: /apps/ssh-gateway
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/ssh-gateway

## Purpose

`@sealant/ssh-gateway` is the SSH routing gateway for sandbox access.

It gives users a single SSH entrypoint and resolves the active internal sandbox runtime target via
the API.

## What it solves

- stable SSH gateway host instead of one exposed port per sandbox
- reduced port-collision risk
- central location for auth/policy controls over sandbox SSH access

## High-level flow

1. User connects as `<prefix>-<sandboxId>@<gateway-host>`.
2. Gateway authenticates the user key.
3. Gateway asks API `GET /v1/sandboxes/{sandboxId}/ssh-target` for the runtime endpoint.
4. Gateway opens upstream SSH and forwards session channels.

## Key files

- `apps/ssh-gateway/src/gateway-server.ts`
- `apps/ssh-gateway/src/sandbox-target.ts`
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
