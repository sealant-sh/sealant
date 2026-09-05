# The controller only needs Node, git, and a Docker CLI. Workspace data arrives on named volumes.
FROM docker:27.5.1-cli AS docker-cli

FROM node:24-alpine AS controller
RUN apk add --no-cache git
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY controller.cjs /opt/sealant-volume-e2e/controller.cjs
ENTRYPOINT ["node", "/opt/sealant-volume-e2e/controller.cjs"]

# Keep the daemon and socat relay on the published version under proof.
FROM ghcr.io/sealant-sh/sealantd:0.13.0 AS sealantd

FROM fedora:41 AS workspace
RUN dnf install -y bash ca-certificates coreutils git openssh-clients shadow-utils tar \
    && dnf clean all \
    && rm -rf /var/cache/dnf
COPY --from=sealantd /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --from=sealantd /usr/local/bin/socat /usr/local/bin/socat
RUN mkdir -p /workspace /run/sealant
ENV SEALANT_OS_FAMILY=fedora \
    SEALANT_WORKSPACE_ROOT=/workspace \
    SEALANT_WORKING_DIRECTORY=/workspace/repo \
    SEALANT_LOGIN_SHELL_PATH=/bin/bash \
    SEALANT_BASH_SHELL_PATH=/bin/bash \
    SEALANT_SSHD_PATH=/usr/sbin/sshd \
    SEALANT_CONTROL_SOCKET=/run/sealant/control.sock \
    SEALANT_LIFECYCLE_SETUP_JSON=[] \
    SEALANT_LIFECYCLE_STARTUP_JSON=[]
ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]
