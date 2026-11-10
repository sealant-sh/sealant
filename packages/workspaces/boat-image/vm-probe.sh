#!/bin/bash
# Boat VM probe: run first, on a fresh Boat VM, before any session.
#
#   sudo bash vm-probe.sh                                      # kernel + isolation, as VM root
#   sudo bash vm-probe.sh --host-network-container IMAGE       # then the same isolation targets
#                                                              # from a `docker run --network host`
#   bash vm-probe.sh --isolation-only                          # isolation only, any user
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
# not checks. An isolation PASS means the connection was refused or timed out, nothing else: a
# probe that could not run is a FAIL, and a check that could not be made (a tool missing, a prefix
# too broad to sample) is a SKIP with its reason. Each pass ends with its verdict:
#   SUMMARY container pass=N fail=N skip=N result=PASS|FAIL|INCOMPLETE
#   SUMMARY kernel pass=N fail=N skip=N isolation pass=N fail=N skip=N result=PASS|FAIL|INCOMPLETE
# result is FAIL when any check failed, INCOMPLETE when none failed but an isolation check was
# skipped, and PASS only when every check ran and passed.
# Exit status: 1 when a kernel check fails (Docker will not work), otherwise 0.
set -u
export LC_ALL=C PATH=${PROBE_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}

mode=vm
container_image=
case "${1:-}" in
  --host-network-container) container_image=${2:?an image with bash, e.g. ubuntu:24.04} ;;
  --isolation-only) mode=isolation ;;
  --targets-only) mode=targets ;;
  --hosts-for) mode=hosts ;;
  "") ;;
  *) echo "usage: vm-probe.sh [--host-network-container IMAGE | --isolation-only]" >&2; exit 2 ;;
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
  local line="SUMMARY" section failed=0 skipped=0 result
  for section in "$@"; do
    line+=" $section pass=${tally[$section.PASS]:-0} fail=${tally[$section.FAIL]:-0} skip=${tally[$section.SKIP]:-0}"
    failed=$((failed + ${tally[$section.FAIL]:-0}))
    # A kernel SKIP is a tool the kernel check did not need; an isolation SKIP is a check missing.
    [ "$section" != kernel ] && skipped=$((skipped + ${tally[$section.SKIP]:-0}))
  done
  if [ "$failed" -gt 0 ]; then result=FAIL; elif [ "$skipped" -gt 0 ]; then result=INCOMPLETE; else result=PASS; fi
  printf '%s result=%s\n' "$line" "$result"
}
has() { command -v "$1" >/dev/null 2>&1; }

# --- IPv4 arithmetic, in bash alone --------------------------------------------------------------
ipv4() { [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] && (( BASH_REMATCH[1] < 256 && BASH_REMATCH[2] < 256 && BASH_REMATCH[3] < 256 && BASH_REMATCH[4] < 256 )); }
to_int() { local IFS=.; set -- $1; echo $(( ($1 << 24) | ($2 << 16) | ($3 << 8) | $4 )); }
to_ip() { echo "$(( ($1 >> 24) & 255 )).$(( ($1 >> 16) & 255 )).$(( ($1 >> 8) & 255 )).$(( $1 & 255 ))"; }
# Hosts worth one attempt inside an IPv4 prefix: the address of a /32, both of a /31, otherwise
# the first two hosts. A prefix broader than /8, or IPv6, is not sampled: `not-covered <why>`.
hosts_for() {
  local cidr=$1 address prefix network
  address=${cidr%/*}
  prefix=${cidr#*/}
  [ "$prefix" = "$cidr" ] && prefix=32
  if ! ipv4 "$address" || ! [[ $prefix =~ ^[0-9]{1,2}$ ]] || (( prefix > 32 )); then
    echo "not-covered not an IPv4 prefix"
    return
  fi
  (( prefix < 8 )) && { echo "not-covered prefix /$prefix too broad to sample"; return; }
  network=$(( $(to_int "$address") & (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF ))
  case $prefix in
    32) to_ip "$network" ;;
    31) echo "$(to_ip "$network") $(to_ip $((network + 1)))" ;;
    *) echo "$(to_ip $((network + 1))) $(to_ip $((network + 2)))" ;;
  esac
}
if [ "$mode" = hosts ]; then
  hosts_for "${2:?a prefix, e.g. 198.51.100.0/24}"
  exit 0
fi

