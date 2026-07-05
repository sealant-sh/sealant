# Local development

How to run the whole Sealant stack locally — web app, a real sandbox, and SSH into it.

## Prerequisites

- **Docker** running (the worker + ssh-gateway drive it to build/launch sandboxes).
- The **Nix dev shell** — `direnv allow` (or `nix develop`) gives Node 24 + pnpm.

## One-time setup

```bash
pnpm install
cp .env.example .env                                  # the dev defaults already point at local infra
pnpm ssh:setup:dev                                    # only if you want to SSH into sandboxes
```

`pnpm ssh:setup:dev` generates `.secrets/*` keys, writes a `Host sbx-*` block to your SSH config
(`~/.config/sealant/ssh_config`, included from `~/.ssh/config` when writable), and appends the
gateway vars — including a shared `SANDBOX_SSH_GATEWAY_TOKEN` — to **`.env`**.

## Topology

Stateful infra + the **worker** + the **ssh-gateway** run in Docker; the **API** and **web** run on
the host (hot reload). `.env` is the single source of truth — every app reads it
(`dotenv -e ../../.env`), and compose passes it to the gateway via `env_file`.

| Service                   | Where                                         | Port               |
| ------------------------- | --------------------------------------------- | ------------------ |
| postgres / rabbitmq / zot | `docker compose up -d`                        | 5433 / 5673 / 5000 |
| api                       | `pnpm --filter @sealant/api dev`              | 4000               |
| web                       | `pnpm --filter @sealant/web dev`              | 3000               |
| worker + ssh-gateway      | `docker compose --profile apps up -d --build` | gateway 2222       |

## Run it

```bash
docker compose up -d                                  # infra
pnpm db:migrate                                       # schema
pnpm --filter @sealant/db db:seed                     # default owner (SDK/CLI; web users sign up)
pnpm --filter @sealant/api dev                        # :4000   (terminal 1)
pnpm --filter @sealant/web dev                        # :3000   (terminal 2)
docker compose --profile apps up -d --build           # worker + ssh-gateway
```

Open **http://localhost:3000**, log in, and start a sandbox. The worker builds the image (pushed to
zot) and launches the container; wait until it's running/ready.

## SSH into a sandbox

```bash
ssh -F ~/.config/sealant/ssh_config sbx-<sandboxId>
```

The `-F` form uses the generated config + an isolated `known_hosts` — no `~/.ssh` edits, and it
survives regenerating the gateway key (so no "host identification changed" warnings).

### Authorization (current ACL)

The gateway authorizes by **owner**: the principal your SSH key resolves to must equal the sandbox's
`ownerUserId`. Keys resolve two ways, in this order:

1. **DB-registered keys** (the normal path): the gateway looks the offered key up in the `ssh_keys`
   table via the API (`POST /v1/ssh-keys/resolve-principal`) on every connection — no restart
   needed. Web users register keys under **Settings → SSH keys** (profile dropdown) or inline when
   creating a sandbox; `db:seed` registers `.secrets/dev_client_key.pub` under `usr_local` for the
   SDK/self-host flow.
2. **The static file `.secrets/gateway_allowed_keys`** (operator break-glass): loaded once at
   gateway start; the trailing comment is the principal. Works even when the API is down, but
   requires a rebuild/restart to change.

## Releasing (packaged self-host)

Users install with `curl -fsSL …/install.sh | sh` (see README) — prebuilt images, no source build.
The pieces:

- **Images**: `.github/workflows/release.yml` builds + pushes multi-arch
  `ghcr.io/get-sealant/sealant-{api,worker,ssh-gateway,web}` on every `vX.Y.Z` tag, smoke-tests the
  installer against them, then publishes the GitHub release with `compose.selfhost.yaml` attached.
  Creating the release is what moves `releases/latest`, i.e. what the installer resolves.
- **Cutting a release**: push a `vX.Y.Z` tag. After the very first release, flip the four GHCR
  packages to public (one-time, per package) or anonymous pulls fail.
- **Local dry-run**: build the images with the same Dockerfiles
  (`docker build -f apps/<app>/Dockerfile -t ghcr.io/get-sealant/sealant-<name>:0.0.0-dev .`), then
  `SEALANT_VERSION=0.0.0-dev SEALANT_COMPOSE_URL=$PWD/compose.selfhost.yaml sh install.sh`. Offset
  ports (`SEALANT_{WEB,API,SSH,REGISTRY}_PORT`) let it coexist with the dev stack.
- **Migrations in the packaged path** run from the api image (`node dist/migrate.js`, programmatic
  drizzle migrator + seed) — same journal table as dev `pnpm db:migrate`, so the histories are
  interchangeable.

## Gotchas

- **Worker / ssh-gateway run from a built image** — after a code change (or merging `main`), you
  must `docker compose --profile apps up -d --build <svc>`. A `restart` runs stale code.
- **`db:seed` needs `DATABASE_URL`** (no default). Run it from the Nix shell, or inline it.
- **Bare `pnpm dev`** starts _every_ workspace (web + docs both bind :3000, mobile/expo, …). Scope
  with `--filter`.
- **"Connection closed" right after the gateway banner** is authorization, not SSH: check
  `docker compose logs --tail=5 ssh-gateway`. Usually the principal ≠ owner (above), the key isn't
  registered (web: Settings → SSH keys; SDK: re-run `db:seed`), or the sandbox isn't running.
- **"Host identification has changed"** means you regenerated the gateway key. The `-F` form avoids
  it; if you used the global known_hosts, run `ssh-keygen -R "[localhost]:2222"`.
