---
title: Environment Variables
description:
  The operator environment reference for a self-hosted Sealant — installer-generated secrets, ports
  and bind knobs, GitHub App variables, and the runtime defaults worth knowing.
---

Self-hosted Sealant reads deployment variables from `~/.sealant/.env` (mode `0600`) through
`docker compose`. This page is the operator's reference for what belongs there.

The [installer](/docs/reference/installer-and-compose) writes only a small subset: generated
infrastructure secrets, the pinned version, the API/web/SSH/registry ports, and the bind host. You
edit this file directly for GitHub App credentials, connected-account encryption, public web/SSH
URLs, CORS origins, or image mirrors. After editing, apply it by re-running the installer or
restarting the stack:

```sh
docker compose --project-directory ~/.sealant up -d
```

## Installer-generated secrets

The installer writes these once, from 32 bytes of `/dev/urandom` (hex-encoded, 64 chars), and never
overwrites an existing value. Do not regenerate them on a live install — rotating
`SEALANT_DB_PASSWORD` against an existing Postgres volume locks you out of your own data.

| Variable                      | Meaning                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEALANT_DB_PASSWORD`         | Postgres password used to build the compose database URL.                                                                                                   |
| `SEALANT_RABBITMQ_PASSWORD`   | RabbitMQ password used to build the compose AMQP URL.                                                                                                       |
| `WORKSPACE_SSH_GATEWAY_TOKEN` | Shared secret between the API and the SSH gateway. Gates the internal `POST /v1/ssh-keys/resolve-principal` and `GET /v1/workspaces/:id/ssh-target` routes. |
| `BETTER_AUTH_SECRET`          | Better Auth signing secret (min 32 chars). Required for web sign-in.                                                                                        |

`SEALANT_VERSION` is also persisted here — the pinned image tag. Current platform release is
`0.4.0`. See [version resolution](/docs/reference/installer-and-compose) for how the installer
chooses it.

## Installer-persisted version, ports, and bind

These are the only non-secret knobs the installer persists and passes through compose. Change one,
then re-run the installer (or `docker compose up -d`) to apply it. By default everything binds to
loopback; see [Beyond localhost](/docs/guides/beyond-localhost) before exposing anything.

| Variable                | Default               | Meaning                                                                                     |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `SEALANT_VERSION`       | resolved by installer | Image tag pulled for every service.                                                         |
| `SEALANT_BIND_HOST`     | `127.0.0.1`           | Host interface for web, API, and SSH. Set `0.0.0.0` to expose beyond the machine.           |
| `SEALANT_WEB_PORT`      | `3000`                | Host port for the web app.                                                                  |
| `SEALANT_API_PORT`      | `4000`                | Host port for the control-plane API.                                                        |
| `SEALANT_SSH_PORT`      | `2222`                | Host port for the SSH gateway.                                                              |
| `SEALANT_REGISTRY_PORT` | `5000`                | Host port for the zot registry. Always bound to loopback regardless of `SEALANT_BIND_HOST`. |

`SEALANT_INSTALL_DIR` and `SEALANT_COMPOSE_URL` are never stored in `.env` — pass them inline to the
install command.

## Self-host compose variables you may add

The default `compose.selfhost.yaml` reads these variables when present, but `install.sh` does not
write them for you.

| Variable                       | Default                                | Meaning                                                                                                                         |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SEALANT_IMAGE_NS`             | `ghcr.io/sealant-sh`                   | Image namespace or mirror used by the installer and compose. Add it to `.env` if manual compose runs should use the mirror too. |
| `SEALANT_SSH_HOST`             | `localhost`                            | Public SSH host the API and UI render in connection commands.                                                                   |
| `SEALANT_WEB_URL`              | `http://localhost:${SEALANT_WEB_PORT}` | Better Auth canonical URL.                                                                                                      |
| `SEALANT_WEB_TRUSTED_ORIGINS`  | localhost + 127.0.0.1 web origins      | Better Auth trusted origins (CSV).                                                                                              |
| `SEALANT_CORS_ALLOWED_ORIGINS` | `*`                                    | API CORS origins, passed to the API as `CORS_ALLOWED_ORIGINS`.                                                                  |
| `DOCKER_SOCKET_PATH`           | `/var/run/docker.sock`                 | Host Docker socket mounted into the worker.                                                                                     |

## GitHub App variables

Private repositories need a GitHub App. Only the first two variables are wired through the self-host
compose file into the API and worker by default — set them in `~/.sealant/.env` and restart.

| Variable                 | Default | Meaning                                                               |
| ------------------------ | ------- | --------------------------------------------------------------------- |
| `GITHUB_APP_ID`          | unset   | GitHub App numeric ID. Required, paired with the private key.         |
| `GITHUB_APP_PRIVATE_KEY` | unset   | GitHub App private key PEM. `\n`-escaped keys are normalized in code. |

