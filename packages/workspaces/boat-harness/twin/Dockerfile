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
# archive is down: the stack probes both, as recipe.e2e.ts does). Only the systemd source comes
# from the snapshot, the one place that still has the pinned version: every binary package built
# from it (systemd-dev too, which systemd pulls in) is pinned there by an apt preference, since the
# native recipe refuses a VM whose systemd-source packages differ in version. The snapshot source,
# the pin and the retry setting are removed again; the image ends on the stock sources. The
# snapshot service answers 503 for some files at times, so it serves only this.
RUN printf 'Acquire::Retries "6";\n' > /etc/apt/apt.conf.d/80-harness-build-retries \
    && cp /etc/apt/sources.list.d/ubuntu.sources /tmp/ubuntu.sources.stock \
    && if [ "${UBUNTU_ARCHIVE}" != http://archive.ubuntu.com/ubuntu ]; then \
      sed -i -e "s|http://archive.ubuntu.com/ubuntu|${UBUNTU_ARCHIVE}|g" \
             -e "s|http://security.ubuntu.com/ubuntu|${UBUNTU_ARCHIVE}|g" /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
    && apt-get update --error-on=any \
    # The snapshot is HTTPS-only, so trust roots come first.
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
    && printf '%s\n' 'Types: deb' "URIs: ${SNAPSHOT}" 'Suites: noble-updates noble-security' \
         'Components: main' 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' \
         > /etc/apt/sources.list.d/harness-snapshot.sources \
    && printf '%s\n' 'Package: src:systemd' "Pin: version ${SYSTEMD_VERSION}" 'Pin-Priority: 1001' \
         > /etc/apt/preferences.d/harness-systemd \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades --no-install-recommends \
       systemd systemd-sysv libsystemd0 libsystemd-shared libudev1 \
       dbus sudo python3 iproute2 ca-certificates curl kmod \
    && rm -f /etc/apt/sources.list.d/harness-snapshot.sources /etc/apt/preferences.d/harness-systemd \
         /etc/apt/apt.conf.d/80-harness-build-retries \
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
# The native recipe's own check (recipe.ts `systemdBaseSetup`): every installed package built from
# the systemd source carries the pinned version. A twin it would refuse fails here, by name.
RUN mixed=$(dpkg-query -W -f='${binary:Package} ${source:Package} ${Version} ${db:Status-Status}\n' \
      | awk -v want="${SYSTEMD_VERSION}" '$2 == "systemd" && $4 == "installed" && $3 != want {print $1 "=" $3}') \
    && if [ -n "$mixed" ]; then \
      echo "twin: systemd-source packages not at ${SYSTEMD_VERSION} (the native recipe refuses this): $mixed" >&2; \
      exit 1; \
    fi
COPY twin-init /usr/local/sbin/twin-init
RUN chmod 0755 /usr/local/sbin/twin-init
LABEL sh.sealant.boat-harness=twin-base
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/usr/local/sbin/twin-init"]
