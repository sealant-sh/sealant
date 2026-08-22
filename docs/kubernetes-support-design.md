# Kubernetes support — architecture and decision record

Status: accepted 2026-08-22. Scope: `sealant-sh/sealantd`, `sealant-sh/sealant`, `sealant-sh/mend`.

This document is the single cross-repository design for running Sealant workspaces and Mend on
Kubernetes. It is additive: the Docker/self-host path stays the default and is not rewritten. Each
repository carries its own shorter record that points back here:

- `sealantd/docs/adr/0013-websocket-control-transport.md`
- `mend/docs/KUBERNETES.md`

## 0. Product invariant this design serves

Mend is code-co-located. The authoritative worktree lives in Mend's central store and a workspace
Pod receives a **mounted view** of that exact worktree and its linked-worktree Git metadata. There
is no clone into the Pod, no copy into an `emptyDir`, no sync-back, and review/checkpoint
correctness never depends on an eventual process. Both Mend and the workspace operate on the same
filesystem objects of one RWX POSIX PVC.

Storage contract: a generic RWX, POSIX-semantics PersistentVolumeClaim. Longhorn, CephFS, NFS, EFS
and others are operator choices; nothing in the code names a CSI driver.

## 1. Current state (inspected on `origin/main`, 2026-08-22)

| Repo     | What exists today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | What blocks Kubernetes                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sealantd | `handle_connection<S,R,W>` in `sealant-control` is generic over `AsyncRead`/`AsyncWrite`; Unix socket (0600 + `SO_PEERCRED`) and stdio are the only frontends; no TLS/WS deps in `Cargo.lock`; image is `FROM scratch`.                                                                                                                                                                                                                                                                                                               | No network transport; no authentication story other than peer uid.                                                                                                                           |
| sealant  | Zod+Promise `RuntimeAdapter` (`supports/launch/stop`); Docker adapter turns `sources.workspace`/`sources.mounts` into `docker run -v`, stages dotfiles/secret-env as host dirs, writes credential files with `docker exec`; `SealantTarget` is `docker-exec \| unix-socket`; k8s/k3s are stubs; builder shells out to `docker build/save`; registry publishes with `docker load/tag/push`; SSH gateway mirrors the docker-exec/unix targets; `process-run-exec-job.ts` and `sync-back` hardcode Docker.                               | Every downstream consumer assumes a Docker resource id, the control socket is reached through the Docker daemon, launch material is a host path, image publish needs `/var/run/docker.sock`. |
| mend     | `StoreConfig.root` = `MEND_STORE_ROOT` or `~/.config/mend/store`; linked worktrees under `<root>/<project>/worktrees/session-<id>` with an absolute `gitdir:` pointer into `<root>/<project>/repo.git/worktrees/…`; the SDK (not Mend) adds the git common dir as a path-identical RW mount; one UDS per session at `<store>/_run/sessions/<id>/mend.sock` mounted at `/run/mend`, serving helper HTTP + `CONNECT /git/transport`; the `mend` helper and `mend-git-ssh` shim are host-written scripts served through that same mount. | `runRoot()` ignores `MEND_STORE_ROOT`; a UDS cannot cross nodes; authorization is socket possession only.                                                                                    |

## 2. Decisions

### D1. Runtime-neutral mount intent; Kubernetes lowers to PVC + subPath

The logical request ("mount this store path here, read-only or not, for this purpose") is separated
from the runtime mechanism.

```ts
interface RuntimeMountIntent {
  readonly sourcePath: string; // absolute, normalized, as the blueprint already requires
  readonly mountPath: string; // container path, preserved verbatim
  readonly readOnly: boolean;
  readonly purpose:
    | "workspace"
    | "git-common"
    | "reference"
    | "session-channel"
    | "project-folder"
    | "launch-material"
    | "control-socket";
}
```

`collectMountIntents(launchInput)` (sealant, `packages/workspaces/src/runtime/mount-intent.ts`)
derives the list from the existing blueprint + launch input. It is pure and runtime-neutral.

