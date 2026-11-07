# Guest network boundary

`POST /sealant/bootstrap/isolate` prepares networking for the already installed admission epoch. It
uses the receiver's bearer and exact identity, boot ID, epoch and operation ID. Its strict
`sealant-guest-network-v1` body contains that `binding`, the guest `private_key` and `public_key`,
`gateway_key`, numeric IPv4 `endpoint`, UDP `port`, and the private resource `subnet` as a `/27`. It
accepts no commands or caller-selected interface names. Setup does not issue an execution permit.

Outer root owns `sealant-workspace` under `/run/netns`. The WireGuard interface is created outside
that namespace so its UDP socket retains provider connectivity, then moved inside. Only the exact
resource subnet and gateway DNS route through it. A separate veth provides ordinary IPv4 Internet
egress. Both namespace and outer forwarding rules deny private, metadata, link-local and reserved
addresses on that path. The VM's own addresses and the tunnel endpoint are denied on the resource
path too, including when the provider and resource ranges overlap. IPv6 is disabled and dropped.
Mapped root has no authority to change this outer-owned network's routes, firewall or interfaces.

The launcher enters the network as outer root, before nspawn creates the mapped user namespace.
Using nspawn's `--network-namespace-path` would join too late and fail with `EPERM`. Before
releasing the fixed gate, launch checks the actual process network namespace against the saved
device/inode. Running invocation adoption checks it again. The resolver bind is read-only. Build
networking and the private-network source probe retain their existing behavior.

`network.json` records public intent before kernel effects. Successful setup records namespace
identity, keys, endpoint, routes, interfaces, addresses, firewall and resolver identity. Keys enter
through the authenticated body; the private key is redacted in memory and reaches WireGuard through
an anonymous descriptor. It never enters argv, environment, state files or subprocess errors. Exact
replay verifies the saved state without mutating it. Partial setup, policy changes, a replaced
namespace or a new boot refuse adoption and retain the original obligation. This layer does not
repair or remove uncertain setup, rebind restored networking, or release host UDP reservations.

Admission remains disabled. The
[worker resource reconciler](../../../docs/architecture/boat-resource-reconciliation.md) now
dispatches this setup contract. Authenticated readiness, resource limits, FINAL close/recovery and
executable parking remain separate work. In particular,
[#465](https://github.com/sealant-sh/sealant/issues/465) blocks admission until canonical close
proves both guest peer and host gateway cleanup before releasing the reserved slot. Parking keeps a
plain `sync` before stop as hygiene.

## Local proof

The required CI step builds `Dockerfile.network-test` and runs `network_proof.py` against the real
resource gateway. It fails explicitly if privileged network namespaces, user namespaces or kernel
WireGuard are unavailable. It uses copied tools and their dependency closure with source scripts
removed, not the runner's networking tools. Docker-only public-address fixtures avoid an Internet
service dependency.

The proof covers encrypted resource TCP, UDP/TCP DNS, ordinary egress, live outer and metadata
service denial, wrong-peer denial, mapped-root mutation denial, exact replay, partial intent,
namespace replacement and policy drift. It also starts the shipped mapped nspawn gate with the full
`0 -> 131072:65536` user map and verifies its actual network and read-only resolver mount. The proof
container selects unified cgroups because Docker has no outer systemd manager; production gets its
hierarchy from the VM. The test stops at the gate and executes no workspace daemon.

There is no Boat allocation, full VM restore or VM 131 session proof in this layer. The first real
end-to-end session still requires operator approval for tailnet join, Funnel on 443/8443/10000 and
host UDP DNAT 40000-40015. Admission must remain held until the remaining gates are executable.
