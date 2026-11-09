# Boat guest twin: the closest local stand-in for a Boat `small` VM that a Docker host can run.
# Facts come from committed evidence (docs/experiments/boat-runtime.md, boat-provider-lifetime*.json,
# recipe.ts) and the 2026-11-09 audits: Ubuntu 24.04, systemd 255.4-1ubuntu8.16 as PID 1 on cgroup v2,
# commands run as uid 1000 `user` with passwordless sudo, and a provider-owned outer `wg0` at boot.
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
ARG SNAPSHOT=https://snapshot.ubuntu.com/ubuntu/20260731T000000Z
ARG SYSTEMD_VERSION=255.4-1ubuntu8.16
ENV container=docker
# The snapshot archive is HTTPS-only, so trust roots come from the base archive first.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
    && sed -i "s|^URIs: .*|URIs: ${SNAPSHOT}|" /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades --no-install-recommends \
       systemd=${SYSTEMD_VERSION} systemd-sysv=${SYSTEMD_VERSION} libsystemd0=${SYSTEMD_VERSION} \
       libsystemd-shared=${SYSTEMD_VERSION} libudev1=${SYSTEMD_VERSION} \
       dbus sudo python3 iproute2 ca-certificates curl kmod \
    && rm -rf /var/lib/apt/lists/* \
    # A Boat VM uses the stock archive. The snapshot was only for the pinned systemd, and it is slow.
    && sed -i -e "s|^URIs: ${SNAPSHOT}$|URIs: http://archive.ubuntu.com/ubuntu/|" /etc/apt/sources.list.d/ubuntu.sources \
    && sed -i -e "0,/archive.ubuntu.com/! s|^URIs: http://archive.ubuntu.com/ubuntu/$|URIs: http://security.ubuntu.com/ubuntu/|" /etc/apt/sources.list.d/ubuntu.sources
# Boat's command user is uid 1000 named `user` (boat-runtime.md: "The command user was uid 1000").
RUN usermod -l user -d /home/user -m ubuntu && groupmod -n user ubuntu \
    && printf '%s\n' 'user ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-boat-user \
    && chmod 0440 /etc/sudoers.d/90-boat-user && visudo -cf /etc/sudoers.d/90-boat-user
# Units that cannot work, or only add noise, inside a container.
RUN systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
       getty.target console-getty.service systemd-logind.service systemd-networkd-wait-online.service \
       systemd-resolved.service apt-daily.timer apt-daily-upgrade.timer motd-news.timer \
       systemd-timesyncd.service e2scrub_reap.service \
    && rm -f /etc/machine-id && touch /etc/machine-id
COPY twin-init /usr/local/sbin/twin-init
RUN chmod 0755 /usr/local/sbin/twin-init
LABEL sh.sealant.boat-harness=twin-base
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/usr/local/sbin/twin-init"]
