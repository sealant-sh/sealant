# GitHub App Integration Progress

## Purpose

This document breaks Phase 1 into concrete schema and API tasks for implementing GitHub App-backed
private repository access in the sandbox creation flow.

Phase 1 target:

- a granted user can select a private GitHub repository from a shared GitHub App installation
- create a sandbox from that repository
- clone the repository with just-in-time installation-token auth
- avoid storing raw GitHub tokens in any durable request snapshot or job payload

## Phase 1 Boundaries

Included:

- GitHub App installation sync
- installation-level grants
- repository listing for granted installs
- sandbox creation from GitHub-backed repository selection
- worker and runtime support for just-in-time clone auth

Not included:

- issue ingestion
- pull request sync
- issue workflow launch
- branch push or PR creation
- repo-level grant overrides

## Current Relevant Surfaces

### Schema and repositories

- `packages/db/src/schema/control-plane.ts`
- `packages/db/src/repositories/repository-profiles.ts`
- `packages/db/src/repositories/sandbox-attempts.ts`
- `packages/db/src/repositories/sandboxes.ts`

### API

- `apps/api/src/app.ts`
- `apps/api/src/lib/create-app.ts`
- `apps/api/src/routes/sandboxes/sandboxes.index.ts`
- `apps/api/src/routes/sandboxes/sandboxes.handlers.ts`
- `apps/api/src/routes/sandboxes/sandboxes.schemas.ts`
- `apps/api/src/routes/sandboxes/sandboxes.routes.ts`

### Worker and runtime

- `apps/worker/src/process-sandbox-build-job.ts`
- `packages/os-integration-buildkit/src/buildkit-builder.ts`
- `packages/runtime-adapters-api/src/docker-runtime-adapter.ts`

### Source integration boundary

- `packages/source-integrations/package.json`
- `packages/sandbox-composition/docs/contracts.md`

### Web sandbox entrypoint

- `apps/web/src/routes/_authenticated/sandboxes/new.tsx`
- `apps/web/src/lib/trpc/router.ts`

## Proposed Phase 1 Delivery Order

1. Add DB schema and repositories for GitHub installs, install repos, grants, and webhook
   deliveries.
2. Stand up a first GitHub source-integration package with installation auth, repo sync, and access
   checks.
3. Add API route group for GitHub installations and repository listing.
4. Extend sandbox create request shape to support a GitHub source selection.
5. Enforce installation grant checks in sandbox creation and persist resolved `repositoryId`.
6. Update worker and runtime to resolve ephemeral clone credentials just in time.
7. Update sandbox UI to use a grant-aware GitHub repo picker.
8. Add tests across schema, API, worker, and runtime.

## Concrete Schema Breakdown

## 1. New DB tables

Add these tables to `packages/db/src/schema/control-plane.ts`.

### `githubAppInstallations`

Purpose:

- one row per GitHub App installation visible to Sealant

Recommended fields:

- `id` - internal Sealant id
- `provider` - default `github`
- `externalInstallationId` - GitHub installation id, unique
- `externalAccountId` - GitHub org or user account id
- `accountLogin` - org or user login
- `accountType` - `organization` or `user`
- `targetType` - install target type if different from account type
- `status` - `active`, `suspended`, `deleted`
- `permissions` - JSON snapshot of granted permissions
- `repositorySelection` - `all` or `selected`
- `installedAt`
- `suspendedAt`
- `lastSyncedAt`
- `createdAt`
- `updatedAt`

Indexes and constraints:

- unique on `externalInstallationId`
- index on `accountLogin`
- index on `status`
- index on `lastSyncedAt`

### `githubInstallationRepositories`

Purpose:

- cache repositories accessible under an installation and map them to `repositories`

Recommended fields:

- `id` - internal Sealant id
- `installationId` - fk to `githubAppInstallations`
- `repositoryId` - fk to existing `repositories`
- `externalRepositoryId` - GitHub repo id
- `owner` - denormalized GitHub owner login
- `name` - denormalized repo name
- `fullName` - `owner/name`
- `defaultBranch`
- `isPrivate`
- `isArchived`
- `pushedAt`
- `lastSyncedAt`
- `createdAt`
- `updatedAt`
- `removedAt` - nullable soft-removal marker

