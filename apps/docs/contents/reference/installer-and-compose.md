---
title: Installer and Compose
description:
  Reference for install.sh — every environment override, how the version is resolved, the compose
  services it starts, and the docker compose commands to operate the stack.
---

Sealant self-hosts from one command:

```sh
curl -fsSL https://get.sealant.dev | sh
```

`get.sealant.dev` redirects to `install.sh`. The script checks prerequisites, downloads the compose
file for a release, generates secrets into `~/.sealant/.env`, pulls the prebuilt images, runs
migrations, and starts the stack. It is idempotent: re-running it repairs the current install
without regenerating secrets or touching data. For the task-oriented walkthrough see
[Install](/docs/getting-started/install); this page is the reference.

## Prerequisites

The installer verifies, and fails early without, all of these:

- `curl`
- The Docker CLI and a running Docker daemon
- Docker Compose v2, version **≥ 2.23.1**

No git, no Node, no firewall changes.

## Environment overrides

Pass these inline on the install command to change installer behavior. The port and bind knobs are
also persisted into `~/.sealant/.env` and read on every run. `SEALANT_INSTALL_DIR` and
`SEALANT_COMPOSE_URL` are never stored and must be repeated. `SEALANT_IMAGE_NS` is not written by
the installer either, but both the installer and compose **do** read it from `~/.sealant/.env` — if
you pull from a mirror, add `SEALANT_IMAGE_NS=…` to `.env` by hand, or every later manual
`docker compose … up -d` silently falls back to `ghcr.io/sealant-sh`.

| Variable                | Default              | Effect                                                                                              |
| ----------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| `SEALANT_VERSION`       | resolved (see below) | Version to install. `latest` re-resolves the newest release; an exact version like `0.1.3` pins it. |
| `SEALANT_INSTALL_DIR`   | `$HOME/.sealant`     | Where install metadata and `.env` live.                                                             |
| `SEALANT_COMPOSE_URL`   | unset                | Override the compose source — a URL or a local file path.                                           |
| `SEALANT_IMAGE_NS`      | `ghcr.io/sealant-sh` | Image namespace or mirror to pull from.                                                             |
| `SEALANT_BIND_HOST`     | `127.0.0.1`          | Host interface for web, API, SSH.                                                                   |
| `SEALANT_WEB_PORT`      | `3000`               | Host web port.                                                                                      |
| `SEALANT_API_PORT`      | `4000`               | Host API port.                                                                                      |
| `SEALANT_SSH_PORT`      | `2222`               | Host SSH gateway port.                                                                              |
| `SEALANT_REGISTRY_PORT` | `5000`               | Host registry port (always loopback).                                                               |

Example — pin a version, expose beyond loopback, move the web port:

```sh
SEALANT_VERSION=0.1.3 SEALANT_BIND_HOST=0.0.0.0 SEALANT_WEB_PORT=8080 \
  sh -c "$(curl -fsSL https://get.sealant.dev)"
```

The full env reference (including secrets and GitHub App variables) is in
[Environment variables](/docs/reference/environment-variables).

## How the version is resolved

In priority order:

1. **`SEALANT_VERSION` set to an exact version** (e.g. `0.2.0`) — installs exactly that.
2. **`SEALANT_VERSION=latest`** — re-resolves GitHub's `releases/latest` and installs the newest.
3. **An existing `~/.sealant/.env`** — reuses the pinned `SEALANT_VERSION` from a prior install.
   This is what makes a bare re-run a repair rather than an upgrade.
4. **No prior install and no override** — resolves `releases/latest`.

The resolved value is written back to `~/.sealant/.env`, so subsequent bare runs stay pinned. To
upgrade, pass `SEALANT_VERSION=latest` again.

The compose file is fetched from the release asset `compose.selfhost.yaml`, falling back to the raw
tagged file, and written to `~/.sealant/compose.yaml`. `SEALANT_COMPOSE_URL` overrides the source.

## What the installer does

1. Checks prerequisites.
2. Resolves the version.
3. Creates the install dir (`~/.sealant` by default).
4. Downloads the compose file to `~/.sealant/compose.yaml`.
5. Creates `~/.sealant/.env` (mode `0600`) and generates any missing secrets.
6. Persists the port and bind knobs.
7. Pulls the images for `api`, `worker`, `ssh-gateway`, and `web`.
8. Runs the one-shot `migrate` service.
9. Starts the stack with `up -d --remove-orphans`.
10. Waits for the API (`/healthz`) and web (`/`) to become healthy.

## Compose services

The self-host compose project (`sealant`) runs eight services:

| Service       | Role                                                          |
| ------------- | ------------------------------------------------------------- |
| `postgres`    | Control-plane database (internal only).                       |
| `rabbitmq`    | Workspace-build job queue (internal only).                    |
| `zot`         | OCI registry for built workspace images, on `127.0.0.1:5000`. |
| `migrate`     | One-shot database migration and seed; exits after running.    |
| `api`         | The control-plane API on `:4000`.                             |
| `worker`      | Builds and runs workspaces on the host Docker daemon.         |
| `ssh-gateway` | SSH access into live workspaces on `:2222`.                   |
| `web`         | The product web app on `:3000`.                               |

Persistent state lives in three named volumes (`sealant_postgres-data`, `sealant_zot-data`,
`sealant_gateway-keys`) — see [Ports and data](/docs/reference/ports-and-data).

## Operating the stack

All commands target the install directory. `docker compose` auto-discovers `~/.sealant/compose.yaml`
from `--project-directory`.

Follow logs (all services, or one):

```sh
docker compose --project-directory ~/.sealant logs -f
docker compose --project-directory ~/.sealant logs -f api
```

Stop without deleting data:

```sh
docker compose --project-directory ~/.sealant down
```

Restart after an `.env` edit:

```sh
docker compose --project-directory ~/.sealant up -d
```

Uninstall, including volumes and the install dir:

```sh
docker compose --project-directory ~/.sealant down -v && rm -rf ~/.sealant
```

`down -v` does not remove workspace containers or images the worker created on the host Docker
daemon — those are separate objects. See
[Upgrade, repair, uninstall](/docs/guides/upgrade-repair-uninstall).

Related: [Install](/docs/getting-started/install) ·
[Environment variables](/docs/reference/environment-variables) ·
[Ports and data](/docs/reference/ports-and-data)
