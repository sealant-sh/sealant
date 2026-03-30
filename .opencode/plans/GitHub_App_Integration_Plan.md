# GitHub App Integration Plan

## Goal

Add a GitHub App integration that gives Sealant shared, grant-based repository access for two
product goals:

1. Let a user launch a sandbox from a private GitHub repository through the existing sandbox
   creation flow.
2. Optionally ingest GitHub Issues into Sealant and support an issue workflow that uses an agent in
   a sandbox to prepare a PR draft.

This plan assumes:

- GitHub installs are shared repo access, not personal user connections.
- Users are granted access to a whole GitHub App installation, not individual repositories.
- Any repository visible to that installation is eligible for sandbox launch for granted users.
- Product-facing language stays centered on `sandboxes` and `issue workflows`.

## Current State

### Existing flow

- Web sandbox form collects a repo URL and launch settings in
  `apps/web/src/routes/_authenticated/sandboxes/new.tsx`.
- Web tRPC injects the signed-in `ownerUserId` in `apps/web/src/lib/trpc/router.ts`.
- Web calls `POST /v1/sandboxes` through `apps/web/src/lib/api/core-api-client.ts`.
- API creates sandbox, sandbox attempt, snapshot, and sandbox build job in
  `apps/api/src/routes/sandboxes/sandboxes.handlers.ts`.
- Worker claims the job, normalizes the sandbox spec, builds, publishes, and launches in
  `apps/worker/src/process-sandbox-build-job.ts`.
- The actual repository clone happens at sandbox startup in
  `packages/os-integration-buildkit/src/buildkit-builder.ts`.

### Existing schema and boundaries

- `repositories`, `issues`, `pull_requests`, `issue_workflows`, and related tables already exist in
  `packages/db/src/schema/control-plane.ts`.
- Issue and PR upsert helpers already exist in `packages/db/src/repositories/issue-workflows.ts`.
- Repository upsert helpers already exist in `packages/db/src/repositories/repository-profiles.ts`.
- `packages/source-integrations` exists and is the intended home for provider-specific repo
  selection, ref resolution, and access flows.
- Current auth plumbing for repo clone is based on `authRef` and file-like secret resolution, not
  GitHub App installation tokens.

## Guiding Principles

- Keep `sandboxes` as the main product surface for repo-backed sandbox creation.
- Keep provider-specific logic in `packages/source-integrations`.
- Never persist raw GitHub installation tokens in DB snapshots, job payloads, logs, or URLs.
- Mint short-lived clone credentials as late as possible, ideally right before runtime launch.
- Link sandboxes and issue workflows to durable `repositoryId` records early.
- Preserve the existing generic/public Git URL path; add GitHub-specific flows alongside it.
- Start with installation-level grants; do not add repo-level grant complexity in the first pass.

## Recommended Architecture

## 1. Integration model

Introduce a GitHub integration model with these concepts:

- `github_app_installations`
  - one row per GitHub App installation
  - stores installation id, account or org metadata, status, permissions snapshot, suspended state,
    and sync timestamps

- `github_installation_repositories`
  - one row per repository accessible to an installation
  - maps installation to durable `repositories.id`
  - stores repo external id, owner and name, default branch, archived and private state, and access
    timestamps

- `github_installation_user_grants`
  - maps Sealant users to installations they are allowed to use
  - stores granted by, granted at, and revoked at

- `github_webhook_deliveries`
  - stores delivery id, event type, processed state, received at, and failure details for
    idempotency and replay safety

This keeps GitHub installs shared, while still letting Sealant control which users may use which
shared installs.

## 2. Source integration service

Build a GitHub source integration inside `packages/source-integrations` that owns:

- verifying webhook signatures
- exchanging app auth into installation access tokens
- listing accessible repos for an installation
- resolving repo metadata and refs
- resolving default branch
- mapping GitHub repos to Sealant `repositories`
- minting just-in-time clone credentials
- issue and PR sync helpers

This package should expose provider-agnostic interfaces where possible, with GitHub as the first
implementation.

## 3. Sandbox creation shape

Evolve sandbox creation so the API can accept a GitHub-backed source descriptor, alongside the
existing generic git URL flow.

Recommended API source shapes:

- generic git source
- GitHub repo source selected from a shared installation

For the GitHub path, the API input should include:

- provider = `github`
- repository id or installation repository id
- ref, branch, or commit
- optional clone mode metadata

The API should:

- authorize the user against the installation grant model
- resolve the GitHub repo into a durable `repositories` row
- populate `sandbox.repositoryId`
- populate `sandbox_attempt.repositoryId`
- normalize the sandbox source for the worker
- persist only repo identity and auth intent, never the installation token itself

## 4. Clone credential flow

Do not mint installation tokens at sandbox request time.

Instead:

