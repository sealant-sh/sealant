---
title: Workspace Images and People
description:
  What a managed workspace image carries so that each person in a workspace can be a Linux user of
  their own, which toolchain paths are shared, and what the image probe records.
---

A workspace can be used by more than one person at a time. Mend runs each person's processes as a
Linux user of their own, with their own home, logins and credentials. The managed images (`fedora`,
`arch`, `ubuntu`) carry what that needs. Users themselves are not made in the image: whoever starts
the workspace makes them when it starts.

## What a managed image carries

- **The `mend` group** (gid 40000). Uids and gids 40000–49999 are left free for the people.
- **Passwordless `sudo` for the group**, with `umask 0002` and the toolchain variables below kept,
  so `sudo npm i -g` lands where a person's own `npm i -g` would. This is not isolation: anyone in
  the group, and their agents, can read and change anyone's files.
- **`useradd` and the ACL tools** (`setfacl`, `getfacl`) on every family: Sealant adds `sudo` on
  Arch and Ubuntu, `acl` on Ubuntu and Fedora, and `util-linux` on Fedora.
- **Shared toolchains under `/opt` and caches under `/var/cache`**, owned by root and `mend`, mode
  2775, named in the image environment so every process sees them. The image lists the directories
  it makes in `SEALANT_PERSON_SHARED_DIRS`; `sealantd` gives them the group's default ACL when the
  workspace starts (an ACL set while the image builds does not survive into it).
- **`/etc/skel` links** from each new home into the shared caches, for tools whose cache sits beside
  their credentials (cargo, Gradle, Maven).
- **`safe.directory = *`** in `/etc/gitconfig`, since files in a shared worktree belong to several
  users.
- **A `docker` group** (gid 2375) when the workspace has its own Docker.

## Shared and per-user paths

No shared path holds a credential. Registries, tokens and logins are read from per-user files, which
stay in the user's home (`/home/<name>`, mode 0700).

| Tool                                                                | Shared (image environment)                                                                                                                                                                                                                      | Per user                                                                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| mise                                                                | `MISE_DATA_DIR=/opt/mise`: installs, downloads, shims (on `PATH`)                                                                                                                                                                               | `~/.config/mise`, trust in `~/.local/state/mise`, `~/.cache/mise` (mise makes its lock files readable only by their creator) |
| uv                                                                  | `UV_PYTHON_INSTALL_DIR=/opt/uv/python`, `UV_TOOL_DIR=/opt/uv/tools`, `UV_TOOL_BIN_DIR` and `UV_PYTHON_BIN_DIR=/opt/uv/bin` (on `PATH`), `UV_CACHE_DIR=/var/cache/uv`                                                                            | `~/.local/share/uv/credentials`, `~/.config/uv`                                                                              |
| Rust                                                                | `RUSTUP_HOME=/opt/rust/rustup`; `/opt/rust/cargo/bin` on `PATH`, where `~/.cargo/bin` links, so rustup's proxies and `cargo install` are everyone's; `~/.cargo/registry` and `~/.cargo/git` link to `/var/cache/cargo`                          | `CARGO_HOME=~/.cargo`: `credentials.toml`, `config.toml`                                                                     |
| pnpm, npm, corepack, bun                                            | `PNPM_HOME=/opt/pnpm`, store `/var/cache/pnpm` (`npm_config_store_dir`, `pnpm_config_store_dir`), `npm_config_cache=/var/cache/npm`, `npm_config_prefix=/opt/npm-global` (bin on `PATH`), `COREPACK_HOME=/opt/corepack`, `BUN_INSTALL=/opt/bun` | `~/.npmrc`, `~/.bunfig.toml`                                                                                                 |
| Browsers for tests                                                  | `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`, `PUPPETEER_CACHE_DIR=/opt/puppeteer`, `CYPRESS_CACHE_FOLDER=/opt/cypress`, `npm_config_devdir=/var/cache/node-gyp`                                                                               | none                                                                                                                         |
| Go, pip                                                             | `GOMODCACHE=/var/cache/go/mod`, `GOCACHE=/var/cache/go/build`, `PIP_CACHE_DIR=/var/cache/pip`                                                                                                                                                   | `~/.netrc`, `pip.conf`, `~/go`                                                                                               |
| JVM                                                                 | `~/.gradle/caches`, `~/.gradle/wrapper` and `~/.m2/repository` link to `/var/cache/gradle` and `/var/cache/m2`                                                                                                                                  | `~/.gradle/gradle.properties`, `~/.m2/settings.xml`                                                                          |
| nvm, pyenv                                                          | `NVM_DIR=/opt/nvm`, `PYENV_ROOT=/opt/pyenv`                                                                                                                                                                                                     | none                                                                                                                         |
| gcloud, AWS, kubectl, Docker, gh, Hugging Face, firebase, git, curl | none                                                                                                                                                                                                                                            | their usual paths under `~`                                                                                                  |

A tool not in the table keeps its state in the user's home, so it is per person by default. The
harness CLIs baked into the image stay where they were installed; `npm i -g` after the build lands
in `/opt/npm-global`, ahead of them on `PATH`.

Anything one person installs is usable by everyone. A toolchain unpacked with fixed file modes
(mise, uv's Pythons, rustup, Playwright) can be extended or repaired by another person only with
`sudo`.

## Nix images take one person

`nix` images get none of the above and run every process as root, as before. Their `/etc/passwd`
links into the read-only store, so no user can be added; the store cannot hold a setuid `sudo`; and
nix as a non-root user needs the nix daemon. A workspace on a `nix` image serves one person.

## Custom base images

A custom base image (`target.os.family: custom`) is not changed. Whether it can serve more than one
person depends on what it carries: `sudo` with its setuid bit, `useradd`, `setfacl`, a writable
`/etc/passwd`, and no user or group in 40000–49999 other than `mend`.

## The image probe

Every image, managed, `nix` or custom, runs a probe as its last build step and keeps the answer in
`/etc/sealant/image-probe.json`: which of those tools it has, whether `/etc/passwd` is writable, the
`mend` group, any user or group in the reserved range, the shared directories, and what
`sealantd capabilities --json` reports. A managed image that lacks any of them fails its build. The
Docker builder reads the answer back and records it on the build, so a client can learn before it
creates a workspace whether the image can serve more than one person. The script stays in the image
at `/usr/local/lib/sealant/image-probe`, so a running workspace can be asked the same question.