The runtime code also accepts the variables below, but the default `compose.selfhost.yaml` does
**not** pass them through. To use one, add it to the `environment:` block of the `api` (and
`worker`) service in `~/.sealant/compose.yaml`, or inject it another way — setting it in `.env`
alone has no effect.

| Variable                      | Default                  | Meaning                                                                                                     |
| ----------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_PRIVATE_KEY_PATH` | unset                    | Alternative to `GITHUB_APP_PRIVATE_KEY`; the code reads the file and hydrates the key.                      |
| `GITHUB_APP_WEBHOOK_SECRET`   | unset                    | Enables webhook signature verification. Without it, `POST /v1/github/webhooks` returns service-unavailable. |
| `GITHUB_API_BASE_URL`         | `https://api.github.com` | GitHub API base URL (for GitHub Enterprise).                                                                |
| `GITHUB_APP_SLUG`             | unset                    | Parsed by the env schema; no current code path uses it.                                                     |
| `GITHUB_APP_CLIENT_ID`        | unset                    | Validated as a pair with the secret; no current code path uses it.                                          |
| `GITHUB_APP_CLIENT_SECRET`    | unset                    | Validated as a pair with the client ID; no current code path uses it.                                       |

See [GitHub App setup](/docs/guides/github-app) for the full walkthrough.

## Connected-account encryption

Connected accounts require one extra secret: `SEALANT_CREDENTIALS_KEY`, a base64 string that decodes
to exactly 32 random bytes. The API uses it to seal connected-account payloads, and the worker uses
the same key to decrypt them before launch.

The runtime code accepts this variable, but the current default `compose.selfhost.yaml` does **not**
generate or pass it through. To enable connected accounts on a self-host install, generate a key,
add it to `~/.sealant/.env`, and add the same environment entry to both the `api` and `worker`
services in `~/.sealant/compose.yaml`:

```yaml
SEALANT_CREDENTIALS_KEY: ${SEALANT_CREDENTIALS_KEY:?set in .env}
```

Then restart with `docker compose --project-directory ~/.sealant up -d`. A later installer re-run
downloads a fresh compose file, so you would need to reapply this compose edit until the packaged
compose file includes it.

## Notable runtime defaults

You should not need to set these for a standard self-host — compose already supplies sensible
values, and most are internal to the container network. They are documented here so you can
recognize them in logs and override them deliberately if you must.

| Variable                                | Default                                                                                   | Meaning                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `DOCKER_SOCKET_PATH`                    | `/var/run/docker.sock`                                                                    | Host Docker socket mounted into the worker to build and run workspaces.                      |
| `DATABASE_URL`                          | compose-built from `SEALANT_DB_PASSWORD`                                                  | Control-plane Postgres connection string.                                                    |
| `RABBITMQ_URL`                          | compose-built from `SEALANT_RABBITMQ_PASSWORD`                                            | Workspace-build queue transport.                                                             |
| `REGISTRY_BASE_URL`                     | `http://zot:5000` in self-host compose (code default `http://127.0.0.1:5000`)             | Internal registry base URL the API and worker use inside the compose network.                |
| `REGISTRY_PUSH_REGISTRY`                | `127.0.0.1:${SEALANT_REGISTRY_PORT}` in self-host compose (code default `127.0.0.1:5000`) | Host registry address embedded in image refs for Docker push/pull.                           |
| `REGISTRY_NAME`                         | `default`                                                                                 | Registry id; must match the SDK's `SEALANT_REGISTRY_ID` (also `default`).                    |
| `DEFAULT_RUNTIME_ADAPTER`               | `docker`                                                                                  | Workspace runtime backend.                                                                   |
| `WORKSPACE_BUILD_QUEUE_PREFETCH`        | `1`                                                                                       | Concurrent workspace builds a worker leases.                                                 |
| `WORKSPACE_BUILD_JOB_LEASE_DURATION_MS` | `900000`                                                                                  | Build-job lease before a stuck job is reaped.                                                |
| `SSH_GATEWAY_BANNER`                    | Sealant welcome text                                                                      | Banner shown on SSH connect.                                                                 |
| `SSH_GATEWAY_WORKSPACE_USERNAME_PREFIX` | `ws`                                                                                      | Username prefix for `ssh ws-<workspace-id>@…`.                                               |
| `SEALANT_OWNER_USER_ID`                 | `usr_local`                                                                               | Pre-auth owner principal the SDK attributes work to (temporary; disappears when auth lands). |

There is no API-token or bearer-auth configuration here today — the current identity model passes an
`ownerUserId` in payloads and queries rather than authenticating requests. See the
[HTTP API auth section](/docs/reference/http-api) and the
[security model](/docs/concepts/security-model).

Related: [Ports and data](/docs/reference/ports-and-data) ·
[Installer and compose](/docs/reference/installer-and-compose) ·
[SSH access](/docs/guides/ssh-access)
