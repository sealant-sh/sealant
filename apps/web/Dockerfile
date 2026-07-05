# Product web app (TanStack Start). Multi-stage: the builder installs the workspace, builds the
# client + SSR bundles, and prunes a production node_modules via `pnpm deploy` (vite bundles the
# workspace packages but keeps npm deps external, so the SSR bundle needs them at runtime); the
# runtime serves dist/ with server.mjs (node builtins only — no HTTP framework).
#
# IMPORTANT: never pass VITE_API_URL as a build arg/env here. The server reads CORE_API_BASE_URL at
# runtime, and a VITE_ value baked into the bundle at build time would shadow it.
FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sealant/web build
RUN pnpm --filter @sealant/web deploy --legacy --prod /deploy

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /app/apps/web/dist ./dist
COPY --from=builder /app/apps/web/server.mjs ./server.mjs
USER node
CMD ["node", "server.mjs"]
