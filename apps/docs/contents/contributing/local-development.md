---
title: Local development
description:
  Run the whole Sealant stack locally — web app, control-plane API, worker, and a real sandbox over
  SSH.
---

This page is an overview. The step-by-step runbook —
[`DEVELOPMENT.md`](https://github.com/sealant-sh/sealant/blob/main/DEVELOPMENT.md) at the repo root
— is canonical; this page won't repeat every command, just the shape of the stack and the parts
worth knowing before you dive in.

## Prerequisites

- **Docker** running — the worker and SSH gateway drive it to build and launch sandboxes.
- The **Nix dev shell** — `direnv allow` (or `nix develop`) gives you Node 24 and `pnpm`.

## Topology

Stateful infra plus the **worker** and **ssh-gateway** run in Docker; the **API** and **web** app
run on the host with hot reload. A single `.env` at the repo root is the source of truth — every app
reads it, and compose passes it to the gateway via `env_file`.

| Service                   | Where                                         | Port               |
| ------------------------- | --------------------------------------------- | ------------------ |
| postgres / rabbitmq / zot | `docker compose up -d`                        | 5433 / 5673 / 5000 |
| api                       | `pnpm --filter @sealant/api dev`              | 4000               |
| web                       | `pnpm --filter @sealant/web dev`              | 3000               |
| worker + ssh-gateway      | `docker compose --profile apps up -d --build` | gateway 2222       |

## One-time setup

```bash
pnpm install
cp .env.example .env          # dev defaults already point at local infra
pnpm ssh:setup:dev             # only if you want to SSH into sandboxes
```

`pnpm ssh:setup:dev` generates `.secrets/*` keys, writes a `Host sbx-*` block to your SSH config,
and appends the gateway vars — including a shared `SANDBOX_SSH_GATEWAY_TOKEN` — to `.env`.

## Running it

```bash
docker compose up -d                          # infra
pnpm db:migrate                               # schema
pnpm --filter @sealant/db db:seed             # default owner (SDK; web users sign up)
pnpm --filter @sealant/api dev                # :4000   (terminal 1)
pnpm --filter @sealant/web dev                # :3000   (terminal 2)
docker compose --profile apps up -d --build   # worker + ssh-gateway
```

Open [http://localhost:3000](http://localhost:3000), sign up, and create a sandbox. The worker
builds the image (pushed to the local zot registry) and launches the container — wait until it's
running/ready, then:

```bash
ssh -F ~/.config/sealant/ssh_config sbx-<sandboxId>
```

The gateway authorizes by owner: the principal your SSH key resolves to must match the sandbox's
owner. See [SSH access](/docs/guides/ssh-access) for how key resolution and authorization work.

## Gotchas worth knowing up front

- **Worker and ssh-gateway run from a built image.** After a code change (or merging `main`),
  rebuild with `docker compose --profile apps up -d --build <service>` — a plain `restart` runs
  stale code.
- **`db:seed` needs `DATABASE_URL`.** Run it from the Nix shell, or set it inline.
- **Bare `pnpm dev` starts every workspace** (web and docs both bind `:3000`). Scope with
  `--filter`.
- **"Connection closed" right after the SSH banner** is authorization, not SSH — check
  `docker compose logs --tail=5 ssh-gateway`. Usually the resolved principal doesn't own the
  sandbox, the key isn't registered, or the sandbox isn't running yet.

## After you change code

Follow the repo-wide agent defaults in
[`AGENTS.md`](https://github.com/sealant-sh/sealant/blob/main/AGENTS.md): run `pnpm format:fix`, use
`pnpm typecheck` (`tsgo`, not `tsc`), and never hand-edit `pnpm-lock.yaml`.

## Releasing

Packaging, image builds, and the self-host installer flow are covered in
[`DEVELOPMENT.md`](https://github.com/sealant-sh/sealant/blob/main/DEVELOPMENT.md#releasing-packaged-self-host)
and in [Installer and compose](/docs/reference/installer-and-compose).
