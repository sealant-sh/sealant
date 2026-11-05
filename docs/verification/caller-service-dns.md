# Caller-owned service DNS verification

Verified on 2026-11-05 on `fix/caller-service-dns`, from `origin/main` at `4e2e3b67`, with Docker
29.9.1. Mend's Executor build failed resolving `registry.npmjs.org` when Docker forwarded embedded
DNS to a private upstream. The
[ADR](../adr/0001-caller-owned-scope-instances.md#configured-dns-egress-2026-11-05) records the fix.
No public SDK/API change, database migration or dependency change is required. Only the private
runtime package changes, so there is no public-package changeset.

## Evidence

Local logs are in `/tmp/coresvc-dns.rvp48I/`:

- `docker-red.log`: the new real Docker regression failed before the production fix. Both DNS
  transports worked before guard installation. After `DockerCallerRuntime.up`, embedded DNS returned
  no A records for `registry.npmjs.org`.
- `docker-final.log`: the real Docker regression passes. A digest-pinned resolver container on a
  private bridge forwards real public DNS requests through its own unguarded Docker resolver. The
  caller workload uses `127.0.0.11` with that private upstream in Docker's `ExtServers`. Both UDP
  and TCP lookups succeed through embedded DNS and directly to the configured upstream. The same
  transports to a second unconfigured private resolver fail. Private TCP 8080 and UDP 5353 listeners
  are reachable before the guard and denied afterward. Repeated convergence keeps DNS working. The
  workload cannot rewrite its shared resolver file. An older workload lacking the read-only mount is
  replaced while its volume data survives. Finally, the provider creates a normal anchor with no DNS
  override and both DNS transports work with the daemon's default `host(127.0.0.53)` upstream on
  this host.
- `regression-final.log`: resource and contract tests cover resolver literal parsing, private rule
  ordering, duplicate removal, malformed/injection-shaped/IPv6-only configuration refusal, and
  Kubernetes' exact kube-system/kube-dns UDP/TCP 53 exception. The Kubernetes client protocol tests
  use an isolated HTTP fixture, not a live cluster.
- `sdk-docker-final.log`: the existing SDK/API/PostgreSQL Docker lifecycle passes, including
  caller/workspace isolation, upgrades, stopped backups, purge and budgets.
- `typecheck-final.log` and `lint-final.log`: forced checks across all 20 packages, no cache hits.
- `format-final.log`: `pnpm format:fix`.

DNS queries use only the public npm registry name; no account sign-in or Mend box is involved. The
service client and DNS upstream are containers on the fixture network. No host-to-service route is
assumed. Tests list and remove their exact `coresvc-` resources. No full monorepo test pass or live
Kubernetes CNI acceptance is claimed; live Kubernetes remains SLNT-544.

## Independent reproduction

Use this PR's checkout, Node 24 or newer, pnpm, and a Docker daemon supporting bridge networking,
NET_ADMIN helpers, and generated `ExtServers` resolver metadata. Public DNS and image pulls must
work from an unguarded container. The focused proof needs no database and does not modify daemon or
host DNS configuration.

```sh
pnpm install --frozen-lockfile
pnpm --filter @sealant/workspaces test:e2e src/resources/caller-dns.e2e.ts \
  --reporter=verbose --silent=false
pnpm exec vitest run packages/workspaces/src/resources \
  packages/api-contracts/src/core-api/resource-instances.test.ts \
  packages/api-contracts/src/core-api/resource-domains.test.ts
pnpm typecheck --force
pnpm lint --force
```

Expect the live Docker test to pass, with its private resolver configuration, denied-traffic
assertions, retained-data migration and default upstream printed. To reproduce the original failure
independently, use a separate checkout of parent `4e2e3b67`, copy only
`packages/workspaces/src/resources/caller-dns.e2e.ts` into it, and run the focused command. It fails
on the first embedded DNS lookup after provider guard installation. Before the fix, that assertion
runs before the read-only mount and migration assertions.

For the broader SDK/API lifecycle, follow the disposable PostgreSQL setup in
[purge verification](caller-service-purge.md#independent-reproduction), then run:

```sh
SEALANT_CALLER_DOCKER_E2E=1 pnpm exec vitest run \
  apps/api/src/routes/resource-domains/caller-instances.docker.test.ts --reporter=verbose
```

CI runs the focused private-resolver proof explicitly in the Docker volume mounts job. The
Kubernetes NetworkPolicy already has the required rule and is unchanged: only pods labelled
`k8s-app=kube-dns` in `kube-system`, over UDP/TCP destination 53. The contract test asserts its
complete destination/port rule and the remaining private-range exclusions. Custom DNS labels or
NodeLocal DNS need deployment-specific policy.
