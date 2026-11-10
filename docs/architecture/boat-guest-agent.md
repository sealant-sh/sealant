# Boat guest agent

On Boat the VM is the workspace. The image a Boat workspace boots from carries the same guest agent
the Lambda MicroVM image carries (`packages/workspaces/microvm-image/agent.mjs`), in its Boat host
mode (`SEALANT_AGENT_HOST=boat`, `boat-host.mjs`), run as a root systemd service
(`sealant-agent.service`) by a checksum-pinned upstream Node at `/opt/sealant/node`. sealantd runs
as PID 1 of its own PID namespace under the agent. There is no mapped root, no `systemd-nspawn` box,
no Python guest and no relay: Core speaks to one process in the VM, over the hosted HTTPS proxy,
with one bearer.

The typed contract is `packages/workspaces/src/runtime/boat/agent-contract.ts`; the routes the
Lambda runtime shares keep their shapes from `src/runtime/microvm/agent-contract.ts`.

## The image

The recipe (`src/images/boat/recipe.ts`) keeps Ubuntu 24.04 and holds the base systemd at the
version Boat restores. It installs `curl`, `xz-utils`, `ca-certificates`, `procps`, `util-linux`,
`iproute2`, `iptables` and `wireguard-tools`; the pinned Node; the agent files from `microvm-image/`
(`agent.mjs`, `docker-service.mjs`, `boat-host.mjs`, `boat-bind.mjs`) under `/opt/sealant/`;
`sealantd` and `sealantctl` from the pinned sealantd image under `/usr/local/bin`; the unit; and
`/var/lib/sealant/agent/manifest.json`. The project install (`nativeWorkspaceInstallation`) runs
directly on the VM's root as root, Nix bootstrap first for the nix family. The agent is enabled,
never started, on the build VM.

When the blueprint asks for the workspace's own Docker, the recipe runs `download-docker.sh` (the
MicroVM image's installer, x86_64 here), the person layout makes the `docker` group, and a drop-in
turns the agent's Docker service on (`SEALANT_MICROVM_DOCKER_CAPABLE=1`, a `198.18.1.1/24` bridge,
`198.19.0.0/16` address pools, the `docker` socket group, the containers' `sealant-docker.slice`
cgroup, a 10-second container stop and the `containerd-shim-runc-v2` path). Such an image answers
launch contract version 2 only.

The agent manifest digest is `boatAgentManifestDigest`: SHA-256 over the path, mode and bytes digest
of the agent files, `sealantd`, the unit and the Docker drop-in. The image writes it to
`manifest.json`, the builder reads it back and records it in the installation receipt (version 4,
`agent.manifestDigest`), allocation freezes it in the execution target, and every bind request names
it; the bind CLI refuses any other (`bind-manifest-mismatch`).

## Bind

Core runs one provider command in a VM:
`sudo -n /opt/sealant/node /opt/sealant/boat-bind.mjs '<json>'`, with the `sealant-bootstrap-v1`
request (identity, boot id, manifest digest, exchange operation, RSA-3072 public key). The CLI
generates the bearer, writes it to tmpfs (`/run/sealant/agent/arm.json`, 0600) and a public record
to the disk (`/var/lib/sealant/agent/bind.json`: identity, boot, operation, key and bearer digests),
and answers `sealant-bootstrap-reply-v1` with the bearer under RSA-OAEP-SHA256. The same exchange
again on the same boot re-encrypts the same bearer; another operation or key refuses
(`bind-exchange-conflict`); a stale boot id refuses (`bind-stale-boot`); a new boot binds afresh for
the identity the disk was first bound to, and a disk parked on its last boot once more as a new
instance of the same deployment (the parking resume). A refusal is one reason code on stderr.

The agent arms itself lazily from the tmpfs bearer: it is the launch secret and the control token,
so `GET /sealant/health` answers it (503, not booted) before any launch, and Core proves the bearer
that way before sealing it.

## Routes

All over the hosted proxy on port 8080, all authenticated by the bearer:

- `POST /sealant/launch`: the MicroVM launch body (`version` 1, or 2 with
  `services.docker: "required"` on a Docker image; `runId`, `controlToken` = the bearer,
  `flushTimeoutMs`, `bootEnv`, `secretEnvJson`). The agent writes the durable launch record
  (`launch.json`: boot id, run id) before `sealantd boot`. A second push on the same boot, from this
  agent process or a restarted one, is `409 already booted`: Core adopts it. `409 {reason: parked}`
  once the disk was parked.
- `GET /sealant/health`: `booted`, `controlSocket`, `daemonExit`, and `services.docker` on a Docker
  image.
- `GET /sealant/control`: the WebSocket relay to sealantd's control socket;
  `503 {error: control-unavailable}` until the socket accepts.
- `POST /sealant/network`: today's `sealant-guest-network-v1` body. The agent brings up `sealant-wg`
  in the VM's own namespace with the private key on `wg`'s stdin only, routes the subnet and the
  gateway, points `/etc/resolv.conf` at the gateway, records the public intent (`network.json`), and
  replays the same config without a change; a different config on the boot is
  `network-binding-conflict`. On a Docker image it fills `DOCKER-USER` once dockerd is up.
- `GET /sealant/network`: `configured`, `handshake` (`wg show latest-handshakes`), `dns` (an
  unpredictable question to the gateway's resolver over UDP and TCP) and `docker_policy` (`absent`
  without Docker; `pending`, `applied` or `failed` for the containers' `DOCKER-USER` policy). Core's
  readiness requires `applied` on a Docker image and `absent` otherwise.
- `POST /sealant/recover`: `{version: 1, runId, secretEnvJson}` with the capture token. Answers from
  the records: `running`, `restarted` (`sealantd boot --recovery` on the VM's own disk),
  `nothing-to-save` with its basis (`daemon`: the recovery boot exited 76; `no-launch`: bound this
  boot and never launched), or a `409` refusal (`recover-new-boot`, `recover-binding-conflict`,
  `recover-state-unknown`, `parked`). An earlier boot's bearer after a reboot is `recover-new-boot`,
  never a 401. `503 {reason: docker-stop-unverified}` when Docker could not be proved stopped:
  nothing was started, and Core retries.
- `POST /sealant/park`: `{format: sealant-agent-park-v1, operationId}`. Kills the daemon's
  namespace, stops Docker, `sync`, writes `/var/lib/sealant/agent/park-<operationId>.json` (0600)
  and answers its path, SHA-256 and size. The same operation again is the same receipt; another
  operation, a launch or a recovery after a park is `409 {reason: parked}`. When Docker could not be
  proved stopped the agent writes no receipt and answers `503 {reason: docker-stop-unverified}`;
  Core maps it as retryable, never as closed, and the same park is retried.

## Verification

`src/runtime/boat/agent-boat.test.ts` runs the real agent and bind CLI on a fake VM against the
contract. `src/runtime/boat/agent-transport.test.ts` runs Core's real execution owner and transport
(`execution.ts`) against that same real agent: bind, health proof, network, launch and adoption of a
lost reply, readiness, every recovery answer, park, and the control relay's typed refusal.
`src/runtime/boat/execution.test.ts` pins how each agent status is classified. These are local
proofs; they do not replace a live Boat session.
