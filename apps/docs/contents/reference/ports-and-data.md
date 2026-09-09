---
title: Ports and Data
description:
  The host ports a self-hosted Sealant listens on, where it keeps its state, and what to back up.
---

Everything Sealant needs on disk lives in one directory and two Docker named volumes. This page is
the reference for what listens where and what to preserve.

## Ports

By default every user-facing port binds to loopback (`127.0.0.1`). Change the interface with
[`SEALANT_BIND_HOST`](/docs/reference/environment-variables) and the host ports with the
`SEALANT_*_PORT` knobs. Postgres is never published to the host — it is reachable only inside the
compose network.

| Service     | Host bind        | Container port |
| ----------- | ---------------- | -------------- |
| Web app     | `127.0.0.1:3000` | `3000`         |
| API         | `127.0.0.1:4000` | `4000`         |
| SSH gateway | `127.0.0.1:2222` | `2222`         |
| Postgres    | internal only    | `5432`         |

The stack runs no message broker and no image registry: the job queue lives in the control-plane
database and workspace images stay in the host Docker daemon. See
[Beyond localhost](/docs/guides/beyond-localhost) for exposing the stack safely.

## State

| State                           | Location                                                   | Kind                |
| ------------------------------- | ---------------------------------------------------------- | ------------------- |
| Install metadata                | `~/.config/sealant/compose.yaml`, `~/.config/sealant/.env` | Host files          |
| Postgres data                   | `sealant_postgres-data`                                    | Docker named volume |
| SSH gateway host key            | `sealant_gateway-keys`, at `/keys/ssh_gateway_host_key`    | Docker named volume |
| Workspace control sockets       | `/run/sealant/sockets`                                     | Host path           |
| Workspace containers and images | Host Docker daemon (via the mounted socket)                | Docker objects      |

A few things worth knowing:

- **The control plane's durable state is Postgres.** Accounts, SSH keys, workspace metadata, and
  execution records all live in the `sealant_postgres-data` volume, as does the job queue (the
  `pgboss` schema, created on first start).
- **The SSH gateway host key is generated once** into `sealant_gateway-keys` and is not rotated on
  upgrade. Deleting that volume changes the host key and triggers the "host key changed" warning on
  next connect.
- **Workspaces run on your host Docker daemon**, created by the worker through the mounted socket.
  They are not part of the compose project — see the uninstall note below.
- **Built workspace images are not in a volume.** They live in the host Docker daemon, tagged
  `sealant-workspace-<os-family>:plan-<hash>`. They are a cache: `docker image rm` on one costs a
  rebuild of that plan, nothing else.

## What to back up

To capture a full install, preserve:

1. `~/.config/sealant/.env` — your secrets and knobs. Without it you cannot match the DB password to
   the volume, preserve web session signing, or keep the SSH gateway token stable. Back this up
   somewhere safe.
2. The `sealant_postgres-data` volume — all durable control-plane state.

The `sealant_gateway-keys` volume is recoverable (a host key is regenerated), though restoring it
avoids the host-key-changed warning for existing users.

## A note on uninstall

`docker compose --project-directory ~/.config/sealant down -v` removes the compose services and the
two named volumes. It does **not** remove workspace containers or images the worker created on your
host Docker daemon — those are separate Docker objects. Clean them up with the usual `docker`
commands if needed. Full sequence in
[Upgrade, repair, uninstall](/docs/guides/upgrade-repair-uninstall).

Related: [Environment variables](/docs/reference/environment-variables) ·
[Installer and compose](/docs/reference/installer-and-compose)
