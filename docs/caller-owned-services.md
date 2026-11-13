# Caller-owned services

Mend can run an Executor gateway for each organization through `sealant.scopes`. Use an
`organization` scope with an application key containing Mend's installation and organization IDs.
Use `instance` for services owned by the entire installation. `project` remains the default and
keeps workspace reach. See [the contract and SDK example](adr/0001-caller-owned-scope-instances.md).

## Docker deployment

Give API and worker the same `SEALANT_RESOURCE_CALLERS` configuration:

```json
[{ "kind": "docker", "name": "mend", "container": "mend", "callbackPorts": [4401] }]
```

`container` is the actual Docker container running Mend's server. In the packaged install, sealant
and Mend share this container. A service's `reach.caller` names this configured entry. It receives
`endpoint.host` and `endpoint.port` in the SDK response. Reach this endpoint from Mend's server
container, not from the Docker host. The callback URL uses `endpoint.callbackHost` and the requested
callback port. Mend must bind that listener on its container interfaces, rather than loopback only.

sealant needs the Docker socket and permission to create bridge networks, named volumes and
short-lived NET_ADMIN guard containers. The workload receives no NET_ADMIN or NET_RAW capability.
There is no published host port. sealant guards both the service's network namespace and Mend's
callback port. Workspaces cannot link to these scopes or join their caller networks. The service can
access public IPv4 integration endpoints, DNS and its one private callback port. Other private
destinations and IPv6 are denied.

Docker DNS is allowed over UDP and TCP destination port 53 only to the instance's configured IPv4
resolvers. sealant reads the anchor's Docker-generated `/etc/resolv.conf`, including `ExtServers`
for embedded DNS, so private LAN/VPC upstreams work without opening other private ports or other
private DNS servers. Docker must expose this upstream metadata; missing, malformed or IPv6-only
configuration refuses startup. sealant does not substitute its own container's resolver or public
fallbacks. The workload gets this file read-only. On the next convergence, existing workloads
without the read-only mount are replaced over their retained volumes.

sealant pins its guard/probe/backup helper by digest. `SEALANT_RESOURCE_CALLER_GUARD_IMAGE`
optionally selects an operator-maintained equivalent containing `iptables`, `ip6tables`, `nc`,
`tar`, `cat` and `sleep`. The normal resource subnet pools must have capacity for two /24 networks
per instance.

Run the worker: it restarts failed workloads from durable desired state, independently of workspace
sessions. The API performs each requested start synchronously and returns its health result. The
existing resource reconciliation interval bounds crash-restart delay. No idle timeout applies.

## Kubernetes deployment

Set `DEFAULT_RUNTIME_ADAPTER=k8s` or `k3s`, and configure both API and worker:

```json
[
  {
    "kind": "kubernetes",
    "name": "mend",
    "namespace": "mend",
    "host": "signin.mend.svc.cluster.local",
    "podLabels": { "app": "mend-api" },
    "callbackPorts": [4401]
  }
]
```

Create `SEALANT_RESOURCE_K8S_NAMESPACE`, default `sealant-services`, with a default StorageClass.
Grant sealant read/write access to StatefulSets, PVCs, Services, Secrets, Pods, pod exec and
NetworkPolicies in that namespace. Purge also requires cluster-scoped `get`/`list` on
PersistentVolumes to verify Delete reclaim policy and confirm storage reclaim, including after a
retry where the PVC is already gone. No cluster-scoped writes are required. It reads its standard
Kubernetes configuration, or the explicit `SEALANT_RESOURCE_K8S_KUBECONFIG` path. Set
`SEALANT_RESOURCE_K8S_NETWORK_POLICY=true` only with a policy-enforcing CNI. The namespace must have
no broader policy admitting workspace traffic.

