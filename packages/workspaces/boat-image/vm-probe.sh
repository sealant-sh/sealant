#!/bin/bash
# Boat VM probe: run first, on a fresh Boat VM, before any session.
#
#   sudo bash vm-probe.sh                                      # kernel + isolation, as VM root
#   sudo bash vm-probe.sh --host-network-container IMAGE       # then the same isolation targets
#                                                              # from a `docker run --network host`
#
# One line per check:
#   kernel     what a root dockerd in the VM needs. FAIL here means Docker will not work.
#   isolation  what a root guest (or a host-network container) can reach on the provider's
#              network. FAIL means reachable: the provider does not isolate it.
#
# Reachability only: a handful of fixed or locally discovered addresses, one short connection
# attempt each, no scanning. Every kernel object it creates carries a sealant-probe name and is
# removed before the next check.
#
# Output: one line per check, `PASS|FAIL|SKIP <section> <check> <detail>`; `INFO` lines are facts,
# not checks. Each pass ends with its verdict: the host-network container's own
#   SUMMARY container pass=N fail=N
# and, last, the VM's
#   SUMMARY kernel pass=N fail=N skip=N isolation pass=N fail=N
# Exit status: 1 when a kernel check fails (Docker will not work), otherwise 0. Isolation FAILs do
# not change it: they are facts for the decision on in-guest egress rules, not errors.
set -u
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

mode=vm
container_image=
case "${1:-}" in
  --host-network-container) mode=vm container_image=${2:?an image with bash, e.g. ubuntu:24.04} ;;
  --targets-only) mode=targets ;;
  "") ;;
  *) echo "usage: vm-probe.sh [--host-network-container IMAGE]" >&2; exit 2 ;;
esac
where=${PROBE_WHERE:-isolation}

kernel_failures=0
declare -A tally=()
# Every check line goes through here, so the summary counts exactly what was printed.
say() {
  printf '%-5s %-10s %-28s %s\n' "$1" "$2" "$3" "${4:-}"
  case "$1" in PASS | FAIL | SKIP) tally["$2.$1"]=$((${tally["$2.$1"]:-0} + 1)) ;; esac
}
summary() {
  local line="SUMMARY" section
  for section in "$@"; do
    line+=" $section pass=${tally[$section.PASS]:-0} fail=${tally[$section.FAIL]:-0}"
    [ "$section" = kernel ] && line+=" skip=${tally[$section.SKIP]:-0}"
  done
  printf '%s\n' "$line"
}
kernel() { # name, detail, command...
  local name=$1 detail=$2
  shift 2
  if [ "$1" = needs ]; then
    # `needs TOOL --`: a missing tool is not a kernel gap; say so and move on.
    if ! command -v "$2" >/dev/null 2>&1; then say SKIP kernel "$name" "no $2 on this VM"; return; fi
    shift 3
  fi
  if "$@" >/dev/null 2>&1; then say PASS kernel "$name" "$detail"; else
    say FAIL kernel "$name" "$detail"
    kernel_failures=$((kernel_failures + 1))
  fi
}
# A TCP connect within two seconds, through bash alone (IPv4 or IPv6 literal).
tcp() { timeout 2 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" 2>/dev/null; }
# PASS when nothing answers on any of the ports, FAIL naming the first port that answers.
unreachable() { # name, address, ports...
  local name=$1 address=$2 port
  shift 2
  for port in "$@"; do
    if tcp "$address" "$port"; then
      say FAIL "$where" "$name" "$address:$port answers"
      return
    fi
  done
  say PASS "$where" "$name" "$address ports $* closed or filtered"
}
# Each target is one line: name address port...
probe_targets() {
  local name address ports
  while read -r name address ports; do
    [ -n "$name" ] || continue
    # shellcheck disable=SC2086
    unreachable "$name" "$address" $ports
  done <<< "$1"
}

if [ "$mode" = targets ]; then
  probe_targets "${PROBE_TARGETS:-}"
  summary "$where"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "vm-probe: run as root (sudo bash vm-probe.sh)" >&2; exit 2; }
say INFO kernel release "$(uname -r)"

# --- kernel: a root dockerd with overlay2, a bridge, veth pairs and nftables NAT --------------------
# On the disk dockerd's data root lives on (/var/lib), not /tmp: overlay2 needs a real upper dir.
probe_dir=$(mktemp -d -p /var/lib -t sealant-probe.XXXXXX)
mkdir -p "$probe_dir/lower" "$probe_dir/upper" "$probe_dir/work" "$probe_dir/merged"
kernel overlayfs "mount overlay (overlay2 storage)" \
  mount -t overlay sealant-probe -o "lowerdir=$probe_dir/lower,upperdir=$probe_dir/upper,workdir=$probe_dir/work" "$probe_dir/merged"
umount "$probe_dir/merged" 2>/dev/null
ls -d "$probe_dir" >/dev/null && rm -rf "$probe_dir"
kernel bridge "create and delete a bridge" needs ip -- \
  sh -c 'ip link add sealant-probe0 type bridge && ip link delete sealant-probe0'
kernel veth "create and delete a veth pair" needs ip -- \
  sh -c 'ip link add sealant-probe1 type veth peer name sealant-probe2 && ip link delete sealant-probe1'
# Docker programs NAT through iptables (the nft backend on Ubuntu 24.04).
if command -v iptables >/dev/null 2>&1; then
  kernel iptables-nat "create and delete a NAT chain" \
    sh -c 'iptables -t nat -N SEALANT-PROBE && iptables -t nat -X SEALANT-PROBE'
