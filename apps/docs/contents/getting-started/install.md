---
title: Install
description:
  Self-host Sealant on your own machine with a single install command, then sign in on localhost.
---

Sealant is self-hosted. You run the whole stack — web app, API, SSH gateway, registry, and their
backing services — on your own infrastructure with Docker Compose. This page installs it on a single
host.

## Prerequisites

- A running **Docker daemon** you can reach without `sudo` (or run the installer as a user in the
  `docker` group).
- **Docker Compose v2**, version **2.23.1 or newer** (`docker compose version`).
- **curl**.

That's it. You don't need git, Node, or any firewall changes — every service runs in a container and
binds to loopback by default.

## Install

```bash
curl -fsSL https://get.sealant.dev | sh
```

## What the installer does

The script is idempotent and never overwrites your secrets or data. In order, it:

1. **Checks prerequisites** — curl, the Docker CLI, a running Docker daemon, and Compose
   `>= 2.23.1`.
2. **Resolves a version** — the newest release by default, or the exact version in `SEALANT_VERSION`
   (see [Upgrade, repair, uninstall](/docs/guides/upgrade-repair-uninstall)).
3. **Creates the install directory** — `~/.sealant` by default (override with
   `SEALANT_INSTALL_DIR`).
4. **Downloads the compose file** to `~/.sealant/compose.yaml` for the resolved release.
5. **Writes `~/.sealant/.env`** with mode `0600` and **generates any missing secrets** once
   (database and RabbitMQ passwords, the SSH gateway token, and the auth secret). Existing values
   are left untouched.
6. **Pulls the prebuilt images** — API, worker, SSH gateway, and web.
7. **Runs database migrations** with `docker compose ... run --rm migrate`.
8. **Starts the stack** with `docker compose ... up -d`.
9. **Waits for health** — the API's `/healthz` and the web app's root URL — before it returns.

## Ports and binding

Everything binds to `127.0.0.1` (loopback) by default, so a fresh install is not reachable from
other machines.

| Service     | Address          | Default port |
| ----------- | ---------------- | ------------ |
| Web app     | `127.0.0.1:3000` | `3000`       |
| API         | `127.0.0.1:4000` | `4000`       |
| SSH gateway | `127.0.0.1:2222` | `2222`       |
| Registry    | `127.0.0.1:5000` | `5000`       |
| Postgres    | internal only    | —            |
| RabbitMQ    | internal only    | —            |

Each port is configurable (`SEALANT_WEB_PORT`, `SEALANT_API_PORT`, `SEALANT_SSH_PORT`,
`SEALANT_REGISTRY_PORT`), and the bind host is `SEALANT_BIND_HOST`. To reach Sealant from another
machine, see [Beyond localhost](/docs/guides/beyond-localhost). The full list of knobs is in
[Environment variables](/docs/reference/environment-variables).

## First login

Open **[http://localhost:3000](http://localhost:3000)** and create an account. The first user you
register is a normal account — there is no separate admin setup.

From here, continue to [Run your first workspace](/docs/getting-started/first-workspace). To connect
private GitHub repositories, set up the [GitHub App](/docs/guides/github-app).

## Managing the install

Your install lives entirely in `~/.sealant` (the compose file, `.env`, and Docker named volumes for
data). To upgrade to a newer release, repair a broken install, view logs, or remove everything, see
[Upgrade, repair, uninstall](/docs/guides/upgrade-repair-uninstall).
