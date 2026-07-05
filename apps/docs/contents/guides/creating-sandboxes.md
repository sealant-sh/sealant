---
title: Creating sandboxes
description:
  A field-by-field walk through the sandbox builder — source, dotfiles, harness, runtime, image
  target, packages, commands, and SSH — plus how to manage sandboxes afterward.
---

A sandbox is a live, disposable development environment built around a real repository. You create
one from the builder at `/sandboxes/new`. The form is a single spec: as you fill it in, a live JSON
preview and health checks update on the right, and submitting it kicks off a real build that
redirects you to the sandbox detail page.

This page walks the builder section by section, in the order the form presents them.

## Sandbox Source

Where the code comes from. Pick a **Source Mode**:

- **Raw Git URL** — paste any public or generic repository URL (for example
  `https://github.com/owner/repo.git`), then set **Branch / Commit** to the ref you want.
- **GitHub App repository** — select a granted GitHub App installation and choose a synced private
  repository. If you have no installation yet, import one first at `/github/setup`; see
  [GitHub App](/docs/guides/github-app). Once synced, you get an installation picker, a repository
  search, a repository picker, and an optional branch/ref (defaults to the repository's default
  branch).

Private repositories require the GitHub App path — a raw URL to a private repo will not clone. See
[GitHub App](/docs/guides/github-app) for the credentials the API and worker need.

## Config repo (dotfiles, optional)

An optional second repository applied on top of the source to set up your environment — shell
config, editor settings, tool defaults. Set **Config Repo Mode** to `none` to skip it, or choose raw
Git / GitHub App the same way as the source.

When enabled you also set:

- **Config Strategy** — the dotfiles manager: `auto`, `chezmoi`, `stow`, or `copy`.
- **Apply Target** — where files land: `home` or `config`.
- **Bootstrap Command** — an optional command to run once after the dotfiles are placed.

## Execution Environment

The harness, the base OS, and where the built image is published.

- **Harness Type** — the agent that will run inside the sandbox: `OpenCode (Standard)`, `Codex`, or
  `Claude Code`. See [Harnesses](/docs/concepts/harnesses).
- **Target OS** — `Fedora`, `Arch`, or `NixOS`.
- **Default Shell** — the login shell for the sandbox.
- **OCI Runtime** — `runc` (standard) or `runsc` (gVisor, stronger isolation). See
  [Security model](/docs/concepts/security-model).
- **Registry ID** — the registry the built image is pushed to (defaults to the configured registry,
  normally `default`).
- **Image Repository** — the repository path for the published image.
- **Image Tag** — the tag applied to the published image.

## Build Dependencies

Under **Package Inventory** you add and remove OS packages to install into the image. Each package
you add is validated against package resolution for the selected target OS, so you find out at
build-spec time whether a name resolves rather than mid-build.

## Runtime Commands

- **Setup Steps** — an ordered list of commands run while building the sandbox (install extra
  tooling, prepare state). Optional.
- **Entrypoint Command** — an optional command that becomes the sandbox's entrypoint.

## Security & Access

Toggle **Enable SSH tunneling** to make the sandbox reachable over the SSH gateway. If you have no
SSH key registered yet, the builder lets you register a public key inline without leaving the form.
See [SSH access](/docs/guides/ssh-access) for the connection details.

SSH is authorized by sandbox owner, so you do not attach specific keys here — any key you have
registered will resolve to you at connect time.

## The live spec preview

The right rail mirrors the form as you fill it in:

- **Operational summary** — a human-readable digest of the current selections.
- **Raw manifest (JSON)** — the exact `spec` that will be submitted. This is the same shape returned
  later at `/sandboxes/<sandbox-id>/spec`.
- **Health check** — validation warnings that must clear before the spec is buildable.

Submitting sends a real create request and redirects you to the sandbox detail page, where the build
progresses through its attempts.

## Managing sandboxes

- **`/sandboxes`** lists your sandboxes with total / running / failed metrics and rows showing name,
  id, repository, tag, status, and created time. **`/sandboxes/active`** and **`/sandboxes/failed`**
  are the same list filtered by status.
- **`/sandboxes/<sandbox-id>`** is the detail page. From here you can **rename** the sandbox,
  **rerun** it from its existing spec, open it in **VS Code** or **Cursor**, and **copy the SSH
  command** once a runtime endpoint exists. It also shows status, attempts, runtime info, selected
  packages, recent events, and the published image reference and digest.
- **`/sandboxes/<sandbox-id>/spec`** shows the raw `spec.json`.

**What is not here yet:** there is no stop or delete action in the web UI, and the SDK's
stop/restart/expire methods are typed but not implemented. If you need to clean up a sandbox today,
bring its container down through Docker on the host. For working with the run inside a sandbox and
its record, see [Runs and execution records](/docs/guides/runs-and-execution-records).

## Related

- [GitHub App](/docs/guides/github-app) — connect private repositories.
- [SSH access](/docs/guides/ssh-access) — keys and connecting.
- [Sandboxes](/docs/concepts/sandboxes) — the concept and lifecycle.
- [HTTP API](/docs/reference/http-api) — creating sandboxes programmatically.
