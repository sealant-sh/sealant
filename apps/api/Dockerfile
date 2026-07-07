# Control-plane API. Multi-stage: the builder installs the workspace and esbuild-bundles the API into
# self-contained JS files; the runtime is a slim node image that runs `node dist/index.js` — no tsx, no
# monorepo source, no node_modules at runtime. The bundle also contains dist/migrate.js (programmatic
# drizzle migrator + seed) and the committed SQL migrations, so the compose `migrate` one-shot runs from
# this same prebuilt image: `node dist/migrate.js`.
FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sealant/api build
# The bundled Agent SDK spawns its vendored `claude` CLI, resolved at runtime as
# @anthropic-ai/claude-agent-sdk-{platform}-{arch} from a node_modules next to the bundle. Stage the
# builder-resolved platform package so the runtime carries it at the version the bundle expects.
RUN node tooling/scripts/stage-agent-cli.mjs /staged

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/apps/api/dist ./dist
# Committed SQL migrations for dist/migrate.js (folder-per-migration layout drizzle-orm reads directly).
COPY --from=builder /app/packages/db/drizzle ./drizzle
# The Agent SDK's platform package (inference spawns its `claude` binary) — see the builder stage.
COPY --from=builder /staged/node_modules ./node_modules
USER node
CMD ["node", "dist/index.js"]
