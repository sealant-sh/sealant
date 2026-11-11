# Local Boat harness

Runs a Boat session's whole lifecycle on one machine, with real code on both sides of every boundary
except Boat's control plane. It is where Boat integration bugs get found. The live box run stays as
the acceptance check.

```sh
pnpm boat:harness                                # every scenario
pnpm boat:harness -t "happy path"                # one scenario
pnpm --filter @sealant/workspaces exec tsx boat-harness/up.ts --launch   # keep one launch up to inspect
```

A failed run keeps its evidence in `$TMPDIR/boat-harness-<run>.*/`: the worker and API logs, the
fake Boat's event log (`boat-events.json`, every provider call and guest answer through the proxy),
Core's Boat rows (`core-rows.json`) and each live twin's `sealant*` journal.

It needs Docker with privileged containers, cgroup v2, kernel WireGuard (`modprobe wireguard`; twins
share the host's kernel and cannot load modules), `openssl`, and internet access for the native
build (archive.ubuntu.com, nodejs.org, snapshot.ubuntu.com, ghcr.io). One pass takes about 25 to 40
minutes. CI runs it on pull requests that touch Boat code, nightly, and on demand
(`.github/workflows/boat-harness.yml`).

## What is real

| Part                                                              | Real or fake                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core worker                                                       | Real: the production bundle (`apps/worker` build) with its packaged Boat assets                                                                                     |
| Core API                                                          | Real, from source                                                                                                                                                   |
| Boat adapter, allocation, execution, shared stop, guest transport | Real                                                                                                                                                                |
| Native snapshot build                                             | Real `BoatSnapshotBuilder` and `install-recipe`, run in the guest twin                                                                                              |
| Guest                                                             | Real `sealant-agent.service` (the MicroVM agent in Boat host mode, `boat-bind.mjs`, the workspace's dockerd when asked) and pinned sealantd, under systemd as PID 1 |
| Resource gateway                                                  | Real `DockerBoatTunnel` and gateway image, real WireGuard                                                                                                           |
| `db` resource                                                     | Real Postgres through Core's Docker resource runtime                                                                                                                |
| Capture session channel                                           | Core's `capture-channel.fixture.ts` in a container, standing in for Mend's                                                                                          |
| Driving client                                                    | `@sealant/sdk`, the surface Mend uses                                                                                                                               |
| Boat's control plane                                              | Fake: `fake-boat.ts`                                                                                                                                                |
| Boat's hosted port proxy                                          | Fake: `fake-boat.ts`                                                                                                                                                |

## The fake Boat

`fake-boat.ts` answers Boat's API from recorded behaviour
(`docs/experiments/boat-provider-lifetime-evidence.json`, `boat-runtime.md`,
`boat-native-snapshots*.md`):

- Create answers 202 `provisioned`, then `cloning`, then `idle` once the twin's systemd is up.
- An `Idempotency-Key` replays the same VM for 24 hours on the fake's clock, then is forgotten.
- At most 20 labels, each value at most 256 bytes.
- Commands run in the twin as uid 1000 through `docker exec`: sync up to 30 s, detached above.
- Detached output keeps the last 8 MiB and reports `stdoutTruncated` / `stderrTruncated` past it.
- `DELETE` needs `X-Ascii-Confirm-Delete` and answers 202 with an operation to poll. As on real Boat
  (seen on #598's live run), the VM is withdrawn at once: `GET` answers 404, it is unlisted, and it
  takes no command or proxy traffic while the operation is still `processing`; the operation
  completes 8 s later (`deletionWithdrawnMs`; real Boat's gap is a few seconds, and the longer one
  makes the race with a second observer easy to hit). A `stuck` deletion is never withdrawn and
  never completes.
- Resume needs its body (`type`, `ttlSeconds`, `noEnv`).
- Saved snapshots are `docker commit` plus a copy of the VM's `/var/lib/sealant/docker` volume
  (commit leaves volumes out; Boat saves the whole disk), and a VM created from one starts with a
  copy of it. Names are at most 63 characters. A trial account can be set to refuse them with 403
  `trial_saved_snapshots_not_allowed`.
- `create from` a snapshot boots a new container, so a new boot ID. Before the VM reads `idle`, the
  fake applies Boat's clone rewrites (`boat-native-guest-startup.md`): it restores the provider's
  own systemd executable and rewrites `.bashrc` to different bytes of the same length (the sandbox
  ID; Boat's exact substitution is unrecorded).
- The hosted proxy for `*.on.boat.dev` answers 403 without `_port_auth` and 302 for `_token`. It
  forwards HTTP and WebSocket to the guest's port 8080, a WebSocket as raw bytes after the upgrade.
  Proxy faults apply to upgrades too, and each upgrade is recorded (`proxy-upgrade <path>`).

Core reaches it without production changes. `preload.mjs`, loaded with `node --import`, sends TLS
connections for `boat.dev` and `*.on.boat.dev` to the fake on 127.0.0.1 and keeps SNI and
certificate checks. The harness CA comes in through `NODE_EXTRA_CA_CERTS`. This covers undici and
`ws`. The preload refuses to load without its port, so a harness process cannot reach real Boat, and
its credential is a random string Boat would reject anyway.

## The guest twin

`twin/Dockerfile` is Ubuntu 24.04 with systemd `255.4-1ubuntu8.16` from the pinned snapshot, as the
recipe requires. It has a uid 1000 `user` with passwordless sudo. `twin-init` runs before systemd on
every start. It bind-mounts a fresh boot ID and creates the provider's outer `wg0`. Twins run
privileged with a private cgroup namespace, and each gets a volume at `/var/lib/sealant/docker`: the
workspace's own dockerd needs an upper directory that is not itself overlayfs, which a VM's disk is
and a container's root is not. (`vm-probe.sh`'s overlayfs check fails in a twin for the same reason;
a VM passes it.)

The resource tunnel is carried over HTTPS, the only mode Boat has (#540, #542, #543; UDP endpoints
went in #586). The worker runs with `SEALANT_BOAT_GATEWAY_RELAY_HOST=127.0.0.1`. It opens the
agent's `/sealant/tunnel` WebSocket through the hosted proxy and relays WireGuard to the gateway's
port, which is published on 127.0.0.1 only. The happy path checks that its tunnel was carried.

The networking follows what the guest enforces:

- The twins sit on a 192.0.X.0/24 bridge, because the guest's workspace namespace refuses private
  and special-purpose destinations (`DENIED` in `guest_network.py`).
- Each capture channel runs in its own container on the twins' bridge. A host firewall commonly
  drops bridge-to-host connections, and the Docker daemon may not see the checkout (for example
  `ProtectHome`), so the channel ships as an esbuild bundle through `docker cp`.

## Scenarios

`lifecycle.harness.ts` runs the happy path, the Docker scenario (`docker-scenario.ts`: a Docker
blueprint driven as the owner's person through `exec(argv, { user })`; hello-world, a build, compose
to `db` through the tunnel, a container reaching the Internet, a two-stage `npm ci` build, the VM's
and the session's cgroup peaks, and `boat-image/vm-probe.sh` in the twin; evidence in
`BOAT_TWIN_PROOF_DIR` when set), then one fault per step. A scenario's own steps check that the
runtime row carries the exact cause, and that Mend sees a terminal workspace (`stopped` or `failed`,
never `retained`) within 60 s (`assertSettled`).

Then, after every scenario and whatever it did, each launch it made must be released
(`assertReleased`): the workspace terminal, and the tunnel slot, publication pin, VM and gateway
gone. Each owner's discard is logged. A launch still not released after a minute gets the owner's
discard only to clean up after a scenario whose body already failed; in a passing scenario, a launch
that needed the discard to release is a leak, and the scenario fails. No marker excuses a failure
here.

Then the whole inventory must empty within 60 s: no live VM in the fake Boat and no `boat-tunnel-*`
container or network, whatever run they are labelled with (a build VM, a VM a recover path made
under a new run id, a changed label). Scenarios run one at a time, so this is exact. A leftover
fails the scenario, and its VMs are then removed outside Boat's API so the next scenario starts
clean.

Two invariants are checked in the same place, for every launch: a run never had two VMs, and a Stop
that ended cleanly (the owner's Stop, no error, no discard) captured its FINAL before the fake Boat
was asked to delete the VM. Every Stop a scenario makes of a ready launch goes through `cleanStop`,
and for those launches a skipped FINAL check fails the scenario, so a change to who writes the stop
columns cannot turn the check off silently. That is: Core recorded the FINAL drain complete before
the fake Boat recorded the delete, and the capture channel answered the head that FINAL names (if
any; a resumed run with no changes names its restored head or none) before it too. The capture
channel's proxy records when each `capture.register` was answered.

A scenario that hits a known defect on main is an expected failure (`defects.ts`, `markers.ts`). A
marker names the failure: where the scenario fails and what the runtime row says (on the happy path,
F3 must happen at the `ready` step). It can also require guest or proxy evidence. The scenario
passes only while it fails exactly that way. Any other failure fails it, and so does passing, so the
fix's pull request removes the marker. An `intermittent` marker (C1, a timing defect) passes either
way but still fails on any other error.

Core sometimes records only an error class (`readiness` / `Error`). A failure message therefore
carries two pieces of evidence: the guest's journal lines that name a cause, and every non-200
answer the guest gave through the hosted proxy. Defect signatures may match either.

## Safety on a shared machine

One harness run at a time per Docker host. A run takes a host lock: a named container,
`sealant-boat-harness-lock`, that runs a heartbeat and stops itself 120 s after its last renewal.
The run's test process renews it every 10 s, and so does its reaper until the run is reaped. A
second run waits while the lock runs. Liveness is never read from process ids: another sandbox on
the same Docker host may have its own PID namespace, and a run between processes (lock taken,
nothing spawned yet) has nothing to find. A stopped lock is taken over only when no object labelled
with its run exists; otherwise the new run stops and names `cleanup.ts`. A run also refuses to start
beside another run's labelled objects, lock or not.

Core's worker reconciles some Docker objects host-wide (resource reach networks, Boat gateways). The
harness refuses to start if any Sealant resource or gateway object already exists on the Docker
host. Set `BOAT_HARNESS_ALLOW_SHARED_DOCKER=1` to accept that risk. The worker and API get their own
`TMPDIR`, because the worker sweeps stale build contexts from its temp directory.

Ownership is a label, never a guess. Core's worker and API run the docker CLI from `PATH`, and the
harness puts `bin/docker` first there. It adds `--label sh.sealant.boat-harness=<run>` to every
container, network and volume Core creates, refuses global options rather than create anything
unlabelled, and passes everything else through. The harness labels its own objects the same way.
Teardown, the reaper and `cleanup.ts` remove only objects carrying the run's label, so they cannot
touch another deployment's resources. The run's scratch directory is removed too, except its logs.

A Docker daemon per run would isolate further, but the host would then need routes into the nested
daemon (root) and nested privileged systemd with WireGuard. Cached images carry
`sh.sealant.boat-harness.cache=true`, not a run label.

Each run starts a detached reaper (`reaper.ts`) in its own process group. Ctrl-C to the test runner,
or a killed test process, skips the stack's teardown but not the reaper. Once the test process is
gone, the reaper removes what the run left and releases the host lock:

- the run's worker and API, found by `SEALANT_BOAT_HARNESS_RUN`;
- every object labelled with the run, images included, even if the run died before its network
  existed.

`pnpm --filter @sealant/workspaces exec tsx boat-harness/cleanup.ts` does the same by hand. It lists
first, removes only with `--remove`, and never touches a live run: the one whose lock heartbeat
runs, including while it builds images. When a process-tree kill takes the reaper with the test
process, the heartbeat stops within 120 s, and `cleanup.ts --remove` reaps the run and its lock.

`markers.test.ts`, `invariants.test.ts`, `reap.test.ts`, `fake-boat.test.ts` and
`docker-wrapper.test.ts` cover the markers, the invariants, the lock, the reaper, cleanup, the
fake's API rules and the wrapper. They need no Docker and run with the package's unit tests.

## When the Ubuntu archive is unreachable

The native build downloads from `archive.ubuntu.com`, as a Boat VM does, and the twin base image
needs both the archive and `snapshot.ubuntu.com` (the only source of the pinned systemd) to build.
An outage would fail every scenario and say nothing about Boat, so:

- Before building, the stack probes the archive and then a full mirror of it
  (`mirrors.edge.kernel.org`), as `recipe.e2e.ts` does. If only the mirror answers, the twin base
  builds from it, and the twins run from a one-layer image over the base that points apt at the
  mirror. The base itself always ends on the stock archive. If neither answers, the stack stops at
  once and says so.
- CI keeps the twin base image in the Actions cache, keyed by the files in `twin/`. A job builds it
  only when they change, so it needs the snapshot service only then.
- For a local run, `BOAT_HARNESS_UBUNTU_ARCHIVE_IP=<a working archive address>` instead pins
  `archive.ubuntu.com` and `security.ubuntu.com` (Canonical serves both from the same machines) in
  each twin's `/etc/hosts`. That changes what the guest resolves, so CI never sets it.

## What it cannot catch

- Boat behaviour nobody has recorded: long-stream drops (the 478 s cut), proxy TLS and header
  quirks, real provisioning times, capacity, rate limits, archive timers, cold restore semantics.
- What the hosted proxy answers when nothing listens on the port. It is unrecorded; the fake
  answers 502.
- The real hosted edge's WebSocket behaviour for the carried tunnel: framing, idle timeouts, frame
  size limits. The fake pipes the upgraded connection's bytes unchanged.
- Boat's exact sudoers, kernel and module set. The twin shares the host kernel.
- Mend itself and `boat-live-check`. The SDK and the capture-channel fixture stand in for Mend.
- VM 131: disk, pruned images, Funnel paths, Garage.
