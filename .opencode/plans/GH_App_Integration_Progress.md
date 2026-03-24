# GitHub App Integration Progress

## Status

Phase 1 is started and the first backend slice is in place.

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

Verified in this pass:

- `pnpm format:fix`
- `pnpm typecheck`
- `pnpm --filter @sealant/api test`

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

- [ ] Update worker job handling for GitHub-backed source metadata
- [ ] Introduce an ephemeral token auth descriptor for source clone auth
- [ ] Update runtime adapter contract to support token auth
- [ ] Update Docker runtime adapter to inject token auth safely
- [ ] Update buildkit executor clone bootstrapping to consume token auth safely
- [ ] Add worker and runtime tests for token-based clone auth

### Web

- [ ] Add grant-aware GitHub installation picker in sandbox create flow
- [ ] Add repo picker for selected installation
- [ ] Add ref input or ref picker for GitHub source
- [ ] Submit GitHub-backed source shape from web to API
- [ ] Preserve generic raw-URL sandbox creation path

### Additional coverage and hardening

- [ ] Add DB-level tests for grant revocation and repository cache filtering
- [ ] Add sandbox create failure tests for suspended installs and missing grants
- [ ] Add webhook processing tests
- [ ] Decide whether sync should stay as an API route or move behind a queue/job boundary later

## Notes

- The current sandbox API path uses a new top-level `sourceSelection` field for GitHub-backed
  launches while keeping the existing raw `spec` path intact.
- The GitHub-backed sandbox path currently rewrites the workspace source to a GitHub clone URL plus
  an installation-repository auth ref sentinel. That gives us durable repository linkage now without
  storing tokens.
- Actual just-in-time installation token resolution inside worker/runtime is still pending, so the
  end-to-end private clone path is not complete yet.
- API-side access control still uses explicit `ownerUserId` request values because the broader API
  auth model has not been converted to session-backed auth yet.

## Recommended Next Slice

Implement the worker/runtime clone-auth path next:

1. parse the GitHub installation repository auth ref in worker/runtime
2. mint a short-lived installation token right before launch
3. extend runtime launch input to support HTTP token clone auth
4. update container bootstrap clone logic to use HTTPS token auth without leaking secrets