Indexes and constraints:

- unique on `installationId + externalRepositoryId`
- unique on `installationId + repositoryId`
- index on `fullName`
- index on `removedAt`
- index on `lastSyncedAt`

### `githubInstallationUserGrants`

Purpose:

- record which Sealant users may use which shared installations

Recommended fields:

- `installationId` - fk to `githubAppInstallations`
- `userId` - fk to auth `user`
- `grantedByUserId` - fk to auth `user`, nullable if system-created
- `grantedAt`
- `revokedAt`

Indexes and constraints:

- primary key or unique on active installation and user combination
- index on `userId + revokedAt`
- index on `installationId + revokedAt`

Note:

- Since this repo does not yet have a richer org or team model, this table is the first local
  access-control layer for shared installs.

### `githubWebhookDeliveries`

Purpose:

- provide webhook idempotency and replay safety

Recommended fields:

- `id` - internal Sealant id
- `deliveryId` - GitHub delivery id
- `eventType`
- `action`
- `installationExternalId` - nullable, because not every webhook will include one
- `payload` - optional JSON payload snapshot or reduced metadata summary
- `receivedAt`
- `processedAt`
- `status` - `received`, `processed`, `failed`, `ignored`
- `errorMessage`

Indexes and constraints:

- unique on `deliveryId`
- index on `eventType + receivedAt`
- index on `status + receivedAt`

## 2. Existing tables to integrate with

No fundamental redesign is needed for these existing tables, but Phase 1 should actively populate
them.

### `repositories`

Use `packages/db/src/repositories/repository-profiles.ts` `upsertRepository(...)` for GitHub repo
sync.

Expected Phase 1 behavior:

- `provider = github`
- `externalId = GitHub repository id`
- `owner`, `name`, `defaultBranch`, `url`, `isArchived`, and `lastSyncedAt` updated from install
  sync

### `sandboxes` and `sandbox_attempts`

Phase 1 should make sure sandbox creation sets:

- `sandbox.repositoryId`
- `sandboxAttempt.repositoryId`

This is required for:

- durable repo lineage
- later issue workflow linkage
- future repo-scoped policies and reporting

## 3. DB repository layer tasks

Add new repository modules under `packages/db/src/repositories/`.

### `github-installations.ts`

Methods to add:

- `upsertInstallation(...)`
- `getInstallationById(...)`
- `getInstallationByExternalId(...)`
- `listInstallationsForUser(...)`
- `listActiveInstallations(...)`
- `setInstallationStatus(...)`
- `grantInstallationToUser(...)`
- `revokeInstallationGrant(...)`
- `userHasInstallationGrant(...)`
- `listInstallationGrants(...)`

### `github-installation-repositories.ts`

Methods to add:

- `upsertInstallationRepository(...)`
- `markInstallationRepositoriesRemoved(...)`
- `listRepositoriesForInstallation(...)`
- `listRepositoriesForUser(...)`
- `getInstallationRepositoryById(...)`
- `getInstallationRepositoryByRepoId(...)`
- `getInstallationRepositoryByExternalRepoId(...)`

### `github-webhook-deliveries.ts`

Methods to add:

- `createWebhookDelivery(...)`
- `getWebhookDeliveryByDeliveryId(...)`
- `markWebhookDeliveryProcessed(...)`
- `markWebhookDeliveryFailed(...)`

### `packages/db` export tasks

Update:

- `packages/db/src/schema/index.ts`
- `packages/db/src/index.ts`

So the new schema types and repositories are available to `apps/api` and `apps/worker`.

### Migration tasks

Add a new migration that creates all four GitHub tables and related indexes and foreign keys.

## Concrete API Breakdown

## 1. Runtime config and app wiring

### `apps/api/src/env.ts`

