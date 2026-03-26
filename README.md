# Sealant

Sealant is a product built around two core ideas:

1. Fast, highly customizable, isolated sandboxes (ready-to-code microVM environments).
2. Detailed, reproducible issue-to-PR workflows with clear reporting of what happened.

Everything else in the architecture exists to serve those two product loops.

## Product terminology contract

To keep the product clear for users, we use exactly two primary domain terms in product-facing
surfaces and API contracts:

- `sandbox`: a launched, isolated coding environment
- `issue workflow`: an issue-to-PR execution flow with lifecycle and reporting

Implementation terms are still valid internally, but are not primary product nouns:

- `workspace run`: internal execution record
- `workspace build job`: internal queue/worker build task

If an API endpoint serves product UI, prefer naming and resource modeling around `sandboxes` and
`issue-workflows`.

## Two core product loops

### 1. Sandboxes / coding environments

A user picks a Git repository, an AI coding harness, and optional personalization inputs like
dotfiles or Nix flakes. Sealant turns those inputs into a composed environment and provisions a
disposable runtime that feels personal, reproducible, and isolated.

These environments are meant to be launched quickly and used however the user wants: AI-assisted
coding, manual development with their own tooling, testing ideas, or other focused tasks.

### 2. Issue-to-PR workflows

Sealant uses the same sandbox and composition engine to run structured issue-to-PR execution flows.
Each workflow execution is isolated, tracked, and reproducible, with clear lineage and reporting on
what the system did from issue intake through code changes and pull request output.

## Status

This repository is now scaffolded as a `Turborepo` monorepo using `pnpm` workspaces, with a root Nix
flake for a reproducible `direnv`-powered development shell.

Today the repo contains the initial workspace layout, the first workspace composition
implementation, and the target architecture for splitting composition, OS integrations, runtime
adapters, and app surfaces into separate workspaces. Several of the workspaces below are
intentionally lightweight placeholders so the intended boundaries are visible in the repo before
every implementation lands.

## Monorepo layout

