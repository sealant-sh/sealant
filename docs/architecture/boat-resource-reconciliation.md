# Boat worker and resource reconciliation

Boat remains unregistered. This layer joins durable tunnel credentials, the Docker resource gateway
and authenticated guest network setup. It does not stage a session, issue an execution permit, prove
a peer handshake, start a daemon, report readiness or release reservations. Admission remains
blocked by
[canonical close and slot release, #465](https://github.com/sealant-sh/sealant/issues/465).

`BoatResources.prepare` requires the exact bound allocation, active pending runtime and installed
execution epoch. It reuses the existing encrypted keys and UDP reservation. Before external setup,
the tunnel record freezes the admission epoch and operation, numeric endpoint and reach subnet. This
additive JSON field requires no migration. Older records without it are parsed unchanged;
compare-and-set installs it once. A changed boot, host, endpoint or subnet cannot silently replace
networking. Unknown setup results retain the keys, port, subnet and original intent.

Every pass reads the run's current resource link and non-archived instances. The host adapter
converges its own exact gateway and attachments, including an empty reach network for an unlinked
workspace. The worker checks the allocation, execution and link again before host setup, before
authenticated guest delivery and before returning the acknowledgement. No provider I/O runs inside a
transaction. Resource links can change concurrently, so acknowledgements describe the checked
configuration; readiness must obtain fresh observations and authorization before admitting
execution.

`BoatExecution.isolate` owns access to the sealed bearer. It refreshes authenticated hosted access
and delivers the strict network request to the [guest agent](boat-guest-agent.md)
(`POST /sealant/network`). The guest private key remains redacted until HTTPS serialization and
reaches `wg` on its stdin only. It validates the returned binding, configured state and receipt, and
checks the execution record again. A lost reply reuses identical inputs. The agent verifies a
completed replay and refuses a different config on the same boot. The host acknowledgement still
says `peerHandshake: unverified`; the agent says `handshake: unverified`. Neither is admission
authority: readiness reads the handshake and the gateway's DNS afterwards.

## Shared resource ownership

Generic Docker convergence preserves the reserved `boat-tunnel-<32 hex>` executor names, including
subnet reservations whose network has not yet been created. It also preserves reach networks with
the Boat ownership label. Only the exact-target Boat adapter may converge or remove those networks.
This prevents the ordinary resource tick from detaching a peer's resource network, or releasing a
subnet between reservation and gateway creation. It does not classify an uncertain gateway as gone.

The resource tick uses current Boat links for idle accounting only. Network intent counts
conservatively as reached while that exact epoch's runtime is active, including an uncertain setup.
A failed custody read aborts that tick before idle decisions. Generic starts and network convergence
still receive only ordinary executors. Boat reconciliation applies current aliases and unlinks on
its next pass. A stopped or held execution receives no new setup; its outstanding network custody
stays for canonical FINAL cleanup. Nothing here expires or recycles UDP slots.

## Worker configuration and bounds

Allocation-only configuration continues to work. Resource reconciliation additionally requires
`SEALANT_BOAT_GATEWAY_HOST_ID`, `SEALANT_BOAT_GATEWAY_IMAGE` and `SEALANT_BOAT_GATEWAY_RELAY_HOST`,
all three or none. The host ID is an operator-owned stable UUID shared across deployments on that
physical Docker host, and the image must be a locally available immutable digest. Partial
configuration, a mutable image tag or a non-Docker resource host refuses worker startup; a gateway
without its relay host is refused by that variable's name. No credential discovery or network
configuration is inferred from the worker's container.

`SEALANT_BOAT_GATEWAY_RELAY_HOST` (IPv4, never `0.0.0.0`) is the address at which the worker reaches
the gateways' published WireGuard ports: `127.0.0.1` when the worker runs on the Docker host, or the
host's address as a worker container sees it. Every tunnel is carried over HTTPS: a network setup
sends the agent `carrier: "websocket"`, and the worker keeps one WebSocket per run open to the
agent's `/sealant/tunnel` through Boat's hosted HTTPS, relaying each WireGuard datagram to the
gateway's port. No Boat VM dials the gateway's host, and that host needs no inbound port and no
firewall rule, as a MicroVM deployment needs none. Every reconcile pass ensures the carrier again,
so a restarted worker or a dropped connection reopens it. WireGuard re-handshakes on its 25 s
keepalive. A run that is closed or held releases its carrier. One worker carries a run: a second
carrier for the same run replaces the first, which holds off for five minutes before it tries again.

The gateway publishes its WireGuard port on the relay host's address only, never on a public
interface. A VM whose agent cannot carry the tunnel (an image built before the carrier) is refused
at network setup with `carrier-unavailable`: there is no gateway address for it to dial.

`SEALANT_BOAT_GATEWAY_ENDPOINT`, the public address VMs once dialled over UDP, is retired. A
deployment that still sets it starts, and it is not read. A session started before the upgrade keeps
what it has until it stops: a gateway whose port was published on every interface is adopted as it
is, and a reservation that recorded the dialled address is reconciled without it. No new gateway is
published that way.

A run's gateway is given one host port from 61000 to 61511, so one Docker host carries 512 Boat
sessions at once (the first allocator's sixteen ports, 40000 to 40015, dated from when each had to
be opened to the Internet; a reservation that holds one keeps it until its run ends). The range sits
above Linux's default ephemeral ports, 32768 to 60999: a port in that range can already be the
source port of an outbound socket on the host, the worker's own carrier to another gateway among
them, and the gateway reserved it could then not bind it. A host whose `ip_local_port_range` was
raised past 60999 has that exposure back. Beyond the ports, each run takes one `/27` of
`SEALANT_RESOURCE_REACH_SUBNETS` and one `/28` of `SEALANT_RESOURCE_EGRESS_SUBNETS`, shared with the
host's other resource networks: the defaults (`10.231.0.0/16`, `10.232.0.0/16`) hold 2048 and 4096.

The relay address decides who can reach the gateway port: `0.0.0.0` is refused, and a routable
address publishes the port there. Change it only with no live Boat sessions: a gateway is labelled
with the address its port was published on, one published elsewhere is refused
(`ownership-conflict`) and never republished, and that run's resources stay unreachable until the
session is launched again. Removing the retired endpoint setting changes nothing for a live run.

The worker shares its resource runtime and subnet store with the gateway. One managed runtime owns
the existing sealed execution service and both reconcilers, and is disposed at shutdown. The
non-overlapping 30-second sweep walks separate allocation and resource cursors, twenty IDs per page,
with four observations in parallel and a 120-second bound per resource entry. Parsing failures, held
and pending entries advance the cursor. Resource idle accounting reads all configured custody on
this deployment and host, independent of the current sweep page.

`BoatResources` owns the effect order because neither the credential store, gateway adapter nor
guest agent alone can check the current allocation and resource link across both setup requests.
Existing owners continue to handle SQL, cryptography and Docker. No new provider client, credential
resolver or cleanup authority is introduced.

## Verification and next gate

Migrated PostgreSQL tests cover additive setup intent, exact replay, rebuilt service adoption, lost
replies, changed targets, stopped-run fencing, unlinks, idle accounting and cursor progress. The
real Docker/WireGuard proof checks that ordinary convergence preserves both a live Boat gateway and
an uncreated reservation; it continues to prove encrypted resource and DNS reach, wrong-peer denial,
relinking and exact cleanup. Its Docker inventory is restricted to owned objects. The agent's
network setup is proven in `agent-boat.test.ts` and `agent-transport.test.ts`.

This layer needs no Boat allocation or VM 131 session to validate its scoped behavior. Authenticated
readiness is next. Its first end-to-end Boat session on VM 131 needs Yiannis's approval for the
tailnet join and Funnel on 443/8443/10000 (the tunnel is carried over HTTPS, so no UDP is forwarded
to the gateway's host). No box changes are made here. FINAL close and recovery follow. The
shipped-only boot guard and base-matching systemd holds remain unchanged.
