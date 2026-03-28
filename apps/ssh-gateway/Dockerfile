FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile

CMD ["pnpm", "--filter", "@sealant/ssh-gateway", "exec", "tsx", "src/index.ts"]
