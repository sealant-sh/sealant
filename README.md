# Sealant

Sealant is an open-source, self-hosted **runtime for agentic development**. It gives coding
harnesses a real sandbox to work in, then turns every run into a structured, replayable
**execution record** — the change, the checks, the terminal output, the artifacts, the browser
evidence, and the source trail behind the result.

Bring your own harness. Keep your code. Read the evidence yourself.

## The model

Three nouns carry the whole system:

- **Sandbox** — a live, disposable development environment around a real repository (code,
  dependencies, harness, processes, services). Where the work happens.
- **Run** — a single harness execution inside a sandbox. What you keep.
- **Execution record** — the durable, append-only, replayable history of a run: one ordered,
  correlated stream of process lifecycle, byte-exact I/O, file changes, network activity, and
  artifacts. The soul of the product.

The core loop is the same everywhere: **create a sandbox → run a harness → replay the record →
review the change.**

## Platform and products

Sealant is a **platform** — programmable infrastructure exposed through a public SDK — and a small
family of **products** built on top of it, each its own open-source repo branded "by Sealant"
(coding agents, browser QA, CI repros, dependency updates). The platform is the point; the products
are the proof that it is real.

It is **open-source and self-hosted**: run the daemon (`sealantd`) inside your own infrastructure,
connect the harnesses you already trust (OpenCode, custom agents, CI workers, or your own loop), and
build on the same public SDK. Your code never leaves your infrastructure.

## What Sealant is not

- **Not an agent or a model** — bring your own harness.
- **Not just a container runtime** — containers isolate; Sealant adds the work model and the record.
- **Not a hosted service** — self-hosted only.
- **Not a judge** — it reports evidence, never verdicts. You decide what it means.

## Documentation

The docs site lives in [`apps/docs/`](apps/docs) (fumadocs) and covers getting started, the
architecture (sandbox lifecycle, the execution record & telemetry, `sealantd` integration), the
packages, and the product and design notes.

Two canonical reference docs sit at the repo root:

- [`SEALANT-PLAN.md`](SEALANT-PLAN.md) — the core product plan: what is being built, and why.
- [`design-system.html`](design-system.html) — the "Evidence Review" design language shared by the
  web app, the marketing site, and `@sealant/ui`.

## Monorepo layout

```text
.
├── apps/                      # deployable apps and services
│   ├── api/                   # control-plane API (Effect)
│   ├── docs/                  # documentation site (fumadocs)
│   ├── electron/              # desktop client surface
│   ├── marketing/             # public marketing site
│   ├── mobile/                # mobile client surface
│   ├── ssh-gateway/           # SSH access into live sandboxes
│   ├── web/                   # main product web app (the review surface)
│   └── worker/                # background worker
├── packages/                  # shared libraries and domain modules
│   ├── api-contracts/         # wire contracts — the single source of truth
│   ├── auth/                  # shared auth
│   ├── db/                    # Effect + PostgreSQL control-plane state
│   ├── issues/                # issue-workflow domain
│   ├── rabbitmq/              # message transport
│   ├── sandboxes/             # sandbox domain: build, publish, launch, lifecycle
│   ├── source-integrations/   # repo/provider integrations (GitHub first)
│   ├── telemetry/             # execution-record ingestion and persistence
│   ├── ui/                    # @sealant/ui — the design system and components
│   └── validators/            # shared schemas
├── tooling/                   # shared config and developer tooling
├── flake.nix                  # Nix development shell
├── turbo.json                 # task graph and caching
└── README.md
```

- `apps/`: user-facing and deployable surfaces — the web app, marketing site, docs, API, worker,
  and access gateways.
- `packages/`: shared code — the wire contracts, sandbox/issue domains, the telemetry/execution
  record, the design system, and reusable utilities.
- `tooling/`: centralized configs and tooling packages (TypeScript, lint, format, test, Tailwind).

## Architecture at a glance

The runtime is built around explicit contracts and a daemon that does the work.

1. A product surface or the SDK submits a sandbox spec (repository, harness, runtime).
2. The control plane (`apps/api`, Effect) normalizes it and provisions an isolated sandbox.
3. The `sealantd` daemon supervises the sandbox and the harness run inside it, emitting a typed
   telemetry firehose.
4. `packages/telemetry` consumes that firehose and persists it as an append-only, event-sourced
   log — the execution record, keyed on `(runId, sequence)` and replayable as a pure fold.
5. The web app (`apps/web`) renders the run as reviewable evidence; access is available over SSH,
   VS Code, or Cursor via `apps/ssh-gateway`.

Supporting integrations feed both the sandbox and run flows without owning either: source
integrations resolve repositories and refs, harness integrations describe launch behavior, and
registry integrations publish and retrieve artifacts.

## Getting started

Allow direnv to load the flake shell:

```bash
direnv allow
```

If you are not using direnv, enter the same shell manually:

```bash
nix develop
```

Then install dependencies:

```bash
pnpm install
```

Run common tasks from the repo root (wired through Turbo):

```bash
pnpm dev          # run apps in development
pnpm build        # build everything
pnpm lint         # repo-wide lint (oxlint)
pnpm typecheck    # type-aware checks (tsgo)
pnpm test         # run tests
pnpm format       # format (oxfmt)
```

### Playwright on NixOS

Use the Playwright-specific shell to run browser automation against the Nix-provided Chromium,
without Playwright's Ubuntu/Debian browser installer:

```bash
nix develop .#playwright
pnpm install
pnpm test:e2e
```

That shell points Playwright at the Nix Chromium through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and
disables the normal download flow (the part that fails on NixOS). Place end-to-end specs in
`tests/e2e/`.

## Tooling baseline

- `direnv` + Nix provide a reproducible shell with `nodejs_24` and `pnpm`.
- `Turborepo` + `pnpm` give task orchestration, caching, and strict, centralized dependencies.
- `oxlint` (with `oxlint-tsgolint` for type-aware rules) handles linting; `oxfmt` handles formatting.
- `@typescript/native-preview` provides the `tsgo` CLI alongside regular `typescript`.

## Design principles

- Keep the user flow simple even when the underlying system is complex.
- Prefer reproducibility over hidden mutable state.
- Keep runtime adapters narrow and replaceable.
- Separate product concerns from execution concerns.
- Treat isolation as a first-class architectural requirement.
- Build around disposable environments, not hand-maintained pets.
- The tool reports; it does not judge. Show observations, never verdicts.

## Why this repo exists

Sealant exists to make one outcome feel easy, fast, and trustworthy without giving up isolation or
reproducibility: **let a harness do real work in a real environment, and get back a record worth
reviewing.** Simple on the surface, disciplined underneath.
