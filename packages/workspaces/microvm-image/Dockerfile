# The Sealant workspace image for AWS Lambda MicroVMs.
#
# Built by the Lambda MicroVM image service (CreateMicrovmImage) from this directory zipped with
# the Dockerfile at the root — see build-image.sh, which also stages the sealantd binaries into
# the context. One generic image serves every blueprint: nothing session-specific is baked in.
# The control plane pushes each launch's boot env, secret env file and dotfiles to the agent
# over the VM's authenticated endpoint, and the agent starts `sealantd boot` (agent.mjs).
#
# Image contract:
#   :8080  the agent — lifecycle hooks (/aws/lambda-microvms/runtime/v1/*), the launch push
#          (/sealant/launch), health (/sealant/health) and the control relay (/sealant/control).
#          The image registers the same port for hooks; the endpoint targets it by default.
#   The base is AL2023 on ARM64 (the only architecture the platform runs). It ships
#   `coreutils-single`; installing `coreutils` conflicts with it and fails the build — never add it.
ARG BASE_IMAGE=public.ecr.aws/lambda/microvms:al2023-minimal
FROM ${BASE_IMAGE}

RUN dnf install -y --setopt=install_weak_deps=0 \
      bash tar gzip zip unzip git util-linux procps-ng findutils which \
      curl-minimal openssh-server \
      nodejs npm \
    && node --version && git --version \
    && npm install -g pnpm@10 \
    && dnf clean all

# The daemon (PID-1 supervisor of the workspace) and its CLI, staged by build-image.sh from the
# released sealantd image at the same path every other Sealant workspace image uses. socat is
# the daemon image's static relay; kept for local tooling parity.
COPY --chmod=755 sealantd /usr/local/bin/sealantd
COPY --chmod=755 sealantctl /usr/local/bin/sealantctl
COPY --chmod=755 socat /usr/local/bin/socat
COPY agent.mjs /opt/sealant/agent.mjs

# Build-static `sealantd boot` facts (crates/sealantd/src/boot/config.rs). The launch push
# carries everything else (source, lifecycle, harness, env). `custom` keeps boot's POSIX-shell
# defaults; the login shell is set explicitly because AL2023 has bash, not zsh.
ENV PATH=/usr/local/bin:$PATH \
    SEALANT_OS_FAMILY=custom \
    SEALANT_WORKSPACE_ROOT=/workspace \
    SEALANT_WORKING_DIRECTORY=/workspace/repo \
    SEALANT_LOGIN_SHELL_PATH=/bin/bash \
    SEALANT_BASH_SHELL_PATH=/bin/bash \
    SEALANT_SSHD_PATH=/usr/sbin/sshd \
    SEALANT_CONTROL_SOCKET=/run/sealant/control.sock \
    SEALANT_MICROVM_AGENT_PORT=8080

RUN mkdir -p /workspace /run/sealant && git config --system safe.directory "*"

WORKDIR /workspace
ENTRYPOINT ["node", "/opt/sealant/agent.mjs"]
