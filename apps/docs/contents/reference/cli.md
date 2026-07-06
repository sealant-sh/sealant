---
title: CLI
description:
  The repo-local sealant command for connected accounts, profile credential bindings, and CLI
  config.
---

Sealant has a real CLI in `apps/cli`. It installs a `sealant` binary from the `@sealant/cli`
workspace package. The CLI is not a separately published package today; use it from a repo checkout
or from whatever packaging path your deployment provides.

The CLI talks to the control-plane API. It uses the same temporary identity model as the HTTP API:
an owner user id is passed to the API, not derived from a bearer token.

## Configuration

The CLI resolves settings in this order: global flag, environment variable, config file, default.

| Setting       | Flag              | Environment variable    | Default                 |
| ------------- | ----------------- | ----------------------- | ----------------------- |
| API base URL  | `--api-url <url>` | `SEALANT_API_URL`       | `http://localhost:4000` |
| Owner user id | `--owner <id>`    | `SEALANT_OWNER_USER_ID` | `usr_local`             |

The config file is `~/.config/sealant/config.json`, or `$XDG_CONFIG_HOME/sealant/config.json` when
`XDG_CONFIG_HOME` is set. It stores only `apiUrl` and `ownerUserId`.

```sh
sealant config show
sealant config set apiUrl http://localhost:4000
sealant config set ownerUserId usr_local
```

## Connected accounts

Connected accounts store provider credentials in your self-hosted control plane. They require
`SEALANT_CREDENTIALS_KEY` to be configured on the API; workspace injection also requires the same
key on the worker. See [Secrets and credentials](/docs/guides/secrets-and-credentials).

```sh
sealant auth status
sealant auth remove claude --name default
```

Provider commands:

| Command               | What it uploads                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `sealant auth claude` | A token from Anthropic's official `claude setup-token`. Use `--token` for non-interactive runs.     |
| `sealant auth codex`  | The official Codex CLI session file: `$CODEX_HOME/auth.json` or `~/.codex/auth.json`. Use `--file`. |
| `sealant auth github` | A GitHub token, usually captured from `gh auth token`. Use `--token` for non-interactive runs.      |

Common flags:

- `--name <name>` stores multiple accounts per provider; default is `default`.
- `--yes` / `-y` skips confirmation prompts where the command supports it.
- `sealant auth claude --token <token>` and `sealant auth github --token <token>` avoid interactive
  capture.
- `sealant auth codex --file <path>` uploads a specific Codex `auth.json`.

The CLI validates credential shape locally before upload. GitHub tokens also get a live
`api.github.com/user` preflight; a token must include `repo`, and `workflow` is recommended.

## Profile bindings

Profiles can bind one connected account per provider. The CLI lists profiles and sets or clears
those bindings through `/v1/profiles`.

```sh
sealant profiles list
sealant profiles bind <profile-slug-or-id> --claude default --codex default --github work
sealant profiles bind <profile-slug-or-id> --clear claude,codex
```

`--claude`, `--codex`, and `--github` take connected-account names. `--clear` takes a
comma-separated provider list. A provider cannot be both set and cleared in the same command.

## Automation notes

- There are no API tokens today. Keep the API on loopback or behind your own authenticating proxy.
- The CLI is useful for connected-account setup and profile binding automation. Use the
  [HTTP API](/docs/reference/http-api) or [`@sealant/sdk`](/docs/reference/sdk) for workspace and
  run automation.
