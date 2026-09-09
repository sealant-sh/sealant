---
title: Upgrade, repair, uninstall
description:
  Re-run the installer to repair, bump SEALANT_VERSION to upgrade, pin exact versions, and tear
  everything down — with the one caveat about workspace containers on the host.
---

Everything Sealant needs lives in `~/.config/sealant`: the compose file (`compose.yaml`), your
generated secrets and knobs (`.env`), and pointers to Docker volumes that hold your data. The
installer is idempotent, so the same one-liner both installs and repairs.

If you installed an older release in `~/.sealant`, the next installer run moves that directory to
the XDG config location before repairing or upgrading it. If `~/.config/sealant` already contains
CLI or SSH config, non-conflicting entries are merged; a name collision leaves the legacy install
untouched. The migration only runs when `SEALANT_INSTALL_DIR` is unset.

## Repair the current install

Re-running the installer **without** `SEALANT_VERSION` reconciles the install at its currently
pinned version. It regenerates the compose file, re-pulls images, re-runs migrations, and restarts
the stack. Your generated secrets and your data are **never** regenerated or lost.

```sh
curl -fsSL https://get.sealant.dev | sh
```

Use this after editing `~/.config/sealant/.env` (for example, to add
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

The resolved version is written back to `~/.config/sealant/.env` and pinned there, so subsequent
plain re-runs stay on that version until you upgrade again.

### Upgrading past the RabbitMQ and zot removal

Installs from before this change ran two extra containers: `rabbitmq` (the job queue) and `zot` (an
OCI registry for workspace images). Between them they cost several hundred MB of RSS at idle, for a
queue carrying a handful of messages a minute and a registry that only ever talked to the same
Docker daemon. The queue now lives in the control-plane Postgres database and built images stay in
the host Docker daemon, so both containers are gone.

The installer removes them for you. If you upgrade by hand, pass `--remove-orphans` so compose
deletes the containers that are no longer in the file:

```sh
docker compose --project-directory ~/.config/sealant up -d --remove-orphans
```

Then reclaim the registry's storage:

```sh
docker volume rm sealant_zot-data
```

Two things to know:

- Workspace images already in the Docker Engine keep working. The first workspace of each build plan
  after the upgrade rebuilds once, because earlier publishes recorded references of the form
  `127.0.0.1:5000/...`.
- Anything still queued in RabbitMQ at the moment of the upgrade is lost, since the queue moved. If
  a workspace was mid-build (or mid-stop) during the upgrade, restart it.

`SEALANT_RABBITMQ_PASSWORD` and `SEALANT_REGISTRY_PORT` lines left in `~/.config/sealant/.env` are
harmless; nothing reads them any more, and you can delete them.

## Pin an exact version

To install or switch to a specific version — for a reproducible deployment, or to roll back — name
it explicitly:

```sh
curl -fsSL https://get.sealant.dev | SEALANT_VERSION=0.4.0 sh
```

The installer requires a running Docker daemon and Docker Compose `>= 2.23.1`.

## Stop without deleting data

To stop the stack but keep your database and secrets:

```sh
docker compose --project-directory ~/.config/sealant down
```

Start it again with the installer, or with
`docker compose --project-directory ~/.config/sealant up -d`.

## Logs

Tail everything, or one service:

```sh
docker compose --project-directory ~/.config/sealant logs -f
docker compose --project-directory ~/.config/sealant logs -f api
```

Service names are `api`, `worker`, `web`, `ssh-gateway`, and `postgres`.

## Uninstall

`down -v` stops the stack **and deletes the compose volumes** — your Postgres data and the SSH
gateway host key. This is destructive and irreversible.

```sh
docker compose --project-directory ~/.config/sealant down -v && rm -rf ~/.config/sealant
```

### Caveat: workspace containers outlive uninstall

Workspace containers and images are created by the worker on the **host Docker daemon** (via the
mounted Docker socket), not inside the compose project. Tearing down the compose project with
`down -v` does **not** remove workspace runtime containers or images that were already built. Clean
them up on the host separately, for example:

```sh
docker ps -a            # find leftover workspace containers
docker rm -f <container>
docker image prune      # reclaim orphaned workspace images
```

Workspace control sockets also live on the host at `/run/sealant/sockets`; remove that directory if
you want a fully clean host.

## What is and isn't preserved

| Item                        | Location                       | Survives `down` |  Survives `down -v`  |
| --------------------------- | ------------------------------ | :-------------: | :------------------: |
| Secrets and knobs           | `~/.config/sealant/.env`       |       yes       | yes (until `rm -rf`) |
| Postgres data               | volume `sealant_postgres-data` |       yes       |          no          |
| SSH gateway host key        | volume `sealant_gateway-keys`  |       yes       |          no          |
| Workspace containers/images | host Docker daemon             |       yes       | yes (manual cleanup) |

See [Ports and data](/docs/reference/ports-and-data) for the full volume and port map, and
[Installer and compose](/docs/reference/installer-and-compose) for what the one-liner does step by
step.