Add typed env parsing for:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_WEBHOOK_SECRET`
- `GITHUB_APP_CLIENT_ID` optional for install UX
- `GITHUB_APP_CLIENT_SECRET` optional for install UX
- `GITHUB_APP_NAME` or `GITHUB_APP_SLUG` optional for UI convenience

### `apps/api/src/app.ts`

Wire new repositories and source-integration services into app assembly.

Expected additions:

- create GitHub installation repository
- create GitHub installation repository-cache repository
- create GitHub webhook repository
- create GitHub source-integration client/service
- mount a new API route group under `/v1/github`

### `apps/api/src/lib/types.ts`

Extend `AppRuntimeConfig` and request bindings so route handlers can access:

- GitHub source integration service
- GitHub installation repository
- GitHub installation repository cache
- GitHub webhook delivery repository

### `apps/api/src/lib/create-app.ts`

Attach the new services and repositories to the Hono context in the same pattern used for existing
repos.

## 2. New API route groups

Create a new route group such as `apps/api/src/routes/github/` with index, schemas, routes, and
handlers.

### Installations endpoints

Recommended first-pass endpoints:

- `GET /v1/github/installations`
  - list active GitHub App installations visible to the current user
  - optionally support admin view later

- `GET /v1/github/installations/:installationId/repositories`
  - list repositories synced under a granted installation
  - supports search and pagination later; first pass can keep search simple

- `POST /v1/github/installations/:installationId/sync`
  - trigger install repo sync or refresh
  - likely admin-only in practice, but the API shape can be added now

### Grants endpoints

Recommended first-pass endpoints:

- `GET /v1/github/installations/:installationId/grants`
- `POST /v1/github/installations/:installationId/grants`
- `DELETE /v1/github/installations/:installationId/grants/:userId`

These can be hidden from the product UI at first if grant administration is manual, but the API
shape is useful.

### Webhook endpoint

Recommended endpoint:

- `POST /v1/github/webhooks`

Responsibilities:

- verify signature
- dedupe by delivery id
- persist delivery state
- dispatch installation and installation repository sync work

Phase 1 scope should handle at least:

- `installation`
- `installation_repositories`

## 3. Sandbox API changes

### Request schema work

Update sandbox request schemas in:

- `apps/api/src/routes/sandboxes/sandboxes.schemas.ts`
- `apps/api/src/routes/sandboxes/sandboxes.routes.ts`

Add a GitHub-backed source variant for create sandbox input.

Recommended source shape for Phase 1:

- existing generic source remains supported
- GitHub source includes:
  - `provider: github`
  - `installationId`
  - `installationRepositoryId` or resolved `repositoryId`
  - `ref` optional

Prefer `installationRepositoryId` at the API boundary because it gives a direct authz anchor.

### Handler work

Update `apps/api/src/routes/sandboxes/sandboxes.handlers.ts` create flow to:

1. detect GitHub-backed source selection
2. resolve installation repository record
3. verify user has active installation grant
4. verify installation status is active
5. upsert or refresh the durable `repositories` row if needed
6. transform GitHub source selection into the normalized sandbox source used by worker
7. create sandbox with `repositoryId`
8. create sandbox attempt with `repositoryId`
9. snapshot source metadata without snapshotting any installation token

### Idempotency expectations

The existing `Idempotency-Key` flow should continue to work unchanged.

The create handler should make sure a retried request:

- resolves the same installation repository
- yields the same sandbox lineage
- does not create duplicated access-grant side effects

### Auth expectations

The API currently relies on caller-supplied identity in some places. Phase 1 should at least make
sandbox GitHub access checks server-side in the handler, not just at the web layer.

## 4. Worker and runtime API contract changes

### `packages/source-integrations`

Create the first concrete package code for GitHub source support.

Recommended module responsibilities:

- create GitHub App JWT
- request installation access token
- list installation repositories
- resolve branch and ref metadata
- produce ephemeral clone credential descriptor

### Worker integration

Update `apps/worker/src/process-sandbox-build-job.ts` so that when a sandbox job contains a
GitHub-backed source:

- worker resolves installation metadata from DB
- worker asks the GitHub integration for an installation token late in the flow
- worker passes an ephemeral clone credential descriptor into runtime launch

### Runtime contract

Current `authRef` handling is too file-oriented for GitHub App tokens.

Phase 1 tasks:

- extend the runtime contract to represent token-based clone auth cleanly
- avoid overloading file-path-only semantics
- keep compatibility with existing generic flows if possible

Recommended credential contract options:

- `type: none`
- `type: file-ref`
- `type: http-token`

### Runtime adapter tasks

Update:

- `packages/runtime-adapters-api/src/docker-runtime-adapter.ts`
- any shared runtime contract files it depends on

So runtime launch can inject temporary token auth for clone without exposing it in logs.

### Build and entrypoint tasks

Update `packages/os-integration-buildkit/src/buildkit-builder.ts` clone bootstrapping so that:

- GitHub token auth is consumed via env or mounted secret
- token is not printed
- token is not persisted into shell history or startup artifacts

## Phase 1 Web and Product Checklist

Even though this document focuses on schema and API work, Phase 1 still needs a minimal UI path.

### Sandbox form tasks

Update `apps/web/src/routes/_authenticated/sandboxes/new.tsx` to:

- add GitHub as a source mode alongside raw URL input
- fetch granted installations for the user
- fetch repos for the selected installation
- allow ref selection or manual ref input
- submit GitHub-backed source payload to sandbox create

### Web API client tasks

Update web API bindings in the appropriate client layer so the web app can call the new GitHub
endpoints and submit the new source shape.

## Phase 1 Test Checklist

## DB

- add schema tests or repository tests for installation upsert, grant checks, and repository listing
- verify revoked grants are excluded from access checks
- verify installation repository rows map correctly to `repositories`

## API

- sandbox create rejects missing installation grant
- sandbox create rejects suspended installation
- sandbox create accepts granted installation repo and stores `repositoryId`
- GitHub list endpoints only return installations and repos the user may access
- webhook endpoint rejects invalid signatures and dedupes repeated deliveries

## Worker and runtime

- worker mints installation token only for GitHub-backed jobs
- runtime receives token in ephemeral form only
- clone flow does not log the token
- generic git flows still behave correctly

## Phase 1 Implementation Checklist

## Schema and DB

- [ ] Add `githubAppInstallations` table to `packages/db/src/schema/control-plane.ts`
- [ ] Add `githubInstallationRepositories` table to `packages/db/src/schema/control-plane.ts`
- [ ] Add `githubInstallationUserGrants` table to `packages/db/src/schema/control-plane.ts`
- [ ] Add `githubWebhookDeliveries` table to `packages/db/src/schema/control-plane.ts`
- [ ] Export new schema types from `packages/db/src/schema/index.ts`
- [ ] Export new schema types and repositories from `packages/db/src/index.ts`
- [ ] Add DB migration for the new GitHub tables and indexes
- [ ] Add `packages/db/src/repositories/github-installations.ts`
- [ ] Add `packages/db/src/repositories/github-installation-repositories.ts`
- [ ] Add `packages/db/src/repositories/github-webhook-deliveries.ts`
- [ ] Add repository tests for grants and installation repo listing

## Source integration

- [ ] Add package code under `packages/source-integrations/` for GitHub App auth
- [ ] Add installation token minting helper
- [ ] Add install repo sync helper
- [ ] Add ref-resolution helper
- [ ] Add webhook signature verification helper

## API wiring

- [ ] Extend `apps/api/src/env.ts` with GitHub App env vars
- [ ] Extend `apps/api/src/lib/types.ts` with GitHub services and repos
- [ ] Extend `apps/api/src/lib/create-app.ts` context wiring
- [ ] Extend `apps/api/src/app.ts` app assembly and route mounting

## GitHub API routes

- [ ] Add `apps/api/src/routes/github/github.index.ts`
- [ ] Add `apps/api/src/routes/github/github.routes.ts`
- [ ] Add `apps/api/src/routes/github/github.schemas.ts`
- [ ] Add `apps/api/src/routes/github/github.handlers.ts`
- [ ] Implement `GET /v1/github/installations`
- [ ] Implement `GET /v1/github/installations/:installationId/repositories`
- [ ] Implement `POST /v1/github/webhooks`
- [ ] Optionally add grant-management endpoints for manual administration

## Sandbox API

- [x] Add GitHub-backed source schema to sandbox create request
- [x] Resolve `installationRepositoryId` in sandbox create handler
- [x] Enforce installation grant checks in sandbox create handler
- [x] Enforce installation active-status checks in sandbox create handler
- [x] Populate `sandbox.repositoryId`
- [x] Populate `sandboxAttempt.repositoryId`
- [x] Keep raw installation token out of snapshots and job payloads
- [x] Add API tests for GitHub-backed sandbox create success and failure cases

## Worker and runtime

- [x] Update worker job handling for GitHub-backed source metadata
- [x] Introduce an ephemeral token auth descriptor for source clone auth
- [x] Update runtime adapter contract to support token auth
- [x] Update Docker runtime adapter to inject token auth safely
- [x] Update buildkit builder clone bootstrapping to consume token auth safely
- [x] Add worker and runtime tests for token-based clone auth

## Web

- [x] Add grant-aware GitHub installation picker in sandbox create flow
- [x] Add repo picker for selected installation
- [x] Add ref input or ref picker for GitHub source
- [x] Submit GitHub-backed source shape from web to API
- [x] Preserve generic raw-URL sandbox creation path

## Release readiness checks

- [ ] Confirm private repo launch works end to end
- [ ] Confirm generic git flow still works end to end
- [ ] Confirm logs and snapshots contain no raw GitHub tokens
- [ ] Confirm suspended installs block new launches
- [ ] Confirm revoked grants block new launches

## Suggested First Build Slice

If implementation is split into small merges, the best first slice is:

1. schema + migrations + DB repositories
2. source-integrations GitHub auth client
3. GitHub list endpoints for installations and repos
4. sandbox create request and handler support for GitHub repo selection
5. worker and runtime just-in-time token auth
6. web repo picker

That sequence keeps the most important private-repo sandbox path deliverable without dragging issue
workflows into the same milestone.

## Local-First Onboarding Checklist

Goal:

- support GitHub App onboarding and repo sync without requiring a public webhook URL
- let Sealant seed installation state directly from the GitHub API
- treat webhook delivery as optional freshness automation rather than required control-plane state

### Backend import and sync

- [x] Add a GitHub App installation fetch helper in `packages/source-integrations/src/github.ts`
- [x] Normalize remote installation payloads into the same DB shape used by webhook ingestion
- [x] Add `POST /v1/github/installations/import` in `apps/api/src/routes/github/`
- [x] Accept `externalInstallationId` and caller `userId` for the import request
- [x] Fetch installation metadata live from GitHub using app auth
- [x] Upsert `github_app_installations` without requiring a webhook delivery first
- [x] Auto-grant the importing user access to the imported installation
- [x] Trigger repository sync immediately after import
- [x] Return imported installation metadata plus synced repository count

### Manual and pull sync behavior

- [x] Make `POST /v1/github/installations/:installationId/sync` grant-aware
- [x] Reject sync for users without an active installation grant
- [x] Reject sync for suspended or deleted installations
- [x] Keep repo sync pull-based through GitHub API listing
- [x] Keep repo listing API backed by the synced installation-repository cache

### Optional webhook behavior

- [x] Keep `POST /v1/github/webhooks` available when `GITHUB_APP_WEBHOOK_SECRET` is configured
- [x] Reuse shared installation-upsert logic between webhook ingestion and manual import
- [x] Ensure import and sync continue to work when webhook config is absent
- [x] Treat webhooks as freshness updates, not the only installation discovery path

### Web product path

- [x] Add GitHub client methods in `apps/web/src/lib/api/core-api-client.ts` for import, list, repo
      list, and sync
- [x] Add a `github` tRPC router in `apps/web/src/lib/trpc/router.ts` that injects session user id
- [x] Add an authenticated setup route that can consume GitHub `installation_id` callback params
- [x] Add a manual installation import form for local development fallback
- [x] Add a GitHub installation picker and repo picker to
      `apps/web/src/routes/_authenticated/sandboxes/new.tsx`
- [x] Add a manual refresh action for repo sync in the GitHub picker flow

### Verification

- [ ] Add source-integration tests for installation fetch parsing
- [x] Add API tests for installation import success and failure cases
- [x] Add API tests for grant-aware sync authorization
- [ ] Add API tests that import works without webhook configuration
- [x] Run `pnpm format:fix`
- [x] Run `pnpm --filter @sealant/api test`
- [x] Run `pnpm typecheck`
