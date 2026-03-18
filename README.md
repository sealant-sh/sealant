# Sealant

Sealant is a product for spinning up isolated, ready-to-code microVM environments from a polished web UI.

The core idea stays the same: a user picks a Git repository, an AI coding harness, and optional personalization inputs like dotfiles or Nix flakes. Sealant turns those inputs into a composed environment and provisions a disposable runtime that feels personal, reproducible, and isolated.

## Status

This repository is now scaffolded as a `Turborepo` monorepo using `pnpm` workspaces, with a root Nix flake for a reproducible `direnv`-powered development shell.

Today the repo contains the initial workspace layout, the first workspace composition implementation, and the target architecture for splitting composition, OS integrations, runtime adapters, and app surfaces into separate workspaces. Several of the workspaces below are intentionally lightweight placeholders so the intended boundaries are visible in the repo before every implementation lands.

## Monorepo layout

```text
.
├── apps/                 # deployable apps and runnable demos
│   ├── README.md
│   ├── api/
│   ├── docs/
│   ├── electron/
│   ├── marketing/
│   ├── web/
│   └── workspace-composition-demo/
├── packages/             # shared libraries, domain modules, and reusable code
│   ├── README.md
│   ├── ai-harness-integrations/
│   ├── os-integration-arch/
│   ├── os-integration-fedora/
│   ├── os-integration-nix/
│   ├── registry-integration/
│   ├── runtime-adapter-docker/
│   ├── runtime-adapter-k3s/
│   ├── runtime-adapter-k8s/
│   ├── runtime-adapters-api/
│   ├── source-integrations/
│   └── workspace-composition/
├── tooling/              # shared config packages and developer tooling
│   └── README.md
├── .envrc                # direnv entrypoint for the Nix dev shell
├── .gitignore
├── .oxfmtrc.json         # repo-wide formatter config
├── .oxlintrc.json        # repo-wide linter config
├── flake.nix             # Nix development shell definition
├── flake.lock            # pinned flake inputs
├── package.json          # root scripts and Turbo dependency
├── pnpm-workspace.yaml   # workspace discovery
├── tsconfig.json         # root TypeScript and tsgo config
├── turbo.json            # task graph and caching config
└── README.md
```

### Workspace roles

- `apps/`: user-facing and deployable surfaces such as the website, API, docs, desktop clients, or runnable demo entrypoints
- `packages/`: shared code such as composition models, OS integrations, runtime adapters, source integrations, harness orchestration, SDKs, and reusable utilities
- `tooling/`: centralized configs and tooling packages such as TypeScript, ESLint, Prettier, Vitest, Tailwind, or internal scripts

## Architecture flow

The long-term architecture is built around a small set of explicit contracts:

1. The product surfaces submit a `UserWorkspaceSpec`.
2. The control plane normalizes that into a `WorkspaceBlueprint`.
3. Workspace composition selects an OS integration and produces a concrete build plan.
4. The selected OS integration produces one or more build artifacts.
5. Runtime adapters launch those artifacts on Docker, Kubernetes, K3s, or future targets.

Supporting integrations feed into that flow without owning it:

- source integrations resolve repositories, refs, and provider-specific access details
- AI harness integrations describe harness requirements and launch behavior
- registry integrations publish, tag, and retrieve produced artifacts

### Current implementation status

- `packages/workspace-composition/`: core composition package that owns the shared workspace contracts and OS-agnostic composition model
- `apps/workspace-composition-demo/`: thin runnable demo workspace that exercises the current composition flow and example specs
- `packages/os-integration-nix/`: extracted Nix-specific executor implementation and example build outputs
- the other package and app workspaces are scaffolded so the intended architecture is explicit before each implementation is filled in

## Planned product shape

Sealant still has three major product areas, but they will be implemented through the monorepo workspaces:

### 1. Website

The website is the user-facing product surface. It should make environment creation feel fast, obvious, and trustworthy.

Core responsibilities:

- collect repo and environment inputs
- present available AI harnesses and runtime options
- show launch status and environment lifecycle state
- eventually manage saved templates, profiles, and histories

### 2. Backend / control plane

The backend turns user intent into a running environment.

Core responsibilities:

- validate and normalize user inputs
- produce `WorkspaceBlueprint` values from validated requests
- resolve repos and configuration sources
- select OS integrations and runtime adapters
- compose the final build request
- coordinate provisioning and lifecycle
- talk to runtime adapters
- track environment state, logs, and failures

### 3. Runtime / infra layer

The infrastructure side contains the deployment and execution model for isolated environments:

