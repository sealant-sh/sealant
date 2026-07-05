---
title: Upgrade, repair, uninstall
description:
  Re-run the installer to repair, bump SEALANT_VERSION to upgrade, pin exact versions, and tear
  everything down — with the one caveat about sandbox containers on the host.
---

Everything Sealant needs lives in `~/.sealant`: the compose file (`compose.yaml`), your generated
secrets and knobs (`.env`), and pointers to Docker volumes that hold your data. The installer is
idempotent, so the same one-liner both installs and repairs.

## Repair the current install

Re-running the installer **without** `SEALANT_VERSION` reconciles the install at its currently
pinned version. It regenerates the compose file, re-pulls images, re-runs migrations, and restarts
the stack. Your generated secrets and your data are **never** regenerated or lost.

```sh
curl -fsSL https://get.sealant.dev | sh
```

Use this after editing `~/.sealant/.env` (for example, to add
[GitHub App credentials](/docs/guides/github-app)) — it restarts the services with the new
environment.

## Upgrade to the latest release

Set `SEALANT_VERSION=latest` to re-resolve GitHub's latest release and move to it:

```sh
curl -fsSL https://get.sealant.dev | SEALANT_VERSION=latest sh
```

Note the placement: the variable must be set on the `sh` side of the pipe. Prefixed to `curl` it
would apply to the download only and the installer would silently repair the current version
instead.

The resolved version is written back to `~/.sealant/.env` and pinned there, so subsequent plain
re-runs stay on that version until you upgrade again.

## Pin an exact version

To install or switch to a specific version — for a reproducible deployment, or to roll back — name
it explicitly:

```sh
curl -fsSL https://get.sealant.dev | SEALANT_VERSION=0.1.3 sh
```

The installer requires a running Docker daemon and Docker Compose `>= 2.23.1`.

## Stop without deleting data

To stop the stack but keep your database, registry, and secrets:

```sh
docker compose --project-directory ~/.sealant down
```

Start it again with the installer, or with `docker compose --project-directory ~/.sealant up -d`.

## Logs

Tail everything, or one service:

```sh
docker compose --project-directory ~/.sealant logs -f
docker compose --project-directory ~/.sealant logs -f api
```

Service names are `api`, `worker`, `web`, `ssh-gateway`, `postgres`, `rabbitmq`, and `zot` (the
registry).

## Uninstall

`down -v` stops the stack **and deletes the compose volumes** — your Postgres data, registry data,
and the SSH gateway host key. This is destructive and irreversible.

```sh
docker compose --project-directory ~/.sealant down -v && rm -rf ~/.sealant
```

### Caveat: sandbox containers outlive uninstall

Sandbox containers and images are created by the worker on the **host Docker daemon** (via the
mounted Docker socket), not inside the compose project. Tearing down the compose project with
`down -v` does **not** remove sandbox runtime containers or images that were already built. Clean
them up on the host separately, for example:

```sh
docker ps -a            # find leftover sandbox containers
docker rm -f <container>
docker image prune      # reclaim orphaned sandbox images
```

Sandbox control sockets also live on the host at `/run/sealant/sockets`; remove that directory if
you want a fully clean host.

## What is and isn't preserved

| Item                      | Location                       | Survives `down` |  Survives `down -v`  |
| ------------------------- | ------------------------------ | :-------------: | :------------------: |
| Secrets and knobs         | `~/.sealant/.env`              |       yes       | yes (until `rm -rf`) |
| Postgres data             | volume `sealant_postgres-data` |       yes       |          no          |
| Registry data             | volume `sealant_zot-data`      |       yes       |          no          |
| SSH gateway host key      | volume `sealant_gateway-keys`  |       yes       |          no          |
| Sandbox containers/images | host Docker daemon             |       yes       | yes (manual cleanup) |

See [Ports and data](/docs/reference/ports-and-data) for the full volume and port map, and
[Installer and compose](/docs/reference/installer-and-compose) for what the one-liner does step by
step.
