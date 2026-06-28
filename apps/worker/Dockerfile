# Build worker. Multi-stage: the builder esbuild-bundles the worker into one JS file; the runtime is a
# slim node image with the Docker CLI + git (the worker shells out to the HOST Docker daemon to build
# images and launch sandboxes, and to git for clones). Runs `node dist/index.js` — no tsx, no monorepo.
FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @sealant/worker build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates docker.io git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/apps/worker/dist ./dist
# Runs as root so it can reach the mounted /var/run/docker.sock (host root:docker).
CMD ["node", "dist/index.js"]
