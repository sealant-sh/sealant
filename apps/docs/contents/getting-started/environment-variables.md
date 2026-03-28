---
title: Environment Variables
slug: /getting-started/environment-variables
status: draft
owner: engineering
updated: 2026-03-28
---

# Environment Variables

This page lists the highest-impact environment variables for local development.

For complete contracts, see each app/package env module:

- `apps/api/src/env.ts`
- `apps/worker/src/env.ts`
- `apps/ssh-gateway/src/env.ts`
- `packages/db/src/env.ts`
- `packages/workspace-build-queue/src/env.ts`
- `packages/auth/src/env.ts`

## Shared infrastructure

- `DATABASE_FILE_PATH` (SQLite path)
- `DATABASE_BUSY_TIMEOUT_MS`
- `RABBITMQ_URL`
- `WORKSPACE_BUILD_QUEUE_PREFETCH`
- `REGISTRY_BASE_URL`
- `REGISTRY_PUSH_REGISTRY`
- `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` (optional pair)

## API (`@sealant/api`)

- `PORT` (default `4000`)
- `CORS_ALLOWED_ORIGINS`
- `REPOLOGY_API_BASE_URL`
- `REPOLOGY_USER_AGENT`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`
- `GITHUB_APP_WEBHOOK_SECRET`
- `SANDBOX_SSH_GATEWAY_TOKEN` (for internal gateway lookup route)
- `SANDBOX_SSH_GATEWAY_HOST`

## Worker (`@sealant/worker`)

- `DEFAULT_RUNTIME_ADAPTER` (default `docker`)
- `DOCKER_SOCKET_PATH`
- `DEFAULT_WORKSPACE_STARTUP_MODE`
- `DEFAULT_WORKSPACE_IDLE_COMMAND`
- `DEFAULT_WORKSPACE_SSH_ENABLED`
- `DEFAULT_WORKSPACE_SSH_LISTEN_PORT`
- `DEFAULT_SSH_AUTHORIZED_KEYS_FILE`
- `DEFAULT_SSH_BIND_HOST`
- `DEFAULT_SSH_ENDPOINT_EXPOSURE_STRATEGY`
- `WORKER_ID`

## SSH Gateway (`@sealant/ssh-gateway`)

- `SSH_GATEWAY_HOST`
- `SSH_GATEWAY_PORT`
- `SSH_GATEWAY_HOST_KEY_PATH`
- `SSH_GATEWAY_ALLOWED_KEYS_FILE`
- `SSH_GATEWAY_SANDBOX_USERNAME_PREFIX`
- `CORE_API_BASE_URL`
- `SANDBOX_SSH_GATEWAY_TOKEN` (required)
- `SSH_UPSTREAM_PRIVATE_KEY_PATH`
- `SSH_UPSTREAM_STRICT_HOST_KEY_CHECKING`

## Auth (`@sealant/auth`)

- `BETTER_AUTH_APP_NAME`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `BETTER_AUTH_TRUSTED_ORIGINS`
