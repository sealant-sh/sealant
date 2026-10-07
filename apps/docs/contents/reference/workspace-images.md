---
title: Workspace Images and People
description:
  What a managed workspace image carries so that each person in a workspace can be a Linux user of
  their own, the environment a person's processes get, and what the image probe records.
---

A workspace can be used by more than one person at a time. Mend runs each person's processes as a
Linux user of their own, with their own home, logins and credentials. The managed images (`fedora`,
`arch`, `ubuntu`) carry what that needs. Users themselves are not made in the image: whoever starts
the workspace makes them when it starts.

None of it changes the environment of a workspace run by one person as root. The image sets no new
environment variable and no `PATH` entry, and root's tools keep their usual locations. (Beyond the
environment, root sees `safe.directory = *` in `/etc/gitconfig`, and Arch and Ubuntu images now
carry `sudo`.) What points a person's tools at shared locations is a file `sealantd` applies to
every process it runs as a user.

## What a managed image carries

- **The `mend` group** (gid 40000). Uids and gids 40000–49999 are left free for the people.
- **Passwordless `sudo` for the group.** Its defaults are bound to the group, so root's own `sudo`
  is unchanged: `umask 0002`, the person environment kept, and the shared bin directories on
  `secure_path`, so `sudo npm i -g` lands where a person's own `npm i -g` would. This is not
  isolation: anyone in the group, and their agents, can read and change anyone's files.
- **`useradd` and the ACL tools** (`setfacl`, `getfacl`) on every family: Sealant adds `sudo` on
  Arch and Ubuntu, `acl` on Ubuntu and Fedora, and `util-linux` on Fedora.
- **Shared toolchain and cache directories** under `/opt` and `/var/cache`, empty, owned by root and
  `mend`, mode 2775, listed one per line in `/etc/sealant/person-shared-dirs`. `sealantd` gives them
  the group's default ACL when the workspace starts (an ACL set while the image builds does not
  survive into it). No installer's own target directory is made in advance: pyenv's and nvm's
  installers refuse a directory that already exists.
- **`/etc/sealant/person-env`**, the environment of a process run as a person (below).
- **`/etc/skel`**: links from each new home into the shared caches, for tools whose cache sits
  beside their credentials (cargo, Gradle, Maven), and pnpm 10's store setting.
- **`safe.directory = *`** in `/etc/gitconfig`, since files in a shared worktree belong to several
  users.
- **`HOME_MODE 0700`** in `/etc/login.defs`, so `useradd -m` makes a home only its user can enter.
  Ubuntu's default is 0750, and every person's primary group is `mend`.
