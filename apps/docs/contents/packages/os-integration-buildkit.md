---
title: "@sealant/os-integration-buildkit"
slug: /packages/os-integration-buildkit
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/os-integration-buildkit

## Purpose

`@sealant/os-integration-buildkit` is the concrete OS integration that compiles a normalized
`WorkspaceBlueprint` into build artifacts using Docker BuildKit.

It currently ships executors for `fedora`, `arch`, and `nix` target OS families.

## Why this package exists

- Translate composition-level contracts into concrete image build plans.
- Keep BuildKit-specific implementation details outside core composition.
- Produce reproducible artifacts for later registry publishing and runtime launch.

## Module map

- `src/buildkit-executor.ts`
  - distro definitions
  - support checks
  - image-plan mapping
  - BuildKit context rendering and docker execution
- `src/index.ts`
  - public executor factory and plan mapping exports

## Public surface

- `BuildkitDistroOsExecutor`
- `createBuildkitOsExecutor(osFamily, options)`
- `mapBlueprintToBuildkitImagePlan(blueprint, osFamily)`
- `BuildkitCommandRunner`
- `BuildkitCommandResult`
- `BuildkitCommandOptions`
- `BuildkitOsExecutorOptions`

Exports are defined in `packages/os-integration-buildkit/src/index.ts`.

## Supported OS families

- `fedora`
- `arch`
- `nix`

## Support rules

The executor rejects a blueprint when:

- the requested target OS family is not `auto` or the executor family
- the selected harness id is unknown to `@sealant/ai-harness-integrations`
- a symbolic package request includes a version pin
- the blueprint includes non-dotfiles input sources
- more than one dotfiles input source is present

## Image planning behavior

The resolved image plan includes:

- distro base image
- distro package manager
- package install mappings
- dotfiles plan, when present
- build/runtime secret references
- runtime environment and image environment

The executor then writes a temporary BuildKit context and emits:

- `oci-image` tarball artifact
- metadata for resolved image plan
- metadata for BuildKit spec

## Compile behavior

During compile, the executor:

1. Validates support for the target blueprint.
2. Generates a resolved image plan.
3. Writes a temporary BuildKit context (Containerfile, entrypoint script, metadata files).
4. Runs Docker BuildKit to build and then `docker save` an image tarball artifact.

Returned artifacts include:

- `oci-image` tarball artifact (`loader: docker-load`)
- metadata artifact for resolved image plan (`json`)
- metadata artifact for BuildKit spec (`json`)

## Support constraints

Current constraints enforced by support checks:

- target OS must be `auto` or match executor family
- harness id must be known in `@sealant/ai-harness-integrations`
- package version pinning is not supported yet
- only `dotfiles` input sources are currently supported
- at most one dotfiles input source

## Runtime flow

1. `supports(input)` validates the blueprint for the current OS family.
2. `compile(input)` renders a BuildKit context.
3. Docker BuildKit builds the image.
4. Docker saves the image to a tarball artifact.
5. The compile result is normalized into shared executor output contracts.

## Cross-package dependency

- Depends on `@sealant/ai-harness-integrations` for harness installation and launch commands.
- Depends on `@sealant/workspace-composition` for normalized blueprints and executor contracts.

## Internal dependencies

- Internal package dependencies:
  - `@sealant/ai-harness-integrations`
  - `@sealant/workspace-composition`
- External runtime dependencies: `zod` (through workspace-composition types), Node runtime APIs

## Scripts

- `pnpm --filter @sealant/os-integration-buildkit lint`
- `pnpm --filter @sealant/os-integration-buildkit test`
- `pnpm --filter @sealant/os-integration-buildkit typecheck`
