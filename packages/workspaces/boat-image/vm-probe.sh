#!/bin/bash
# Boat VM probe: run first, on a fresh Boat VM, before any session.
#
#   sudo bash vm-probe.sh                      # kernel, as VM root
#   sudo bash vm-probe.sh --container IMAGE    # then one container, run by the VM's own Docker
#
# One line per check:
#   kernel     what a root dockerd in the VM needs. FAIL here means Docker will not work.
#   container  a container the VM's Docker ran on its default bridge network: the kernel features
#              above, used for real. FAIL means Docker is there and could not run it.
#
# It looks at this VM only (and at Docker Hub, which an image pull needs). What a guest can reach on
# the provider's network is not its question: Boat's network is the deployment owner's own
# infrastructure, and nothing here connects to it.
# Every kernel object it creates carries a sealant-probe name and is removed before the next check.
#
# Output: one line per check, `PASS|FAIL|SKIP <section> <check> <detail>`; `INFO` lines are facts,
# not checks. A check that could not be made (a tool missing) is a SKIP with its reason. The last
# line is the verdict:
#   SUMMARY kernel pass=N fail=N skip=N result=PASS|FAIL|INCOMPLETE
#   SUMMARY kernel pass=N fail=N skip=N container pass=N fail=N skip=N result=PASS|FAIL|INCOMPLETE
# result is FAIL when any check failed, INCOMPLETE when none failed but the container check was
# asked for and skipped (no Docker on the VM), and PASS only when every check ran and passed.
# Exit status: 1 when a kernel or container check fails (Docker will not work), otherwise 0.
set -u
export LC_ALL=C PATH=${PROBE_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}

container_image=
case "${1:-}" in
  --container) container_image=${2:?an image the VM can pull or already has, e.g. ubuntu:24.04} ;;
  "") ;;
  *) echo "usage: vm-probe.sh [--container IMAGE]" >&2; exit 2 ;;
esac

failures=0
declare -A tally=()
# Every check line goes through here, so the summary counts exactly what was printed.
say() {
  printf '%-5s %-10s %-28s %s\n' "$1" "$2" "$3" "${4:-}"
  case "$1" in PASS | FAIL | SKIP) tally["$2.$1"]=$((${tally["$2.$1"]:-0} + 1)) ;; esac
  [ "$1" = FAIL ] && failures=$((failures + 1))
  return 0
}
summary() {
  local line="SUMMARY" section failed=0 skipped=0 result
  for section in "$@"; do
    line+=" $section pass=${tally[$section.PASS]:-0} fail=${tally[$section.FAIL]:-0} skip=${tally[$section.SKIP]:-0}"
    failed=$((failed + ${tally[$section.FAIL]:-0}))
    # A kernel SKIP is a tool the kernel check did not need; a container SKIP is a check missing.
    [ "$section" != kernel ] && skipped=$((skipped + ${tally[$section.SKIP]:-0}))
  done
  if [ "$failed" -gt 0 ]; then result=FAIL; elif [ "$skipped" -gt 0 ]; then result=INCOMPLETE; else result=PASS; fi
  printf '%s result=%s\n' "$line" "$result"
}
has() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" = 0 ] || { echo "vm-probe: run as root (sudo bash vm-probe.sh)" >&2; exit 2; }
say INFO kernel release "$(uname -r)"

# --- kernel: a root dockerd with overlay2, a bridge, veth pairs and nftables NAT ----------------
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
  fi
else
  say SKIP kernel docker-hub "no curl on this VM"
fi

# --- container: the VM's own Docker runs one, on its default bridge network -----------------------
sections=(kernel)
if [ -n "$container_image" ]; then
  sections+=(container)
  if has docker; then
    container_output=$(docker run --rm --label sealant-probe=vm-probe "$container_image" true 2>&1)
    container_status=$?
    if [ "$container_status" = 0 ]; then say PASS container run "$container_image ran and exited 0"; else
      # Docker's last line says why (no such image, no bridge, no runtime); the rest is progress.
      say FAIL container run "docker run exited $container_status: $(printf '%s\n' "$container_output" | tail -n 1)"
    fi
  else
    say SKIP container run "no docker on this VM"
  fi
fi

summary "${sections[@]}"
[ "$failures" = 0 ]
