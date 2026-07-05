---
title: Sealant Docs Content
slug: /
status: draft
owner: engineering
updated: 2026-04-03
---

This directory contains framework-agnostic Markdown content for the docs site.

The intent is to keep documentation authoring moving while the final docs rendering stack is still
in flux.

## Sections

- [packages/index.md](./packages/index.md): package-by-package reference docs
- [architecture/index.md](./architecture/index.md): cross-package lifecycle and system flow docs
- [apps/index.md](./apps/index.md): deployable app/service docs
- [getting-started/index.md](./getting-started/index.md): local setup and first-run guides
- [changelog/index.md](./changelog/index.md): implementation notes and rollout history

## Writing conventions

- Prefer the product terms `sandbox`, `run`, and `harness` in user-facing descriptions.
- Use `sandbox build job` and `attempt` only for internal orchestration details.
- Keep pages focused on boundaries, contracts, and call flows.
