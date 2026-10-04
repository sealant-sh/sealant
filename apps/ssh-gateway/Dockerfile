# SSH gateway. Multi-stage: the builder esbuild-bundles the gateway into one JS file (ssh2 kept
# external — it has native bindings); the runtime is a slim node image with just ssh2 installed. Runs
# `node dist/index.js` — no tsx, no monorepo source.
FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable
WORKDIR /app

COPY . .
# QEMU-emulated arm64 builds are slow enough that pnpm's default registry fetch timeout trips
# (ERR_PNPM_BROKEN_METADATA_JSON, twice on the v0.17.0 release) — give the fetch real room.
RUN pnpm config set fetch-timeout 600000 && pnpm config set fetch-retries 5
# Bound to the committed pnpm-lock.yaml: an image never resolves a dependency the lockfile did not
# name, so a package published after the commit (a prerelease of our own included) cannot drift in.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sealant/ssh-gateway build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# No Docker CLI and no docker.sock: the gateway reaches workspaces only through the §2.2 bind-mounted
# control sockets (unix://), so a gateway compromise can never touch the host Docker daemon.
# ssh2 has native bindings and is kept out of the bundle; install just it (skip the optional
# cpu-features native addon — ssh2 runs without it). Exact: the version pnpm-lock.yaml resolves for
# apps/ssh-gateway, so the runtime carries the ssh2 the bundle was built and tested against.
RUN npm install --omit=dev --omit=optional ssh2@1.17.0 && npm cache clean --force
COPY --from=builder /app/apps/ssh-gateway/dist ./dist
CMD ["node", "dist/index.js"]