1. API stores enough metadata for later credential resolution.
2. Worker claims the job.
3. Right before launch, worker asks the GitHub source integration for a short-lived installation
   token for the exact repo.
4. Runtime launch passes that token as an ephemeral secret.
5. The container clones the repo over HTTPS using `GIT_ASKPASS`, git credential helper, or extra
   header injection.
6. Token is discarded after launch.

Recommended first pass:

- use HTTPS and installation token auth
- avoid SSH deploy keys initially
- avoid embedding token in the clone URL
- avoid storing token in the normalized blueprint snapshot

This is important because the clone happens in the runtime entrypoint, not at API create time.

## Phase 1: Private Repo to Sandbox

### Scope

Deliver private GitHub repository support in the sandbox creation flow.

### Workstreams

#### A. Data model

Add new GitHub integration tables and repositories for:

- installations
- installation repositories
- installation user grants
- webhook deliveries

Also add fields or linkage needed to:

- associate sandboxes and sandbox attempts with `repositoryId`
- associate a GitHub-backed source with the resolved repository and installation context

#### B. GitHub App setup

Add runtime config for:

- app id
- client id and client secret if needed for install UX
- private key
- webhook secret
- app slug or app URL if needed

Add minimal initial GitHub App permissions:

- `metadata: read`
- `contents: read`

Optional later permissions for issue workflows:

- `issues: read`
- `pull_requests: read` or `write`
- `contents: write` if the workflow will push branches

#### C. Source integration package

Implement `packages/source-integrations/github` with:

- app auth
- installation token minting
- repo listing and sync
- ref resolution
- repo metadata normalization
- installation access checks

#### D. Install and grant UX

Add a user-facing integration flow in the web app:

- view connected GitHub installs available in Sealant
- view repos exposed by each install
- grant a user access to an install
- show whether an install is usable for sandbox creation

Recommended first pass:

- an admin manually grants installation access inside Sealant
- users only see installations they are granted
- users can browse any synced repo under a granted installation

#### E. Sandbox UI

Update the sandbox creation UI so users can:

- choose source type: generic git or GitHub
- browse granted GitHub installations
- browse repos under the selected installation
- select branch or ref
- optionally still paste a URL for generic or public flows

The repo picker should include search and filtering from day one because installation-level grants
can expose many repositories.

#### F. Sandbox API

Extend sandbox creation in `apps/api` to:

- validate GitHub repo access through installation grant checks
- resolve repo to installation
- upsert the resolved repository
- store `repositoryId` on sandbox and attempt rows
- store source auth intent without storing raw token
- keep idempotency behavior intact

#### G. Worker and runtime

Extend worker and runtime so that:

- a GitHub-backed sandbox causes just-in-time token minting
- token is injected as an ephemeral runtime secret
- clone uses HTTPS auth safely
- logs redact auth material

#### H. Verification

Add tests for:

- installation grant checks
- repo selection and ref resolution
- sandbox creation with GitHub repo source
- worker token minting
- runtime clone env wiring
- token redaction behavior

### Deliverable

A user can select a granted private GitHub repository in the sandbox flow and successfully launch a
sandbox that clones the repo.

## Phase 2: Repository Sync and Issue Ingestion

### Scope

Bring GitHub repository and issue data into Sealant so issue workflows can start from synchronized
records.

### Workstreams

#### A. Webhooks

Add webhook handling for:

- `installation`
- `installation_repositories`
- `repository`
- `issues`
- `pull_request`

The webhook handler should:

- verify signature
- dedupe by delivery id
- persist processing outcome
- be safe to replay

#### B. Backfill and sync jobs

Add sync paths to:

- backfill repositories for an installation
- refresh repository metadata
- backfill open issues for selected repos
- optionally backfill recent pull requests

#### C. DB upserts

Use existing repo and issue workflow repositories to:

- upsert repository records
- upsert issue records
- upsert pull request records
- keep `syncedAt` and metadata fresh

#### D. Product surfaces

Replace mock issue pages in the web app with real data:

- issues list
- ready-for-work issues
- repository issue views
- issue detail entry point for starting a workflow

### Deliverable

Sealant can ingest and display GitHub-backed repositories, issues, and PR records tied to shared
installs.

## Phase 3: Issue Workflow to PR Draft

### Scope

Allow a user to start an issue workflow from a synced issue and produce a PR draft artifact.

### Workstreams

#### A. Workflow creation

Add API routes and service logic to:

- create an issue workflow from an issue
- create an execution linked to a sandbox
- link execution records to `sandboxId` and `sandboxAttemptId`

#### B. Sandbox composition

When starting an issue workflow:

- link the workflow to `repositoryId`
- create a sandbox with issue context injected into prompt and setup
- optionally choose a repository profile or template
- keep workflow and sandbox lineage connected in DB

#### C. Agent execution

