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

On first install, the installer generates these values into `~/.config/sealant/.env` (file mode
`0600`) using 32 random bytes each, hex-encoded to 64 characters. They are generated **once** and
never overwritten on re-runs, so repairs and upgrades keep them stable.

| Variable                      | What it's for                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `SEALANT_DB_PASSWORD`         | Postgres password used in the control-plane database URL.                                           |
| `WORKSPACE_SSH_GATEWAY_TOKEN` | Shared secret the SSH gateway uses to call the API's principal-resolution and SSH-target endpoints. |
| `BETTER_AUTH_SECRET`          | Better Auth signing secret for web sessions (minimum 32 chars).                                     |

These are infrastructure secrets. Keep `~/.config/sealant/.env` readable only by you, and back it up
if you care about not regenerating the auth secret. Rotating `BETTER_AUTH_SECRET` invalidates
existing web sessions.

The SSH gateway also holds a host key, auto-generated once into the `sealant_gateway-keys` Docker
volume. It is not rotated on upgrades. See [SSH access](/docs/guides/ssh-access) for the connection
model and how your personal SSH public keys map to workspaces.

## GitHub App credentials and clone tokens

Cloning **private** repositories uses a GitHub App, not a stored personal token. You set these in
`~/.config/sealant/.env`:

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

| Provider | Stored payload                                                                                               | Injected into workspace as                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | Token from Anthropic's official `claude setup-token`, or a Claude Code session `.credentials.json` you paste | `CLAUDE_CODE_OAUTH_TOKEN` environment variable (token), or a copy of the session file without its refresh token at `$HOME/.claude/.credentials.json`, mode `600` |
| Codex    | Official Codex CLI `auth.json`                                                                               | A copy of `auth.json` whose refresh token is a placeholder, at `$HOME/.codex/auth.json`, mode `600`                                                              |
| GitHub   | Token from `gh auth token` or a provided token                                                               | `GITHUB_TOKEN` and `GH_TOKEN` environment variables                                                                                                              |

For Claude, the session-file path is the recommended one: run
`CLAUDE_CONFIG_DIR=~/.config/sealant/claude-session claude` on your machine, `/login` inside it
(this writes a fresh session without touching your main Claude login), and paste the contents of
`~/.config/sealant/claude-session/.credentials.json`. A session file presents as your subscription.
A `claude setup-token` value also works, but Anthropic treats setup tokens as API auth, so some
models are credit-gated when used interactively.

The API validates the provider shape, encrypts the payload with AES-256-GCM through
`@sealant/credentials`, and stores only the sealed payload plus non-secret metadata in Postgres
(`connected_accounts`). No connected-account endpoint returns the plaintext secret.

### The required encryption key

Connected accounts require `SEALANT_CREDENTIALS_KEY`: a base64 string that decodes to exactly 32
random bytes. The API needs it to create connected accounts; the worker needs the same key to
decrypt and inject them.

The current self-host installer does **not** generate this key, and the current self-host compose
file does **not** pass it to `api` or `worker` by default. If you enable connected accounts on
self-host, generate the key yourself, put it in `~/.config/sealant/.env`, and add it to both service
environments in `~/.config/sealant/compose.yaml`. Without it, connected-account create calls return
service-unavailable, and a workspace that requests credential refs fails launch rather than silently
running without credentials. Restart with
`docker compose --project-directory ~/.config/sealant up -d`; re-running the installer downloads a
fresh compose file, so you would need to reapply the compose edit afterward.

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

### How Claude and Codex logins stay fresh

A Claude session file and a Codex `auth.json` carry a refresh token that rotates: each refresh
revokes (Claude) or spends (Codex) the one before it. So Sealant keeps exactly one refresher per
login, and every other copy cannot refresh:

- **The store holds the only refresh token.** Workspaces and inference calls get a copy: Claude's
  file without `refreshToken`, Codex's `auth.json` with a placeholder refresh token. A copy runs
  until its access token expires and cannot rotate, spend or revoke the login.
- **The worker is the only refresher.** It runs the official CLI against the stored login in a
  private directory: Claude about an hour before its access token expires, Codex a day before. One
  refresh per login at a time, across every worker. Sealant never calls a provider's OAuth or token
  endpoint; the CLI does the refresh.
- **Running workspaces get the new copy.** Straight after a refresh the worker writes it into every
  running workspace launched with that login, over the executor's control connection. Claude Code
  and Codex both pick up a replaced file without a restart.
- **A refused refresh ends the login.** The account is marked `invalid`, launches with it are
  refused, and inference answers with a request to reconnect. Connecting the account again clears
  it.

Refreshing requires `SEALANT_CREDENTIALS_KEY` on the worker. Workspaces launched before copies were
introduced still hold a refresh token; the worker reads their rotations back after runs and at stop
until they end.

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
| Infra secrets (`SEALANT_DB_PASSWORD`, etc.) | `~/.config/sealant/.env`                          | Installer, once            |
| GitHub App key                              | `~/.config/sealant/.env`                          | You                        |
| GitHub installation clone tokens            | In-memory, short-lived                            | API/worker, at build time  |
| Connected-account payloads                  | Postgres `connected_accounts`, AES-256-GCM sealed | Web app, CLI, API          |
| Profile connected-account bindings          | Postgres `profile_connected_accounts`             | Web app, CLI, API          |
| Workspace injected provider credentials     | Env vars or files inside the launched workspace   | Worker, just before launch |
| SSH gateway host key                        | `sealant_gateway-keys` volume                     | Gateway, auto-generated    |
| Your SSH public keys                        | Postgres (via Settings → SSH keys)                | You, in the web app        |

See [Environment variables](/docs/reference/environment-variables) for every deployment variable and
[Ports and data](/docs/reference/ports-and-data) for where state is stored.
