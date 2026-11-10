# Boat VM probe

`packages/workspaces/boat-image/vm-probe.sh` runs first on a fresh Boat VM, before any session. It
answers one question in a few seconds: can a root dockerd run here?

- **kernel:** it checks overlay2 on `/var/lib`, a bridge, a veth pair, a NAT chain, a network
  namespace, cgroup v2 and its controllers, IP forwarding, bridge netfilter, and Docker Hub
  reachability.
- **container** (when asked): the VM's own Docker runs one container on its default bridge network,
  which uses those kernel features for real.

It looks at the VM alone. What a guest can reach on the provider's network is not its question:
Boat's network is the deployment owner's own infrastructure, so the probe connects to nothing there,
and the checks of metadata endpoints, the provider's gateway, its WireGuard peers and neighbouring
VMs are gone, with their `--isolation-only` mode.

## Run

Copy the script to the VM, then run it as root. The second form also runs a container:

```sh
sudo bash vm-probe.sh
sudo bash vm-probe.sh --container ubuntu:24.04   # needs Docker on the VM
```

## Read it

Each check prints one line: `PASS|FAIL|SKIP <section> <check> <detail>`. `INFO` lines are facts, not
checks. The last line is the verdict:

```
SUMMARY kernel pass=13 fail=0 skip=0 result=PASS
SUMMARY kernel pass=13 fail=0 skip=0 container pass=1 fail=0 skip=0 result=PASS
```

`result` is `FAIL` when any check failed, and `INCOMPLETE` when none failed but the container check
was asked for and couldn't be made (no Docker on the VM). It is `PASS` only when every check ran and
passed.

- A kernel `FAIL` means Docker won't work on this VM. The exit status is 1.
- A container `FAIL` means Docker is there and couldn't run the container. Its last line of output
  is printed, and the exit status is 1.
- A kernel `SKIP` means a tool is missing (for example `nft` when `iptables` is used), not a kernel
  gap.

## Known readings

- **overlayfs fails inside a container** whose root is itself overlay. The local harness twin gives
  Docker's data root a volume for this reason. A VM's disk passes.
- **`modprobe br_netfilter` fails without `/lib/modules`.** That happens in a container that shares
  its host's kernel. The `br-netfilter` line then reports whether the host already has the module
  loaded.
