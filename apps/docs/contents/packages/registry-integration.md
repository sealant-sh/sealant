---
title: "@sealant/registry-integration"
slug: /packages/registry-integration
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/registry-integration

## Purpose

`@sealant/registry-integration` is the registry-facing package for publishing and reading OCI image
artifacts, with Zot as the current backend.

## Why this package exists

- Keep registry protocol and publish workflow logic separate from API/worker apps.
- Standardize artifact publication outputs (tag and digest references).
- Maintain a reusable client surface for registry health/tag/manifest operations.

## Module map

- `src/client.ts`
  - Zot client, command runner, and publish helper
- `src/index.ts`
  - public exports for client creation and registry utilities

## Public surface

- `createZotRegistryClient(config)`
- `buildRegistryImageReference(...)`
- `RegistryClientHttpError`
- `ZotRegistryClient`
- publish and client contracts (`PublishOciImageInput`, `PublishOciImageResult`, etc.)

Exports are defined in `packages/registry-integration/src/index.ts`.

## Supported registry operations

- health/ping checks
- extension discovery
- repository tag listing
- manifest lookup
- OCI image publish into Zot

## Cross-package dependency

- Consumes `oci-image` artifacts produced by `@sealant/os-integration-buildkit`.
- Used by `@sealant/api` for registry inspection routes.
- Used by `@sealant/worker` after workspace build compilation.

## Registry terms

- `publish` means uploading an image into the registry
- `pull` means downloading an image from the registry
- `run` or `deploy` means starting something from that image on a runtime such as Docker,
  Kubernetes, Kata, or gVisor

## Current publish behavior

`publishOciImage(...)` currently performs a Docker-assisted upload path:

1. `docker load -i <artifact>`
2. `docker tag <image> <pushRegistry>/<repository>:<tag>`
3. `docker push <pushRegistry>/<repository>:<tag>`
4. resolve manifest digest through Zot API

This is an implementation detail of the current bridge from BuildKit output to registry storage.

## Local development

Start Zot:

```bash
docker compose up -d zot
```

Host endpoint: `http://127.0.0.1:5000`

Bundled config: `packages/registry-integration/dev/zot/config.json`

## Internal dependencies

- Internal package dependencies: none
- External runtime dependencies: none (Docker CLI required for current publish path)

## Scripts

- `pnpm --filter @sealant/registry-integration lint`
- `pnpm --filter @sealant/registry-integration test`
- `pnpm --filter @sealant/registry-integration typecheck`
