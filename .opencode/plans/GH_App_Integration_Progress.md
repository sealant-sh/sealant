# GitHub App Integration Progress

## Status

Phase 1 now covers the full local-first private-repo sandbox path in product and runtime code:
webhook-optional installation import, grant-aware GitHub repo selection, and just-in-time
installation-token clone auth at launch.

Implemented in this pass:

- GitHub App installation, installation repository, installation grant, and webhook delivery schema
  added to `packages/db/src/schema/control-plane.ts`
- Drizzle migration added at `packages/db/drizzle/0009_github_app_integration.sql`
- DB repositories added for installations, installation repositories, and webhook deliveries
- repository lookup helpers added to `packages/db/src/repositories/repository-profiles.ts`
- initial `@sealant/source-integrations` package implementation added for GitHub App JWT creation,
  webhook verification, installation token minting, repository listing, and auth-ref helpers
- API env/config wiring added for GitHub App settings
- new GitHub API routes added under `apps/api/src/routes/github/`
- `createApiApp` now mounts `/v1/github`
- sandbox creation now accepts a GitHub-backed `sourceSelection`, verifies installation grants
  server-side, resolves the selected repository, links `repositoryId`, and rewrites the workspace
  source to a GitHub auth-ref based clone descriptor
- API tests added for granted installation listing and GitHub-backed sandbox creation
- GitHub source integration now supports fetching a single installation directly from the GitHub App
  API
- new `POST /v1/github/installations/import` route seeds installation state without requiring an
  incoming webhook first
- installation import auto-grants the importing user and immediately performs repository sync
- manual installation sync is now grant-aware and blocks inactive installations
- API tests added for webhookless installation import and grant-aware sync rejection
- web core API client and tRPC router now expose GitHub installation import, listing, repository
  listing, and manual sync flows
- authenticated GitHub setup page added for callback-driven import and manual installation-id import
- sandbox creation UI now supports a GitHub App source mode with installation picker, repo picker,
  optional ref override, and manual repo refresh
- worker now parses GitHub installation-repository auth refs and mints installation access tokens
  immediately before runtime launch
- runtime launch contract now supports ephemeral HTTP token clone auth alongside existing file-ref
  auth paths
- Docker runtime now injects GitHub HTTP token clone credentials for launch-time repo clone only
- buildkit entrypoint now uses `GIT_ASKPASS` for HTTP token clone auth and cleans up clone auth
  material after repository bootstrap
- worker, runtime adapter, and buildkit tests added for token-based private clone auth
- app shell now includes a GitHub Access entrypoint for installation management

Verified in this pass:

- `pnpm format:fix`
- `pnpm typecheck`
- `pnpm --filter @sealant/api test`
- `pnpm --filter @sealant/runtime-adapters-api test`
- `pnpm --filter @sealant/os-integration-buildkit test`
- `pnpm --filter @sealant/worker test`

## Completed Checklist Items

### Schema and DB

- [x] Add `githubAppInstallations` table to `packages/db/src/schema/control-plane.ts`
- [x] Add `githubInstallationRepositories` table to `packages/db/src/schema/control-plane.ts`
- [x] Add `githubInstallationUserGrants` table to `packages/db/src/schema/control-plane.ts`
- [x] Add `githubWebhookDeliveries` table to `packages/db/src/schema/control-plane.ts`
- [x] Export new schema types from `packages/db/src/schema/index.ts`
- [x] Export new schema types and repositories from `packages/db/src/index.ts`
- [x] Add DB migration for the new GitHub tables and indexes
- [x] Add `packages/db/src/repositories/github-installations.ts`
- [x] Add `packages/db/src/repositories/github-installation-repositories.ts`
- [x] Add `packages/db/src/repositories/github-webhook-deliveries.ts`
- [ ] Add repository tests for grants and installation repo listing

### Source integration

- [x] Add package code under `packages/source-integrations/` for GitHub App auth
- [x] Add installation token minting helper
- [x] Add install repo sync helper
- [ ] Add ref-resolution helper
- [x] Add webhook signature verification helper

### API wiring

