---
title: Secrets and credentials
description:
  How credentials work in Sealant today — installer secrets, GitHub App tokens, connected accounts,
  profile bindings, and what is still not shipped.
---

This page describes how secrets and credentials actually work in the current build. It separates
infrastructure secrets, GitHub App clone credentials, connected accounts for harnesses, and the
general secrets surface that is not wired yet.

## Installer-generated secrets

On first install, the installer generates these values into `~/.sealant/.env` (file mode `0600`)
using 32 random bytes each, hex-encoded to 64 characters. They are generated **once** and never
overwritten on re-runs, so repairs and upgrades keep them stable.

| Variable                      | What it's for                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `SEALANT_DB_PASSWORD`         | Postgres password used in the control-plane database URL.                                           |
| `SEALANT_RABBITMQ_PASSWORD`   | RabbitMQ password used in the AMQP URL between services.                                            |
| `WORKSPACE_SSH_GATEWAY_TOKEN` | Shared secret the SSH gateway uses to call the API's principal-resolution and SSH-target endpoints. |
| `BETTER_AUTH_SECRET`          | Better Auth signing secret for web sessions (minimum 32 chars).                                     |

These are infrastructure secrets. Keep `~/.sealant/.env` readable only by you, and back it up if you
care about not regenerating the auth secret. Rotating `BETTER_AUTH_SECRET` invalidates existing web
sessions.

The SSH gateway also holds a host key, auto-generated once into the `sealant_gateway-keys` Docker
volume. It is not rotated on upgrades. See [SSH access](/docs/guides/ssh-access) for the connection
model and how your personal SSH public keys map to workspaces.

## GitHub App credentials and clone tokens

Cloning **private** repositories uses a GitHub App, not a stored personal token. You set these in
`~/.sealant/.env`:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`

The API and worker use those values to mint an app JWT and request short-lived installation access
tokens at build time. Those tokens are used for repository clone and GitHub App-backed dotfiles.
They expire quickly; Sealant does not write a long-lived repository credential into the workspace
for this path. Full setup is in [GitHub App for private repos](/docs/guides/github-app).

## Connected accounts for harnesses

Connected accounts are the built-in path for bringing your own Claude, Codex, or GitHub identity
into a workspace. They are separate from the GitHub App clone path above.

You can manage connected accounts in two places:

- **Web app:** `/settings/connected-accounts`
- **CLI:** `sealant auth claude`, `sealant auth codex`, `sealant auth github`,
  `sealant auth status`, and `sealant auth remove`

The stored provider payloads are:

| Provider | Stored payload                                       | Injected into workspace as                          |
| -------- | ---------------------------------------------------- | --------------------------------------------------- |
| Claude   | Token from Anthropic's official `claude setup-token` | `CLAUDE_CODE_OAUTH_TOKEN` environment variable      |
| Codex    | Official Codex CLI `auth.json`                       | `$HOME/.codex/auth.json` file with mode `600`       |
| GitHub   | Token from `gh auth token` or a provided token       | `GITHUB_TOKEN` and `GH_TOKEN` environment variables |

The API validates the provider shape, encrypts the payload with AES-256-GCM through
`@sealant/credentials`, and stores only the sealed payload plus non-secret metadata in Postgres
(`connected_accounts`). No connected-account endpoint returns the plaintext secret.

### The required encryption key

Connected accounts require `SEALANT_CREDENTIALS_KEY`: a base64 string that decodes to exactly 32
random bytes. The API needs it to create connected accounts; the worker needs the same key to
decrypt and inject them.

The current self-host installer does **not** generate this key, and the current self-host compose
file does **not** pass it to `api` or `worker` by default. If you enable connected accounts on
self-host, generate the key yourself, put it in `~/.sealant/.env`, and add it to both service
environments in `~/.sealant/compose.yaml`. Without it, connected-account create calls return
service-unavailable, and a workspace that requests credential refs fails launch rather than silently
running without credentials. Restart with `docker compose --project-directory ~/.sealant up -d`;
re-running the installer downloads a fresh compose file, so you would need to reapply the compose
edit afterward.

## Profile bindings and workspace injection

Profiles can bind one connected account per provider. The live route is
`/profiles/<profile-id>/agents`, and the live API is:

- `GET /v1/profiles`
- `GET /v1/profiles/:profileId/credential-bindings`
- `PUT /v1/profiles/:profileId/credential-bindings`

The CLI exposes the same binding flow with:

```sh
sealant profiles list
sealant profiles bind <profile> --claude default --codex default --github work
sealant profiles bind <profile> --clear codex
```

Workspace creation accepts connected-account references through `credentials` on the create payload
or through `spec.credentials`. A profile binding can provide defaults, and explicit per-provider
entries win:

```json
{
  "credentials": {
    "profileId": "prof_123",
    "claude": "default",
    "github": "work"
  }
}
```

Each provider value is a connected-account id (`cacc_...`) or an account name for that provider. The
API checks ownership and status, then rewrites the workspace blueprint to opaque
`connected-account:<id>` refs. Secret material is not copied into the workspace spec. The worker
resolves those refs immediately before launch, decrypts the stored payloads, and injects env vars or
files into the running workspace.

Codex has one extra behavior: after a run, the worker best-effort reads the workspace's
`$HOME/.codex/auth.json` and syncs back a newer refresh timestamp so rotated Codex sessions are not
lost. This also requires `SEALANT_CREDENTIALS_KEY`.

## Dotfiles are still for non-secret customization

The config/dotfiles repository option in the workspace builder is still the path for shell config,
editor settings, and tooling bootstrap. Do **not** put sensitive secrets in a dotfiles repo you
wouldn't want cloned into an environment. Connected accounts are the provider-credential injection
path; general named secret injection is not shipped.

## What is not shipped

- **No general user, org, or global secrets manager.** The database has early secret tables, but
  there is no live web/API workflow for named arbitrary secrets.
- **Profile secrets and env-var pages are static.** `/profiles/$profileId/secrets` and
  `/profiles/$profileId/env-variables` display placeholder data and do not persist anything.
- **No API tokens.** There is no token create/list/revoke UI and no bearer-token auth on the
  control-plane API. The current API identity model is still `ownerUserId` in payloads and queries.

## Where secrets live, at a glance

| Secret or credential                        | Where it lives                                    | Managed by                 |
| ------------------------------------------- | ------------------------------------------------- | -------------------------- |
| Infra secrets (`SEALANT_DB_PASSWORD`, etc.) | `~/.sealant/.env`                                 | Installer, once            |
| GitHub App key                              | `~/.sealant/.env`                                 | You                        |
| GitHub installation clone tokens            | In-memory, short-lived                            | API/worker, at build time  |
| Connected-account payloads                  | Postgres `connected_accounts`, AES-256-GCM sealed | Web app, CLI, API          |
| Profile connected-account bindings          | Postgres `profile_connected_accounts`             | Web app, CLI, API          |
| Workspace injected provider credentials     | Env vars or files inside the launched workspace   | Worker, just before launch |
| SSH gateway host key                        | `sealant_gateway-keys` volume                     | Gateway, auto-generated    |
| Your SSH public keys                        | Postgres (via Settings → SSH keys)                | You, in the web app        |

See [Environment variables](/docs/reference/environment-variables) for every deployment variable and
[Ports and data](/docs/reference/ports-and-data) for where state is stored.