- **A `docker` group** (gid 2375, or the image's own) when the workspace has its own Docker.

## The person environment

`/etc/sealant/person-env` is the environment of a process run as a person:

- **`sealantd` applies it** to every process it runs as a user: executions, sessions, and a person's
  dotfiles bootstrap. It never applies it to root's processes. It sits over the daemon's own
  environment and the user's `HOME`, `USER`, `LOGNAME` and `SHELL`, and under the variables the
  caller passes. A client such as Mend applies nothing: `sealantd` starts processes a client cannot
  reach, and it knows the base `PATH`.
- **The first line is the version**, `# person-env 1`. A reader that does not know the version
  applies nothing and says so.
- **Then one `KEY=VALUE` per line.** Other lines starting with `#`, and blank lines, are comments.
  Values are literal, with no quoting and no expansion.
- **`PATH_PREPEND` is not a variable:** its value goes in front of the process's `PATH`.

`su -` and `runuser -l` start from a clean environment, so a login shell made that way has none of
it.

## Shared and per-user paths

No shared path holds a credential. Registries, tokens and logins are read from per-user files, which
stay in the user's home (`/home/<name>`, mode 0700).

| Tool                                                                            | Shared (in the person environment)                                                                                                                                                                                                                                     | Per user                                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| mise                                                                            | `MISE_DATA_DIR=/opt/mise`: installs and downloads. Its shims are not put on `PATH`                                                                                                                                                                                     | `~/.config/mise`, trust in `~/.local/state/mise`, `~/.cache/mise`       |
| uv                                                                              | `UV_PYTHON_INSTALL_DIR=/opt/uv/python`, `UV_TOOL_DIR=/opt/uv/tools`, `UV_TOOL_BIN_DIR` and `UV_PYTHON_BIN_DIR=/opt/uv/bin` (on `PATH`), `UV_CACHE_DIR=/var/cache/uv`                                                                                                   | `~/.local/share/uv/credentials`, `~/.config/uv`                         |
| Rust                                                                            | `RUSTUP_HOME=/opt/rust/rustup`; `/opt/rust/cargo/bin` on `PATH`, where `~/.cargo/bin` links, so rustup's proxies and `cargo install` are everyone's; `~/.cargo/registry` and `~/.cargo/git` link to `/var/cache/cargo`                                                 | `CARGO_HOME=~/.cargo`: `credentials.toml`, `config.toml`                |
| pnpm, npm, corepack, bun                                                        | `PNPM_HOME=/opt/pnpm` (it and its `bin`, where pnpm 11 puts global bins, on `PATH`), store `/var/cache/pnpm` (`pnpm_config_store_dir`; pnpm 10 reads it from `~/.config/pnpm/rc`), `npm_config_prefix=/opt/npm-global` (bin on `PATH`), `COREPACK_HOME`, `BUN_INSTALL` | `~/.npmrc`, `~/.npm` (npm's cache and its debug logs), `~/.bunfig.toml` |
| Browsers for tests                                                              | `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`, `PUPPETEER_CACHE_DIR=/opt/puppeteer`, `CYPRESS_CACHE_FOLDER=/opt/cypress`                                                                                                                                               | none                                                                    |
| Go, pip                                                                         | `GOMODCACHE=/var/cache/go/mod`, `GOCACHE=/var/cache/go/build`, `PIP_CACHE_DIR=/var/cache/pip`                                                                                                                                                                          | `~/.netrc`, `pip.conf`, `~/go`                                          |
| JVM                                                                             | `~/.gradle/caches`, `~/.gradle/wrapper` and `~/.m2/repository` link to `/var/cache/gradle` and `/var/cache/m2`                                                                                                                                                         | `~/.gradle/gradle.properties`, `~/.m2/settings.xml`                     |
| nvm, pyenv, gcloud, AWS, kubectl, Docker, gh, Hugging Face, firebase, git, curl | none                                                                                                                                                                                                                                                                   | their usual paths under `~`                                             |

- **npm's cache is per user** because npm's debug logs live under it and print a token passed on the
  command line (`--//registry…:_authToken=…`) verbatim.
- **mise's cache is per user** because mise makes its lock files writable only by their creator, so
  a second person could never take a lock in a shared one. Installs are shared all the same.
- **cargo's package-cache locks are per user**, in `~/.cargo`, while its registry is shared. Two
  people's cargo therefore do not wait for each other: two first extractions of the same crate at
  the same moment can fail one build, and building again fixes it.
- **pnpm trees do not cross layouts.** A `node_modules` records the store it was installed from:
  root's under `/root`, a person's in `/var/cache/pnpm`. A tree installed in one layout and used in
  the other makes `pnpm add` fail with `ERR_PNPM_UNEXPECTED_STORE` on pnpm 10 and 11, and pnpm 10's
  `pnpm install` ask to reinstall. `pnpm install --force`, run once by whoever now uses the tree,
  rebuilds it against their store.
- **nvm refuses to run while an npm prefix is set.** A person who uses nvm runs
  `unset npm_config_prefix` first, as nvm itself says.
- **A tool not in the table** keeps its state in the user's home, so it is per person by default.
- **Fixed file modes:** anything one person installs is usable by everyone, but a toolchain unpacked
  with fixed file modes (uv's Pythons, rustup, Playwright) can be extended or repaired by another
  person only with `sudo`.
- **Private artifacts are visible:** the shared caches hold what people download, so a private
  package fetched by one person is readable by the others, as is anything in a shared Docker.

## Restoring a capture per person

A capture workspace (one whose worktree a session channel saves and restores) is told who owns what
its restore writes with an owner map on its source, `ownerMap: { gid, worktreeUid, people }`. Core
passes it to `sealantd` at boot as `SEALANT_CAPTURE_OWNER_MAP`, JSON in `sealantd`'s own form
(`{"gid":40000,"worktree":40012,"people":{"acct_a":40012}}`):

- **A person's saved directory**, `<harnessHome>/people/<id>/`, is restored owned by their uid and
  the `mend` group. The directory itself is `0710`: the group may pass through to `conversations/`,
  not list or read the rest. Everything under `conversations/` is group-readable and -writable; the
  rest keeps its recorded mode, so a person's own transcripts stay theirs.
- **The worktree and its git directory** are the group's: the root is owned by `worktreeUid` and the
  group, setgid, and every entry gets its owner's bits copied to the group (a `0644` file comes back
  `0664`). Captures made before the per-person layout restore the same way.
- **A directory for an id not in the map** (a member who left) is restored as before, root's.
- **The executor's privilege posture.** A map that names at least one person makes the executor a
  per-person one: `sealantd` does not set no-new-privileges, so every person's passwordless `sudo`
  works, and `runtime.getCapabilities` reports `noNewPrivileges: false`. Without a map, or with one
  that names nobody, it is set, as for every other workspace. The executor is root by design here,
  not a sandbox.

Core checks the map at create: `gid` 40000, every uid in 40001–49999 (the range's first id is the
group's), ids that are one directory name, no id and no uid twice, at most 256 people. It launches
one only on an image whose probe reports `restore.owner_map` from its `sealantd`; on another image,
or one with no probe, the launch fails with `owner-map-unsupported` and nothing starts. Cloudflare
sandboxes refuse it at create. Only the source sets it: a workspace's environment, its secret
environment and a cluster ConfigMap never reach `SEALANT_CAPTURE_OWNER_MAP`.

The map is fixed for the executor's life, since `sealantd` reads it at boot: a standby's claim and a
recovery restore under the map the executor booted with. A workspace without a map boots and
restores exactly as before, and pays nothing for the option.

## Nix images take one person

`nix` images get only the probe step, and run every process as root, as before. Their `/etc/passwd`
links into the read-only store, so no user can be added; the store cannot hold a setuid `sudo`; and
nix as a non-root user needs the nix daemon. A workspace on a `nix` image serves one person.

## Custom base images

A custom base image (`target.os.family: custom`) gets only the probe step. Whether it can serve more
than one person depends on what it carries: `sudo` with its setuid bit, `useradd`, `setfacl`, a
writable `/etc/passwd`, and no user or group in 40000–49999 other than `mend`. A base that builds as
a user who cannot write `/etc` still builds; its image has no probe answer and reads as unknown.

## The image probe

Every image, managed, `nix` or custom, runs a probe as its last build step and keeps the answer in
`/etc/sealant/image-probe.json`. The answer covers:

- which of the tools above the image has, and whether `sudo` carries its setuid bit;
- the sudoers rule, and whether `/etc/sudoers` reads `/etc/sudoers.d`;
- whether `/etc/passwd` is writable;
- the `mend` group, and any user or group in the reserved range;
- the person environment and the shared directories;
- what `sealantd capabilities --json` reports;
- whether the probe ran under `no_new_privs`.

A managed image that lacks any of them fails its build. The Docker builder reads the answer back and
records it on the build; a later build that reuses the image keeps it. A client can therefore learn
before it creates a workspace whether the image can serve more than one person. The script stays in
the image at `/usr/local/lib/sealant/image-probe`, so a running workspace can be asked the same
question.

The image is not the whole answer. Under `no_new_privs`, which Kubernetes pods run with
(`allowPrivilegeEscalation: false`), `sudo` cannot raise a person's privileges; a probe run there
reports it.
