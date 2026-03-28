---
title: "@sealant/workspace-composition"
slug: /packages/workspace-composition
status: draft
owner: engineering
updated: 2026-03-28
---

# @sealant/workspace-composition

## Purpose

`@sealant/workspace-composition` defines the core composition contracts used to turn user intent
into a normalized sandbox build target.

It accepts a user-facing `UserWorkspaceSpec`, normalizes it into `WorkspaceBlueprint`, and defines
the executor contracts consumed by concrete OS integrations.

## Why this package exists

- Keep sandbox composition rules centralized and reusable across apps.
- Keep product-facing inputs (`sandbox` and `issue workflow` context) separated from execution
  implementation details.
- Provide stable, typed contracts that integration packages can compile from.

## Public surface

Core export groups:

- `user-workspace-spec`: parse and normalize user input (`parseUserWorkspaceSpec`,
  `normalizeUserWorkspaceSpec`, `userWorkspaceSpecSchema`)
- `blueprint`: normalized model (`workspaceBlueprintSchema`, `parseWorkspaceBlueprint`,
  `workspaceBlueprintVersion`)
- `executor`: OS executor contracts and build artifact schemas
- `buildkit`: BuildKit-specific compile input/output schemas used by BuildKit-backed executors

Top-level exports live in `packages/workspace-composition/src/index.ts`.

## Module map

- `src/user-workspace-spec.ts`
  - ergonomic user input schema
  - alias conflict validation
  - shorthand normalization to canonical blueprint shape
- `src/blueprint.ts`
  - normalized internal blueprint schema
  - target/runtime/access/lifecycle/customization defaults
- `src/executor.ts`
  - `OsExecutor` interface
  - support failure vocabulary
  - standardized build artifact schemas
- `src/buildkit.ts`
  - BuildKit-specialized compile schemas (`ResolvedImagePlan`, `BuildkitBuildSpec`)

## Normalization guarantees

`normalizeUserWorkspaceSpec(input)` guarantees that downstream layers receive one strict contract:

- exactly one workspace source (`source`, `repo`, or `sources.workspace`)
- inferred source provider when omitted (`github`, `gitlab`, `generic`)
- deduped symbolic package requests
- normalized setup/startup command steps
- explicit target OS and runtime selectors
- resolved runtime defaults (workspace paths, persistence, OCI runtime, outbound networking)

## Support and compile contracts

`OsExecutor.supports(...)` returns a typed success/failure shape.

Standardized support failure reasons:

- `unsupported-os`
- `unsupported-harness`
- `unsupported-package`
- `unsupported-access-mode`
- `unsupported-runtime-requirement`

`OsExecutor.compile(...)` returns one or more standardized artifacts:

- `oci-image`
- `filesystem-closure`
- `manifest`
- `metadata`

## Related contract docs

- `packages/workspace-composition/docs/contracts.md`
- `packages/workspace-composition/docs/user-workspace-spec.md`
- `packages/workspace-composition/docs/workspace-blueprint.md`
- `packages/workspace-composition/docs/executor-contract.md`

## Deep dive pages

- [User Workspace Spec](./workspace-composition/user-workspace-spec.md)
- [Workspace Blueprint](./workspace-composition/workspace-blueprint.md)
- [Executor and BuildKit Contracts](./workspace-composition/executor-and-buildkit-contracts.md)

## Internal dependencies

- External runtime dependencies: `zod`
- Internal package dependencies: none

## Typical call flow

1. Product/API surface receives a workspace request.
2. Request is normalized into `WorkspaceBlueprint`.
3. Blueprint is passed to OS executor selection and compile steps.
4. Compile step returns artifacts that downstream registry/runtime layers use.

## Scripts

- `pnpm --filter @sealant/workspace-composition lint`
- `pnpm --filter @sealant/workspace-composition test`
- `pnpm --filter @sealant/workspace-composition typecheck`
