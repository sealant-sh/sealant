---
title: Kubernetes
description:
  Run Sealant's control plane and workspaces on Kubernetes — install, upgrade, roll back,
  troubleshoot.
---

Kubernetes support is additive: the Docker self-host install stays the default and nothing here is
needed for it. On Kubernetes, workspaces are Pods that mount subdirectories of an RWX claim and are
controlled over mutual-TLS WebSocket; images build in rootless BuildKit Jobs; the worker needs no
Docker socket. Design and decision log: `docs/kubernetes-support-design.md` in the repository.

## What you need

- A cluster with an **RWX, POSIX-semantics StorageClass** (Longhorn, CephFS, NFS, EFS, …). Sealant
  names no driver; the contract is "ReadWriteMany + POSIX rename/unlink/fsync/O_EXCL".
- **cert-manager** (the chart bootstraps an internal CA from it).
- A namespace for workspaces with Pod Security `baseline` at most (the images run as root), and
  `privileged` wherever the BuildKit Jobs run — rootless BuildKit needs `Unconfined`
  seccomp/AppArmor, which `baseline` forbids. One namespace for both must be `privileged`;
  `restricted` is not claimed anywhere.
- Kubernetes ≥ 1.30 for the `appArmorProfile` field on the BuildKit Job (older clusters take the
  annotation the chart also sets).
- **Unprivileged user namespaces enabled on build nodes** (`user.max_user_namespaces > 0`) —
  rootless BuildKit creates one per build, and hardened distributions ship it disabled (Talos
  defaults to `0`; the failure reads
  `rootlesskit … fork/exec /proc/self/exe: no space left on device`, which is the kernel's userns
  quota, not disk). On Talos: `machine.sysctls: { user.max_user_namespaces: "15000" }`. Workspace
  nodes need the same once Docker is enabled (next bullet).
- **For workspace-scoped Docker** (`workspaces.docker.enabled`, off by default): Docker-enabled
  workspace Pods run in a user namespace (`hostUsers: false`), so the cluster needs Kubernetes ≥
  1.33 (user namespaces on by default), containerd ≥ 2.0 or CRI-O ≥ 1.25, kernel ≥ 6.3, and an
  idmap-capable filesystem behind every claim in `workspaces.volumeMappings` — ext4, xfs, btrfs, or
  CephFS on kernel ≥ 6.7. NFS does not support idmapped mounts, so an NFS-backed store cannot host
  Docker-enabled workspaces (workspaces without Docker are unaffected).
- Nodes that trust the in-cluster registry as an insecure (plain-HTTP) registry, or an external TLS
  registry configured through `registry.external`.

## Install

```sh
kubectl create namespace sealant
kubectl -n sealant create secret generic sealant-secrets \
  --from-literal=SEALANT_DB_PASSWORD="$(openssl rand -hex 32)" \
  --from-literal=SEALANT_RABBITMQ_PASSWORD="$(openssl rand -hex 32)" \
  --from-literal=WORKSPACE_SSH_GATEWAY_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=SEALANT_CREDENTIALS_KEY="$(openssl rand -base64 32)"
# The RWX claim Mend's store lives on (created by the Mend chart, or by you):
kubectl -n sealant get pvc mend-store
helm install sealant deploy/helm/sealant -n sealant \
  --set workspaces.volumeMappings[0].logicalRoot=/var/lib/mend/store \
  --set workspaces.volumeMappings[0].claimName=mend-store
```

The chart creates: Postgres and RabbitMQ (or points at yours), the zot registry, a migration Job
(pre-install/pre-upgrade hook), the API, one worker, the SSH gateway, the web app, the workspace
ServiceAccounts and the narrow worker Role, a self-signed → internal CA issuer chain with a
`clientAuth`-only certificate for the control plane, NetworkPolicies and PodDisruptionBudgets. **No
Ingress and no public Service is created.** Reach the API with a port-forward or add your own
Ingress; set `sshGateway.service.type=LoadBalancer` to expose SSH.

