# Composition Contracts

`@sealant/workspace-composition` owns the OS-agnostic composition layer for workspace creation.

## Core Contracts

- `UserWorkspaceSpec`: validated, user-facing request shape coming from a product surface such as
  `apps/web` or another API client; its first concrete schema now lives in
  `src/user-workspace-spec.ts`
- `WorkspaceBlueprint`: normalized, defaulted, OS-agnostic internal model used for executor
  selection; its first concrete schema now lives in `src/blueprint.ts`
- `OsIntegration`: package-level category for OS backends such as `os-integration-nix`; the concrete
  runtime contract they implement is `OsExecutor` from `src/executor.ts`
- `BuildArtifact`: the concrete result produced by an OS integration, such as an image, closure,
  manifest, metadata bundle, or another launchable artifact; its first standardized schema now lives
  in `src/executor.ts`
- `RuntimeAdapter`: contract implemented by packages such as `runtime-adapter-docker` or
  `runtime-adapter-k8s` that can launch a build artifact on a specific runtime target

## Ownership Boundaries

`workspace-composition` owns:

- `UserWorkspaceSpec`
- `WorkspaceBlueprint`
- normalization and defaulting
- executor selection and dispatch
- shared executor contracts
- shared build artifact definitions

`os-integration-*` packages own:

- OS-specific compilation and build behavior
- OS-specific package resolution
- OS-specific startup and bootstrap wiring
- concrete build artifacts for that integration

`runtime-adapters-api` owns:

- the launch contract between the control plane and runtime adapter implementations

`runtime-adapter-*` packages own:

- launch, stop, inspect, and lifecycle behavior for a concrete runtime backend

`source-integrations` owns:

- source-provider specific repository selection, ref resolution, and access flows

`ai-harness-integrations` owns:

- harness metadata, package requirements, and startup orchestration inputs

`registry-integration` owns:

- artifact publishing, tagging, lookup, and retrieval

## Intended Flow

1. A product surface submits a `UserWorkspaceSpec`.
2. Workspace composition normalizes that into a `WorkspaceBlueprint`.
3. Workspace composition selects an `OsIntegration`.
4. The selected OS integration produces one or more `BuildArtifact` values.
5. A runtime adapter launches those artifacts on Docker, Kubernetes, K3s, or another supported
   backend.

## Current Implementation Note

The first concrete Nix-backed build path now lives in `@sealant/os-integration-nix`. This package stays focused on the shared composition contracts, normalization, and executor-selection boundary that feed concrete OS integrations.
