# Zweit

Zweit is a product for spinning up isolated, ready-to-code microVM environments from a polished web UI.

The core idea stays the same: a user picks a Git repository, an AI coding harness, and optional personalization inputs like dotfiles or Nix flakes. Zweit turns those inputs into a composed environment and provisions a disposable runtime that feels personal, reproducible, and isolated.

## Status

This repository is now scaffolded as a `Turborepo` monorepo using `pnpm` workspaces, with a root Nix flake for a reproducible `direnv`-powered development shell.

Today the repo contains the workspace layout and shared build orchestration. Application code will grow into the workspaces below instead of living in top-level product folders.

## Monorepo layout

```text
.
├── apps/                 # deployable apps and services
│   └── README.md
├── packages/             # shared libraries, domain modules, and reusable code
│   └── README.md
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

- `apps/`: user-facing and deployable surfaces such as the website, API, workers, or control-plane services
- `packages/`: shared code such as UI primitives, environment models, adapters, SDKs, and reusable utilities
- `tooling/`: centralized configs and tooling packages such as TypeScript, ESLint, Prettier, Vitest, Tailwind, or internal scripts

## Planned product shape

Zweit still has three major product areas, but they will be implemented through the monorepo workspaces:

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
- resolve repos and configuration sources
- compose the final Nix flake
- coordinate provisioning and lifecycle
- talk to runtime adapters
- track environment state, logs, and failures

### 3. Runtime / infra layer

The infrastructure side contains the deployment and execution model for isolated environments:

- Kubernetes manifests and platform configuration
- runtime and scheduling integration
- networking, storage, and secrets wiring
- adapter implementations for different deployment targets

The architecture should stay adapter-oriented so Zweit can target different execution backends over time.

## Why the monorepo uses Turbo + pnpm

- `pnpm` workspaces keep dependency management fast, strict, and centralized
- `Turborepo` gives us task orchestration, caching, and a clean way to scale builds across apps and shared packages
- shared tooling in `tooling/` keeps config consistent without copy-pasting setup across apps

## Tooling baseline

- `direnv` + Nix provide a reproducible shell with `nodejs_latest` and `pnpm`
- `oxlint` handles repo-wide linting
- `oxlint-tsgolint` enables type-aware Oxlint rules backed by TypeScript Go
- `oxfmt` handles repo-wide formatting
- `@typescript/native-preview` provides the `tsgo` CLI at the root alongside regular `typescript`

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
- define the flake composition model
- define the runtime adapter interface
- document the security model and trust boundaries

## Why this repo exists

Zweit is trying to make spinning up a personal, AI-ready coding microVM feel easy, fast, and clean without giving up reproducibility or isolation.

The goal is a product experience that feels simple on the surface while staying disciplined underneath.