- [x] Extend `apps/api/src/env.ts` with GitHub App env vars
- [x] Extend `apps/api/src/lib/types.ts` with GitHub services and repos
- [x] Extend `apps/api/src/lib/create-app.ts` context wiring
- [x] Extend `apps/api/src/app.ts` app assembly and route mounting

### GitHub API routes

- [x] Add `apps/api/src/routes/github/github.index.ts`
- [x] Add `apps/api/src/routes/github/github.routes.ts`
- [x] Add `apps/api/src/routes/github/github.schemas.ts`
- [x] Add `apps/api/src/routes/github/github.handlers.ts`
- [x] Implement `GET /v1/github/installations`
- [x] Implement `GET /v1/github/installations/:installationId/repositories`
- [x] Implement `POST /v1/github/webhooks`
- [ ] Optionally add grant-management endpoints for manual administration
- [x] Implement `POST /v1/github/installations/:installationId/sync`
- [x] Implement `POST /v1/github/installations/import`

### Sandbox API

- [x] Add GitHub-backed source schema to sandbox create request
- [x] Resolve `installationRepositoryId` in sandbox create handler
- [x] Enforce installation grant checks in sandbox create handler
- [x] Enforce installation active-status checks in sandbox create handler
- [x] Populate `sandbox.repositoryId`
- [x] Populate `sandboxAttempt.repositoryId`
- [x] Keep raw installation token out of snapshots and job payloads
- [x] Add API tests for GitHub-backed sandbox create success and failure cases

## Still Pending For Phase 1

### Worker and runtime

- [x] Update worker job handling for GitHub-backed source metadata
- [x] Introduce an ephemeral token auth descriptor for source clone auth
- [x] Update runtime adapter contract to support token auth
- [x] Update Docker runtime adapter to inject token auth safely
- [x] Update buildkit executor clone bootstrapping to consume token auth safely
- [x] Add worker and runtime tests for token-based clone auth

### Web

- [x] Add grant-aware GitHub installation picker in sandbox create flow
- [x] Add repo picker for selected installation
- [x] Add ref input or ref picker for GitHub source
- [x] Submit GitHub-backed source shape from web to API
- [x] Preserve generic raw-URL sandbox creation path

### Additional coverage and hardening

- [ ] Add DB-level tests for grant revocation and repository cache filtering
- [ ] Add sandbox create failure tests for suspended installs and missing grants
- [ ] Add source-integration tests for direct installation fetch parsing
- [ ] Add webhook processing tests
- [ ] Decide whether sync should stay as an API route or move behind a queue/job boundary later

### Local-first onboarding

- [x] Allow installation import without webhook delivery
- [x] Auto-grant the importing user on installation import
- [x] Sync repositories immediately after installation import
- [x] Require grants for manual installation sync
- [x] Add web callback route and manual install-import UI
- [x] Add sandbox-form GitHub installation and repository picker

## Notes

- The current sandbox API path uses a new top-level `sourceSelection` field for GitHub-backed
  launches while keeping the existing raw `spec` path intact.
- The GitHub-backed sandbox path currently rewrites the workspace source to a GitHub clone URL plus
  an installation-repository auth ref sentinel. That gives us durable repository linkage now without
  storing tokens.
- The worker now resolves the auth-ref sentinel into a short-lived GitHub installation token right
  before runtime launch, and the runtime uses ephemeral HTTP token auth for clone without storing
  the token in snapshots or job payloads.
- Installation discovery no longer has to begin with a webhook; the API can now import installation
  state directly from GitHub using the external installation id.
- Webhooks are still supported for installation freshness and repo cache updates, but they are no
  longer the only path that can seed installation state.
- API-side access control still uses explicit `ownerUserId` request values because the broader API
  auth model has not been converted to session-backed auth yet.

## Recommended Next Slice

Recommended next slice:

1. add source-integration tests for direct installation fetch parsing
2. add sandbox-create failure coverage for suspended installs and missing grants
3. verify the private GitHub sandbox flow end to end against a real GitHub App installation
4. decide whether installation sync should remain request-driven or move behind a background job
