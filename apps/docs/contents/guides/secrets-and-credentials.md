---
title: Secrets and credentials
description:
  How credentials work in Sealant today — installer-generated secrets, GitHub App tokens, and
  dotfiles — and an honest list of what is not shipped yet.
---

This page describes how secrets and credentials actually work in the current build. It is
deliberately split: what works today, then a plain list of what does **not** exist yet, so you don't
design around surfaces that are still mock. For the broader status picture see
[What ships today](/docs/introduction/what-ships-today).

## Installer-generated secrets

On first install, the installer generates a set of secrets into `~/.sealant/.env` (file mode `0600`)
using 32 random bytes each, hex-encoded to 64 characters. They are generated **once** and never
overwritten on re-runs, so repairs and upgrades keep them stable.

| Variable                    | What it's for                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `SEALANT_DB_PASSWORD`       | Postgres password used in the control-plane database URL.                                           |
| `SEALANT_RABBITMQ_PASSWORD` | RabbitMQ password used in the AMQP URL between services.                                            |
| `SANDBOX_SSH_GATEWAY_TOKEN` | Shared secret the SSH gateway uses to call the API's principal-resolution and SSH-target endpoints. |
| `BETTER_AUTH_SECRET`        | Better Auth signing secret for web sessions (minimum 32 chars).                                     |

These are infrastructure secrets. You generally never touch them by hand. Keep `~/.sealant/.env`
readable only by you, and back it up if you care about not regenerating the auth secret (rotating
`BETTER_AUTH_SECRET` invalidates existing sessions).

The SSH gateway also holds a host key, auto-generated once into the `sealant_gateway-keys` Docker
volume. It is not rotated on upgrades. See [SSH access](/docs/guides/ssh-access) for the connection
model and how your personal SSH public keys map to sandboxes.

## GitHub App credentials and clone tokens

Cloning **private** repositories uses a GitHub App, not a stored token. You set two values in
`~/.sealant/.env`:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`

From those, the API and worker mint an app JWT and then request **short-lived installation access
tokens** at build time. Those tokens are used for the clone and for dotfiles runtime auth, and they
expire quickly — no long-lived repository credential is written to disk in the sandbox. Full setup
is in [GitHub App for private repos](/docs/guides/github-app).

## Bringing your own tooling: dotfiles

The way to bring personal tooling, shell config, and credentials into a sandbox today is the
**config / dotfiles repository** option in the sandbox builder
([`/sandboxes/new`](/docs/guides/creating-sandboxes)). You can point it at a raw Git URL or a GitHub
App repository, choose a dotfiles manager and target, and optionally run a bootstrap command. This
is the supported path for customizing an environment — put the tooling (and any personal config
you're comfortable committing) in a repo and reference it per sandbox.

Do **not** put sensitive secrets in a dotfiles repo you wouldn't want cloned into an environment.
There is no per-sandbox secret injection to do this safely yet — see below.

## Not yet shipped

These surfaces exist in the UI as static or placeholder screens, or don't exist at all. Do not rely
on them:

- **No in-app user, org, or global secrets management.** There is no route to store or manage
  secrets in the web app. The profile secrets screens (`/profiles/$profileId/secrets`,
  `/profiles/$profileId/env-variables`) are **static mockups** — they display placeholder bindings
  and do not persist anything.
- **No per-sandbox secret injection UI.** There is no supported way to inject a named secret into a
  sandbox at build or run time from the app. Environment customization goes through the dotfiles
  repo and the builder's runtime setup commands instead.
- **No API tokens.** There is no token create/list/revoke UI and no bearer-token auth. The current
  identity model is temporary: the owner user is passed as `ownerUserId` in payloads and queries
  rather than being enforced from an authenticated session. Anyone who can reach the API can act
  against it — keep it on a trusted network. See [Beyond localhost](/docs/guides/beyond-localhost)
  and [Security model](/docs/concepts/security-model).

## Where secrets live, at a glance

| Secret                                      | Where it lives                     | Managed by                |
| ------------------------------------------- | ---------------------------------- | ------------------------- |
| Infra secrets (`SEALANT_DB_PASSWORD`, etc.) | `~/.sealant/.env`                  | Installer, once           |
| GitHub App key                              | `~/.sealant/.env`                  | You                       |
| GitHub installation clone tokens            | In-memory, short-lived             | API/worker, at build time |
| SSH gateway host key                        | `sealant_gateway-keys` volume      | Gateway, auto-generated   |
| Your SSH public keys                        | Postgres (via Settings → SSH keys) | You, in the web app       |

See [Environment variables](/docs/reference/environment-variables) for every variable and
[Ports and data](/docs/reference/ports-and-data) for where state is stored.
