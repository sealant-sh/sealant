---
title: CLI
description:
  There is no Sealant CLI yet — install.sh is the only command-line entry point today, and here is
  what to use for automation in the meantime.
---

**Sealant does not ship a CLI.** There is no `sealant` binary, no installable command-line tool, and
no `sealant <command>` interface. A CLI is planned, but nothing is shipped today — do not script
against a command that does not exist.

## The one command-line entry point

The only official command-line entry point is the installer, `install.sh`, run through the
one-liner:

```sh
curl -fsSL https://get.sealant.dev | sh
```

It installs, upgrades, and repairs a self-hosted Sealant. Its full reference — every environment
override and every `docker compose` command to operate the stack — is in
[Installer and compose](/docs/reference/installer-and-compose).

## Automating Sealant today

Until a CLI exists, drive Sealant programmatically through:

- **The [HTTP API](/docs/reference/http-api)** — the control plane on `http://localhost:4000`, with
  a live OpenAPI spec at `/openapi.json` you can generate a client from.
- **The [SDK](/docs/reference/sdk)** — `@sealant/sdk`, a fluent TypeScript client. It is preview and
  monorepo-only for now (not yet published to npm).

See [What ships today](/docs/introduction/what-ships-today) for the current state of every surface.
