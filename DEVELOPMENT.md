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

`pnpm ssh:setup:dev` appends the gateway vars — including a shared `SANDBOX_SSH_GATEWAY_TOKEN` — to
**`.env`**. That's all it does: the gateway's host key autogenerates on first boot (into the
`gateway-keys` compose volume, same mechanism as the packaged self-host stack), and your client key
is your own — registered through the web app (first-run `/setup` wizard or **Settings → SSH keys**),
which also prints the `Host sbx-*` block to paste into `~/.ssh/config`.

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

Open **http://localhost:3000**. With an empty database the web app routes you to the first-run
**`/setup` wizard**: create your account, paste your SSH public key, and copy the `Host sbx-*` block
into `~/.ssh/config`. Then start a sandbox — the worker builds the image (pushed to zot) and
launches the container; wait until it's running/ready.

## SSH into a sandbox

```bash
ssh sbx-<sandboxId>
```

Works once the wizard's `Host sbx-*` block is in your `~/.ssh/config` and your key is registered. No
generated identities, no `IdentityFile` pinning — the gateway authenticates whatever key your SSH
client offers against the keys registered to your account.

### Authorization (current ACL)

The gateway authorizes by **owner**: the principal your SSH key resolves to must equal the sandbox's
`ownerUserId`. Keys resolve two ways, in this order:

1. **DB-registered keys** (the normal path): the gateway looks the offered key up in the `ssh_keys`
   table via the API (`POST /v1/ssh-keys/resolve-principal`) on every connection — no restart
   needed. Users register keys in the first-run `/setup` wizard, under **Settings → SSH keys**, or
   inline when creating a sandbox.
2. **The static file `/keys/gateway_allowed_keys`** in the `gateway-keys` volume (operator
   break-glass): loaded once at gateway start; the trailing comment is the principal. Works even
   when the API is down, but requires a restart to change.

### SSH into SDK-created sandboxes (`usr_local`)

The SDK stamps `ownerUserId=usr_local` (seeded by `db:seed`), so your web account's key won't
authorize you into SDK-created sandboxes. Two options:

- **Recommended:** point the SDK at your real account — `SEALANT_OWNER_USER_ID=<your web user id>` —
  so SDK sandboxes are owned by you and your registered key just works.
- **Break-glass:** add a **dedicated** keypair's public key to `/keys/gateway_allowed_keys` (in the
  `gateway-keys` volume) with the trailing comment `usr_local`, and connect with `-i` pointing at
  that key. Never list your main key there: the static file wins over the DB, so it would remap
  **all** your connections to `usr_local`. (`SEALANT_DEV_SSH_PUBLIC_KEY_FILE` on the seed does the
  DB-side equivalent for automation.)

## Releasing (packaged self-host)

Users install with `curl -fsSL …/install.sh | sh` (see README) — prebuilt images, no source build.
The pieces:

- **Images**: `.github/workflows/release.yml` builds + pushes multi-arch
  `ghcr.io/sealant-sh/sealant-{api,worker,ssh-gateway,web}` on every `vX.Y.Z` tag, smoke-tests the
  installer against them, then publishes the GitHub release with `compose.selfhost.yaml` attached.
  Creating the release is what moves `releases/latest`, i.e. what the installer resolves.
- **Cutting a release**: push a `vX.Y.Z` tag. After the very first release, flip the four GHCR
  packages to public (one-time, per package) or anonymous pulls fail.
- **Local dry-run**: build the images with the same Dockerfiles
  (`docker build -f apps/<app>/Dockerfile -t ghcr.io/sealant-sh/sealant-<name>:0.0.0-dev .`), then
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
  registered (Settings → SSH keys), or the sandbox isn't running.
- **"Host identification has changed"** means the gateway host key changed (e.g. you removed the
  `gateway-keys` volume). Run `ssh-keygen -R "[127.0.0.1]:2222"` and reconnect.
