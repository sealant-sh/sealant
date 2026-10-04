# Build worker. Multi-stage: the builder esbuild-bundles the worker into one JS file; the runtime is a
# slim node image with the Docker CLI + git (the worker shells out to the HOST Docker daemon to build
# images and launch workspaces, and to git for clones). Runs `node dist/index.js` — no tsx, no monorepo.
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
RUN pnpm --filter @sealant/worker build
# The bundled Agent SDK spawns its vendored `claude` CLI (the session keep-fresh sweeper's refresh
# ping), resolved at runtime as @anthropic-ai/claude-agent-sdk-{platform}-{arch} from a node_modules
# next to the bundle. Stage the builder-resolved platform package so the runtime carries it at the
# version the bundle expects — mirrors apps/api/Dockerfile.
RUN node tooling/scripts/stage-agent-cli.mjs apps/worker /staged
# Same for the Codex CLI: the Codex keep-fresh sweeper spawns @openai/codex/bin/codex.js
# (`app-server`), which resolves its @openai/codex-{platform}-{arch} vendored binary next to the
# bundle — mirrors apps/api/Dockerfile.
RUN node tooling/scripts/stage-codex-cli.mjs apps/worker /staged

# Docker 27 carries CLI/API support for named-volume subpaths (API >= 1.45). Copy the official,
# version-pinned CLI instead of relying on Debian's older docker.io package.
FROM docker:27.5.1-cli AS docker-cli

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
# Workspace image builds force DOCKER_BUILDKIT=1, which requires the matching buildx plugin.
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN docker buildx version
WORKDIR /app
COPY --from=builder /app/apps/worker/dist ./dist
# What a MicroVM workspace image's recipe copies in: the in-VM agent and the guest-local Docker
# installer. The MicroVM image builder reads them from beside dist/ and sends them with each build.
COPY --from=builder /app/packages/workspaces/microvm-image/ ./microvm-image/
# The Agent SDK's platform package (the keep-fresh sweeper spawns its `claude` binary) — see the
# builder stage.
COPY --from=builder /staged/node_modules ./node_modules
# Assert the vendored claude binary resolves exactly the way the bundle will resolve it at runtime,
# per arch — a broken layout must fail the image build, not the first sweep in production.
RUN node -e "const{createRequire}=require('node:module');const p=createRequire('/app/dist/index.js').resolve('@anthropic-ai/claude-agent-sdk-'+process.platform+'-'+process.arch+'/claude');require('node:fs').accessSync(p);console.log('claude CLI resolvable: '+p)"
# Same assert for the Codex CLI: the launcher AND its platform binary package must both resolve.
RUN node -e "const{createRequire}=require('node:module');const r=createRequire('/app/dist/index.js');const launcher=r.resolve('@openai/codex/bin/codex.js');require('node:fs').accessSync(launcher);const platform=createRequire(r.resolve('@openai/codex/package.json')).resolve('@openai/codex-'+process.platform+'-'+process.arch+'/package.json');console.log('codex CLI resolvable: '+launcher+' (+ '+platform+')')"
# Runs as root so it can reach the mounted /var/run/docker.sock (host root:docker).
CMD ["node", "dist/index.js"]
