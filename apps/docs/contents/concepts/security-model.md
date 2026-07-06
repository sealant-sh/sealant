---
title: Security model
description:
  The trust model today, honestly — loopback by default, public-key SSH, a worker that holds the
  host Docker socket, and an API with no auth enforcement yet.
---

This page describes what Sealant actually enforces today, not what it will enforce eventually. Read
it before you put Sealant anywhere other than your own machine. The short version: Sealant is safe
to run on `localhost`, and you are responsible for anything beyond that until auth hardening lands.

## Everything binds to loopback by default

The installer binds every published port to `127.0.0.1`:

| Service        | Default bind     |
| -------------- | ---------------- |
| Web app        | `127.0.0.1:3000` |
| API            | `127.0.0.1:4000` |
| SSH gateway    | `127.0.0.1:2222` |
| Registry (Zot) | `127.0.0.1:5000` |
| Postgres       | internal only    |
| RabbitMQ       | internal only    |

Nothing is reachable from another machine unless you deliberately change `SEALANT_BIND_HOST` (see
[Environment variables](/docs/reference/environment-variables)). This loopback default is the single
biggest thing keeping a fresh install safe. If you want a networked deployment, do it deliberately
and read [Beyond localhost](/docs/guides/beyond-localhost) first.

## SSH is public-key only, with ownership checks

The [SSH gateway](/docs/guides/ssh-access) accepts **public-key authentication only** — no
passwords. When you connect as `ws-<workspace-id>`, the gateway:

1. Resolves your public key's fingerprint to the user who registered it.
2. Asks the API for the workspace's SSH target, which is authorized **only** when the workspace's
   owner matches that user.
3. Requires the workspace to be `running` or `ready`.

A few things worth knowing:

- Active key fingerprints are **globally unique** — one physical public key can be active for only
  one user.
- An optional static allowlist file, if present, is checked **before** the database. A key in that
  file cannot be revoked through the app, so treat the static allowlist as an operator-level
  override.
- The gateway's host key is auto-generated once into a volume on first run and is **not rotated on
  upgrades**.

## The worker holds the host Docker socket

Sealant builds and launches [workspaces](/docs/concepts/workspaces) as containers on your host's
Docker daemon. To do that, the worker container is given the host **Docker socket**
(`/var/run/docker.sock`).

Holding the Docker socket is equivalent to **root on the host**. Anything that can influence what
the worker builds or launches can, in principle, reach the host. Concretely:

- Workspace containers run on your real Docker daemon, alongside anything else it runs.
- Workspace containers and images are created **outside** the Sealant Compose project, so they
  persist independently of it.
- You should trust the repositories and specs you feed into Sealant to the same degree you trust
  code you would run on the host itself.
- Per workspace, the spec's OCI runtime option in the [builder](/docs/guides/creating-workspaces)
  can select `runsc` (gVisor) for stronger container isolation than the default `runc`.

This is a deliberate tradeoff for a self-hosted, single-tenant runtime. It also means Sealant is not
something to expose to untrusted users.

## The API has no auth enforcement yet

This is the most important honesty note on this page: **the control-plane API does not enforce
authentication today.**

- There are **no API tokens** and no bearer-token verification on the contract endpoints.
- Identity is temporary: many calls take an `ownerUserId` / `userId` directly in the request payload
  or query string. The [SDK](/docs/reference/sdk) defaults this to a single static principal
  (`usr_local`).
- The web app's own sign-in is real, but the API behind it trusts the identity it is handed.

The practical rule: **do not expose the API (port 4000) beyond a trusted network.** Anyone who can
reach it can act as any owner. Auth hardening — real tokens and enforced identity — is planned, and
this page will change when it lands.

## Secrets and connected accounts

The installer generates the stack's secrets once into `~/.sealant/.env` with `0600` permissions and
never overwrites existing values. `GITHUB_APP_PRIVATE_KEY`, database and queue passwords, and the
SSH gateway token are environment-level operator secrets.

Connected accounts for Claude, Codex, and GitHub are a separate provider-credential path. They are
stored sealed in Postgres and require `SEALANT_CREDENTIALS_KEY` on the API and worker. The current
self-host installer does not generate or pass that key through by default, so enabling connected
accounts is an explicit operator step.

There is still **no general in-app secrets manager** for arbitrary named secrets. Profile secrets
and env-var pages are static placeholders today. See
[Secrets and credentials](/docs/guides/secrets-and-credentials) and
[Environment variables](/docs/reference/environment-variables).

## Related

- [Beyond localhost](/docs/guides/beyond-localhost) — what to harden before exposing Sealant.
- [SSH access](/docs/guides/ssh-access) — the public-key connection flow.
- [Ports & data](/docs/reference/ports-and-data) — what binds where and where state lives.
- [Environment variables](/docs/reference/environment-variables) — the knobs referenced above.
