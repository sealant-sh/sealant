# Control-plane API. Multi-stage: the builder installs the workspace and esbuild-bundles the API into a
# single self-contained JS file; the runtime is a slim node image that runs `node dist/index.js` — no
# tsx, no monorepo source, no node_modules at runtime. The `builder` stage is reused by the compose
# `migrate` one-shot (it has drizzle-kit + the migrations).
FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @sealant/api build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/apps/api/dist ./dist
USER node
CMD ["node", "dist/index.js"]
