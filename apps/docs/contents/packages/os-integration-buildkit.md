---
title: "@sealant/os-integration-buildkit"
slug: /packages/os-integration-buildkit
status: draft
owner: engineering
updated: 2026-03-29
---

# @sealant/os-integration-buildkit

## Purpose

`@sealant/os-integration-buildkit` is Sealant's concrete OS integration for compiling a normalized
`WorkspaceBlueprint` into a runnable container image artifact using Docker BuildKit.

In the sandbox lifecycle, this package is the bridge between composition contracts and an OCI image
tarball that downstream registry/runtime orchestration can consume.

## Scope and boundaries

This package is responsible for:

- support checks for BuildKit-backed distro executors
- mapping blueprint contracts to a concrete `ResolvedImagePlan`
- rendering a BuildKit context (`Containerfile`, `entrypoint.sh`, metadata files)
- executing `docker build` and `docker save`
- returning a typed compile result with artifacts + BuildKit extension metadata

This package is not responsible for:

- queueing workspace build jobs
- artifact publication/tagging in registries
- runtime adapter selection/launch execution
- lifecycle persistence in the database

Those concerns live in other packages/apps (especially `@sealant/worker`,
`@sealant/registry-integration`, and `@sealant/runtime-adapters-api`).

## Why this package exists

- Keeps BuildKit implementation details outside `@sealant/workspace-composition`.
- Provides one concrete executor implementation for current distro targets.
- Produces repeatable artifacts and metadata that match shared compile contracts.
- Centralizes distro-specific package manager and shell/SSHD differences.

## System placement

High-level placement in the sandbox lifecycle:

1. `@sealant/workspace-composition` normalizes user workspace intent into a `WorkspaceBlueprint`.
2. `@sealant/worker` selects a concrete executor for target OS family.
3. `@sealant/os-integration-buildkit` compiles blueprint -> OCI image tarball + metadata.
4. Downstream registry/runtime layers publish/load/run the produced artifact.

See also:

- `apps/docs/contents/architecture/sandbox-lifecycle.md`
- `apps/docs/contents/apps/worker.md`

## Package structure

`packages/os-integration-buildkit/src/buildkit-executor.ts` is intentionally the primary
implementation module and contains:

- process command runner (`defaultCommandRunner`)
- distro catalog (`distroDefinitions`)
- executor support checks (`getBuildkitExecutorSupport`)
- package resolution and image plan mapping
- renderers (`renderContainerfile`, `renderWorkspaceEntrypoint`, dotfiles/runtime helpers)
- build context generation (`writeBuildContext`)
- Docker build/save execution (`buildImageTarball`)
- public executor class + factory and mapping helper exports

`packages/os-integration-buildkit/src/index.ts` only re-exports the package public surface.

## Public API reference

### Exports

- `BuildkitDistroOsExecutor`
- `createBuildkitOsExecutor(osFamily, options)`
- `mapBlueprintToBuildkitImagePlan(blueprint, osFamily)`
- `BuildkitCommandRunner`
- `BuildkitCommandResult`
- `BuildkitCommandOptions`
- `BuildkitOsExecutorOptions`

### Core interfaces (behavior)

- `supports(input)`
  - validates input schema
  - returns normalized support contract (`OsExecutorSupport`)
- `compile(input)`
  - validates input schema
  - runs same support gate
  - maps plan, renders context, executes Docker build/save
  - returns parsed `BuildkitOsExecutorCompileResult`

## Supported OS families

- `fedora`
- `arch`
- `nix`

Each family has a concrete distro definition that drives base image, package strategy, shell paths,
and SSHD path.

## Distro definitions

| OS family | Base image         | Package manager | Bash path                     | SSHD path                     |
| --------- | ------------------ | --------------- | ----------------------------- | ----------------------------- |
| `fedora`  | `fedora:41`        | `dnf`           | `/bin/bash`                   | `/usr/sbin/sshd`              |
| `arch`    | `archlinux:latest` | `pacman`        | `/bin/bash`                   | `/usr/sbin/sshd`              |
| `nix`     | `nixos/nix:latest` | `nix`           | `/root/.nix-profile/bin/bash` | `/root/.nix-profile/bin/sshd` |

In addition to those fields, each distro definition includes:

- `packageMap`: mapping from normalized package ids to concrete install package list
- `internalPackages`: always-installed core packages (certs, shell, ssh, basic tooling)
- `shellPaths`: concrete paths for `bash`, `zsh`, and `fish`

## End-to-end compile pipeline

`compile(input)` executes this deterministic sequence:

1. Parse input with `parseBuildkitOsExecutorCompileInput(...)`.
2. Evaluate support via `supports(...)` / `getBuildkitExecutorSupport(...)`.
3. Map blueprint -> `ResolvedImagePlan` with secrets/package/runtime decisions.
4. Write build context directory under temp (`sealant-buildkit-<os>-*`).
5. Render and write:
   - `Containerfile`
   - `entrypoint.sh`
   - `resolved-image-plan.json`
   - `buildkit-spec.json`