# --- reachability --------------------------------------------------------------------------------
# One TCP connect, bounded at two seconds. Prints the outcome: `open`, `closed` (refused, or no
# route: the kernel answered), `filtered` (no answer in time), or `error <reason>` (the attempt
# itself could not be made, which is never taken for closed).
tcp() {
  local output code
  output=$(timeout 2 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" 2>&1)
  code=$?
  case $code in
    0) echo open ;;
    124) echo filtered ;;
    126 | 127) echo "error cannot run timeout or bash ($code)" ;;
    *)
      case $output in
        *"Connection refused"* | *"No route to host"* | *"Network is unreachable"*) echo closed ;;
        *"Connection timed out"*) echo filtered ;;
        *) echo "error ${output##*: }" ;;
      esac
      ;;
  esac
}
# PASS when every port is closed or filtered, FAIL on the first port that answers or on a probe
# that could not run (with its reason).
unreachable() { # name, address, ports...
  local name=$1 address=$2 port outcome seen=()
  shift 2
  if ! ipv4 "$address" && ! [[ $address =~ ^[0-9a-fA-F:]+$ && $address == *:* ]]; then
    say FAIL "$where" "$name" "probe error: '$address' is not an IP address"
    return
  fi
  for port in "$@"; do
    outcome=$(tcp "$address" "$port")
    case $outcome in
      open) say FAIL "$where" "$name" "$address:$port answers"; return ;;
      error*) say FAIL "$where" "$name" "probe error at $address:$port: ${outcome#error }"; return ;;
      *) seen+=("$port:$outcome") ;;
    esac
  done
  say PASS "$where" "$name" "$address ${seen[*]}"
}
# Each target is one line: name address port...  A `skip` line is a check that cannot be made:
# `name skip reason...`, printed as SKIP so the summary counts it.
probe_targets() {
  local name address rest
  while read -r name address rest; do
    [ -n "$name" ] || continue
    if [ "$address" = skip ]; then say SKIP "$where" "$name" "$rest"; continue; fi
    # shellcheck disable=SC2086
    unreachable "$name" "$address" $rest
  done <<< "$1"
}
# The isolation prerequisites: without them no connection attempt means anything.
prerequisites() {
  local tool ok=0
  for tool in timeout bash; do
    if ! has "$tool"; then say FAIL "$where" "prerequisite-$tool" "missing: no connection attempt can be bounded"; ok=1; fi
  done
  return $ok
}

if [ "$mode" = targets ]; then
  prerequisites && probe_targets "${PROBE_TARGETS:-}"
  summary "$where"
  exit 0
fi

if [ "$mode" = vm ]; then
  [ "$(id -u)" = 0 ] || { echo "vm-probe: run as root (sudo bash vm-probe.sh), or use --isolation-only" >&2; exit 2; }
  say INFO kernel release "$(uname -r)"

  # --- kernel: a root dockerd with overlay2, a bridge, veth pairs and nftables NAT --------------
  kernel() { # name, detail, command...
    local name=$1 detail=$2
    shift 2
    if [ "$1" = needs ]; then
      # `needs TOOL --`: a missing tool is not a kernel gap; say so and move on.
      if ! has "$2"; then say SKIP kernel "$name" "no $2 on this VM"; return; fi
      shift 3
    fi
    if "$@" >/dev/null 2>&1; then say PASS kernel "$name" "$detail"; else
      say FAIL kernel "$name" "$detail"
      kernel_failures=$((kernel_failures + 1))
    fi
  }
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
  if has iptables; then
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
  if has curl; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://registry-1.docker.io/v2/ 2>/dev/null)
    if [ "$code" = 401 ] || [ "$code" = 200 ]; then say PASS kernel docker-hub "registry answers HTTP $code"; else
      say FAIL kernel docker-hub "registry answered '${code:-nothing}'"
      kernel_failures=$((kernel_failures + 1))
    fi
  else
    say SKIP kernel docker-hub "no curl on this VM"
  fi
fi

# --- isolation: what a root guest reaches beyond the Internet -------------------------------------
# The targets, fixed and discovered here (the container pass reuses them: its image has no ip/wg).
# A target that cannot be discovered becomes a `skip` line with the reason.
targets=""
add() { targets+="$*"$'\n'; }
skip() { local name=$1; shift; targets+="$name skip $*"$'\n'; }
add metadata-ipv4 169.254.169.254 80
add metadata-ecs 169.254.170.2 80
add metadata-alibaba 100.100.100.200 80
add metadata-ipv6 fd00:ec2::254 80
add link-local-gateway 169.254.0.1 80 443
if has getent && getent hosts metadata.google.internal >/dev/null 2>&1; then
  say INFO isolation metadata-name "metadata.google.internal resolves: $(getent hosts metadata.google.internal | awk '{print $1; exit}')"
