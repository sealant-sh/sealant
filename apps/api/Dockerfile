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
# QEMU-emulated arm64 builds are slow enough that pnpm's default registry fetch timeout trips
# (ERR_PNPM_BROKEN_METADATA_JSON, twice on the v0.17.0 release) — give the fetch real room.
RUN pnpm config set fetch-timeout 600000 && pnpm config set fetch-retries 5
RUN pnpm install --lockfile=false
RUN pnpm --filter @sealant/api build
# The bundled Agent SDK spawns its vendored `claude` CLI, resolved at runtime as
# @anthropic-ai/claude-agent-sdk-{platform}-{arch} from a node_modules next to the bundle. Stage the
# builder-resolved platform package so the runtime carries it at the version the bundle expects.
RUN node tooling/scripts/stage-agent-cli.mjs apps/api /staged

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/apps/api/dist ./dist
# Committed SQL migrations for dist/migrate.js (folder-per-migration layout drizzle-orm reads directly).
COPY --from=builder /app/packages/db/drizzle ./drizzle
# The Agent SDK's platform package (inference spawns its `claude` binary) — see the builder stage.
COPY --from=builder /staged/node_modules ./node_modules
# Assert the vendored claude binary resolves exactly the way the bundle will resolve it at runtime,
# per arch — a broken layout must fail the image build, not the first inference in production.
RUN node -e "const{createRequire}=require('node:module');const p=createRequire('/app/dist/index.js').resolve('@anthropic-ai/claude-agent-sdk-'+process.platform+'-'+process.arch+'/claude');require('node:fs').accessSync(p);console.log('claude CLI resolvable: '+p)"
USER node
CMD ["node", "dist/index.js"]
