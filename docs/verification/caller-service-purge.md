# Caller-owned service purge verification

Verified on 2026-11-05 on `feat/org-service-purge`, based on `origin/main` at `1a0bf727`. The design
is recorded in
[the caller-owned services ADR](../adr/0001-caller-owned-scope-instances.md#explicit-purge-2026-11-05).
No database migration or dependency change is required. Tests use synthetic credentials, a fresh
PostgreSQL 17 database and digest-pinned Docker images. No real account sign-in or Mend box access
is involved.

## Evidence

Logs are in `/tmp/coresvc-purge.X6Irry/`:

- `resource-regression.log`: 111 resource, API, admission, reach and contract tests passed,
  including the live Docker SDK/API/Postgres lifecycle and purge test, with no skipped tests.
- `kubernetes-final.log`: four Kubernetes protocol tests passed using the real Kubernetes client
  against an isolated local HTTP fixture. These include the final orphaned-PV retry case.
- `sdk-tests.log`: 287 SDK tests passed; five existing gated tests skipped.
- `typecheck-final.log` and `lint-final.log`: forced checks across all 20 packages, no cache hits.
- `format-final.log`: `pnpm format:fix`.

The Docker test uses a client container on the caller network, never host-to-service reach. It
writes a synthetic token into the service data volume and confirms it exists in a stopped-volume
backup. Archive retains that volume; purge deletes it and an abandoned read-only backup helper.
Assertions cover refusal while running, including a stopped row whose Docker workload is still
running, shared lifecycle-lock exclusion, stopped and archived purge, sealed-env/revision removal,
row and provider-resource absence, retained storage after a partial failure, and zero budgets after
successful cleanup. A new instance can reuse the key, but an old-id purge cannot delete it.

The API/SDK database tests cover both organization and installation scopes. A real PostgreSQL DELETE
trigger injects a failure after provider cleanup. Budget release rolls back with row deletion,
sealed env remains cleared, and a retry finishes without restarting the archived record.
Project-owned purge is refused and its existing instance remains.

Kubernetes protocol tests exercise StatefulSet, Pod, PVC, Secret, Service and NetworkPolicy
deletion, waiting for Delete-policy PV reclaim, refusal of live pods/controllers or Retain-policy
PVs, exact namespace/instance isolation, missing-resource idempotence, and retry after a
provider 403. They also find Retain storage by its claim ref after its PVC is gone. These are
protocol/contract tests, not live cluster acceptance; SLNT-544 owns live Kubernetes validation.

sealant stores no caller-volume backup files. Backups are tar streams; purge removes abandoned
helpers. Copies downloaded by Mend, external snapshots, database/WAL backups and physical media
sanitization are outside this operation. Kubernetes needs cluster-scoped read/list access to PVs; it
performs no cluster-scoped writes and refuses Retain reclaim policy.

## Independent reproduction

Use Docker bridge networking with NET_ADMIN support, Node 24 or newer, pnpm, and an unused local
PostgreSQL database. The fixture uses an in-memory Postgres data mount and removes its exact owned
Docker names. Set a different free local port if necessary.

```sh
pnpm install --frozen-lockfile
docker run -d --name coresvc-purge-verify-postgres \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=coresvc-test -e POSTGRES_DB=coresvc_test \
  -p 127.0.0.1:15439:5432 postgres:17
docker exec coresvc-purge-verify-postgres pg_isready -U postgres
# Repeat pg_isready until ready, then:
export SEALANT_TEST_DATABASE_URL=postgresql://postgres:coresvc-test@127.0.0.1:15439/coresvc_test
DATABASE_URL="$SEALANT_TEST_DATABASE_URL" pnpm db:migrate
pnpm format:fix
pnpm typecheck --force
pnpm lint --force
SEALANT_CALLER_DOCKER_E2E=1 pnpm exec vitest run \
  packages/workspaces/src/resources apps/api/src/routes/resource-domains \
  packages/api-contracts/src/core-api/resource-instances.test.ts \
  packages/api-contracts/src/core-api/resource-domains.test.ts
pnpm --filter @sealant/sdk test
docker ps -a --filter name=coresvc-purge-verify-postgres
docker rm -f coresvc-purge-verify-postgres
```

The resource run must have no skipped tests: the explicit Docker gate is required. Its live test
timeout is five minutes. All HTTP probes to the service originate from the client container. The
Kubernetes tests create their own temporary kubeconfig and protocol server; they never load a real
cluster's credentials. After verification, inspect provider objects by the instance id and confirm
the data volumes/PVCs, env Secret, endpoint objects, helpers and instance row are absent.