```text
.
├── apps/                 # deployable apps and services
│   ├── README.md
│   ├── api/
│   ├── docs/
│   ├── electron/
│   ├── marketing/
│   └── web/
├── packages/             # shared libraries, domain modules, and reusable code
│   ├── README.md
│   ├── ai-harness-integrations/
│   ├── os-integration-buildkit/
│   ├── package-standardization/
│   ├── registry-integration/
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

- `apps/`: user-facing and deployable surfaces such as the website, API, docs, and desktop clients
- `packages/`: shared code such as composition models, OS integrations, runtime adapters, source
  integrations, harness orchestration, SDKs, and reusable utilities
- `tooling/`: centralized configs and tooling packages such as TypeScript, ESLint, Prettier, Vitest,
  Tailwind, or internal scripts

## Architecture flow

The long-term architecture is built around explicit contracts and shared infrastructure that power
both core loops.

Sandbox flow:

1. The product surfaces submit a `UserWorkspaceSpec`.
2. The control plane normalizes that into a `WorkspaceBlueprint`.
3. Workspace composition selects an OS integration and produces a concrete build plan.
4. The selected OS integration produces one or more build artifacts.
5. Runtime adapters launch those artifacts on Docker, Kubernetes, K3s, or future targets.

Issue-to-PR flow:

1. The product surfaces submit issue context, repository details, and execution preferences.
2. The control plane resolves inputs, composes the execution request, and provisions an isolated
   environment.
3. The worker executes the workflow, coordinates builds/tooling/harness actions, and records
   execution lineage.
4. The system persists artifacts, state transitions, and issue-to-PR reporting for auditability and
   reproducibility.

Supporting integrations feed into both flows without owning either flow:

- source integrations resolve repositories, refs, and provider-specific access details
- AI harness integrations describe harness requirements and launch behavior
- registry integrations publish, tag, and retrieve produced artifacts

### Current implementation status

- `packages/db/`: shared Drizzle + SQLite package for durable control-plane state including auth,
  repositories, profiles, workflow execution state, issue-to-PR lineage, and build-job coordination
- `packages/auth/`: shared Better Auth package for future product-app authentication, backed by the
  shared SQLite database package
- `packages/workspace-composition/`: core composition package that owns the shared workspace
  contracts and OS-agnostic composition model
- `apps/api/`: initial Hono-based control-plane API scaffold with generated OpenAPI docs, Scalar
  reference UI, and the first registry-backed route group
- `apps/worker/`: first background worker scaffold for consuming queued workspace image build jobs,
  running BuildKit executors for Fedora, Arch, and Nix, and publishing images to the registry
- `packages/workspace-build-queue/`: RabbitMQ queue transport package for durable workspace image
  build requests and dead-letter handling
- `packages/registry-integration/`: initial Zot-backed registry client plus local dev registry
  compose/config; today it publishes the current BuildKit-produced OCI image archive through a
  Docker-assisted upload flow into Zot, while keeping the stored artifact as a standard OCI image
  for later runtime adapters
- the other package and app workspaces are scaffolded so the intended architecture is explicit
  before each implementation is filled in

## Planned product shape

Sealant still has three major product areas, but each one exists to support the two core loops
(sandboxes and issue-to-PR):

### 1. Website

The website is the user-facing product surface. It should make both sandbox launch and issue-to-PR
execution feel fast, obvious, and trustworthy.

Core responsibilities:

- collect repo, environment, and issue inputs
- present available AI harnesses and runtime options
- show sandbox launch status and environment lifecycle state
- show issue workflow progress, outcomes, and reporting
- eventually manage saved templates, profiles, and histories

### 2. Backend / control plane

The backend turns user intent into sandbox sessions and issue workflows.

Core responsibilities:

- validate and normalize sandbox and issue-to-PR inputs
- produce `WorkspaceBlueprint` values from validated requests
- resolve repos and configuration sources
- select OS integrations and runtime adapters
- compose final build and execution requests
- coordinate provisioning, execution, and lifecycle
- talk to runtime adapters
- track environment state, logs, failures, and issue-to-PR lineage/reporting

### 3. Runtime / infra layer

The infrastructure side contains the deployment and execution model for isolated environments and
repeatable issue workflows:

- Kubernetes manifests and platform configuration
- runtime and scheduling integration
- networking, storage, and secrets wiring
- adapter implementations for different deployment targets

The architecture should stay adapter-oriented so Sealant can target different execution backends
over time.

## Defined package architecture

- `packages/db/`: shared SQLite database package for durable control-plane state, Drizzle schema,
  migrations, and repositories for build-job processing
- `packages/auth/`: shared Better Auth package for shared auth configuration, clients, and session
  helpers across product apps
- `packages/workspace-build-queue/`: RabbitMQ transport package for queue names, message contracts,
  publishers, consumers, and dev broker setup
- `packages/workspace-composition/`: core composition system for `UserWorkspaceSpec`,
  `WorkspaceBlueprint`, normalization/defaulting, executor contracts, executor selection, and build
  artifact definitions
- `packages/os-integration-buildkit/`: BuildKit-based OS integration for Fedora, Arch, and Nix image
  compilation
- `packages/package-standardization/`: Repology-backed package resolution and normalized package
  contract utilities
- `packages/runtime-adapters-api/`: shared launch contracts and built-in runtime adapter
  implementations (Docker, plus Kubernetes/K3s scaffolds)
- `packages/source-integrations/`: source-provider integration package for repository selection, ref
  resolution, and provider-specific access flows; GitHub will be the first provider here
- `packages/ai-harness-integrations/`: shared contracts and orchestration for AI coding harnesses
- `packages/registry-integration/`: artifact and registry publishing, tagging, lookup, and retrieval

## Defined app architecture

- `apps/web/`: main product web app for creating and managing workspaces
- `apps/api/`: control-plane API for validation, orchestration, lifecycle, and state
- `apps/worker/`: background worker for consuming queued workspace image build jobs and driving
  compile/publish work
- `apps/docs/`: user and contributor documentation site
- `apps/marketing/`: public website and launch surfaces
- `apps/electron/`: desktop client surface if desktop becomes a first-class client

## Why the monorepo uses Turbo + pnpm

- `pnpm` workspaces keep dependency management fast, strict, and centralized
- `Turborepo` gives us task orchestration, caching, and a clean way to scale builds across apps and
  shared packages
- shared tooling in `tooling/` keeps config consistent without copy-pasting setup across apps

## Tooling baseline

- `direnv` + Nix provide a reproducible shell with `nodejs_24` and `pnpm`
- `oxlint` handles repo-wide linting
- `oxlint-tsgolint` enables type-aware Oxlint rules backed by TypeScript Go
- `oxfmt` handles repo-wide formatting
- `@typescript/native-preview` provides the `tsgo` CLI at the root alongside regular `typescript`

## Workspace composition

The composition contracts now live in `packages/workspace-composition/`, and the concrete BuildKit
OS execution path now lives in `packages/os-integration-buildkit/`.

That package contains:

- `UserWorkspaceSpec` and `WorkspaceBlueprint` documentation
- normalization and defaulting helpers
- executor and artifact contract definitions
- shared composition contracts that feed concrete OS integrations such as
  `packages/os-integration-buildkit/`

Composition documentation lives in `packages/workspace-composition/docs/`.

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

### Playwright on NixOS

Use the Playwright-specific shell when you want browser automation without relying on Playwright's
Ubuntu/Debian browser installer:

```bash
nix develop .#playwright
pnpm install
pnpm playwright:open-google
```

That shell points Playwright at the Nix-provided Chromium binary through
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and disables Playwright's normal browser download flow, which
is the part that fails on NixOS.

The repo now includes root Playwright tooling:

```bash
pnpm test:e2e
pnpm test:e2e:ui
pnpm playwright:open-google
```

Set `PLAYWRIGHT_HEADLESS=0` if you want `pnpm playwright:open-google` to keep a visible browser open
for 30 seconds.

Place end-to-end specs in `tests/e2e/`.

Run common workspace tasks from the repo root:

```bash
pnpm dev
pnpm dev:tui
pnpm build
pnpm build:tui
pnpm format
pnpm format:check
pnpm lint
pnpm lint:fix
pnpm lint:types
pnpm typecheck
pnpm typecheck:tui
pnpm typecheck:tsc
pnpm test
pnpm test:tui
```

`pnpm build`, `pnpm dev`, `pnpm test`, and `pnpm typecheck` are wired through Turbo. Use the `*:tui`
variants to force Turbo's terminal UI.

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

Sealant exists to make two outcomes feel easy, fast, and trustworthy without giving up isolation or
reproducibility:

- launching personal, highly customizable, AI-ready coding sandboxes
- running detailed, tracked, reproducible issue workflows with clear reporting

The goal is a product experience that feels simple on the surface while staying disciplined
underneath.
