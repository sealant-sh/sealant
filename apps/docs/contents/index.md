---
title: Sealant Documentation
description:
  Open-source, self-hosted runtime for agentic development — workspaces, runs, and replayable
  execution records.
---

Sealant is an open-source, self-hosted runtime for agentic development. It gives coding harnesses a
real, disposable development environment to work in — a **workspace** — and turns every harness
execution — a **run** — into a durable, replayable **execution record**. You run it on your own
infrastructure; your code never leaves it.

## Start here

- **[Install Sealant](/docs/getting-started/install)** — one command, needs only Docker with Compose
  v2:

  ```bash
  curl -fsSL https://get.sealant.dev | sh
  ```

- **[Create your first workspace](/docs/getting-started/first-workspace)** — sign up in the web app,
  add an SSH key, build a workspace around a real repository, and SSH into it.

## Learn the system

- **[What is Sealant](/docs/introduction)** — the model, who it's for, and what it deliberately is
  not.
- **[How Sealant works](/docs/introduction/how-sealant-works)** — the services a self-hosted install
  runs and how a workspace request flows through them.
- **[What ships today](/docs/introduction/what-ships-today)** — an honest status table of every
  surface: shipped, preview, or planned.

## Go deeper

- **Guides** — [connect the GitHub App](/docs/guides/github-app),
  [SSH into workspaces](/docs/guides/ssh-access),
  [create workspaces](/docs/guides/creating-workspaces),
  [runs and execution records](/docs/guides/runs-and-execution-records),
  [upgrade, repair, uninstall](/docs/guides/upgrade-repair-uninstall).
- **Reference** — [environment variables](/docs/reference/environment-variables),
  [ports and data](/docs/reference/ports-and-data), [the HTTP API](/docs/reference/http-api),
  [the SDK (preview)](/docs/reference/sdk).
- **Concepts** — [workspaces](/docs/concepts/workspaces),
  [execution records](/docs/concepts/execution-records), [harnesses](/docs/concepts/harnesses),
  [the security model](/docs/concepts/security-model).
- **Contributing** — [work on Sealant itself](/docs/contributing).
