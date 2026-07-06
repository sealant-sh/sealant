---
title: Beyond localhost
description:
  Bind Sealant to a real interface, set the SSH and web URLs, fix up CORS and trusted origins — and
  understand the security tradeoffs before you do.
---

By default the installer binds the web app, API, and SSH gateway to `127.0.0.1` (loopback). Nothing
is reachable from another machine. That is the right default. Before you change it, read
[Security implications](#security-implications) at the bottom — the current build has **no API
authentication enforcement**, so exposing Sealant exposes it to anyone who can reach the port.

## Bind to a routable interface

`SEALANT_BIND_HOST` controls the host interface for the web app, API, and SSH gateway. Set it to
`0.0.0.0` (or a specific interface IP) in `~/.sealant/.env`, then re-run the installer to restart:

```sh
SEALANT_BIND_HOST=0.0.0.0
```

```sh
curl -fsSL https://get.sealant.dev | sh
```

The published ports are unchanged unless you override them:

| Service     | Variable           | Default host port |
| ----------- | ------------------ | ----------------- |
| Web         | `SEALANT_WEB_PORT` | `3000`            |
| API         | `SEALANT_API_PORT` | `4000`            |
| SSH gateway | `SEALANT_SSH_PORT` | `2222`            |

The Zot registry (`SEALANT_REGISTRY_PORT`, default `5000`), Postgres, and RabbitMQ stay on loopback
regardless of `SEALANT_BIND_HOST`.

## SSH host

The SSH gateway command shown in the web UI is rendered from `SEALANT_SSH_HOST` (default
`localhost`). Set it to the hostname or IP users will actually connect to, so the copy-paste command
works off-box:

```sh
SEALANT_SSH_HOST=sealant.internal.example.com
```

Connections then look like:

```sh
ssh -p 2222 ws-<workspace-id>@sealant.internal.example.com
```

See [SSH access](/docs/guides/ssh-access) for the full connection and key model.

## Web URL, trusted origins, and CORS

Auth and cross-origin requests are pinned to specific origins. When the web app is served from
anything other than `http://localhost:3000`, update all three:

- **`SEALANT_WEB_URL`** — the canonical URL Better Auth uses (default
  `http://localhost:${SEALANT_WEB_PORT:-3000}`). Set it to the exact URL users load in the browser,
  e.g. `https://sealant.example.com`.
- **`SEALANT_WEB_TRUSTED_ORIGINS`** — a CSV of origins Better Auth trusts. Defaults to the
  localhost/127.0.0.1 web origins; add your real origin(s).
- **`SEALANT_CORS_ALLOWED_ORIGINS`** — the API's allowed CORS origins (passed through as
  `CORS_ALLOWED_ORIGINS`). The self-host compose default is `*`. If you expose the API, set this to
  your web origin explicitly rather than leaving it wide open.

```sh
SEALANT_WEB_URL=https://sealant.example.com
SEALANT_WEB_TRUSTED_ORIGINS=https://sealant.example.com
SEALANT_CORS_ALLOWED_ORIGINS=https://sealant.example.com
```

Re-run the installer after changing these. See
[Environment variables](/docs/reference/environment-variables) for the full contract.

## Terminate TLS in front

Sealant serves plain HTTP. If you expose it beyond a trusted network, put a reverse proxy (Caddy,
nginx, a load balancer) in front to terminate TLS, and point `SEALANT_WEB_URL` / origins at the
`https://` address. Sealant does not manage certificates for you.

## Security implications

Exposing Sealant beyond loopback is a real risk in the current build. Be deliberate:

- **No API authentication is enforced yet.** The identity model is temporary — the owner user is
  passed in request payloads and queries (`ownerUserId`) rather than being verified from an
  authenticated session or token. There are no API tokens. Anyone who can reach the API port can act
  against it. Treat network reachability as the only access control you have today, and keep the API
  on a trusted network or behind an authenticating proxy.
- **The worker mounts the host Docker socket** (`DOCKER_SOCKET_PATH`, default
  `/var/run/docker.sock`) to build and run workspaces. Access to workspace creation is effectively
  access to the host Docker daemon, which is equivalent to root on the host. Do not expose
  workspace-creating surfaces to untrusted users.
- **Workspaces run real code from real repositories.** Anyone who can create a workspace can run
  arbitrary code on your host.

For the full model and where the current gaps are, read
[Security model](/docs/concepts/security-model) and
[What ships today](/docs/introduction/what-ships-today). If you only need off-box access for
yourself, prefer an SSH tunnel or a VPN over binding to `0.0.0.0` on a public network.