- **Docker** keeps its current argv builders byte-for-byte. `collectMountIntents` is exercised
  against the Docker adapter's mount args in tests to prove the two agree, but the adapter does not
  consume intents on its hot path — this is the "no production behaviour change" guarantee of PR 1.
  Absolute paths continue to mean literal host paths to Docker.
- **Kubernetes** lowers intents with `lowerMountIntents(intents, volumeMappings)`:
  - `SEALANT_K8S_VOLUME_MAPPINGS` is a JSON array of `{ logicalRoot, claimName, readOnly? }`.
    Mappings are validated at config time: absolute normalized roots, no root equals or is a
    descendant of another (ambiguous overlap is rejected), unique claim names.
  - Every intent `sourcePath` is normalized with `path.posix.normalize`, must be absolute, contain
    no `.`/`..` segments, and be a **proper** descendant of exactly one root (a path equal to a root
    is refused — never mount the whole store). The remainder becomes the PVC `subPath`.
  - Symlink escape: the worker does not mount the store and cannot `realpath`; the defence is
    kubelet's own subPath resolution, which since the CVE-2017-1002101 fix resolves subPath without
    following symlinks outside the volume. The design relies on that documented guarantee and on the
    lexical checks above; it does not claim more.
  - Output is a deterministic list of `volumes` (one per claim) and `volumeMounts` (one per intent,
    `mountPath` preserved, `readOnly` preserved, `subPath` set).
- Existing SDK behaviour (the SDK discovers `gitdir:` → common dir and requests a path-identical RW
  mount) is unchanged; under Kubernetes that request simply lowers to a second subPath mount of the
  same claim at the same absolute container path, which is exactly what a linked worktree needs.

### D2. One Kubernetes implementation

`KubernetesRuntimeAdapter` is the implementation. `K8sRuntimeAdapter` and `K3sRuntimeAdapter` become
thin subclasses that only set `id` and a distribution profile (`k3s` defaults to no PriorityClass
and no topology spread since single-node is common). No second code path.

### D3. Native mTLS WebSocket transport in `sealantd`

A third frontend, `serve_wss`, is added beside `serve_unix` and `serve_stdio`:

- Disabled unless `SEALANT_CONTROL_WSS_LISTEN` (or `--wss-listen`) is set. With none of the new
  variables present `sealantd boot` and bare `sealantd` behave identically; the Unix socket is still
  created (it is the readiness signal and the in-Pod path for local tooling).
- TLS via `rustls` (`ring` backend — builds on musl, no C toolchain, works from `scratch`). Server
  cert/key from `SEALANT_CONTROL_WSS_CERT` / `SEALANT_CONTROL_WSS_KEY`; client CA from
  `SEALANT_CONTROL_WSS_CLIENT_CA`. The client verifier is `WebPkiClientVerifier` with **no**
  anonymous fallback, so an unauthenticated client is rejected at the TLS handshake before any byte
  reaches the HTTP upgrade, let alone the control dispatcher.
- The workspace's own server certificate is issued with `server auth` EKU only; control-plane client
  certificates carry `client auth`. WebPKI rejects a server-only cert used as a client cert, so a
  workspace that can read its own TLS Secret cannot impersonate the control plane. Optional
  `SEALANT_CONTROL_WSS_CLIENT_NAMES` further pins accepted client SANs.
- WebSocket via `tokio-tungstenite` over the TLS stream. Path must be exactly `/control`; any other
  path or a non-upgrade request gets `404`/`400` and the connection closes. Limits: handshake
  timeout, max concurrent connections (semaphore), max message size = `max_frame_bytes + 4`, no
  compression. Binary messages carry the **exact** length-prefixed Protobuf byte stream: the WS
  stream is adapted into `AsyncRead`/`AsyncWrite` (`tokio_util::io::{StreamReader, SinkWriter}`) and
  handed to the unchanged `handle_connection`. Backpressure is the existing bounded per-connection
  outbound channel plus WS sink backpressure; channel cleanup is the existing teardown path.
