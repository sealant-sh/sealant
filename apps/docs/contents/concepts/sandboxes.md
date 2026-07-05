---
title: Sandboxes
description:
  The sandbox model and lifecycle — spec to build to launch to ready — and where sandboxes actually
  live on your host.
---

A sandbox is a live, disposable development environment built around a real repository: your code,
its dependencies, a [harness](/docs/concepts/harnesses), and the processes it needs to run. It is
where the work happens. When you are done with it, you throw it away and build a fresh one from the
same spec.

Sandboxes are disposable on purpose. You do not maintain them; you describe them and rebuild them.

## The spec

Every sandbox starts from a spec — a declarative description of the environment you want. You build
one in the web app at `/sandboxes/new`, or submit one through the
[HTTP API](/docs/reference/http-api) or the [SDK](/docs/reference/sdk). A spec captures:

- **Source** — a raw Git URL or a repository from a connected [GitHub App](/docs/guides/github-app)
  installation, plus the branch, commit, or ref to check out.
- **Config / dotfiles** — an optional second repository for dotfiles, with a manager, target, and
  optional bootstrap command.
- **Harness** — the agent or tool that will do the work: OpenCode, Codex, or Claude Code. See
  [Harnesses](/docs/concepts/harnesses).
- **Runtime** — the target OS family (Fedora, Arch, or NixOS), the default shell, and the OCI
  runtime (`runc` or the gVisor-based `runsc`).
- **Packages** — extra packages to install, resolved and validated as you add them.
- **Commands** — setup steps that run during the build, and an optional entrypoint.
- **Image target** — the registry, image repository, and tag the baked image is published under.
- **SSH** — whether to expose the sandbox over the [SSH gateway](/docs/guides/ssh-access).

The builder shows the live JSON spec as you edit it, so what you submit is exactly what you see.

## The lifecycle

A sandbox moves through four phases. Once you submit a spec, the rest is automatic.

1. **Spec** — your normalized spec is persisted and a build job is enqueued.
2. **Build** — a background worker claims the job, compiles the spec into an OCI image with BuildKit
   (installing packages, baking in the harness, running your setup commands), and **publishes that
   image to the registry**. This is the reproducible artifact: the same spec bakes the same image.
3. **Launch** — a runtime adapter (Docker by default) pulls the published image and starts a
   container from it.
4. **Ready** — the container is up and the sandbox is reachable — over
   [SSH, VS Code, or Cursor](/docs/guides/ssh-access), and for
   [runs](/docs/concepts/execution-records).

A sandbox can also land in a **failed** state if the build or launch does not complete. The
`/sandboxes` list groups your sandboxes by total, running, and failed so you can see the health of
the fleet at a glance.

## Attempts

Building and launching a sandbox is recorded as an **attempt**. Each rerun starts a new attempt
against the same spec, so a single sandbox accumulates a history of build/launch attempts you can
inspect on its detail page. This is how you retry a transient failure without losing the record of
what happened before.

## Disposability and rerun

Because a sandbox is fully described by its spec, you never repair one — you rebuild it. From a
sandbox's detail page you can **rerun** it, which bakes and launches a fresh environment from the
stored spec and metadata. Throw the old one away; the spec is the thing you keep.

> Today the web app has no stop or delete button. You bring a sandbox's container down through
> Docker on the host (see [Ports & data](/docs/reference/ports-and-data)). The SDK exposes `stop` /
> `restart` / `expire` in its typed surface, but those are not wired end to end yet.

## Where sandboxes actually live

Sandboxes are **containers on your host's Docker daemon**. The Sealant worker drives the host Docker
socket directly to build and launch them — so a running sandbox is an ordinary container you can see
with `docker ps`, and its image lives in the bundled registry (Zot, on `127.0.0.1:5000`).

This has two practical consequences:

- Sandbox containers and images are created **outside** the Sealant Compose project. Uninstalling
  Sealant does not automatically remove sandbox containers or images the worker created — clean
  those up through Docker directly.
- Because the worker holds the host Docker socket, it is effectively root on the host. Read the
  [security model](/docs/concepts/security-model) before exposing Sealant beyond loopback.

## Current constraints

- BuildKit compilation supports **dotfiles** as the only additional input source beyond the main
  repository.
- Package **version pinning** is not yet supported by the build.
- The Docker runtime adapter is the default; Kubernetes/k3s adapters are not on this path yet.

## Related

- [Creating sandboxes](/docs/guides/creating-sandboxes) — the step-by-step guide.
- [Runs & execution records](/docs/concepts/execution-records) — what a sandbox produces when a
  harness runs inside it.
- [SSH access](/docs/guides/ssh-access) — connecting to a ready sandbox.
- [Ports & data](/docs/reference/ports-and-data) — where sandbox state lives on the host.