6. Run `docker build` with BuildKit enabled and optional `--secret` mounts.
7. Run `docker save` to export `workspace-image.tar`.
8. Return parsed compile result with typed artifacts and BuildKit extension block.

## Support gate details

Support checks are centralized in `getBuildkitExecutorSupport(...)` and are reused by both
`supports(...)` and `compile(...)`.

The executor rejects in these cases:

- `unsupported-os`
  - requested target OS is neither `auto` nor this executor's specific family
- `unsupported-harness`
  - harness id is not registered in `@sealant/ai-harness-integrations`
- `unsupported-package`
  - package version pinning is requested (`pkg.version` is set)
- `unsupported-runtime-requirement`
  - non-dotfiles input purpose is supplied
  - more than one dotfiles source is supplied

When rejected via `compile(...)`, the method throws with the support message.

## Blueprint-to-plan mapping

`mapBlueprintToBuildkitImagePlan(...)` / `mapBlueprintToResolvedImagePlan(...)` translates a
normalized blueprint into a fully concrete `ResolvedImagePlan` consumed by renderers.

### Field mapping highlights

- `blueprint.target.os.family` -> executor support and selected distro definition
- `blueprint.tooling.packages` -> initial package request list
- harness integration install packages -> merged into package request list
- `blueprint.customization.defaultShell` -> shell package + runtime shell behavior
- `blueprint.customization.applyDotfiles` + dotfiles input -> dotfiles plan section
- `blueprint.runtime.env` -> copied into `runtimeEnv`
- source auth refs -> build/runtime secret plan

### Package resolution algorithm

Package requests are assembled in this exact order:

1. user-declared `tooling.packages`
2. harness-required packages from `harnessIntegration.installPackages`
3. selected non-bash default shell package (`zsh` or `fish`)
4. dotfiles helper packages when dotfiles apply is enabled
   - always add `git`
   - `auto`: add `chezmoi` and `stow`
   - `chezmoi`: add `chezmoi`
   - `stow`: add `stow`

Each request resolves through distro `packageMap` if known, otherwise passes through as-is
(`installPackages: [request.id]`).

Final install command generation deduplicates concrete install package names in first-seen order via
`normalizeInstallPackages(...)`.

### Secret planning rules

- Workspace repo auth:
  - if `blueprint.sources.workspace.authRef` is set, emit runtime secret:
    - id: `workspace_git_key`
    - phase: `runtime`
    - kind: `ssh-key`
- Dotfiles repo auth:
  - if dotfiles `authRef` is absent: no build secret
  - if dotfiles `authRef` has prefix `github-installation-repository:<id>`:
    - dotfiles are deferred to runtime apply
    - no build secret is emitted
    - `githubInstallationRepositoryId` is stored in plan
  - otherwise:
    - dotfiles are applied at build time
    - build secret `dotfiles_git_key` is emitted
    - plan includes `authSecretId: dotfiles_git_key`

## Build context generation

`writeBuildContext(...)` creates a temp directory and writes the complete build context.

Generated file set:

- `Containerfile`
- `entrypoint.sh`
- `resolved-image-plan.json`
- `buildkit-spec.json`
- output location placeholder: `workspace-image.tar`

Derived naming conventions:

- image name: `sealant-workspace-<os-family>-<harness-id>`
- image reference: `<image-name>:<harness-id>`

`buildkit-spec.json` contains:

- `contextDirectory`
- `containerfilePath`
- `imageReference`
- `push: false`
- `secrets` (from build-phase plan secrets)
- `buildArgs` (currently empty object)

## Containerfile rendering

`renderContainerfile(plan)` emits a deterministic Dockerfile with these phases:

1. `# syntax=docker/dockerfile:1.7`
2. `FROM <base image>`
3. distro package install command
4. harness install command
5. default shell setup (`ENV SHELL=...` on nix, `usermod -s ... root` elsewhere)
6. copy/chmod workspace entrypoint
7. optional build-time dotfiles step
8. `WORKDIR /workspace`
9. `ENTRYPOINT ["/usr/local/bin/workspace-entrypoint"]`

### Package manager install command behavior

- `dnf`
  - refresh/upgrade
  - install deduplicated package list
  - clean caches
- `pacman`
  - sync/update
  - install deduplicated package list with `--needed`
  - clear cache (`pacman -Scc --noconfirm || true`)
- `nix`
  - `nix profile add` using `nixpkgs#<pkg>` flake refs
  - `--accept-flake-config` and `nix-command flakes` experimental features
  - validate profile with `profile list`

### Harness install command adaptation for nix

On nix images only, harness install command rewriting applies when the integration command matches:

- `npm install -g <pkg...>`

It becomes:

- `npm install -g --prefix /usr/local <pkg...>`

This avoids nix profile/global path friction for harness global installs.

### Build-time dotfiles step behavior

When `plan.dotfiles.applyAt === "build"`, `renderDotfilesStep(...)` emits one `RUN` layer that:

- clones dotfiles into `/root/.local/share/chezmoi`
- optionally mounts secret key at `/run/sealant/dotfiles_key` when `authSecretId` exists
- detects manager for `auto` mode (`chezmoi` / `stow` / `copy` fallback)
- applies dotfiles with selected manager
- supports optional bootstrap command for stow mode

If `applyAt !== "build"`, this layer is omitted completely.

## Entrypoint rendering and runtime control flow

`renderWorkspaceEntrypoint(plan)` generates the runtime control script used as container entrypoint.

### Startup responsibilities

At runtime, the script performs these stages in order:

1. initialize strict shell mode (`set -euo pipefail`)
2. set key constants (`WORKSPACE_ROOT`, repo URL/ref, working directory)
3. create runtime directories and baseline env (`HOME`, `USER`, `PATH`)
4. fix glibc loader symlink on nix if missing (`/lib64/ld-linux-x86-64.so.2`)
5. configure workspace clone auth from env
6. optionally configure and start SSHD
7. clone workspace repo if `.git` does not exist
8. cleanup clone auth material/env
9. optionally apply runtime dotfiles
10. run lifecycle setup steps
11. run lifecycle startup steps
12. execute foreground command selection

### Workspace clone auth handling

The entrypoint supports two auth modes:

- SSH key mode
  - reads `SEALANT_WORKSPACE_AUTH_KEY_BASE64`
  - writes decoded key to runtime file
  - exports `GIT_SSH_COMMAND`
- HTTP token mode
  - reads `SEALANT_WORKSPACE_HTTP_TOKEN`
  - writes `GIT_ASKPASS` helper script
  - exports `GIT_ASKPASS` and `GIT_TERMINAL_PROMPT=0`

After clone, `cleanup_workspace_clone_auth()` removes helper files and unsets auth-related env vars.

### SSH mode handling

When `SEALANT_ENABLE_SSH` is truthy (`1` or `true`), the script:

- sets SSH port (`SEALANT_SSH_PORT`, default `2222`)
- resolves authorized keys source from file or base64 env
- ensures `/etc/passwd`, `/etc/group`, `/etc/shadow` are writable (copy/repair flow)
- repairs locked root shadow entry (`root:!`) when needed
- ensures `sshd` user/group records exist
- generates host key if missing
- writes forced shell wrapper `/usr/local/bin/workspace-ssh-shell`
- writes runtime `sshd_config` with `ForceCommand /usr/local/bin/workspace-ssh-shell`
- starts SSHD with distro-specific binary path

### Runtime dotfiles handling

When dotfiles are planned for runtime (`applyAt: runtime`), entrypoint logic:

- expects GitHub installation repository id in plan metadata
- optionally requires `SEALANT_DOTFILES_HTTP_TOKEN` for GitHub installation-backed auth
- writes a separate dotfiles `GIT_ASKPASS` helper when token is present
- clones dotfiles repo to `/root/.local/share/chezmoi`
- resolves manager when `auto` (`chezmoi`, `stow`, `copy`)
- applies dotfiles and clears dotfiles auth env afterwards

### Lifecycle and foreground execution precedence

Foreground execution precedence is fixed:

1. `SEALANT_FOREGROUND_COMMAND` override (executed with bash)
2. blueprint startup foreground command (`foreground.kind === "command"`)
3. harness launch command in configured default shell

Lifecycle `setup` and `startup.steps` are rendered as isolated subshell blocks with explicit
working-directory `cd` and shell choice (`sh` or distro bash path).

## Runtime environment variables consumed by entrypoint

Primary variables read by generated `entrypoint.sh`:

- SSH controls
  - `SEALANT_ENABLE_SSH`
  - `SEALANT_SSH_PORT`
  - `SEALANT_SSH_AUTHORIZED_KEYS_FILE`
  - `SEALANT_SSH_AUTHORIZED_KEYS_BASE64`
- workspace clone auth
  - `SEALANT_WORKSPACE_AUTH_KEY_BASE64`
  - `SEALANT_WORKSPACE_HTTP_TOKEN`
  - `SEALANT_WORKSPACE_HTTP_USERNAME`
- runtime dotfiles auth (runtime-apply only)
  - `SEALANT_DOTFILES_HTTP_TOKEN`
  - `SEALANT_DOTFILES_HTTP_USERNAME`
- process control
  - `SEALANT_FOREGROUND_COMMAND`
  - `SEALANT_OCI_RUNTIME` (special handling for `runsc`)

## Docker execution behavior