else
  kernel nftables-nat "create and delete an nft NAT table" needs nft -- \
    sh -c 'nft add table ip sealant_probe && nft add chain ip sealant_probe post "{ type nat hook postrouting priority 100; }" && nft delete table ip sealant_probe'
fi
kernel netns "create and delete a network namespace" needs ip -- \
  sh -c 'ip netns add sealant-probe && ip netns delete sealant-probe'
kernel cgroup-v2 "unified hierarchy" test -f /sys/fs/cgroup/cgroup.controllers
for controller in cpu memory pids io; do
  kernel "cgroup-$controller" "controller available" grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers
done
kernel ip-forward "forwarding sysctl readable" test -r /proc/sys/net/ipv4/ip_forward
say INFO kernel ip-forward "net.ipv4.ip_forward=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)"
if [ -e /proc/sys/net/bridge/bridge-nf-call-iptables ] || modprobe -n br_netfilter >/dev/null 2>&1; then
  say PASS kernel br-netfilter "present or loadable"
else
  say INFO kernel br-netfilter "absent: Docker warns, inter-container filtering off"
fi
say INFO kernel user-namespaces "$(unshare -U true >/dev/null 2>&1 && echo available || echo unavailable)"
say INFO kernel apparmor-userns "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"
say INFO kernel tun "$(test -c /dev/net/tun && echo present || echo absent)"
if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://registry-1.docker.io/v2/ 2>/dev/null)
  if [ "$code" = 401 ] || [ "$code" = 200 ]; then say PASS kernel docker-hub "registry answers HTTP $code"; else
    say FAIL kernel docker-hub "registry answered '${code:-nothing}'"
    kernel_failures=$((kernel_failures + 1))
  fi
fi

# --- isolation: what a root guest reaches beyond the Internet -------------------------------------
# The targets, fixed and discovered here (the container pass reuses them: its image has no ip/wg).
targets=""
add() { targets+="$*"$'\n'; }
add metadata-ipv4 169.254.169.254 80
add metadata-ecs 169.254.170.2 80
add metadata-alibaba 100.100.100.200 80
add metadata-ipv6 fd00:ec2::254 80
add link-local-gateway 169.254.0.1 80 443
if getent hosts metadata.google.internal >/dev/null 2>&1; then
  say INFO isolation metadata-name "metadata.google.internal resolves: $(getent hosts metadata.google.internal | awk '{print $1; exit}')"
fi
default=$(ip -4 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "via") { print $(i + 1); exit } }')
if [ -n "$default" ]; then add default-gateway "$default" 22 80 443 8080; else
  say INFO isolation default-gateway "no IPv4 default route"
fi
# The provider's WireGuard: its configured peers' tunnel addresses (allowed-ips hosts) and the
# first host of the interface's own subnet.
if [ -d /sys/class/net/wg0 ]; then
  wg_net=$(ip -4 -o address show dev wg0 2>/dev/null | awk '{ print $4; exit }')
  say INFO isolation provider-wg0 "address ${wg_net:-none}"
  for peer in $( (wg show wg0 allowed-ips 2>/dev/null || true) | tr '\t ' '\n\n' | grep -E '^[0-9.]+/(3[0-2]|2[0-9])$' | head -n 3); do
    add provider-wg0-peer "${peer%/*}" 22 80 443
  done
  if [ -n "$wg_net" ]; then
    first=$(python3 -c 'import ipaddress,sys; n=ipaddress.ip_interface(sys.argv[1]).network; print(next(n.hosts()))' "$wg_net" 2>/dev/null)
    [ -n "$first" ] && [ "$first" != "${wg_net%/*}" ] && add provider-wg0-first "$first" 22 80 443
  fi
else
  say INFO isolation provider-wg0 "absent"
fi
# Other VMs on the provider's private network: the first two hosts of the primary subnet and up
# to three neighbours the VM already knows.
primary=$(ip -4 -o address show scope global 2>/dev/null | awk '$2 != "wg0" && $2 !~ /^(docker|br-|veth|sealant)/ { print $4; exit }')
say INFO isolation primary-address "${primary:-none}"
if [ -n "$primary" ]; then
  for host in $(python3 -c 'import ipaddress,sys
i=ipaddress.ip_interface(sys.argv[1]); hosts=i.network.hosts()
print(" ".join(str(h) for h,_ in zip(hosts,range(2)) if h!=i.ip))' "$primary" 2>/dev/null); do
    add provider-subnet-host "$host" 22 80 443
  done
fi
for neighbour in $(ip -4 neigh show 2>/dev/null | awk '$1 != "'"$default"'" { print $1 }' | head -n 3); do
  add provider-neighbour "$neighbour" 22 80 443
done
# The VM's own public address, as the Internet sees it.
if command -v curl >/dev/null 2>&1; then
  public=$(curl -s --max-time 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
  if [ -n "$public" ]; then
    say INFO isolation public-address "$public"
    add own-public-address "$public" 22 8080
  fi
fi
probe_targets "$targets"

# The same targets from a host-network container: what a `docker run --network host` reaches.
if [ -n "$container_image" ]; then
  if command -v docker >/dev/null 2>&1; then
    script=$(readlink -f "$0")
    docker run --rm --network host --label sealant-probe=vm-probe \
      -e PROBE_TARGETS="$targets" -e PROBE_WHERE=container \
      -v "$script":/vm-probe.sh:ro "$container_image" bash /vm-probe.sh --targets-only \
      || say FAIL container run "the host-network container did not run"
  else
    say INFO container run "no docker on this VM"
  fi
fi

summary kernel isolation
[ "$kernel_failures" = 0 ]
