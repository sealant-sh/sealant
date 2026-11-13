# Caller-owned scope instances

Accepted 2026-11-05. Mend needs one Executor integration gateway per organization, run through
Sealant's public SDK. Extend scopes rather than introduce a second service lifecycle and budget. A
scope has an immutable `ownerKind`: `project` by default, `organization`, or `instance`. Its
application key identifies the owner. These are application-owned resource domains, not user
identities. Service keys retain their existing installation-wide authority.

An organization or instance scope runs caller-only instances. Their spec names a deployment
configured caller, its service port, and one callback port on that caller. They have no worktree key
and `idleStopAfterSeconds: null`. Project instances retain workspace reach and idle stopping.
Workspace links to organization and instance scopes are refused. Reach selection also excludes
caller-only instances, including if a stale link exists.

## Public contract

```ts
const scope = await sealant.scopes.ensure({
  key: "mend:installation:organization:org-id",
  ownerKind: "organization",
  budget: { cpuMillicores: 1000, memoryBytes: 1610612736, storageBytes: 10737418240 },
});
const services = sealant.scopes.actAs(scope.id).instances;
await services.up(
  "executor",
  {
    alias: "executor",
    worktreeKey: null,
    image: "ghcr.io/usefulsoftwareco/executor-selfhost@sha256:<64 hex>",
    command: null,
    env: { DO_NOT_TRACK: "1", EXECUTOR_DISABLE_ANALYTICS: "1" },
    volumes: [{ name: "data", mountPath: "/app/data", storageBytes: 10737418240 }],
    limits: { cpuMillicores: 1000, memoryBytes: 1610612736 },
    ready: { kind: "tcp", port: 4400 },
    idleStopAfterSeconds: null,
    reach: { kind: "caller", caller: "mend", port: 4400, callbackPort: 4401 },
  },
  {
    cause: "person",
    secretEnv: {
      /* write-only secrets */
    },
  },
);
const observation = await services.get("executor");
// observation.endpoint is a stable private host and port for Mend's server.
await services.stop("executor", { kind: "person", by: "upgrade" });
const tar = await services.backup("executor", "data");
// Stream tar to the application's backup store, then up with the new pinned image.
```

Secret env is a separate write-only input. It is encrypted with sealant's credential cipher before
persistence, excluded from specs, replies, run records, diagnostic errors and command arguments.
Omission retains existing secrets; an explicit map replaces them. Changing secrets replaces the
container. Only the provider receives plaintext. Provider administrators can inspect process env, as
they can inspect the volume. Applications must keep sealant's encryption key through upgrades.

`up` is idempotent by scope and instance key. A changed spec stops and removes the old container
before starting its replacement over the same named volumes. Explicitly stopped instances stay
stopped against `cause: "use"`. Restart after failure has no workspace dependency. Observations
include when health was checked. Backup streams a read-only tar of a named volume only after the
provider confirms the instance stopped. Archive retains volumes. There is no implicit volume
deletion. Only the explicit caller-owned purge below deletes retained data.

The caller binding, service port, callback port and existing volume mappings are immutable. New
volumes may be added with additional storage admission. Changing a network binding needs a new
instance. Concurrent lifecycle mutations return `ResourceInstanceBusyError`; retry after the active
operation completes. Backup verifies the stopped state again under its stream's lock. A race or copy
failure fails that stream, so the caller must discard the incomplete tar.

## Provider and network boundaries

The caller is configured by the operator, never an arbitrary container or pod selector supplied by
an API request. In Mend's packaged install, Mend and sealant are processes in the same `mend`
container. That container is the caller; `localhost` in an Executor container is not Mend. Mend
binds its private sign-in listener on its private container interface. A separate sealant install
names the Mend server container instead. Bare-host callers need a container endpoint; unsupported
caller configurations fail clearly before starting a workload.

Docker uses a dedicated internal caller network per instance and a separate egress network. A
network namespace anchor gets the rules before the workload starts. Only the caller reaches the
declared service port. New connections from the instance reach only the caller's callback port among
private addresses. Public internet egress remains available for integration tools. No port is
published and workspaces never join these networks. Rules deny private, link-local, metadata and
IPv6 destinations except that explicit callback and the configured IPv4 DNS resolvers on UDP/TCP 53.
The workload holds neither NET_ADMIN nor NET_RAW. The anchor and its networks outlive workload
replacement, preserving DNS and addresses. sealant also filters the caller's callback port on every
interface, so a workspace-facing interface cannot expose that listener. Other caller ports keep
their deployment's existing behavior. Archive removes that instance's callback allow rule and keeps
the port closed to other sources. Operators must not replace the configured caller container while
an instance runs; stop its instances first, replace the caller, then start them so sealant restores
networks and guards.

Kubernetes uses a one-replica StatefulSet with retained, individually named PVCs, a ClusterIP
Service, a write-only Secret, readiness probes and a NetworkPolicy. Caller namespace and pod
selectors are deployment configuration. Ingress admits only the caller on the declared port; private
egress admits only the caller's callback port, with DNS and public internet egress. The deployment
must enforce NetworkPolicy and isolate service pods from broader allow policies. AWS MicroVM,
Firecracker and other runtimes refuse caller instances with a named unsupported runtime error. They
do not silently use Docker. Kubernetes caller ingress policy belongs to the deployment, since
sealant cannot replace policies for Mend's other listeners. Its callback Service must select the
configured caller pods and expose the configured callback port. Do not publish that listener through
an Ingress or a workspace service.

## Data flow and limits

