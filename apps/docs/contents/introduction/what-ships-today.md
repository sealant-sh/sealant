---
title: What ships today
description: An honest status table of every Sealant surface — shipped, preview, or planned.
---

Sealant is early, and these docs never present unshipped surface as real. This page is the single
source of truth for what state each surface is in. When another page says "preview" or "planned",
this is what it means:

- **Shipped** — wired end to end; you can use it today on a self-hosted install.
- **Preview** — real code you can try, but incomplete, unstable, or only partially persisted; expect
  gaps and breaking changes.
- **Mock** — the UI exists but renders static placeholder data; nothing you do there persists.
- **Planned** — does not exist yet; anything describing it is direction, not documentation.

## Status table

| Surface                    | Status  | Current state                                                                                                                                                                                                                                                |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform release           | Shipped | Current platform release is `0.4.0`. Workspace images bake `ghcr.io/sealant-sh/sealantd:0.5.0` and run `sealantd boot` as PID 1.                                                                                                                             |
| One-line installer         | Shipped | `curl -fsSL https://get.sealant.dev \| sh` installs, repairs, and upgrades the full stack; see [Install](/docs/getting-started/install).                                                                                                                     |
| Web app: workspace flow    | Shipped | Create, list, rename, rerun, and inspect workspaces (status, build history, events, spec, published image). No stop/delete from the UI yet.                                                                                                                  |
| SSH access                 | Shipped | Register keys in Settings → SSH keys, then `ssh -p 2222 ws-<workspace-id>@localhost`; VS Code/Cursor Remote-SSH work over the same path. See [SSH access](/docs/guides/ssh-access).                                                                          |
| GitHub App integration     | Shipped | Import an installation at `/github/setup`, sync repositories, and use private repos in workspace creation. See [GitHub App](/docs/guides/github-app).                                                                                                        |
| HTTP API                   | Shipped | Workspaces, runs and execution records, SSH keys, connected accounts, profiles, registries, GitHub, package resolution, setup state; OpenAPI at `/openapi.json`. See [HTTP API](/docs/reference/http-api).                                                   |
| API auth / API tokens      | Planned | There are no API tokens and no bearer-auth enforcement on the control-plane API today. Identity is an `ownerUserId` passed in payloads and queries — a temporary model. Keep the API on loopback.                                                            |
| SDK (`@sealant/sdk`)       | Shipped | Published on npm as `@sealant/sdk` `0.4.0`. It covers workspace create/get/list, server-side `harness.run()` / `harness.start()`, run lookup, and record reads. Some typed methods still throw `SealantNotImplementedError`. See [SDK](/docs/reference/sdk). |
| CLI (`sealant`)            | Preview | Repo-local `apps/cli` binary with `auth`, `profiles`, and `config` subcommands for connected accounts and profile credential bindings. It is real code, but it is not a separately published package. See [CLI](/docs/reference/cli).                        |
| Runs review UI             | Preview | The run record page (workspace → run) renders the recorded timeline: commands with per-command scrollback, attribution, and raw events. No artifact UI yet; live runs poll rather than stream.                                                               |
| Connected accounts         | Preview | `/settings/connected-accounts`, CLI auth commands, profile agent bindings, and workspace credential injection exist. They require `SEALANT_CREDENTIALS_KEY`; the default self-host installer does not generate or persist that key yet.                      |
| General secrets management | Planned | Named user/org/global secrets are not wired. Profile secrets and env-var pages are static placeholders. See [Secrets and credentials](/docs/guides/secrets-and-credentials).                                                                                 |
| Repositories UI            | Mock    | `/repositories` pages render static placeholder data.                                                                                                                                                                                                        |
| Profiles UI                | Preview | `/profiles` list/detail pages are mostly static, but `/profiles/<profile-id>/agents` is wired to live profile credential bindings. The create form does not submit.                                                                                          |
| Registry UI                | Mock    | `/registry` pages still read mock data through the web app's registry service. The real registry endpoints exist in the [HTTP API](/docs/reference/http-api).                                                                                                |
| Password reset             | Planned | The forgot/reset password forms exist but reset emails are not available yet.                                                                                                                                                                                |

## How to read the rest of the docs

Guides and references only document shipped behavior in their instructions. Where a page touches a
preview or planned surface, it links back here rather than describing behavior that does not exist.
If you find a page that contradicts this table, the table wins — and please
[open an issue](https://github.com/sealant-sh/sealant/issues).
