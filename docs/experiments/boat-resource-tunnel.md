# Boat resource gateway

This layer implements the host endpoint of a Boat session's resource tunnel. Boat remains
unregistered. It does not configure a remote guest, issue an execution permit, or establish
authenticated daemon readiness. SLNT-530 remains incomplete until those integrations land.

`DockerBoatTunnel` uses the existing resource subnet allocator, `desiredAttachments` policy and
`DockerResourceRuntime.attachExecutor`. A separate adapter owns the encrypted endpoint because the
existing runtime owns resource containers and local Docker executors, not remote peer keys or UDP
listeners. The gateway image is built from `packages/workspaces/boat-tunnel/Dockerfile` and selected
by immutable digest. It is separate from the existing cloud-metadata guard and from `boat-assets`.

## Boundary

Each run has one deterministic gateway name, bound to its complete `BoatExecutionTarget`. A
different incarnation, peer, key, image or UDP port refuses adoption. The gateway joins only its own
egress network and its private resource reach network. Project/worktree selection and alias
overrides use the same policy as Docker sessions. Relinking removes the previous attachments; DNS
caching is disabled so aliases follow the new attachments.

The gateway publishes only WireGuard UDP 51820 at the caller's frozen host port. Resources publish
no ports. A single peer owns `100.127.255.254/32`; its DNS server is `100.127.255.253`. Those fixed
addresses live inside each gateway's network namespace. Forwarding admits only that peer into its
exact RFC1918 reach subnet and interface. Host bridge and gateway addresses are refused. Return
traffic requires an established connection. All other forwarding, IPv6 and unsolicited resource
connections are denied. DNS forwards through Docker's resolver in the same isolated namespace.

The container has NET_ADMIN only, a read-only root, no host mounts, no privilege escalation, 128 MiB
memory, half a CPU and 64 PIDs. Its only writable application state is a private 1 MiB tmpfs. The
encrypted interface stays down until filtering and NAT are installed. The private key crosses Docker
exec stdin and an anonymous descriptor, never argv, environment, files, labels or receipts. Public
acknowledgements and errors contain no private key.

Replay inspects ownership, image, limits, entrypoint, mounts, published port, network membership,
WireGuard keys and peer, ordered firewall rules, forwarding policy, and working TCP/UDP DNS. A
changed policy refuses acknowledgement rather than silently repairing an active gateway. An
ambiguous create response can adopt only the exact owned container. No failure path deletes an
unknown object. Removal checks the target binding and removes its gateway and networks while
preserving resources and volumes.

An acknowledgement explicitly reports `peerHandshake: "unverified"`. Its digest includes the
container's start identity and current resource attachments. A gateway restart invalidates that
receipt; the remote peer must establish a new handshake before readiness can be accepted.

## Remaining composition work

The durable worker must freeze and protect key material and reserve the host UDP port before calling
this adapter. It must serialize attachment changes and removal under the current execution claim.
Replays retain the same target and keys. Unknown outcomes retain their obligations until inspection
resolves them.

The resource reconciler currently derives live executors from Docker runtime rows. Do not wire this
gateway into a live Boat launch until that reconciler also retains the gateway identity and
converges its attachments. Remote network namespaces, CPU/memory/PID limits, guest peer setup,
authenticated handshake/readiness and execution-permit issuance remain separate gates. A host
endpoint receipt alone must never authorize a permit. FINAL close/recovery and executable parking
remain unavailable; parking will use a plain `sync` before stop as hygiene.

The bounded visible-failure policy for a crash after allocation issuance and before create is
tracked in [#461](https://github.com/sealant-sh/sealant/issues/461). Empty inventory never
authorizes a duplicate create, even after visible failure.

## Local proof

CI builds the image and runs this real Docker/WireGuard test in the Docker job, without a Boat key
or provider calls:

```sh
docker build --iidfile /tmp/boat-tunnel-image-id \
  -f packages/workspaces/boat-tunnel/Dockerfile packages/workspaces/boat-tunnel
python3 -B -m unittest discover -s packages/workspaces/boat-tunnel -p 'test_*.py'
SEALANT_BOAT_TUNNEL_TEST_IMAGE_FILE=/tmp/boat-tunnel-image-id \
  pnpm --filter @sealant/workspaces test:e2e src/resources/boat-tunnel.e2e.ts
```

The test sends encrypted DNS over UDP and TCP and connects to actual linked resources. It checks
wrong-key refusal, cross-session denial, a live host listener, project/worktree relinking, restart
and reconnection, foreign-container refusal, changed limits, extra network membership and changed
firewall contents/order. Exact replay preserves the endpoint; removal preserves the resource
container. Final assertions require every owned test container and network to be absent. This is
local encrypted-traffic evidence, not a remote Boat or NAT traversal proof.