- Kubernetes manifests and platform configuration
- runtime and scheduling integration
- networking, storage, and secrets wiring
- adapter implementations for different deployment targets

The architecture should stay adapter-oriented so Sealant can target different execution backends over time.

## Defined package architecture

- `packages/workspace-composition/`: core composition system for `UserWorkspaceSpec`, `WorkspaceBlueprint`, normalization/defaulting, executor contracts, executor selection, and build artifact definitions
- `packages/os-integration-nix/`: Nix-specific OS integration that turns a `WorkspaceBlueprint` into a concrete Nix build path
- `packages/os-integration-fedora/`: Fedora-specific OS integration placeholder
- `packages/os-integration-arch/`: Arch-specific OS integration placeholder
- `packages/runtime-adapters-api/`: shared contract between the control plane and runtime adapter implementations
- `packages/runtime-adapter-docker/`: Docker runtime adapter placeholder
- `packages/runtime-adapter-k8s/`: Kubernetes runtime adapter placeholder
- `packages/runtime-adapter-k3s/`: K3s runtime adapter placeholder
- `packages/source-integrations/`: source-provider integration package for repository selection, ref resolution, and provider-specific access flows; GitHub will be the first provider here
- `packages/ai-harness-integrations/`: shared contracts and orchestration for AI coding harnesses
- `packages/registry-integration/`: artifact and registry publishing, tagging, lookup, and retrieval

## Defined app architecture

- `apps/web/`: main product web app for creating and managing workspaces
- `apps/api/`: control-plane API for validation, orchestration, lifecycle, and state
- `apps/docs/`: user and contributor documentation site
- `apps/marketing/`: public website and launch surfaces
- `apps/electron/`: desktop client surface if desktop becomes a first-class client
- `apps/workspace-composition-demo/`: runnable demo for composition flows and blueprint examples

## Why the monorepo uses Turbo + pnpm

- `pnpm` workspaces keep dependency management fast, strict, and centralized
- `Turborepo` gives us task orchestration, caching, and a clean way to scale builds across apps and shared packages
- shared tooling in `tooling/` keeps config consistent without copy-pasting setup across apps

## Tooling baseline

- `direnv` + Nix provide a reproducible shell with `nodejs_24` and `pnpm`
- `oxlint` handles repo-wide linting
- `oxlint-tsgolint` enables type-aware Oxlint rules backed by TypeScript Go
- `oxfmt` handles repo-wide formatting
- `@typescript/native-preview` provides the `tsgo` CLI at the root alongside regular `typescript`

## Workspace composition

The composition contracts now live in `packages/workspace-composition/`, and the concrete Nix build path now lives in `packages/os-integration-nix/` instead of the temporary sandbox under `temp/`.

That package contains:

- `UserWorkspaceSpec` and `WorkspaceBlueprint` documentation
- normalization and defaulting helpers
- executor and artifact contract definitions
- shared composition contracts that feed concrete OS integrations such as `packages/os-integration-nix/`

The runnable demo documentation lives in `apps/workspace-composition-demo/`.

## Getting started

Allow direnv to load the flake shell:

```bash
direnv allow
```

If you are not using direnv, you can enter the same shell manually:

```bash
nix develop
```

Then install dependencies:

```bash
pnpm install
```

Run common workspace tasks from the repo root:

```bash
pnpm dev
pnpm build
pnpm format
pnpm format:check
pnpm lint
pnpm lint:fix
pnpm lint:types
pnpm typecheck
pnpm typecheck:tsc
pnpm test
```

`pnpm build`, `pnpm dev`, and `pnpm test` are wired through Turbo. The lint, format, and typecheck commands run from the repo root so the baseline tooling works before app packages exist.

## Contributor notes

### Design principles

- Keep the user flow simple even if the underlying system is complex.
- Prefer reproducibility over hidden mutable state.
- Keep runtime adapters narrow and replaceable.
- Separate product concerns from execution concerns.
- Treat isolation as a first-class architectural requirement.
- Build around disposable environments, not hand-maintained pets.

### Early engineering priorities

- stand up the first app workspaces under `apps/`
- define shared domain packages under `packages/`
- centralize config and standards under `tooling/`
- extract the first OS integration boundary from the current Nix implementation
- define the runtime adapter interface
- define source and harness integration contracts
- document the security model and trust boundaries

## Why this repo exists

Sealant is trying to make spinning up a personal, AI-ready coding microVM feel easy, fast, and clean without giving up reproducibility or isolation.

The goal is a product experience that feels simple on the surface while staying disciplined underneath.
