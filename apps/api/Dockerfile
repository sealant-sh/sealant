# Dev-grade image for the control-plane API. Runs the TypeScript directly via tsx (no build step),
# matching apps/worker + apps/ssh-gateway. The API only talks to Postgres/RabbitMQ/registry over the
# network — it does NOT need the Docker CLI or git (only the worker does, for building/launching).
FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile

# The API reads its config from process.env (provided by compose), so no dotenv wrapper here.
CMD ["pnpm", "--filter", "@sealant/api", "exec", "tsx", "src/index.ts"]
