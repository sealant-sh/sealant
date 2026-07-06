---
title: What ships today
description: An honest status table of every Sealant surface — shipped, preview, or planned.
---

Sealant is early, and these docs never present unshipped surface as real. This page is the single
source of truth for what state each surface is in. When another page says "preview" or "planned",
this is what it means:

- **Shipped** — wired end to end; you can use it today on a self-hosted install.
- **Preview** — real code you can try, but incomplete, unpublished, or not persisted; expect gaps
  and breaking changes.
- **Mock** — the UI exists but renders static placeholder data; nothing you do there persists.
- **Planned** — does not exist yet; anything describing it is direction, not documentation.

## Status table

| Surface                 | Status  | Current state                                                                                                                                                                                                                                                      |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One-line installer      | Shipped | `curl -fsSL https://get.sealant.dev \| sh` installs, repairs, and upgrades the full stack; see [Install](/docs/getting-started/install).                                                                                                                           |
| Web app: workspace flow | Shipped | Create, list, rename, rerun, and inspect workspaces (status, attempts, events, spec, published image). No stop/delete from the UI yet.                                                                                                                             |
| SSH access              | Shipped | Register keys in Settings → SSH keys, then `ssh -p 2222 ws-<workspace-id>@localhost`; VS Code/Cursor Remote-SSH work over the same path. See [SSH access](/docs/guides/ssh-access).                                                                                |
| GitHub App integration  | Shipped | Import an installation at `/github/setup`, sync repositories, and use private repos in workspace creation. See [GitHub App](/docs/guides/github-app).                                                                                                              |
| HTTP API                | Shipped | Workspaces, runs and execution records (timeline/scrollback/loss/changes), SSH keys, registries, GitHub, package resolution; OpenAPI at `/openapi.json`. See [HTTP API](/docs/reference/http-api).                                                                 |
| API auth / API tokens   | Planned | There are no API tokens and no bearer-auth enforcement today. Identity is an `ownerUserId` passed in payloads and queries — a temporary model. Keep the API on loopback.                                                                                           |
| SDK (`@sealant/sdk`)    | Preview | Covers the workspace → run → record path: blocking `harness.run()`, non-blocking `harness.start()` + `record.stream()`, and the record read surface. First npm release in flight — usable only inside the monorepo until it lands. See [SDK](/docs/reference/sdk). |
| CLI                     | Planned | No `sealant` CLI exists. The installer script is the only command-line entry point. See [CLI](/docs/reference/cli).                                                                                                                                                |
| Runs review UI          | Preview | The run record page (workspace → run) renders the recorded timeline: commands with per-command scrollback, attribution, and raw events. No artifact UI yet; live runs poll rather than stream.                                                                     |
| Secrets management      | Planned | No in-app secrets management exists. See [Secrets and credentials](/docs/guides/secrets-and-credentials) for what you can do today.                                                                                                                                |
| Repositories UI         | Mock    | `/repositories` pages render static placeholder data.                                                                                                                                                                                                              |
| Profiles UI             | Mock    | `/profiles` pages render static placeholder data; the create form does not submit.                                                                                                                                                                                 |
| Registry UI             | Mock    | `/registry` pages render mock registry data. The real registry endpoints exist in the [HTTP API](/docs/reference/http-api).                                                                                                                                        |
| Password reset          | Planned | The forgot/reset password forms exist but reset emails are not available yet.                                                                                                                                                                                      |

## How to read the rest of the docs

Guides and references only document shipped behavior in their instructions. Where a page touches a
preview or planned surface, it links back here rather than describing behavior that does not exist.
If you find a page that contradicts this table, the table wins — and please
[open an issue](https://github.com/sealant-sh/sealant/issues).
