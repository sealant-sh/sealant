---
title: GitHub App for private repos
description:
  Create a GitHub App, wire its credentials into Sealant, and import the installation so you can
  build workspaces from private repositories.
---

Public repositories clone from a raw Git URL with no extra setup. Private repositories need a
**GitHub App**: Sealant uses the app's installation to mint short-lived tokens for cloning, instead
of a personal access token. This page walks the whole path — create the app, wire the credentials,
import the installation, sync repositories.

## 1. Create the GitHub App

In GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App** (create it under
your personal account or an organization, depending on where the repos live).

Fill in the essentials:

- **GitHub App name** — anything, e.g. `sealant-<yourname>`.
- **Homepage URL** — your Sealant web URL is fine (e.g. `http://localhost:3000`).
- **Webhook** — uncheck **Active**. Sealant does not require webhooks for the clone flow (see
  [Webhooks](#webhooks-optional) below).

Set **Repository permissions**:

- **Contents** — Read-only (required to clone private repos).
- **Metadata** — Read-only (granted automatically).

Under **Where can this app be installed?**, pick whichever scope matches your repos. Then **Create
GitHub App**.

## 2. Generate a private key

On the app's settings page, scroll to **Private keys** and click **Generate a private key**. GitHub
downloads a `.pem` file. Note the numeric **App ID** shown near the top of the same page — you need
both.

## 3. Wire the credentials into Sealant

Both values go into `~/.sealant/.env`. The self-host compose file passes `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` through to the API and worker.

```sh
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

The private key is multi-line PEM. You can either:

- paste it with literal `\n` escapes on one line as shown above (Sealant normalizes escaped newlines
  in code), or
- paste the real multi-line PEM inside double quotes.

Then re-run the installer to restart the API and worker with the new environment:

```sh
curl -fsSL https://get.sealant.dev | sh
```

Re-running without `SEALANT_VERSION=latest` repairs the current install in place — your generated
secrets and data are never regenerated. See
[Upgrade, repair, uninstall](/docs/guides/upgrade-repair-uninstall).

## 4. Install the app on your repositories

Back in the GitHub App's settings, open **Install App** and install it on the account or
organization that owns your repos. Choose **All repositories** or select specific ones. GitHub
creates an **installation** and gives it an ID.

## 5. Import the installation into Sealant

Open the web app at **`/github/setup`**. You can import the installation two ways:

- **Automatic** — if you reach the page via GitHub's post-install setup redirect, Sealant reads the
  `installation_id` from the query string and imports it for you.
- **Manual** — paste the installation ID. Find it in the URL of the installation's settings page in
  GitHub (`.../installations/<id>`).

Once imported, click **Sync repositories** to pull the list of repos the installation can access.

## 6. Build a workspace from a private repo

Go to [`/workspaces/new`](/docs/guides/creating-workspaces). For **Source**, choose the GitHub App
repository option, select your installation, and pick a synced repository and ref. Sealant mints a
short-lived installation token for the clone at build time — no long-lived token is stored on disk.

You can also point the optional **config/dotfiles** repository at a private GitHub App repo the same
way.

## Webhooks (optional)

Sealant exposes a webhook endpoint at **`POST /v1/github/webhooks`** for installation and
installation-repository change events. It is not required for the clone flow.

To enable signature verification, the API reads `GITHUB_APP_WEBHOOK_SECRET`. **Caveat:** the
self-host compose file does **not** pass this variable through by default. If the secret is absent,
the webhook endpoint returns service-unavailable. To use webhooks you must edit
`~/.sealant/compose.yaml` to add `GITHUB_APP_WEBHOOK_SECRET` to the API service environment (and set
a matching secret in your GitHub App's webhook config). Expected request headers are
`x-github-delivery`, `x-github-event`, and `x-hub-signature-256`.

## Notes

- Private repo auth uses **GitHub App installation tokens**, not classic PATs.
- `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_SLUG` are parsed by the env
  schema but are **not** used by the current setup or clone flow. You do not need to set them.
- `GITHUB_APP_PRIVATE_KEY_PATH` is an alternative to `GITHUB_APP_PRIVATE_KEY`: point it at a mounted
  PEM file and the code hydrates the key from disk. It is not passed through the default compose
  file, so you would need to mount the file and edit compose to use it.

See [Environment variables](/docs/reference/environment-variables) for the full list, and
[Secrets and credentials](/docs/guides/secrets-and-credentials) for how these tokens fit the broader
credential model.
