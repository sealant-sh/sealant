---
title: Sealant Docs Content
slug: /
status: draft
owner: engineering
updated: 2026-03-28
---

# Sealant Docs Content

This directory contains framework-agnostic Markdown content for the docs site.

The intent is to keep documentation authoring moving while the final docs rendering stack is still
in flux.

## Sections

- [packages/index.md](./packages/index.md): package-by-package reference docs
- [architecture/index.md](./architecture/index.md): cross-package lifecycle and system flow docs
- [apps/index.md](./apps/index.md): deployable app/service docs
- [getting-started/index.md](./getting-started/index.md): local setup and first-run guides

## Writing conventions

- Prefer product terms `sandbox` and `issue workflow` in user-facing descriptions.
- Use `workspace build job` and `run` only for internal orchestration details.
- Keep pages focused on boundaries, contracts, and call flows.
