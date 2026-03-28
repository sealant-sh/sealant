---
title: "@sealant/source-integrations"
slug: /packages/source-integrations
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/source-integrations

## Purpose

`@sealant/source-integrations` contains source provider integration logic for repository access,
resolution, and provider-specific auth workflows.

GitHub App support is the current implementation.

## Why this package exists

- Keep source-provider APIs and auth behavior out of app/business layers.
- Normalize provider payloads into stable internal contracts.
- Support secure repository access for sandbox and issue workflow execution.

## Module map

- `src/github.ts`
  - GitHub App auth, installation lookup, repository listing, webhook verification
- `src/index.ts`
  - public GitHub integration exports

## Public surface

GitHub integration exports:

- `GitHubSourceIntegration` class
- `createGitHubSourceIntegration(options)`
- auth-ref helpers:
  - `createGitHubInstallationRepositoryAuthRef(installationRepositoryId)`
  - `parseGitHubInstallationRepositoryAuthRef(authRef)`
- GitHub contract types (`GitHubRemoteInstallation`, `GitHubRemoteInstallationRepository`,
  `GitHubInstallationAccessToken`)

Exports are defined in `packages/source-integrations/src/index.ts`.

## Integration behavior

- `GitHubSourceIntegration.isConfigured()` checks whether app id + private key are available.
- `GitHubSourceIntegration.isWebhookVerificationConfigured()` checks webhook secret availability.
- `createAppJwt()` creates a signed JWT for GitHub App API calls.
- `verifyWebhookSignature(...)` validates incoming webhook payloads.
- `createInstallationAccessToken(...)` exchanges an installation id for a short-lived token.
- `getInstallation(...)` fetches installation metadata from GitHub.
- `listInstallationRepositories(...)` paginates installation repositories in batches of 100.

## Auth ref helpers

- `createGitHubInstallationRepositoryAuthRef(installationRepositoryId)` produces a stable auth ref.
- `parseGitHubInstallationRepositoryAuthRef(authRef)` extracts the repository id when the prefix
  matches.

These helpers let composition and build flows carry provider access as opaque references.

## GitHub integration capabilities

- create App JWT using configured app id and private key
- verify webhook signatures using HMAC SHA-256
- fetch installation metadata
- create installation access tokens
- list installation repositories with pagination

## Configuration shape

`GitHubSourceIntegrationOptions` supports:

- `appId`
- `privateKey`
- `webhookSecret`
- `apiBaseUrl`
- `fetch` override
- `now` clock override

## Cross-package dependency

- Used by `@sealant/api` for GitHub app and repository integrations.
- Used by `@sealant/worker` when workspace execution needs provider access.
- Used indirectly by `@sealant/db` through GitHub installation persistence.

## Internal dependencies

- Internal package dependencies: none
- External runtime dependencies: Node `crypto`, `fetch`

## Scripts

- `pnpm --filter @sealant/source-integrations lint`
- `pnpm --filter @sealant/source-integrations typecheck`
