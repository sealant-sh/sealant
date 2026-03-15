# Zweit

Zweit is a product for spinning up isolated, ready-to-code microVM environments from a polished web UI.

The idea is simple: a user picks a Git repository, an AI coding harness, and optional personalization inputs like a dotfiles repo or Nix flake repo. Zweit turns those choices into a composed Nix flake, applies it to an isolated runtime, and gives the user a coding environment that feels personal, reproducible, and disposable.

## Status

This repository is at the very beginning. The README is the first pass at the product and engineering blueprint.

## What Zweit aims to do

- Let a user launch a coding microVM with minimal setup.
- Start from a clean Nix-based environment.
- Compose user-selected inputs into a final flake for that environment.
- Support multiple AI harnesses such as Claude Code, Codex, OpenCode, T3, and other future options.
- Allow optional inputs like:
  - a dotfiles repository
  - a Nix flakes repository
  - editor and tool preferences
  - bootstrap scripts or templates
- Keep environments isolated, reproducible, and easy to destroy.

## User flow

The intended website flow for the MVP is:

1. User selects a Git repository.
2. User selects an AI harness.
3. User optionally provides dotfiles, Nix flakes, and other customization sources.
4. Zweit generates or assembles a final flake from those inputs.
5. The backend provisions an isolated runtime.
6. The runtime boots with the composed environment applied.
7. The user lands in a ready-to-code session.

## Product shape

Zweit has three major parts.

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

The initial runtime direction is a containerd-backed flow that launches a Kata-based isolated environment built from a Nix base image and then layered with user-selected flakes.

### 3. Infra block

The infra block contains the deployment and execution side of the system:

- Kubernetes manifests and related platform configuration
- runtime and scheduling integration
- networking, storage, and secrets wiring
- adapter implementations for different deployment targets

The architecture should be adapter-oriented so Zweit can target different execution backends over time instead of baking every assumption into one platform.

## Architecture direction

The current intended default path is:

- primary execution model: `Kata on Kubernetes`
- control mechanism: `containerd`-style runtime orchestration
- base environment: `Nix` image or flake-defined base
- user customization: composed flakes built from selected inputs

Over time, the adapter model should support targets such as:

- Kubernetes + Kata
- plain Docker + Kata where appropriate
- AWS-backed adapters such as EC2 or Fargate-facing integrations
- Railway or other managed platform adapters

## Isolation and security

Strong isolation is a core product goal.

Zweit is meant to give users a safer default than dropping arbitrary code into a long-lived shared environment. The current direction is to use Kata-style isolation and disposable environments so untrusted repositories and AI-assisted coding sessions can run with tighter boundaries.

That said, this repository is still in the design phase. Security claims should eventually be backed by explicit threat models, hardening work, and documented guarantees.

## How flake composition should work

At a high level, Zweit should assemble a final environment from several possible inputs:

- base Zweit runtime flake
- selected AI harness package and configuration
- target code repository
- user dotfiles repository
- user Nix flakes repository
- optional templates or org presets

This composition layer is one of the core product differentiators. It should produce environments that are:

- reproducible
- inspectable
- portable across supported adapters
- easy to regenerate from the same inputs

## Proposed repository shape

As the codebase grows, a structure like this likely makes sense:

```text
.
├── README.md
├── infra/        # k8s, deployment, adapters, platform config
├── backend/      # API, control plane, flake composition, lifecycle
├── web/          # website / product UI
├── runtime/      # base images, nix modules, bootstrap logic
├── docs/         # architecture notes, ADRs, threat model, flows
└── examples/     # sample configs, sample flakes, launch definitions
```

## Contributor notes

This section is here so the README works both as a product README and an engineering README.

### Design principles

- Keep the user flow simple even if the underlying system is complex.
- Prefer reproducibility over hidden mutable state.
- Keep runtime adapters narrow and replaceable.
- Separate product concerns from execution concerns.
- Treat isolation as a first-class architectural requirement.
- Build around disposable environments, not hand-maintained pets.

### Early engineering priorities

- define the flake composition model
- define the runtime adapter interface
- stand up the first `Kata on Kubernetes` path
- define the backend environment lifecycle state machine
- build the first website flow for repo + harness + flake inputs
- document the security model and trust boundaries

### Likely core abstractions

- `EnvironmentRequest`: what the user asked for
- `EnvironmentSpec`: normalized launch definition
- `FlakeBuilder`: turns inputs into a final flake
- `RuntimeAdapter`: launches and manages environments on a target
- `Session`: the running coding environment and its lifecycle metadata

## MVP scope

The first meaningful version should likely support:

- one polished web flow
- one primary runtime adapter
- one Nix-based environment composition path
- a small set of AI harness choices
- basic environment lifecycle operations: create, view, stop, destroy

If that works well, Zweit can expand into richer adapters, org templates, saved profiles, and more advanced workspace features.

## Roadmap ideas

- reusable environment templates
- org-level defaults and policies
- persistent volumes and optional resume behavior
- audit trails and security controls
- richer editor integrations
- cost-aware placement across adapters

## Non-goals for the first phase

- supporting every cloud target on day one
- building a giant general-purpose PaaS
- overcomplicating the website before the launch flow works well

## Why this repo exists

Zweit is trying to make spinning up a personal, AI-ready coding microVM feel easy, fast, and clean without giving up reproducibility or isolation.

The goal is a product experience that feels simple on the surface while staying disciplined underneath.
