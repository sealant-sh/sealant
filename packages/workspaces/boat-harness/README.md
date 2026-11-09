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

It needs Docker with privileged containers, cgroup v2, kernel WireGuard (`modprobe wireguard`),
`openssl`, and internet access for the native build (archive.ubuntu.com, nodejs.org,
snapshot.ubuntu.com, ghcr.io). One pass takes about 25 to 40 minutes. CI runs it on pull requests
that touch Boat code, nightly, and on demand (`.github/workflows/boat-harness.yml`).

## What is real

| Part                                                              | Real or fake                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Core worker                                                       | Real: the production bundle (`apps/worker` build) with its packaged Boat assets   |
| Core API                                                          | Real, from source                                                                 |
| Boat adapter, allocation, execution, FINAL close, guest transport | Real                                                                              |
| Native snapshot build                                             | Real `BoatSnapshotBuilder` and `install-recipe`, run in the guest twin            |
| Guest                                                             | Real units, receiver, relay, launcher and pinned sealantd, under systemd as PID 1 |
| Resource gateway                                                  | Real `DockerBoatTunnel` and gateway image, real WireGuard                         |
| `db` resource                                                     | Real Postgres through Core's Docker resource runtime                              |
| Capture session channel                                           | Core's `capture-channel.fixture.ts` in a container, standing in for Mend's        |
| Driving client                                                    | `@sealant/sdk`, the surface Mend uses                                             |
| Boat's control plane                                              | Fake: `fake-boat.ts`                                                              |
| Boat's hosted port proxy                                          | Fake: `fake-boat.ts`                                                              |

## The fake Boat

`fake-boat.ts` answers Boat's API from recorded behaviour
(`docs/experiments/boat-provider-lifetime-evidence.json`, `boat-runtime.md`,
`boat-native-snapshots*.md`):

- create answers 202 `provisioned`, then `cloning`, then `idle` once the twin's systemd is up;
- commands run in the twin as uid 1000 through `docker exec`, sync up to 30 s, detached above;
- `DELETE` needs `X-Ascii-Confirm-Delete` and returns an operation to poll;
- saved snapshots are `docker commit`; `create from` boots a new container, so a new boot ID;
- the hosted proxy for `*.on.boat.dev` answers 403 without `_port_auth`, 302 for `_token`, and
  forwards HTTP and WebSocket to the guest's port 8080.

Core reaches it without production changes. `preload.mjs`, loaded with `node --import`, sends TLS
connections for `boat.dev` and `*.on.boat.dev` to the fake on 127.0.0.1 and keeps SNI and
certificate checks. The harness CA comes in through `NODE_EXTRA_CA_CERTS`. This covers undici and
`ws`. The preload refuses to load without its port, so a harness process cannot reach real Boat, and
its credential is a random string Boat would reject anyway.

## The guest twin

`twin/Dockerfile` is Ubuntu 24.04 with systemd `255.4-1ubuntu8.16` from the pinned snapshot, as the
recipe requires. It has a uid 1000 `user` with passwordless sudo. `twin-init` runs before systemd on
every start. It bind-mounts a fresh boot ID and creates the provider's outer `wg0`. Twins run
privileged with a private cgroup namespace.

The networking follows what the guest enforces:

- The twins sit on a 192.0.X.0/24 bridge, because the guest's workspace namespace refuses private
  and special-purpose destinations (`DENIED` in `guest_network.py`).
- The workspace namespace also refuses the WireGuard endpoint's own address. On Boat the gateway
  host and Mend's capture endpoint are different addresses, so the gateway endpoint here is the host
  address of a second, otherwise empty bridge.
- Each capture channel runs in its own container on the twins' bridge. A host firewall commonly
  drops bridge-to-host connections, and the Docker daemon may not see the checkout (for example
  `ProtectHome`), so the channel ships as an esbuild bundle through `docker cp`.

## Scenarios

`lifecycle.harness.ts` runs the happy path, then one fault per step. Every scenario ends with
`assertSettled`, which checks four things:

- Mend sees a terminal workspace (`stopped` or `failed`, never `retained`) within 60 s.
- The runtime row carries the exact cause.
- The UDP slot and the publication pin are released.
- No live VM and no gateway container or network is left.

A scenario that hits a known defect on main is an expected failure (`defects.ts`). It passes only
while it fails with that defect's signature. Once the defect is fixed it fails, so the fix's pull
request removes the marker. Where timing decides which of two defects a scenario meets first (the 30
s sweep race can strike any launch), the marker names both.

Core sometimes records only an error class (`readiness` / `Error`). A failure message therefore
carries two pieces of evidence: the guest's journal lines that name a cause, and every non-200
answer the guest gave through the hosted proxy. Defect signatures may match either.

## Safety on a shared machine

Core's worker reconciles some Docker objects host-wide (resource reach networks, Boat gateways). The
harness refuses to start if any Sealant resource or gateway object already exists on the Docker
host. Set `BOAT_HARNESS_ALLOW_SHARED_DOCKER=1` to accept that risk. The worker and API get their own
`TMPDIR`, because the worker sweeps stale build contexts from its temp directory.

Teardown removes:

- everything labelled `sh.sealant.boat-harness=<run>`;
- the Core-labelled objects created during the run;
- the run's scratch directory, except its logs.

Cached images keep the label value `cache`. Interrupting the test runner can kill the stack before
its teardown runs. Then `pnpm --filter @sealant/workspaces exec tsx boat-harness/cleanup.ts` lists
what the run left, and `--remove` removes it.

## What it cannot catch

- Boat behaviour nobody has recorded: long-stream drops (the 478 s cut), proxy TLS and header
  quirks, real provisioning times, capacity, rate limits, archive timers, cold restore semantics.
- What the hosted proxy answers when nothing listens on the port. It is unrecorded; the fake
  answers 502.
- Boat's exact sudoers, kernel and module set. The twin shares the host kernel.
- Mend itself and `boat-live-check`. The SDK and the capture-channel fixture stand in for Mend.
- VM 131: disk, pruned images, Funnel paths, UDP 40000 to 40015 from Boat, Garage.
