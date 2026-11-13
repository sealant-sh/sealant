# Boat guest agent

On Boat the VM is the workspace. The image a Boat workspace boots from carries the same guest agent
the Lambda MicroVM image carries (`packages/workspaces/microvm-image/agent.mjs`), in its Boat host
mode (`SEALANT_AGENT_HOST=boat`, `boat-host.mjs`), run as a root systemd service
(`sealant-agent.service`) by a checksum-pinned upstream Node at `/opt/sealant/node`. sealantd runs
as PID 1 of its own PID namespace under the agent, in a transient scope of its own
(`systemd-run --scope`, `sealant-workspace-<id>.scope` under `sealant-workspace.slice`,
`OOMPolicy=continue`), and the unit itself has `OOMPolicy=continue`: an OOM kill takes one process
of the workspace, never the agent and never the unit. There is no mapped root, no `systemd-nspawn`
box, no Python guest and no relay: Core speaks to one process in the VM, over the hosted HTTPS
proxy, with one bearer.

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

The agent starts sealantd with its own environment (the unit's FHS `PATH`,
`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`) under the boot env the launch pushes
(`nativeLaunchBootEntries`), so that `PATH` is the one of sealantd and of every session and command
it starts. On a Nix image the launch adds the image's own `PATH`, the one its project install ran
with (`nativeImagePath`):
`/usr/local/bin:/nix/var/nix/profiles/default/bin:/usr/sbin:/usr/bin:/sbin:/bin`. Without it the
profile's tools were off sealantd's `PATH`, and a session whose argv is a bare `zsh` (Mend's
interactive shell) failed to start (`zsh: No such file or directory`): Ubuntu has no zsh, the
profile does (SLNT-786). The agent itself keeps the unit's `PATH`, so its own `ip` and `wg` stay
Ubuntu's; the wrappers it starts sealantd in, which run with sealantd's environment, are named by
absolute path (`/usr/bin/systemd-run`, `/usr/bin/unshare`). A Nix container gets the same from its
image `PATH`. An Ubuntu launch names no `PATH`. `/etc/sealant/native-boot.json` still records the
image's boot entries; nothing reads it.

When the blueprint asks for the workspace's own Docker, the recipe runs `download-docker.sh` (the
MicroVM image's installer, x86_64 here), the person layout makes the `docker` group, and a drop-in
turns the agent's Docker service on (`SEALANT_MICROVM_DOCKER_CAPABLE=1`, a `198.18.1.1/24` bridge,
`198.19.0.0/16` address pools, the `docker` socket group, the containers' `sealant-docker.slice`
cgroup, a 10-second container stop and the `containerd-shim-runc-v2` path). Such an image answers
launch contract version 2 only.

The engine is the bundle's own, end to end. The agent starts the bundle's `containerd` (its socket
and state under the exec root, in the engine cgroup, CRI off) and gives dockerd `--containerd` for
it. dockerd otherwise adopts a containerd already listening on `/run/containerd`, as a base image's
own may be. Such a containerd, finding this bundle's newer `containerd-shim-runc-v2` first on PATH,
cannot read the shim's bootstrap (VM 131 run 7: `unsupported protocol: Yunix`). Readiness then runs
a real container: an image of one static file (`docker-init`) imported and run with no network and
no pull. So an engine that answers `docker info` but cannot start a container is never ready
(`container-probe-failed`; `containerd-failed` when its containerd does not start). Every start and
failure says which containerd dockerd uses (binary, socket, version), the shim's version and whether
a system containerd socket was there. The agent's journal records it, and a failed health carries it
in `services.docker.output`, which Core redacts into the launch diagnostic.

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
the identity the disk was first bound to, and for no other (`bind-identity-conflict`). A refusal is
one reason code on stderr.

The agent arms itself lazily from the tmpfs bearer: it is the launch secret and the control token,
so `GET /sealant/health` answers it (503, not booted) before any launch, and Core proves the bearer
that way before sealing it.

## Routes

All over the hosted proxy on port 8080, all authenticated by the bearer:

- `POST /sealant/launch`: the MicroVM launch body (`version` 1, or 2 with
  `services.docker: "required"` on a Docker image; `runId`, `controlToken` = the bearer,
  `flushTimeoutMs`, `bootEnv`, `secretEnvJson`). The agent writes the durable launch record
  (`launch.json`: boot id, run id) before `sealantd boot`. A second push on the same boot, from this
  agent process or a restarted one, is `409 already booted`: Core adopts it.
- `GET /sealant/health`: `booted`, `controlSocket`, `daemonExit`, and `services.docker` on a Docker
  image.
- `GET /sealant/control`: the WebSocket relay to sealantd's control socket;
  `503 {error: control-unavailable}` until the socket accepts.
