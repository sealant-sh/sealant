# SSH gateway. Multi-stage: the builder esbuild-bundles the gateway into one JS file (ssh2 kept
# external — it has native bindings); the runtime is a slim node image with just ssh2 installed. Runs
# `node dist/index.js` — no tsx, no monorepo source.
FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @sealant/ssh-gateway build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# No Docker CLI and no docker.sock: the gateway reaches sandboxes only through the §2.2 bind-mounted
# control sockets (unix://), so a gateway compromise can never touch the host Docker daemon.
# ssh2 has native bindings and is kept out of the bundle; install just it (skip the optional
# cpu-features native addon — ssh2 runs without it).
RUN npm install --omit=dev --omit=optional ssh2@^1.17.0 && npm cache clean --force
COPY --from=builder /app/apps/ssh-gateway/dist ./dist
CMD ["node", "dist/index.js"]