- Graceful shutdown reuses the `watch::Receiver<bool>`; the listener stops accepting and each
  connection's teardown runs.
- Nothing logs credentials or payloads: TLS errors log the error kind, never peer material.
- Node side: `@sealant/runtime-client` gains
  `openWebSocketDuplex({ url, ca, cert, key, servername })` returning a `Duplex` whose bytes are
  identical to the Unix-socket stream, so `SealantClient.fromStream` is unchanged. This uses the
  `ws` package (new dependency, Kubernetes consumers only).

Alternative considered: a token bearer on the WS upgrade. Rejected as primary because it requires a
per-workspace secret the worker must distribute and rotate; mTLS with cert-manager gives identity to
both sides with a deterministic DNS name and no secret in env. It remains an acceptable alternative
if an operator cannot run cert-manager; it is documented but not implemented.

### D4. Direct authenticated Mend session channel, no sidecar

Mend keeps the per-session UDS for Docker and adds a cluster-internal network listener
(`MEND_SESSION_ENDPOINT_LISTEN`, e.g. `0.0.0.0:3106`) that serves the **same** route table and the
same `CONNECT /git/transport` byte tunnel. Every request must carry `Authorization: Bearer <token>`
and `x-mend-session-id`; the server resolves the session only after the token verifies.

- Token: 32 random bytes, base64url, minted at provision. Only `sha256(token)` is persisted
  (`session_channel_tokens`), so a Mend restart verifies deterministically.
- Scope: exactly what the socket grants — the closures for that one session. The token carries no
  user or project access; the session row is checked to be live and bound to the current
  `sealantWorkspaceId` before any verb runs.
- Lifecycle: minted per provision (cold or hot-pool), revoked (row deleted) on stop, replacement and
  drain; `stop` before `start` on relaunch already exists, so a replaced workspace's token is dead
  before the new one is minted.
- Delivery: `MEND_SESSION_TOKEN` rides Sealant's `secretEnv` channel (so the sealantd redactor knows
  it), `MEND_SESSION_ENDPOINT` and `MEND_SESSION_ID` ride plain `env`.
- Helper and shim: the scripts are still host-written into `<store>/_run/sessions/<id>/bin` and
  still mounted at `/run/mend`. Under Kubernetes that directory is a read-only subPath of the store
  claim and contains no socket (sockets never touch the RWX filesystem). Both scripts pick the
  transport at runtime: UDS if `/run/mend/mend.sock` exists, else network if `MEND_SESSION_ENDPOINT`
  is set, else a readable error. The token is never printed.
- Why no relay sidecar: the network listener reuses the identical handlers and frame pump as the UDS
  server; a sidecar would add a privileged-adjacent container, a second auth hop, and Pod lifecycle
  coupling for no reduction in code. The transport abstraction is the route table + a `listen`
  strategy, which is small.
- Known limitation, stated plainly: the in-cluster channel is HTTP over the cluster network. The
  token is the authenticator; NetworkPolicy limits who can reach the listener; optional TLS
  (`MEND_SESSION_ENDPOINT_TLS_CERT/KEY`) is supported for operators who want it.

### D5. Kubernetes object model (per workspace attempt)

Names derive from the run id: `ws-<token>` where `<token>` is the run id lowercased, non `[a-z0-9-]`
replaced, trimmed to 40 chars, plus a 6-char hash suffix for uniqueness → always DNS-1123 and stable
across redelivery.