SDK -> strict API contract -> service-key authorization -> scope owner/reach checks -> encrypted
secret storage and desired spec -> resource-domain admission -> provider convergence -> observed
state. The reconciler reads durable desired state after a process restart. A deterministic provider
workload identity and stop-before-replace maintain one writer per volume. Provider operations must
serialize per instance across API and reconciliation, including backup.

Caller instances reserve CPU, memory and declared storage through existing resource-domain
allocations. Budget checks serialize on the domain and include reserved and in-use allocations.
Lowering a budget never stops running work. Confirmed stop releases compute; retained and archived
volumes remain charged. Spec changes reserve any increase before stopping the current workload.
Docker storage bytes are admission reservations, consistent with domain budgets, not filesystem
quotas. Memory and CPU are provider limits. Undeclared image volumes are refused for caller
instances rather than silently creating unbudgeted storage.

Same-size replacements reuse compute admission. A larger replacement needs headroom for the full new
allocation while the old allocation remains charged, then releases the old allocation after
successful start. Stop first when that headroom is unavailable. Smaller replacements retain the
conservative old charge until a confirmed stop. Failed starts retain reservations, and archive
retains the declared storage charge. This avoids undercounting after ambiguous provider failures.

The existing Docker workspace-instance path remains separate from caller reach. It is unsuitable for
Mend because a workspace network would expose the gateway and tie its lifetime to sessions.

## Configured DNS egress, 2026-11-05

A Docker host commonly uses a private LAN/VPC resolver. Allowing loopback to Docker's embedded
`127.0.0.11` is insufficient: its forwarded queries can traverse the instance's OUTPUT guard and hit
the private-address rejection. A real private-resolver fixture reproduces this with
`registry.npmjs.org` before any production change.

Keep the SDK/API and operator caller configuration unchanged. On each provider convergence, read the
anchor's Docker-generated `/etc/resolv.conf` before installing its guard. With embedded DNS, parse
Docker's `ExtServers` metadata, including `host(address)` entries; otherwise parse the file's
nameservers. Accept only validated IP literals, deduplicate them, and admit IPv4 UDP/TCP destination
port 53 to those exact addresses before private-address rejection. IPv6 stays denied. An
unavailable, malformed or IPv6-only resolver configuration fails startup closed. Do not fall back to
sealant's own resolver file, which can describe a different container from the Docker host, and do
not add public fallback resolvers or a blanket private port-53 exemption. Existing anchors get the
current rules on their next convergence. This remains inside the existing Docker caller adapter; a
new configuration service or public DNS option would add unnecessary caller burden.

Bind the generated resolver file read-only into the workload, retaining Docker's embedded DNS and
search configuration while preventing it from rewriting the next guard's allowlist metadata.
Convergence replaces an older workload lacking that mount, keeping its retained volumes.

Kubernetes already admits both DNS transports only to pods labelled `k8s-app=kube-dns` in
`kube-system`, covering the standard kube-dns/CoreDNS deployment. Preserve that rule and add
explicit contract coverage of its destination and ports. Custom DNS labels or NodeLocal DNS need
deployment-specific policy and remain outside this contract. Project/workspace egress is unchanged.

Verify using a real Docker caller workload, an embedded resolver forwarding to one configured
private resolver container, and a second unconfigured private resolver. Both embedded and direct
configured UDP/TCP queries must resolve a public name. DNS to the other resolver and non-DNS TCP/UDP
to private listeners must fail. Kubernetes coverage checks the emitted NetworkPolicy; live CNI
acceptance remains SLNT-544.

## Explicit purge, 2026-11-05

Mend must remove an organization's Executor OAuth tokens, including those in its retained data
volume. Add `instances.purge(key, { expectedInstanceId: instance.id })`, backed by
`POST /v1/resource-domains/:resourceDomainId/instances/:key/purge`. The result is
`{ kind: "purged" | "already-purged" }`. This operation applies only to organization and instance
scopes with caller reach. Project scope behavior stays unchanged.

The instance must already be stopped or archived. Refuse a running desired state, a provider that
still has a workload, and a different instance id before deleting data. Requiring the observed id
prevents a delayed retry from deleting a new instance that reuses the application key. An absent key
returns already-purged after scope authorization; no tombstone or old secret-bearing instance row is
retained. The key can subsequently create a new instance with a new id.

Use the same instance advisory lock as up, reconciliation and the entire backup stream. After a
fresh stopped check, atomically fence the instance as archived and clear its sealed env and secret
revision before provider deletion. A partial failure leaves that archived record and all storage
charges for an explicit retry. It cannot be restarted. Delete exact provider objects idempotently,
confirm removal, then release every recorded compute/storage allocation and delete the instance row
in one transaction. No database transaction spans provider I/O. Repeated deletion accepts absent
objects but never hides permission or provider errors.

Docker removes the workload, namespace anchor, transient guard/probe/backup containers, callback
allow rule, dedicated networks and retained named volumes. Kubernetes removes the StatefulSet,
service pod, backup pod/policy, Service, Secret, NetworkPolicy and retained PVCs, waiting for
termination/deletion before reporting success. No caller-owned volume backups are stored by sealant:
backup is a tar stream, and purge removes any abandoned helper. Copies downloaded by Mend or an
operator, external snapshots and database/WAL backups are outside this operation. Provider removal
is not a guarantee of physical media sanitization. Kubernetes storage must use Delete reclaim policy
for its underlying data to be reclaimed; a Retain-bound claim is refused rather than leaving its
volume behind. Live Kubernetes acceptance belongs to SLNT-544.
