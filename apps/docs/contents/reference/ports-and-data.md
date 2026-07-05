---
title: Ports and Data
description:
  The host ports a self-hosted Sealant listens on, where it keeps its state, and what to back up.
---

Everything Sealant needs on disk lives in one directory and three Docker named volumes. This page is
the reference for what listens where and what to preserve.

## Ports

By default every user-facing port binds to loopback (`127.0.0.1`). Change the interface with
[`SEALANT_BIND_HOST`](/docs/reference/environment-variables) and the host ports with the
`SEALANT_*_PORT` knobs. Postgres and RabbitMQ are never published to the host — they are reachable
only inside the compose network.

| Service      | Host bind        | Container port |
| ------------ | ---------------- | -------------- |
| Web app      | `127.0.0.1:3000` | `3000`         |
| API          | `127.0.0.1:4000` | `4000`         |
| SSH gateway  | `127.0.0.1:2222` | `2222`         |
| zot registry | `127.0.0.1:5000` | `5000`         |
| Postgres     | internal only    | `5432`         |
| RabbitMQ     | internal only    | `5672`         |

The registry stays on loopback even when `SEALANT_BIND_HOST=0.0.0.0` — only web, API, and SSH follow
the bind host. See [Beyond localhost](/docs/guides/beyond-localhost) for exposing the stack safely.

## State

| State                         | Location                                                | Kind                |
| ----------------------------- | ------------------------------------------------------- | ------------------- |
| Install metadata              | `~/.sealant/compose.yaml`, `~/.sealant/.env`            | Host files          |
| Postgres data                 | `sealant_postgres-data`                                 | Docker named volume |
| Registry data                 | `sealant_zot-data`                                      | Docker named volume |
| SSH gateway host key          | `sealant_gateway-keys`, at `/keys/ssh_gateway_host_key` | Docker named volume |
| Sandbox control sockets       | `/run/sealant/sockets`                                  | Host path           |
| Sandbox containers and images | Host Docker daemon (via the mounted socket)             | Docker objects      |

A few things worth knowing:

- **The control plane's durable state is Postgres.** Accounts, SSH keys, sandbox metadata, and
  execution records all live in the `sealant_postgres-data` volume.
- **The SSH gateway host key is generated once** into `sealant_gateway-keys` and is not rotated on
  upgrade. Deleting that volume changes the host key and triggers the "host key changed" warning on
  next connect.
- **Sandboxes run on your host Docker daemon**, created by the worker through the mounted socket.
  They are not part of the compose project — see the uninstall note below.
- The registry (`sealant_zot-data`) holds the built sandbox images. It is a cache: it can be rebuilt
  from source repositories, but losing it means re-building sandboxes.

## What to back up

To capture a full install, preserve:

1. `~/.sealant/.env` — your secrets and knobs. Without it you cannot decrypt sessions or match the
   DB password to the volume. Back this up somewhere safe.
2. The `sealant_postgres-data` volume — all durable control-plane state.

The `sealant_zot-data` and `sealant_gateway-keys` volumes are recoverable (rebuild images;
regenerate a host key), though restoring the gateway key avoids the host-key-changed warning for
existing users.

## A note on uninstall

`docker compose --project-directory ~/.sealant down -v` removes the compose services and the three
named volumes. It does **not** remove sandbox containers or images the worker created on your host
Docker daemon — those are separate Docker objects. Clean them up with the usual `docker` commands if
needed. Full sequence in [Upgrade, repair, uninstall](/docs/guides/upgrade-repair-uninstall).

Related: [Environment variables](/docs/reference/environment-variables) ·
[Installer and compose](/docs/reference/installer-and-compose)
