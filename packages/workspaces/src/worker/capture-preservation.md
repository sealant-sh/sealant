# Parking ledger, activation unavailable

This layer extends `WorkspaceCaptureDrainRepo` above Core parent
`1e0a00ea7c504507da8aaad3a35a3ebaede7d3db`. It does not implement functional parking. No production
Boat executor or receiver exists at that parent. This layer performs no provider save, stop, delete,
recovery create, admission or snapshot retirement.

## Canonical ownership

The capture drain remains the sole authority. Its private relational children store immutable
incarnations, one frozen retention episode, recovery artifacts, typed operation details,
observations and consumers. Recovery artifacts remain separate from the image catalog. The current
incarnation pointer cannot yet advance. Episodes, source identity, sealed capture material,
publication consumers and artifact consumers cannot yet be discharged or released.

Writer contract `3` preserves the previous evidence and issued-removal safeguards. Contract `2`
cannot mutate enrolled custody. Generic terminal observations, drain/recovery claims and deletion
cannot complete an enrolled lineage. The ticketless deletion path also refuses an unreadable
supplied ledger. Unenrolled Docker and MicroVM behavior keeps its existing meaning.

Enrollment checks the existing Boat runtime, native publication and unreleased consumer. It is
idempotent for the same identity and rejects a replacement identity. Adoption of an already-retained
source creates the episode in the same transaction. A first retention records database time.
Historical adoption uses only the existing retained timestamp and records that provenance.

The policy accepts integer delays from `300` through `604800` seconds and defaults to `3600`. Each
episode freezes its delay, policy digest and eligibility timestamp. Repeated failures, reloads and
descendants do not reset it. `automaticParkingEnabled` defaults to true and blocks new close
intentions when false. Prepared and issued obligations remain recorded. No shared Boat runtime
configuration parser exists at this parent, so this layer adds no environment setting or file
parser. The canonical retention method accepts the policy for a future composition owner.

Claims last 120 seconds of database time, carry a monotonic fence and refuse expired owners. The
indexed due selector takes at most ten roots with `FOR UPDATE SKIP LOCKED`. An eligible close
reservation persists its immutable target details and request digest. `issue` always refuses
prepared work with `executor-unavailable`; issued work is observe-only. A claim is no dispatch
permit. There is no issuance callback or provider dependency.

Observation replay can reconcile synthetic preexisting issued work. Exact completed removal
observations must match the sandbox and recorded provider operation. Snapshot readiness alone cannot
produce `parked`. Unknown outcomes retain their occupied operation and pins across claim expiry and
restart. Removal settlement does not clear run retention or sealed recovery material.

The internal serializable view distinguishes retained, parking, parked, recovering and unknown
facts. It names known VMs and snapshots. Compute observations retain their timestamp and become
unknown after two minutes or while removal is unresolved. Allowance is a dated account aggregate
against ten included snapshots, never a per-artifact allocation. After five minutes it reports
unknown with its last observation. Public API and SDK projection await the incarnation-aware
executor owner.

## Activation contracts still required

1. Registration must enroll identities from actual allocation, guest and publication evidence. Every
   control, session, credential, drain, recovery and cleanup consumer must resolve the current
   incarnation before a child can become current. No production enrollment caller is added here.
2. The guest must prove settled FINAL, writer exclusion, durable export of volatile filesystem bytes
   and terminal closure before namespace teardown. Capsule verification must use immutable
   saved-artifact identity. Receipt ID columns currently reserve these contracts; their presence
   does not prove the guest or provider evidence. Tests seed synthetic verified history only.
3. The executor must persist frozen provider packets, enforce one-shot dispatch and reconcile exact
   positive observations. It must prove private personal scope, exclusive snapshot names and exact
   deletion completion. Missing objects and timeouts cannot discharge obligations. This layer
   supplies no constructors for verified custody or dispatch authority.
4. Recovery must create one held child with fresh control identities, prove trusted boot before
   restored startup, wait for hydration and rebind the capture lineage through the pinned daemon's
   proven protocol. Ordinary restore, setup and harness execution must remain excluded.
5. Canonical completion/discard must settle all effects and descendants before episode discharge,
   artifact retirement or native publication release. Current database guards deliberately block
   these transitions, including ordinary FINAL/discard removal for an enrolled source.
6. The composition owner must wire the shared configuration and indexed reconciler. API/SDK
   projection must consume actual canonical facts. Independent parent review and the remaining live
   proofs precede activation. SLNT-539 remains incomplete.

## Reproduction and evidence

Use a dedicated disposable Postgres 17 database. The parking suite applies all committed migrations
and fails if `SEALANT_TEST_DATABASE_URL` is absent. It never silently skips. No provider credential,
Docker daemon, runtime bundle or external service is needed. Run the import probes serially with
lint and typecheck. They create forbidden imports temporarily at the actual caller paths and remove
each owned file before exiting.

```sh
export SEALANT_TEST_DATABASE_URL='<owned isolated Postgres URL>'
pnpm --filter @sealant/workspaces exec vitest run src/worker/capture-preservation.db.test.ts
pnpm --filter @sealant/workspaces exec vitest run \
  src/worker/capture-preservation.db.test.ts \
  src/worker/capture-drain.test.ts \
  src/worker/capture-drain-ledger.db.test.ts \
  src/worker/preserve-before-deadline.test.ts \
  src/worker/recover-retained-executors.test.ts \
  src/runtime/executor-preservation.test.ts \
  src/runtime/docker-runtime-adapter.test.ts \
  src/runtime/microvm/adapter.test.ts
pnpm --filter @sealant/api exec vitest run \
  src/routes/workspaces/capture-evidence.db.test.ts \
  src/routes/workspaces/stop-discard.test.ts \
  src/routes/workspaces/retained-status.test.ts
node packages/db/src/testing/capture-preservation-imports.mjs
psql "$SEALANT_TEST_DATABASE_URL" -X -f packages/workspaces/src/worker/capture-preservation.plan.sql
pnpm typecheck
pnpm --filter @sealant/db lint
pnpm --filter @sealant/workspaces lint
pnpm format:fix
git diff --check
```

On 2026-11-05, PostgreSQL 17.10 passed 326 workspace tests across eight files, including 33 parking
cases and 16 generated retry/owner schedules. The three API files passed all 36 tests. Every test
ran with zero skips. Six lint probes rejected direct custody imports, including same-directory
relative imports. All 20 monorepo typecheck tasks passed. The affected package lints passed.

The query diagnostic adds 25,000 completed generic roots inside a transaction, analyzes the table,
runs the actual bounded due selector and single-root claim update, then rolls everything back. One
local run had 25,200 roots, including 153 custody roots and 126 scheduled roots. The selector used
`workspace_capture_drains_preservation_due`, examined 25 index candidates, filtered 15 and returned
ten. Its execution took 0.074 ms with 39 shared-buffer hits. The claim update used the primary key,
updated one row and took 0.503 ms including triggers. These are diagnostic observations on a warm
local database. The shared 32-core host had load 48.58; unrelated ffmpeg processes were observed
during this verification. This establishes the observed indexed plan and bounded result, with no
production capacity or speedup claim. The script requires due fixtures from the parking suite.

The migration's table definitions and snapshot came from the repository's Drizzle generator.
Target-specific guards and deferred relational constraints accompany that generated migration. The
suite proves rollback before adoption, retention, intention and completion commits, concurrent
claims, stale-owner rejection, immutable history, old-writer refusal, pin retention and late replay.
Synthetic receipt IDs exercise database ordering; they are not guest custody or live provider proof.