| Object                     | Name                | Notes                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pod                        | `ws-<token>`        | `restartPolicy: Never`, `automountServiceAccountToken: false`, `/run/sealant` from `emptyDir`, store subPath mounts, launch Secret projected at `/run/sealant/launch`, TLS Secret at `/run/sealant/tls`, resources, PriorityClass, topology spread, optional `runtimeClassName`. |
| Service                    | `ws-<token>`        | ClusterIP, one port (`SEALANT_K8S_CONTROL_PORT`, default 7443). Endpoint persisted as `wss://ws-<token>.<ns>.svc:<port>/control`.                                                                                                                                                |
| Secret                     | `ws-<token>-launch` | `env.json` (secret env), credential files, small dotfiles manifest+archives. Never labels/annotations/args.                                                                                                                                                                      |
| Certificate (cert-manager) | `ws-<token>`        | DNS name `ws-<token>.<ns>.svc`, usages `server auth`, issuerRef from config, secretName `ws-<token>-tls`.                                                                                                                                                                        |

Launch: create-or-adopt each object (409 → get and compare labels), wait for Pod `Running`, then
open a real mTLS WSS connection and call `runtime.health`; only then `ready`. Credential files are
written over the authenticated control channel (`exec sh -c 'umask 077 && … base64 -d > path'` with
stdin), the same script the Docker adapter uses. Stop: delete Pod, Service, Certificate, Secrets
with `propagationPolicy: Background`; 404 → `not-found`; 403/5xx → error. Reconcile: a label
selector `app.kubernetes.io/managed-by=sealant,sealant.sh/run-id` lists everything the worker owns;
`reapExpiredWorkspaces` becomes adapter-generic.

Labels on every object: `app.kubernetes.io/managed-by=sealant`, `sealant.sh/workspace-id`,
`sealant.sh/run-id`, `sealant.sh/adapter`, `sealant.sh/principal` (opaque id, only when provided).

Launch material (D6) for dotfiles too large for a Secret uses `SEALANT_K8S_STAGING_CLAIM` (an RWX
claim) under `<runId>/dotfiles`, cleaned on ready and on failure.

Pod security: main container `privileged: false`, `allowPrivilegeEscalation: false`, drop `ALL` then
add back only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `KILL` (the images run as root
and `sealantd boot` applies dotfiles/chowns), `seccompProfile: RuntimeDefault`. This is **not**
restricted-PSS compliant (root user); the workspace namespace needs
`pod-security.kubernetes.io/enforce: baseline` (or privileged when DinD is enabled). DinD is a later
PR and the only privileged container.

### D6. Launch material abstraction

`LaunchMaterialStager` (sealant, `packages/workspaces/src/runtime/launch-material.ts`):

```ts
interface StagedLaunchMaterial { readonly secretEnvDir?: string; readonly dotfilesArchiveDir?: string; readonly cleanup(): Promise<void>; }
```

- Docker: current behaviour (host dirs under `WORKSPACE_CONTROL_SOCKET_HOST_DIR/_dotfiles` or tmp),
  unchanged.
- Kubernetes: secret env (policy-bounded to 32 KiB) and credential files → the launch Secret (limit
  1 MiB enforced by the API; we budget 768 KiB); dotfiles archives → the launch Secret when they
  fit, else the staging claim subPath; without a staging claim an oversize archive is a readable
  `launch-material-too-large` error. Retries are idempotent (same names, apply semantics).
- Credential sync-back already runs `cat` over `SealantRuntime`; with generic target derivation it
  is runtime-neutral and needs no Docker exec.

### D7. Image building without a Docker socket

`WorkspaceImageBuilder` with `plan()` and `buildAndPublish()`:

- `DockerWorkspaceImageBuilder` wraps today's `compileWorkspaceBuildSpec` + `publishOciImage`.
- `KubernetesWorkspaceImageBuilder` runs one `moby/buildkit:rootless` Job per build: context
  (Containerfile + plan JSON) in a ConfigMap, build secrets in a Secret, registry auth in a
  docker-config Secret,
  `buildctl-daemonless.sh build --frontend dockerfile.v0 --output type=image,name=<ref>,push=true`.
  Job name derives from the plan hash + tag (idempotent), labels for cleanup,
  `ttlSecondsAfterFinished` from policy, logs surfaced on failure, digest resolved by the existing
  `headManifest`. Rootless BuildKit needs `seccomp`/`AppArmor` `Unconfined` and a non-root uid;
  documented.