For the first pass:

- create branch in sandbox
- edit code in response to prompts
- capture diff summary
- capture validation output
- produce PR title and body draft as workflow artifact

Optional later:

- push branch
- create draft PR on GitHub
- sync resulting PR back into `pull_requests`

#### D. Reporting

Persist workflow outputs into existing issue workflow execution tables:

- events
- validation results
- diff files
- summaries
- PR links

### Deliverable

A user can launch an issue workflow from a synced issue and get a reproducible sandbox-backed PR
draft package, even if PR creation is still manual.

## API and Package Changes

### New or updated packages

- `packages/source-integrations`
  - GitHub App auth
  - install and repo sync
  - token minting
  - webhook verification
  - ref resolution

### API additions

- GitHub install callback or connect flow
- webhook endpoints
- installation and repo listing endpoints for the web app
- installation grant management endpoints
- issue listing and detail endpoints
- issue workflow create, list, and detail endpoints

### Web additions

- GitHub integration settings page
- grant-aware repo picker in sandbox creation
- issues pages backed by real API data
- issue workflow launch and reporting pages

## Security Considerations

- Do not persist raw installation tokens.
- Do not place tokens inside sandbox snapshots or sandbox specs.
- Do not put tokens in clone URLs.
- Redact auth material from worker, runtime, and API logs.
- Verify GitHub webhook signatures.
- Treat webhook delivery handling as idempotent.
- Grant checks must happen server-side, not only in the UI.
- Keep app permissions minimal for each phase.
- Separate read-only sandbox access from later write-enabled issue workflow access if possible.

Recommended permission split:

- Phase 1 sandbox repo pull: read-only install permissions
- Phase 3 PR draft creation or push: separate write-enabled permission set or explicit feature gate

## Important Open Design Decisions

1. Grant scope
   - Start with installation-level grants only.
   - Do not add per-repo grant rules in the first pass.
   - Revisit repo-level allow or deny overrides only if a real security or operations need appears.

2. Clone auth abstraction
   - Current `authRef` is too file-oriented.
   - Introduce a real source-auth descriptor that can represent:
     - ephemeral token
     - mounted secret
     - SSH key
     - future provider-specific auth modes

3. Callback and webhook ownership
   - Recommended:
     - install and connect UX in `apps/web`
     - webhook ingestion and control-plane sync in `apps/api`

4. Generic vs GitHub-first UX
   - Support both.
   - Use a GitHub picker for private GitHub repos.
   - Keep raw URL input for generic or public git sources.

5. Install lifecycle behavior
   - If an installation is suspended or removed, new sandbox launches should fail authz immediately.
   - Existing sandbox records should remain for history and auditability.
   - Reruns or new launches tied to that install should be blocked until access is restored.

## Implementation Order

1. Add DB schema for installations, installation repos, installation grants, and webhook deliveries.
2. Implement GitHub source integration package.
3. Add install sync and installation grant management APIs.
4. Add GitHub install and repo picker UI in sandbox creation.
5. Extend sandbox create API to accept GitHub-backed source selection.
6. Link sandboxes and attempts to resolved `repositoryId`.
7. Add just-in-time token minting in worker and runtime.
8. Verify private repo sandbox launch end to end.
9. Add webhook ingestion for issues and PRs.
10. Replace mock issue pages with real issue data.
11. Add issue workflow APIs and UI.
12. Add PR draft artifacts and optional GitHub PR creation.

## Initial Acceptance Criteria

### Sandbox flow

- A user with a valid installation grant can see and select a private GitHub repository.
- Sandbox creation succeeds without exposing GitHub credentials in snapshots or logs.
- The sandbox clones the private repository successfully.
- Sandbox and attempt rows link to the resolved repository.

### Issue workflow flow

- GitHub issues can be ingested and upserted into the existing issue tables.
- A user can start an issue workflow from a synced issue.
- The resulting execution is linked to sandbox lineage and stores structured reporting artifacts.

## Known Risks

- The current API has limited auth enforcement and should not rely only on the web client to enforce
  ownership.
- Installation tokens expire quickly; minting too early will cause flaky clone behavior.
- Repository rename, archive, transfer, or removal events must update cached install repo lists
  safely.
- Shared install access adds grant-management complexity without a current org, team, or role model
  in Sealant.
- The current runtime clone path is optimized for file-based auth and will need refactoring for
  token-based auth.
- Installation-level grants may expose many repositories, so search, filtering, and good admin
  hygiene matter.

## Recommended First Milestone

Ship only this first:

- GitHub App install sync
- installation-level grants
- synced repo cache per installation
- grant-aware repo picker
- sandbox creation from private GitHub repos
- just-in-time clone token injection
- no issue ingestion yet

That gets the highest-value path live while keeping write permissions and issue workflow complexity
out of the first rollout.
