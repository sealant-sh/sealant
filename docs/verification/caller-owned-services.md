# Caller-owned services verification

Verified on 2026-11-05 in `feat/org-services`, based on `af96a324`, with Docker client/server
29.9.1, PostgreSQL 17, Node 26.1.0 and pnpm 11.10.0. Tests use synthetic credentials and a BusyBox
HTTP service. No real Executor account, integration sign-in or Mend box is involved.

## Evidence

The real Docker test is `apps/api/src/routes/resource-domains/caller-instances.docker.test.ts`. It
calls the public SDK, through the authenticated API and migrated Postgres repositories, against the
local Docker daemon. Mend's server is represented by a client container. The host is never used as
the service client. An outsider container shares the caller's workspace-facing network.

Assertions cover:

- Organization ownership, immutable owner/reach, and rejection of workspace links.
- A digest-pinned workload with a 1.5 GiB memory limit, retained named volumes and no published
  port.
- Caller DNS/HTTP reach, allowed callback, refusal of other caller ports from the service, and
  refusal of service DNS/IP and the private callback from the outsider.
- Repeated up preserving the container and digest; changed specs replacing it with data retained.
- Encrypted secrets absent from the spec/reply, omission retaining them, explicit clearing, and
  refusal of plain/secret env overlap.
- A concurrent lifecycle request returning busy, with normal access restored after lock release.
- Admission refusal rolling back a new instance or changed spec without replacing running work.
- Worker recovery after workload failure and anchor restart, with no idle stop a century later.
- Stopped compute release, storage retention, and a read-only tar containing the retained data.
- Failure after adding storage, refusal to recreate a missing retained volume, and archive keeping
  existing data and the full storage charge while removing its callback allow rule.

`packages/workspaces/src/resources/caller-instances.test.ts` checks strict spec/config parsing,
workspace reach exclusion, no idle stop, Docker guard ordering and Kubernetes objects. Kubernetes
objects include one replica, retained PVCs, memory limits, readiness, a stable private Service,
caller selectors and restricted egress. Kubernetes was not run against a live cluster here.

The local raw command logs are in `/tmp/coresvc-work.IFMhnf/`: `caller-tests-final.log`,
`regression-3.log`, `all-tests-final.log`, `typecheck-final.log`, `lint-final.log` and
`format-final.log`. The focused regression run passed 123 tests with the gated Docker test skipped;
the explicit Docker command below enables that test. CI runs it explicitly in the Docker job too.
The final provider-change regression is in `regression-post-pr.log`, with required checks in
`typecheck-post-pr.log` and `lint-post-pr.log`. It proves Kubernetes refuses legacy workspace
up/stop/archive/exec/link operations before changing desired state or invoking the provider.

The full local `turbo test --force` run hit two failures in the unchanged
`packages/workspaces/src/runtime/home-credentials.test.ts`. Its tracing shim did not observe the
`env` command or an inherited `p0` variable during the concurrent run on this Nix host. Its isolated
repeat passed 48 tests with one skipped, in `host-shell-baseline.log`. A run excluding that file
passed the remaining workspace tests but stopped at the unchanged SSH gateway fixture with
`Cannot parse privateKey: Malformed OpenSSH private key`, in `all-tests-excluding-host-shell.log`.
Those files and their implementations have no diff from `af96a324`. No tests are excluded in CI. The
full run with CI's Node 24 also hit the two shell-tracing failures, recorded in
`all-tests-node24.log`. The full local monorepo suite is therefore not claimed green. Separately,
the SDK suite passed 287 tests, the workspace suite excluding the shell file passed 1,308, and the
isolated shell file passed 48.

The Docker CI follow-up is recorded in `/tmp/coresvc-ci.4N2FeF/`. Hosted Docker represented absent
port bindings as `null`, while local Docker returned `{}`. The no-published-port assertion now
checks the map length instead of its JSON spelling. `ci-failure.log` captures the original failure;
`port-bindings.log` checks zero bindings and a one-binding negative control. `caller-docker.log`,
`typecheck-forced.log` and `lint-forced.log` record the follow-up verification.

## Independent reproduction

Use a checkout of this PR, Docker with bridge networking and NET_ADMIN support, pnpm, Node 24 or
newer, and an otherwise unused PostgreSQL database. These commands make only a `coresvc-` database
container; the test prints and removes its own exact container/network/volume names.

```sh
pnpm install --frozen-lockfile
docker run -d --name coresvc-verify-postgres \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=coresvc-test -e POSTGRES_DB=coresvc_test \
  -p 127.0.0.1:15439:5432 postgres:17
docker exec coresvc-verify-postgres pg_isready -U postgres
# Repeat pg_isready until ready, then:
export SEALANT_TEST_DATABASE_URL=postgresql://postgres:coresvc-test@127.0.0.1:15439/coresvc_test
DATABASE_URL="$SEALANT_TEST_DATABASE_URL" pnpm db:migrate
pnpm format:fix
pnpm typecheck
pnpm lint
pnpm exec turbo test --force
SEALANT_CALLER_DOCKER_E2E=1 pnpm exec vitest run \
  apps/api/src/routes/resource-domains/caller-instances.docker.test.ts \
  packages/workspaces/src/resources/caller-instances.test.ts
docker ps -a --filter name=coresvc-verify-postgres
docker rm -f coresvc-verify-postgres
```

Expected Docker result: two test files and six tests pass, with none skipped. The broad run skips
this gated test; its independent explicit invocation is required. The Docker test timeout is five
minutes and provider readiness timeout is fifteen seconds. Both images are pinned in source.

For Kubernetes acceptance, deploy with a policy-enforcing CNI, a default StorageClass and the RBAC
in [deployment instructions](../caller-owned-services.md). Independently probe from the configured
caller and an unrelated workspace pod, verify callback/private egress policy, upgrade and retain
data, then scale to zero and download the backup. Do not treat manifest tests as evidence that a
particular cluster enforces NetworkPolicy.