`buildImageTarball(...)` runs two Docker CLI commands in order:

1. `docker build ... --tag <image-ref> <context-dir>`
2. `docker save --output <workspace-image.tar> <image-ref>`

Build secrets are forwarded as BuildKit secret flags:

- `--secret id=<id>,src=<sourceRef>`

`defaultCommandRunner` characteristics:

- always sets `DOCKER_BUILDKIT=1`
- captures stdout/stderr buffers
- throws `buildkit-command-failed` error code on non-zero exit or signal
- includes stderr/stdout context in failure message where available

## Compile output contract

`compile(...)` returns a validated `BuildkitOsExecutorCompileResult` containing:

- `executor`
  - `id`
  - `osFamily`
- `artifacts`
  - `oci-image` tarball artifact (`loader: docker-load`)
  - metadata artifact for resolved image plan JSON
  - metadata artifact for buildkit spec JSON
- `metadata`
  - `defaultArtifactName`
  - notes indicating BuildKit executor family
- `buildkit`
  - full `imagePlan`
  - full `spec`

This contract is the handoff boundary used by registry and runtime orchestration.

## Failure modes and troubleshooting guide

### Support validation failures

- Symptom: compile throws before Docker invocation.
- Check:
  - `target.os.family` mismatch with executor family
  - unknown harness id
  - version-pinned package requests
  - unsupported or multiple input sources

### Docker invocation failures

- Symptom: error code `buildkit-command-failed`.
- Check:
  - Docker daemon availability
  - secret source file existence/readability
  - package manager command failures during build
  - insufficient disk space for image layers/tarball

### Runtime clone/auth failures

- Symptom: container starts but repo clone fails.
- Check:
  - workspace SSH key base64 validity (if SSH auth path)
  - HTTP token + username env wiring (if HTTP auth path)
  - branch/ref existence for workspace source

### SSH bootstrap failures

- Symptom: SSH enabled but no remote access.
- Check:
  - authorized keys file/path or base64 env content
  - `SEALANT_ENABLE_SSH` truthy value
  - selected SSH port exposure in runtime layer

## Security model notes

- Build secrets use BuildKit `--secret` instead of baking credentials into image layers.
- Workspace clone auth material is removed and env-unset after clone step.
- Dotfiles runtime token helper is deleted after dotfiles apply.
- SSH runs key-only auth (`PasswordAuthentication no`) with forced shell wrapper.

Current security caveats:

- `StrictHostKeyChecking=no` is used for git SSH clone paths.
- Entrypoint script currently contains a large surface area of shell logic.

## Testing coverage map

`src/buildkit-executor.test.ts` exercises:

- blueprint -> image plan mapping
- runtime-deferred dotfiles for GitHub installation auth refs
- dotfiles manager package inclusion behavior
- Node/npm package mapping behavior across distros
- Docker command invocation sequence (`build` then `save`)
- generated `Containerfile` and `entrypoint.sh` content assertions
- harness foreground launch behavior
- nix-specific rendering and runtime adjustments
- passthrough behavior for unmapped package ids

## Extension playbook

### Adding a new distro family

1. Add a new entry in `distroDefinitions`.
2. Define base image, package manager, package map, internal packages, shell/SSHD paths.
3. Ensure `BuildkitTargetOsFamily` contract includes the new family.
4. Add renderer/test coverage for package install command and shell behavior.

### Expanding package mappings

1. Add package id mapping to distro `packageMap`.
2. Verify fallback behavior still works for unknown packages.
3. Add tests for cross-distro parity when needed.

### Evolving auth or dotfiles behavior

1. Keep auth phase split explicit (`build` vs `runtime`).
2. Preserve secret handling invariants (no secret in image layer metadata).
3. Add compile + entrypoint rendering tests for new auth modes.

## Current constraints and non-goals

- only one dotfiles input source is supported
- non-dotfiles input purposes are rejected
- package version pinning is not yet supported
- unknown package ids mostly pass through best-effort per distro
- build spec generation is currently local-export oriented (`push: false`)

## Cross-package dependencies

- `@sealant/ai-harness-integrations`
  - harness install and launch command contracts
- `@sealant/workspace-composition`
  - schemas, parser/validator helpers, compile contract types

## Runtime dependencies

- Docker CLI + daemon
- Node.js `child_process` + filesystem APIs

## Scripts

- `pnpm --filter @sealant/os-integration-buildkit lint`
- `pnpm --filter @sealant/os-integration-buildkit test`
- `pnpm --filter @sealant/os-integration-buildkit typecheck`

## Related docs

- `apps/docs/contents/packages/workspace-composition.md`
- `apps/docs/contents/packages/workspace-composition/executor-and-buildkit-contracts.md`
- `apps/docs/contents/apps/worker.md`
- `apps/docs/contents/architecture/sandbox-lifecycle.md`