sealant creates one replica, stops it before changing its template, retains individually named PVCs,
and returns a stable ClusterIP DNS endpoint. Ingress admits only the configured caller pods on the
service port. Egress permits their callback port, kube-dns and public IPv4 destinations. The
callback host must route to those caller pods on the same port. Mend's deployment must keep the
callback listener private and restrict its own ingress. DNS admits only UDP/TCP 53 to
`k8s-app=kube-dns` pods in `kube-system`, including standard CoreDNS installations. Custom DNS
labels and NodeLocal DNS need deployment-specific policy. IPv6-only clusters are unsupported.
Kubernetes is covered by contract/manifest tests; a live cluster is still required for deployment
acceptance of its CNI, storage, DNS and RBAC behavior.

AWS MicroVM, Firecracker and other runtime adapters return `ResourceRuntimeUnsupportedError`. An
external caller with no configured container or pod endpoint is refused.

## Secrets, upgrades and backup

Configure the same persistent `SEALANT_CREDENTIALS_KEY` on API and worker before passing `secretEnv`
to `instances.up`. Its values are sealed in the database. Plain `spec.env` is durable configuration
and must contain no secrets. Omitting `secretEnv` retains it; `{}` clears it. An env name cannot
occur in both maps. Provider administrators can inspect container env or Kubernetes Secrets.

`up` with the same key/spec/secrets reuses the workload. Changing the pinned image, command, env,
secrets or limits replaces it while retaining named volumes. Existing volume names, paths and
capacities, plus the caller/ports, cannot change. Declare every image VOLUME explicitly on Docker.
Memory/CPU are enforced by the provider. Docker storage declarations reserve budget rather than
enforce disk quotas; PVC requests reserve Kubernetes storage.

`get` probes current health and includes `observedAt`. `stop` waits for provider confirmation,
releases compute and retains storage. `backup(key, volume)` returns an uncompressed tar stream and
holds the instance lock until completion or cancellation. Consume or cancel the stream before
starting it again. Discard an incomplete tar if the stream fails, including a concurrent start
winning the lock. Backups need an application-owned destination. `archive` removes the workload and
networking while retaining every volume. Use explicit purge to delete retained data.

Same-size upgrades reuse budget. Increases reserve the whole replacement before stopping the old
workload; stop first if the scope lacks that headroom. Failed starts retain reservations. Archive
retains declared storage, including after a failed start. Capacity decreases keep the old charge
until stop. These choices keep existing resource-domain admission conservative after a crash.

## Remove an organization's service

`secretEnv: {}` clears only sealant's env, and archive keeps the data volume. To remove Executor's
stored OAuth tokens too, stop or archive its caller-owned instance, then purge its observed id:

```ts
const instance = await services.get("executor");
await services.stop("executor", { kind: "person", by: "remove organization Executor" });
await services.purge("executor", { expectedInstanceId: instance.id });
// { kind: "purged" }; a repeat returns { kind: "already-purged" }.
```

Purge is irreversible and applies only to organization and installation scopes. Project scopes keep
their existing lifecycle. It refuses a running instance, including one Docker still runs after a
failed stop. The expected id prevents a delayed retry from purging a replacement that uses the same
key. An absent key reports already-purged after scope authorization; no tombstone is kept. An
archived scope can still purge its instances. Reusing a purged key creates a new instance id.

After the stopped provider check, sealant fences the instance as archived and clears sealed env and
its secret revision. Docker removes its workload, anchor, helpers, callback allow rule, dedicated
networks and named volumes. Kubernetes removes its StatefulSet, pod, backup helper/policy, Service,
Secret, NetworkPolicy and retained PVCs, waiting for object deletion and underlying Delete-policy
volume reclamation. A bound Retain-policy PV refuses purge before deletion, because PVC deletion
would leave its data. Change the PV reclaim policy through the cluster operator, then retry.

Only confirmed provider deletion releases budgets and removes the instance row. If cleanup fails,
retry the same purge. It retains an archived record and conservative charges, cannot restart, and
continues from missing resources without recreating them. Backup streams and other lifecycle
operations share the purge lock; consume or cancel a backup before purging.

sealant retains no caller-volume backup files. It streams downloads directly and purge removes any
abandoned helper. Mend must delete backups it downloaded or stored elsewhere. External provider
snapshots, database/WAL backups and physical media sanitization remain operator responsibilities.
