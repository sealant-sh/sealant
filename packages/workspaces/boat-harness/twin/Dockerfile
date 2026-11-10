# Boat guest twin: the closest local stand-in for a Boat `small` VM that a Docker host can run.
# Facts come from committed evidence (docs/experiments/boat-runtime.md, boat-provider-lifetime*.json,
# recipe.ts) and the 2026-11-09 audits: Ubuntu 24.04, systemd 255.4-1ubuntu8.16 as PID 1 on cgroup v2,
# commands run as uid 1000 `user` with passwordless sudo, and a provider-owned outer `wg0` at boot.
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
ARG SNAPSHOT=https://snapshot.ubuntu.com/ubuntu/20260731T000000Z
ARG SYSTEMD_VERSION=255.4-1ubuntu8.16
# The stock archive, or a full mirror of it (see below; the stack picks one and, when only the
# mirror answers, points the running twins at it too).
ARG UBUNTU_ARCHIVE=http://archive.ubuntu.com/ubuntu
ENV container=docker
# Packages come from the stock archive, as on a Boat VM (or from a full mirror of it when the
# archive is down: the stack probes both, as recipe.e2e.ts does). Only the pinned systemd comes from
# the snapshot, the one place that still has that version, through a second source used for five
# packages and removed again; the snapshot service answers 503 for some files at times, so the
# less it serves, the better. apt retries each fetch during the build; the image ends on the stock
# sources, without the retry setting.
RUN printf 'Acquire::Retries "6";\n' > /etc/apt/apt.conf.d/80-harness-build-retries \
    && cp /etc/apt/sources.list.d/ubuntu.sources /tmp/ubuntu.sources.stock \
    && if [ "${UBUNTU_ARCHIVE}" != http://archive.ubuntu.com/ubuntu ]; then \
      sed -i -e "s|http://archive.ubuntu.com/ubuntu|${UBUNTU_ARCHIVE}|g" \
             -e "s|http://security.ubuntu.com/ubuntu|${UBUNTU_ARCHIVE}|g" /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
    && apt-get update --error-on=any \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates dbus sudo python3 iproute2 curl kmod \
    # The snapshot is HTTPS-only, so it comes after ca-certificates.
    && printf '%s\n' 'Types: deb' "URIs: ${SNAPSHOT}" 'Suites: noble-updates noble-security' \
         'Components: main' 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' \
         > /etc/apt/sources.list.d/harness-snapshot.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades --no-install-recommends \
       systemd=${SYSTEMD_VERSION} systemd-sysv=${SYSTEMD_VERSION} libsystemd0=${SYSTEMD_VERSION} \
       libsystemd-shared=${SYSTEMD_VERSION} libudev1=${SYSTEMD_VERSION} \
    && rm -f /etc/apt/sources.list.d/harness-snapshot.sources /etc/apt/apt.conf.d/80-harness-build-retries \
    && mv /tmp/ubuntu.sources.stock /etc/apt/sources.list.d/ubuntu.sources \
    && rm -rf /var/lib/apt/lists/*
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
# Boat restores its own systemd executable on a clone and rewrites .bashrc (same length).
RUN install -d -m 0755 /var/lib/boat-twin \
    && cp /usr/lib/systemd/systemd /var/lib/boat-twin/provider-systemd \
    && printf '%s\n' '# boat-sandbox bx_00000000' >> /home/user/.bashrc
COPY twin-init /usr/local/sbin/twin-init
RUN chmod 0755 /usr/local/sbin/twin-init
LABEL sh.sealant.boat-harness=twin-base
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/usr/local/sbin/twin-init"]