- Generated Containerfile output for Docker is unchanged; golden tests pin it.

### D8. Transport generalization across sealant

- `SealantTarget` gains
  `{ kind: "websocket", url, tls: { caPath, certPath, keyPath, servername? } }`.
- `sealantTargetForRuntimeInstance` handles `k8s`/`k3s` via the persisted `wss://` endpoint; Docker
  keeps unix-socket preference and docker-exec fallback.
- `process-run-exec-job.ts`, the SSH gateway, sync-back, stop and reapers use the generic
  derivation; `SealantRuntimeDockerExecLive` is removed in favour of `SealantRuntimeControlLive`.
- Kubernetes TLS client material for the worker and gateway comes from
  `SEALANT_K8S_CONTROL_CLIENT_{CERT,KEY,CA}_PATH` (mounted from a cert-manager client Certificate).

### D9. Mend deployment

- Store at `MEND_STORE_ROOT=/var/lib/mend/store` on `store.existingClaim`; `runRoot()` is fixed to
  derive from the store root; sockets are not created in Kubernetes mode
  (`MEND_DEPLOYMENT_MODE=kubernetes`).
- `/api/health` reports `storeRoot`, `deploymentMode`, `sessionChannel`.
- One worker replica; the engine owns in-memory supervision, so active-active is not claimed. The
  chart pins `worker.replicaCount: 1` and documents it.
- Pod recovery: a recreated workspace Pod sees the same worktree; the process that was in RAM is
  gone. What resumes is the durable worktree, checkpoints and harvested harness state.

### D10. Docker compatibility (release blockers)

`DEFAULT_RUNTIME_ADAPTER=docker` stays; compose files, installers, socket defaults, host mounts,
stored blueprints, SDK calls and the Docker adapter tests are unchanged. Golden tests pin the full
`docker run` argv for representative inputs. WSS and the Mend network channel are off unless
configured. Docker users pull no Kubernetes package at runtime (the client library is a normal
dependency of the worker image but never initialised unless `DEFAULT_RUNTIME_ADAPTER` or the
blueprint requests `k8s`/`k3s`).

## 3. Delivery

Stacked PRs per repository (each passes typecheck/lint/tests and is deployable on its own):

| #   | Repo           | Branch                               | Content                                                                                                                                                                                                                       |
| --- | -------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | sealant        | `k8s/01-runtime-seams`               | This document; `RuntimeMountIntent` + `collectMountIntents`; `LaunchMaterialStager` (Docker impl); `websocket` target variant + generic derivation; exec job / gateway / sync-back / reaper de-Dockered; Docker golden tests. |
| 2   | sealantd       | `k8s/01-wss-transport`               | `serve_wss`, config, ADR-0013, Node `openWebSocketDuplex`, integration tests.                                                                                                                                                 |
| 3   | sealant        | `k8s/02-lifecycle`                   | `KubernetesRuntimeAdapter`, PVC lowering, object model, readiness, stop, reconcile, RBAC, config.                                                                                                                             |
| 4   | sealant        | `k8s/03-buildkit-jobs`               | `WorkspaceImageBuilder`, BuildKit Job implementation, registry digest resolution.                                                                                                                                             |
| 5   | mend           | `k8s/01-session-channel`             | Store root fix, network session endpoint, tokens, dual-mode helper/shim, hot pool, health.                                                                                                                                    |
| 6   | sealant + mend | `k8s/04-deploy-e2e`, `k8s/02-deploy` | Helm charts, NetworkPolicies, kind-based cross-node E2E, upgrade/rollback/troubleshooting docs.                                                                                                                               |

## 4. Out of scope for the first cut

- Workspace-local DinD sidecar on Kubernetes (`tooling.services.docker.enabled` returns
  `unsupported-runtime-requirement` until its own PR).
- Active-active Mend workers.
- Read-only git common dir with a per-session overlay (tracked in `mend/docs/GIT-ACCESS.md`).
