---
title: Contributing
description:
  Orientation for working on Sealant itself — monorepo shape, where things live, and where the real
  rules live.
---

Sealant is a `pnpm` + `turbo` monorepo. Everything you need to build or change the runtime lives in
one repo: the control-plane API, the web app, the background worker, the SSH gateway, and the shared
packages that carry the workspace domain and the execution record between them.

## Where things live

- **`apps/`** — deployable surfaces: the product web app, the control-plane API, the worker, the SSH
  gateway, this docs site, and the marketing site. See
  [Monorepo layout](/docs/contributing/monorepo-layout) for a one-paragraph map of each.
- **`packages/`** — shared libraries: wire contracts, the workspace domain, the
  telemetry/execution-record log, auth, the design system, and the (unpublished, preview) SDK. Same
  page as above.
- **`tooling/`** — centralized TypeScript, lint, format, and test config shared by every workspace.

## Start here

- [Local development](/docs/contributing/local-development) — enter the dev shell, install deps, and
  run the full stack (infra in Docker, API and web on the host, a real workspace, SSH into it).
- [Monorepo layout](/docs/contributing/monorepo-layout) — what each app and package is for.
- [Effect and API conventions](/docs/contributing/effect-and-api-conventions) — the wiring pattern
  every new API route follows, from DB repository to HTTP handler.
- [Design system](/docs/contributing/design-system) — the token/type/component language shared by
  the web app, marketing site, and `@sealant/ui`.
- [Docs authoring](/docs/contributing/docs-authoring) — how this site is built and the honesty rule
  behind every page in it.

## The canonical rules

Two files at the repo root are the actual source of truth for agent and contributor conventions —
this site links to them rather than duplicating them, so they stay in sync:

- [`AGENTS.md`](https://github.com/sealant-sh/sealant/blob/main/AGENTS.md) — product language,
  dependency and workspace rules, model-selection guidance for agent work, and Effect conventions.
- [`DEVELOPMENT.md`](https://github.com/sealant-sh/sealant/blob/main/DEVELOPMENT.md) — the canonical
  runbook for running the full stack locally, including SSH access and the release/packaging flow.

If a doc page here and one of those files ever disagree, the repo file wins.