Every `SEALANT_K8S_*` knob the worker reads is in the
[environment variables reference](/docs/reference/environment-variables#kubernetes-runtime-worker).

## How a workspace runs

| Concern          | Docker self-host                                                         | Kubernetes                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Mount source     | host path → `docker run -v`                                              | proper descendant of a mapped logical root → PVC `subPath`                                                                            |
| Git common dir   | path-identical bind mount                                                | second `subPath` of the same claim at the same absolute path                                                                          |
| Control channel  | Unix socket (+ docker-exec bridge)                                       | `wss://<pod-service>.<ns>.svc:7443/control`, mTLS, internal CA                                                                        |
| Launch material  | host dirs bind-mounted                                                   | projected Secret (`env.json`, small dotfiles) or staging claim subPath                                                                |
| Credential files | `docker exec` stdin                                                      | control-channel `exec` stdin after health                                                                                             |
| Image build      | `docker build/save` + `load/tag/push`                                    | rootless BuildKit Job pushing to the registry                                                                                         |
| Pod security     | —                                                                        | non-privileged, caps dropped, RuntimeDefault seccomp, root user                                                                       |
| Docker service   | rootless dind on a per-workspace bridge, `DOCKER_HOST=tcp://docker:2375` | rootless dind sidecar in a user-namespaced Pod, `DOCKER_HOST=unix:///run/docker/docker.sock`; `docker` resolves to the Pod's loopback |

Readiness means the worker opened the real mTLS channel and `runtime.health` answered — not that the
Pod is `Running`.

## Upgrade

1. `helm upgrade sealant deploy/helm/sealant -n sealant -f your-values.yaml`. The migration Job runs
   as a pre-upgrade hook; the API/web/gateway roll; the worker is `Recreate` (one replica).
2. Running workspaces keep running. Their Pods were created by the old worker; the new worker adopts
   them by label on its reconciliation tick and on any redelivered launch.
3. Workspace images carry a pinned `sealantd`. A Sealant release that changes the daemon pin rotates
   the plan hash, so the next launch rebuilds the image in a BuildKit Job; existing Pods are
   untouched until they are stopped.

## Roll back

`helm rollback sealant <revision> -n sealant`. Migrations are forward-only: roll back application
versions only within a range whose migrations are compatible (the release notes say when they are
not). Workspace Pods, Services and Secrets are labelled `sealant.sh/run-id`; they survive control
plane rollbacks and are reconciled by whichever worker comes back.

## Troubleshooting

| Symptom                                                                    | Where to look                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch fails: `mount source '…' is not under any configured logical root`  | `workspaces.volumeMappings` must contain the root Mend uses (`MEND_STORE_ROOT`); the API's `SEALANT_MOUNT_ALLOWED_STORE_ROOTS` is derived from the same list.                                                                                                         |
| Launch fails: `Pod … was not Running within …: ErrImagePull`               | Nodes cannot pull from the registry. For the in-cluster zot, configure containerd to allow the insecure registry `sealant-registry.<ns>.svc:5000`.                                                                                                                    |
| Launch fails: `did not answer over wss://…`                                | `kubectl -n <ws-ns> logs ws-<id>` — `sealantd boot` prints why the WSS frontend did not start (missing TLS Secret → cert-manager issuer not ready; wrong CA → the control client certificate was issued by a different issuer).                                       |
| `needs client TLS material … not configured`                               | The worker/API/gateway Pods do not mount `sealant-control-client-tls`; check the certificate is `Ready` and lives in the namespace the control plane runs in.                                                                                                         |
| Build Job fails with `--- buildkit log tail ---`                           | The tail is in the error; the Job stays for `SEALANT_K8S_BUILD_TTL_SECONDS` (`kubectl -n <ns> logs job/build-…`). Rootless BuildKit needs `Unconfined` seccomp/AppArmor — a stricter Pod Security level on the build namespace blocks it.                             |
| Orphaned `ws-…` Pods after a worker crash                                  | The worker's reconciliation tick deletes Pods whose runtime instance is stopped or missing. `kubectl -n <ws-ns> get pods -l app.kubernetes.io/managed-by=sealant` shows what it manages.                                                                              |
| Workspace cannot reach the internet / Mend                                 | NetworkPolicies: `networkPolicies.workspaceEgressCidrs` and `workspaceEgressAllow` in the values.                                                                                                                                                                     |
| Docker-enabled Pod stays Pending, or `container 'docker' CrashLoopBackOff` | `kubectl -n <ws-ns> logs ws-<id> -c docker`. `newuidmap … Operation not permitted` or a rejected `hostUsers` field means the node runtime lacks user namespaces (containerd < 2.0); a mount error on the store claim means its filesystem is not idmap-capable (NFS). |
| `docker run` inside the workspace: `pull access denied` / timeouts         | Nested containers egress through the workspace Pod, so the same `workspaceEgressCidrs` apply; a private-range registry needs its own entry. Docker Hub's anonymous pull limit counts per node egress IP, shared by every workspace.                                   |

## Security model, stated plainly

- `sealantd` accepts WSS connections only with a client certificate chaining to the internal CA
  **and** carrying the `clientAuth` EKU. Workspace server certificates are `serverAuth` only, so a
  workspace that reads its own TLS Secret cannot authenticate as the control plane.
- Workspace Pods mount no ServiceAccount token and the egress policy excludes private ranges and the
  cloud metadata address; the Kubernetes API is unreachable from a workspace by both policy and
  credentials.
- Secrets never appear in Pod specs, labels, annotations or arguments. Boot material is a projected
  Secret deleted after the daemon is healthy; credential files stream over the authenticated
  channel's stdin.
- NetworkPolicies supplement mTLS and Mend's session tokens; they are a reachability control, not
  authentication, and depend on your CNI enforcing them.
- With `workspaces.docker.enabled`, a Docker-enabled workspace Pod is user-namespaced and carries
  one `privileged` sidecar: the rootless Docker daemon. Privileged there means privileged over the
  Pod's own namespace — root inside is an unprivileged uid on the node, and the node's devices are
  present but unopenable. The sidecar runs without seccomp (privileged implies it); the workspace
  container keeps its non-privileged, caps-dropped, `RuntimeDefault` posture. The host container
  runtime socket is never mounted anywhere.

## Limits in this release

- Workspace-scoped Docker needs `workspaces.docker.enabled` and the user-namespace prerequisites
  above. Inside it, nested `--memory` / `--cpus` limits are ignored (the rootless daemon runs
  without cgroup delegation; the Pod's limits still bound everything), the image graph is a
  per-workspace emptyDir capped by `workspaces.docker.graphSize` that pulls cold every workspace,
  and images whose files are owned by uids above ~64500 fail to extract (the Pod owns 65536 ids).
- One worker replica. Launches and stops are idempotent per run id, but concurrent workers have not
  been exercised.
- Pod recovery resumes from durable state (the worktree on the claim, checkpoints, harvested harness
  state). A process that was in memory when a node died is gone; the adapter recreates the Pod and
  remounts the same worktree, nothing more.
- The E2E suite (`deploy/e2e/kind`) proves the linked-worktree shape across two nodes on a generic
  NFS-backed RWX class; it does not exercise vendor CSI drivers.
