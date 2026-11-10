# Boat VM probe

`packages/workspaces/boat-image/vm-probe.sh` runs first on a fresh Boat VM, before any session. It
answers two questions in a few seconds:

- **kernel:** can a root dockerd run here? It checks overlay2 on `/var/lib`, a bridge, a veth pair,
  a NAT chain, a network namespace, cgroup v2 and its controllers, IP forwarding, bridge netfilter,
  and Docker Hub reachability.
- **isolation:** what can a root guest reach on the provider's network? It tries metadata and
  credential endpoints (IPv4, IPv6, ECS, Alibaba), link-local, the default gateway, the provider
  `wg0` peers, the primary subnet's hosts, ARP neighbours, and the VM's own public address. Each
  check is one connection attempt to a fixed or locally discovered address. It does no scanning.

## Run

Copy the script to the VM, then run it as root. The second form also runs the same isolation targets
from a host-network container, which is what a `docker run --network host` reaches:

```sh
sudo bash vm-probe.sh
sudo bash vm-probe.sh --host-network-container ubuntu:24.04   # needs Docker on the VM
bash vm-probe.sh --isolation-only                             # isolation alone, any user
```

## Read it

Each check prints one line: `PASS|FAIL|SKIP <section> <check> <detail>`. `INFO` lines are facts, not
checks. The last line is the verdict, and it also counts the host-network container's checks when
that pass runs:

```
SUMMARY kernel pass=17 fail=0 skip=0 isolation pass=9 fail=0 skip=0 result=PASS
```

`result` is `FAIL` when any check failed, and `INCOMPLETE` when none failed but an isolation check
couldn't be made. It is `PASS` only when every check ran and passed.

- An isolation `PASS` means the connection was refused or got no answer in time, and each port's
  outcome is printed (`22:closed 80:filtered`). A probe that couldn't run is a `FAIL` with its
  reason, never a pass.
- A missing discovery tool (`ip`, `wg`) makes the checks that need it `SKIP` with that reason, so
  the verdict reads `INCOMPLETE`. `timeout` and `bash` are required: without them, every isolation
  check is a `FAIL`.
- A WireGuard peer's routed prefix is sampled by hosts inside it: the /32 itself, both addresses of
  a /31, otherwise the first two. A prefix broader than /8, or an IPv6 one, is a `SKIP` that names
  it as not covered.

- A kernel `FAIL` means Docker won't work on this VM. The exit status is 1.
- An isolation `FAIL` means the provider lets a root guest reach that address. That's a fact for the
  decision on in-guest egress rules, not an error, and it leaves the exit status at 0.
- A kernel `SKIP` means a tool is missing (for example `nft` when `iptables` is used), not a kernel
  gap.

## Known readings

- **overlayfs fails inside a container** whose root is itself overlay. The local harness twin gives
  Docker's data root a volume for this reason. A VM's disk passes.
- **`own-public-address`** is an `INFO` line, not a check, because a NAT shared with something
  listening answers for it, as on a lab host. On a Boat VM, it shows whether the VM's own public
  address loops back to it.
- **`modprobe br_netfilter` fails without `/lib/modules`.** That happens in a container that shares
  its host's kernel. The `br-netfilter` line then reports whether the host already has the module
  loaded.