fi
if has ip; then
  default=$(ip -4 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "via") { print $(i + 1); exit } }')
  if [ -n "$default" ]; then add default-gateway "$default" 22 80 443 8080; else
    skip default-gateway "the VM has no IPv4 default route"
  fi
  # The provider's WireGuard: hosts inside each routed prefix of its peers (allowed-ips), and the
  # first hosts of the interface's own subnet.
  if ip link show dev wg0 >/dev/null 2>&1; then
    wg_net=$(ip -4 -o address show dev wg0 2>/dev/null | awk '{ print $4; exit }')
    say INFO isolation provider-wg0 "address ${wg_net:-none}"
    if has wg; then
      prefixes=$( (wg show wg0 allowed-ips 2>/dev/null || true) | awk '{ for (i = 2; i <= NF; i++) print $i }' | head -n 3)
      [ -n "$prefixes" ] || say INFO isolation provider-wg0-peer "no peer prefixes"
      for prefix in $prefixes; do
        hosts=$(hosts_for "$prefix")
        if [[ $hosts == not-covered* ]]; then skip provider-wg0-peer "$prefix ${hosts#not-covered }"; continue; fi
        for host in $hosts; do add provider-wg0-peer "$host" 22 80 443; done
      done
    else
      skip provider-wg0-peer "no wg on this VM to list the provider's peers"
    fi
    if [ -n "$wg_net" ]; then
      hosts=$(hosts_for "$wg_net")
      if [[ $hosts == not-covered* ]]; then skip provider-wg0-subnet "$wg_net ${hosts#not-covered }"; else
        for host in $hosts; do
          [ "$host" = "${wg_net%/*}" ] || add provider-wg0-subnet "$host" 22 80 443
        done
      fi
    fi
  else
    say INFO isolation provider-wg0 "absent"
  fi
  # Other VMs on the provider's private network: the first hosts of the primary subnet and up to
  # three neighbours the VM already knows.
  primary=$(ip -4 -o address show scope global 2>/dev/null | awk '$2 != "wg0" && $2 !~ /^(docker|br-|veth|sealant)/ { print $4; exit }')
  if [ -n "$primary" ]; then
    say INFO isolation primary-address "$primary"
    hosts=$(hosts_for "$primary")
    if [[ $hosts == not-covered* ]]; then skip provider-subnet-host "$primary ${hosts#not-covered }"; else
      for host in $hosts; do
        [ "$host" = "${primary%/*}" ] || add provider-subnet-host "$host" 22 80 443
      done
    fi
  else
    skip provider-subnet-host "the VM has no global IPv4 address"
  fi
  neighbours=$(ip -4 neigh show 2>/dev/null | awk -v gw="$default" '$1 != gw { print $1 }' | head -n 3)
  if [ -n "$neighbours" ]; then
    for neighbour in $neighbours; do add provider-neighbour "$neighbour" 22 80 443; done
  else
    say INFO isolation provider-neighbour "the VM knows no other neighbours"
  fi
else
  for check in default-gateway provider-wg0-peer provider-subnet-host provider-neighbour; do
    skip "$check" "no ip on this VM to discover the target"
  done
fi
# The VM's own public address, as the Internet sees it (informational: a NAT may answer for it).
if has curl; then
  public=$(curl -s --max-time 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
  if ipv4 "$public"; then
    say INFO isolation public-address "$public"
    # A fact, not a check: a NAT shared with something listening answers for it.
    if has timeout; then
      for port in 22 8080; do
        say INFO isolation own-public-address "$public:$port $(tcp "$public" "$port")"
      done
    fi
  else
    say INFO isolation public-address "not discovered"
  fi
else
  say INFO isolation public-address "no curl on this VM"
fi
prerequisites && probe_targets "$targets"

# The same targets from a host-network container: what a `docker run --network host` reaches.
if [ -n "$container_image" ]; then
  if has docker; then
    script=$(readlink -f "$0")
    container_output=$(docker run --rm --network host --label sealant-probe=vm-probe \
      -e PROBE_TARGETS="$targets" -e PROBE_WHERE=container \
      -v "$script":/vm-probe.sh:ro "$container_image" bash /vm-probe.sh --targets-only 2>&1)
    container_status=$?
    # Its check lines count toward the VM's verdict; its own SUMMARY is replaced by that verdict.
    while IFS= read -r line; do
      case $line in
        SUMMARY*) ;;
        PASS* | FAIL* | SKIP*)
          printf '%s\n' "$line"
          read -r verdict section _ <<< "$line"
          tally["$section.$verdict"]=$((${tally["$section.$verdict"]:-0} + 1))
          ;;
        *) [ -n "$line" ] && printf 'INFO  container  output                       %s\n' "$line" ;;
      esac
    done <<< "$container_output"
    [ "$container_status" = 0 ] || say FAIL container run "the host-network container exited $container_status"
  else
    say SKIP container run "no docker on this VM"
  fi
fi

sections=(isolation)
[ "$mode" = vm ] && sections=(kernel isolation)
[ -n "$container_image" ] && sections+=(container)
summary "${sections[@]}"
[ "$kernel_failures" = 0 ]
