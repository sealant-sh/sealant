---
title: SSH access
description:
  Register an SSH key and connect into a live sandbox through the gateway — including VS Code and
  Cursor, and the one-key-per-user gotcha.
---

Every sandbox with SSH enabled is reachable through the Sealant SSH gateway. You authenticate with
an SSH key you register once, and connect to a per-sandbox username. Your key never leaves your
machine; the gateway only ever sees your public key.

## Register a public key

The gateway does public-key auth only. Before you can connect, register the **public** half of a
keypair.

Two places register a key, and they write to the same store:

- **Settings → SSH keys** (`/settings/ssh-keys`) — paste a public key, optionally name it, and it
  works immediately. You can also list and remove registered keys here.
- **Inline in the sandbox builder** — when you enable SSH on a new sandbox and have no key yet, the
  builder lets you register one without leaving the form. See
  [Creating sandboxes](/docs/guides/creating-sandboxes).

If you do not have a key, generate one:

```bash
ssh-keygen -t ed25519 -C "you@example.com"
```

Then paste the contents of the public file (for example `~/.ssh/id_ed25519.pub`) into the form.

## The gateway model

You do not connect to a sandbox directly. You connect to the gateway on port `2222`, and it routes
you into the right sandbox based on the username and your key.

- **Username** is `sbx-<sandbox-id>` — the sandbox id with an `sbx-` prefix.
- **Auth** is public-key only. Passwords are never accepted.
- **Principal resolution**: on connect, the gateway maps your key's fingerprint to the user who
  registered it, then asks the API for the sandbox's SSH target. The API authorizes the connection
  only when the sandbox is owned by that same user and its runtime is `running` or `ready`.

So a connection succeeds only when the key you present belongs to the user who owns the sandbox you
are asking for.

## Connect

Once the sandbox is running and your key is registered:

```bash
ssh -p 2222 sbx-<sandbox-id>@localhost
```

If you changed `SEALANT_SSH_PORT` or `SEALANT_SSH_HOST` at install time, substitute those values for
`2222` and `localhost`. See [Environment variables](/docs/reference/environment-variables).

If your registered key is not your default identity, point SSH at it explicitly:

```bash
ssh -p 2222 -i ~/.ssh/id_ed25519 sbx-<sandbox-id>@localhost
```

## From VS Code or Cursor

The sandbox detail page (`/sandboxes/<sandbox-id>`) shows action buttons when the sandbox exposes an
SSH endpoint:

- **Open in VS Code** and **Open in Cursor** launch the editor's Remote-SSH flow against the
  sandbox.
- **Copy SSH command** copies the ready-to-run `ssh` line for the sandbox.

The editor buttons open a `vscode://` / `cursor://` remote authority that targets the
`sbx-<sandbox-id>` alias. For the editor to resolve that alias to the right host, port, and identity
file, add a matching entry to your `~/.ssh/config`:

```
Host sbx-*
  HostName localhost
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
```

With that in place, `ssh sbx-<sandbox-id>` and the editor buttons both resolve the same way.

## Gotchas

- **One physical key can be active for only one user.** Active key fingerprints are globally unique
  across Sealant. If you try to register a public key that is already active for another account, it
  will not attach to yours. Use a distinct key per user.
- **A static allowlist wins over the database.** If the operator configured
  `SSH_GATEWAY_ALLOWED_KEYS_FILE`, keys in that file are accepted before database resolution runs —
  and removing a key from the web UI cannot override a key that is still present in the static file.
- **Changed port or host.** The `2222` / `localhost` defaults come from `SEALANT_SSH_PORT` and
  `SEALANT_SSH_HOST`. If your install overrides them, every command and config entry above uses your
  values instead.
- **The sandbox must be up.** Principal resolution only authorizes a target whose runtime is
  `running` or `ready`. A queued, building, or failed sandbox refuses SSH.

## Related

- [Creating sandboxes](/docs/guides/creating-sandboxes) — enabling SSH and registering a key inline.
- [Environment variables](/docs/reference/environment-variables) — `SEALANT_SSH_PORT`,
  `SEALANT_SSH_HOST`, and gateway knobs.
- [Ports and data](/docs/reference/ports-and-data) — what binds to loopback and where the gateway
  host key lives.