- `GET /sealant/tunnel`: the resource tunnel's WebSocket carrier, the tunnel's only transport
  (`409 tunnel-not-carried` until a network is configured). Core opens it through Boat's hosted
  HTTPS with the control token, the same way it reaches every other route, and relays it to the
  gateway on its own host. Neither the VM nor the gateway's host takes an inbound connection, as
  with a MicroVM. Each binary frame is one WireGuard datagram, either way, and a message a proxy
  split into fragments is put back together as one. In the VM, `sealant-wg`'s peer is a UDP relay on
  loopback, and the relay learns the port WireGuard picked itself once its interface is up
  (`wg show … listen-port`), so no port is handed over that could be taken first. The relay takes
  datagrams from that port only and sends only to it, so nothing else on the VM can stand in for
  WireGuard. One carrier at a time: a newer one replaces the older, which is closed with 1012. The
  relay's and WireGuard's ports are kept on tmpfs, so an agent restarted on the boot binds the relay
  where the peer points, or re-points the peer. `GET /sealant/network` lists `carriers`
  (`websocket`) before Core configures anything, and says `carrier_attached` once configured. Core
  refuses an agent that does not list it (an image from before the carrier) with
  `carrier-unavailable`: there is no gateway address for a VM to dial instead.
- `POST /sealant/network`: the `sealant-guest-network-v1` body: the tunnel's keys, the resource
  subnet and `carrier: "websocket"`; an address or port to dial is refused
  (`invalid-network-config`). The agent brings up `sealant-wg` in the VM's own namespace with the
  private key in a 0600 tmpfs file that exists only for the `wg` call, routes the subnet and the
  gateway, starts the VM's resolver (a DNS forwarder on `100.127.255.254:53` that asks the gateway
  first, for resource names, then the VM's own resolvers) and points `/etc/resolv.conf` at it (the
  VM's own resolver is kept, and put back at agent start on a boot that has no tunnel: a reboot, or
  a VM restored from a saved snapshot); a resolver that cannot bind fails the step, records the
  public intent (`network.json`), and replays the same config without a change; a different config
  on the boot is `network-binding-conflict`. It programs no firewall: the workspace's containers are
  on Docker's own networks, whose bridge address and address pools the image recipe keeps clear of
  the tunnel's addresses and the resource pool.
- `GET /sealant/network`: `configured`, `handshake` (`wg show latest-handshakes`; the peer's
  `persistent-keepalive` starts it, never DNS), `dns` (an unpredictable question asked of the VM's
  resolver, which reaches the gateway's, over UDP and TCP) and, when wg can say, `transfer`
  (`{sent, received}` bytes with the gateway, `wg show transfer`). A handshake that is not verified
  carries the counters into the launch diagnostic (`tunnel: {sentBytes, receivedBytes}`): sent and
  nothing received is a gateway the carrier's datagrams do not reach. `transfer` is optional, so an
  older agent's answer still decodes. An agent built before the in-VM Docker network policy was
  removed also reports `docker_policy`; Core accepts the field and never reads it.
- `POST /sealant/recover`: `{version: 1, runId, secretEnvJson}` with the capture token. Answers from
  the records: `running`, `restarted` (`sealantd boot --recovery` on the VM's own disk),
  `nothing-to-save` with its basis (`daemon`: the recovery boot exited 76; `no-launch`: bound this
  boot and never launched), or a `409` refusal (`recover-new-boot`, `recover-binding-conflict`,
  `recover-state-unknown`). An earlier boot's bearer after a reboot is `recover-new-boot`, never
  a 401. `503 {reason: docker-stop-unverified}` when Docker could not be proved stopped, and
  `503 {reason: daemon-stop-unverified}` when a daemon scope could not be proved gone: nothing was
  started, and Core retries.

There is no park route: Core removed parking, and the agent no longer serves `POST /sealant/park`
(an image built before that still does, and nothing calls it).

## An agent restarted on the same boot

sealantd runs in a transient scope of its own (`sealant-workspace-<id>.scope`), outside the agent
unit's cgroup, so it survives the agent process. A restarted agent adopts the launch from the launch
record and the launch environment the launch left on tmpfs (`/run/sealant/agent/launch-env.json`,
0600: run, contract, boot env with the secret env file's path). It then holds no daemon child:
health reports the daemon from its scope (`booted: true`, no `daemonExit` while a scope is active,
`{code: null, signal: null}` once none is), recover answers `running` while a scope is live and
otherwise kills every scope through systemd and proves it gone (and Docker's cgroups empty) before
it starts the recovery boot from the adopted environment. A launch record without the environment
adopts nothing: the launch stays accepted, and recover is `recover-state-unknown`. After a reboot
the tmpfs is empty and nothing is adopted.

## Verification

`src/runtime/boat/agent-boat.test.ts` runs the real agent and bind CLI on a fake VM against the
contract. `src/runtime/boat/agent-transport.test.ts` runs Core's real execution owner and transport
(`execution.ts`) against that same real agent: bind, health proof, network, launch and adoption of a
lost reply, readiness, every recovery answer, and the control relay's typed refusal.
`src/runtime/boat/execution.test.ts` pins how each agent status is classified. These are local
proofs; they do not replace a live Boat session.
