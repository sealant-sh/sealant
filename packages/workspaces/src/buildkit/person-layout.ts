/**
 * The person layout of the managed workspace images (Mend's ADR 0016, delivery 9): what an image
 * needs so that every person who runs something in a workspace can be a Linux user of their own,
 * and the probe that records, inside every built image, whether it can.
 *
 * **The image changes no environment of today's processes.** It sets no `ENV`: root and every
 * process of the shared layout see exactly the environment and `PATH` they saw before (beyond the
 * environment, root sees `safe.directory = *`, and Arch and Ubuntu gain a `sudo` binary). What
 * points a person's tools at the shared locations is a file, {@link PERSON_ENV_PATH}, that sealantd
 * applies to every process it runs as a user, and never to root's. An earlier draft set those
 * variables image-wide; it broke nvm (`npm_config_prefix`), the pyenv installer (an existing
 * `PYENV_ROOT`) and every `node_modules` installed against root's pnpm store (2026-10-06 review).
 *
 * What the managed families (Fedora, Arch, Ubuntu) get:
 *
 * - **The `mend` group** (gid 40000) and **passwordless `sudo`** for it. Its defaults (`umask
 *   0002`, the person environment kept, the shared bin directories on `secure_path`) are bound to
 *   the group, so root's own `sudo` is unchanged. This is deliberately not isolation: anyone in the
 *   group can read and change anyone's files.
 * - **`useradd` and the ACL tools** on every base: Ubuntu and Arch lack `sudo`, Ubuntu and Fedora
 *   lack `acl`, Fedora lacks `setpriv` (`util-linux`). Users themselves are made at executor
 *   prepare, by Mend, never at build.
 * - **Shared toolchain and cache directories** under `/opt` and `/var/cache`, owned by root and
 *   `mend`, mode 2775, empty, listed one per line in {@link PERSON_SHARED_DIRS_PATH}. Default ACLs
 *   set at build do not survive into the image, so sealantd sets them at boot, as root, on every
 *   directory that file lists. No installer's own target is made (pyenv and nvm refuse to install
 *   into a directory that exists), and no tool's existing location moves.
 * - **`/etc/skel`**: links from each new home into the shared caches, for the tools whose cache
 *   lives beside their credentials (cargo, Gradle, Maven), and pnpm 10's store setting. Root's home
 *   is not touched. {@link PERSON_TOOLCHAINS} lists what is shared and what stays per user.
 * - **`safe.directory = *`** in `/etc/gitconfig`: files in a shared worktree belong to several uids,
 *   and git before 2.46 has no prefix wildcard for nested and linked repositories.
 * - **`HOME_MODE 0700`** in `/etc/login.defs`, so `useradd -m` makes a home only its user can enter
 *   (Ubuntu's default is 0750, and every person's primary group is `mend`).
 *
 * Nix images get none of it and take one person: their passwd is in the read-only store, the store
 * cannot hold a setuid `sudo`, and non-root nix needs the daemon. Custom base images get only the
 * probe step: whatever the base carries decides.
 */
import type { WorkspaceImageProbe } from "@sealant/validators";

/** The group every person's user belongs to. */
export const MEND_GROUP = "mend";
export const MEND_GID = 40000;
/** Mend allocates person uids from this range; the image must leave it free (but for `mend`). */
export const RESERVED_ID_RANGE = { first: 40000, last: 49999 } as const;
/**
 * The group the Docker CLI's people join where the image carries it. Outside the reserved range, and
 * fixed, so a runtime that serves a Docker socket can hand it to this gid.
 */
export const DOCKER_GID = 2375;

/** Where the image writes the probe's answer, and where the probe script stays for prepare. */
export const IMAGE_PROBE_PATH = "/etc/sealant/image-probe.json";
export const IMAGE_PROBE_SCRIPT_PATH = "/usr/local/lib/sealant/image-probe";

/**
 * The environment of a process run as a person, version {@link PERSON_ENV_VERSION}. The contract:
 *
 * - **Who applies it:** sealantd, to every process it runs as a user (executions, sessions, a
 *   person's dotfiles bootstrap), and never to root's. It sits over the daemon's environment and
 *   the passwd entry's `HOME`/`USER`/`LOGNAME`/`SHELL`, and under the variables the caller passes.
 *   Clients (Mend) apply nothing: sealantd starts processes a client cannot reach (the dotfiles
 *   bootstrap) and has the base `PATH` at hand.
 * - **Format:** the first line is `# person-env <version>`. A reader that does not know the
 *   version applies nothing and says so. Then one `KEY=VALUE` per line; other `#` lines and blank
 *   lines are comments; values are literal (no quoting, no expansion).
 * - **`PATH_PREPEND`** is not a variable: its value goes in front of the process's `PATH`.
 */
export const PERSON_ENV_PATH = "/etc/sealant/person-env";
export const PERSON_ENV_VERSION = 1;
/** The shared directories, one per line, for sealantd's default ACL at boot. */
export const PERSON_SHARED_DIRS_PATH = "/etc/sealant/person-shared-dirs";

/**
 * Every shared toolchain, and where each keeps what is per person. Nothing on the shared side holds
 * a credential: registries, tokens and logins are read from the per-user files in the last column,
 * which stay in the user's own home (`/home/<name>`, 0700).
 */
export const PERSON_TOOLCHAINS: ReadonlyArray<{
  readonly tool: string;
  readonly shared: readonly string[];
  readonly perUser: readonly string[];
}> = [
  {
    tool: "mise",
    shared: ["/opt/mise (MISE_DATA_DIR: installs and downloads; shims stay off PATH)"],
    // mise creates its lock files 0644 whatever the umask, so a second person could never take a
    // lock in a shared cache (measured 2026-10-06); the cache holds no install, only metadata.
    perUser: ["~/.config/mise", "~/.local/state/mise (trust)", "~/.cache/mise (lock files)"],
  },
  {
    tool: "uv",
    shared: [
      "/opt/uv/python (UV_PYTHON_INSTALL_DIR)",
      "/opt/uv/tools (UV_TOOL_DIR)",
      "/opt/uv/bin (UV_TOOL_BIN_DIR, UV_PYTHON_BIN_DIR; on PATH)",
      "/var/cache/uv (UV_CACHE_DIR)",
    ],
    perUser: ["~/.local/share/uv/credentials", "~/.config/uv/uv.toml"],
  },
  {
    tool: "Rust",
    shared: [
      "/opt/rust/rustup (RUSTUP_HOME)",
      "/opt/rust/cargo/bin (on PATH; ~/.cargo/bin links here, so rustup's proxies and `cargo install` are everyone's)",
      "/var/cache/cargo/registry and /var/cache/cargo/git (~/.cargo/registry and ~/.cargo/git link here)",
    ],
    // Cargo's package-cache locks live in CARGO_HOME, so two people's cargo do not wait for each
    // other on the shared registry: two first extractions of one crate at the same moment can fail
    // one build, which a rebuild fixes. Sharing the locks would need cargo's own lock and its
    // last-use database (SQLite) group-writable across users, which is unproven.
    perUser: ["~/.cargo (CARGO_HOME): credentials.toml, config.toml, the package-cache locks"],
  },
  {
    tool: "pnpm, npm, corepack, bun",
    shared: [
      "/opt/pnpm (PNPM_HOME, on PATH)",
      "/var/cache/pnpm (pnpm_config_store_dir; pnpm 10 through ~/.config/pnpm/rc from /etc/skel)",
      "/opt/npm-global (npm_config_prefix, bin on PATH)",
      "/opt/corepack (COREPACK_HOME)",
      "/opt/bun (BUN_INSTALL, bin on PATH)",
    ],
    // npm's cache stays per user: its debug logs live under it and print a token passed on the
    // command line verbatim.
    perUser: ["~/.npmrc", "~/.npm (cache and debug logs)", "~/.bunfig.toml"],
  },
  {
    tool: "browsers for tests",
    shared: [
      "/opt/ms-playwright (PLAYWRIGHT_BROWSERS_PATH)",
      "/opt/puppeteer (PUPPETEER_CACHE_DIR)",
      "/opt/cypress (CYPRESS_CACHE_FOLDER)",
    ],
    perUser: [],
  },
  {
    tool: "Go, pip",
    shared: [
      "/var/cache/go/mod (GOMODCACHE)",
      "/var/cache/go/build (GOCACHE)",
      "/var/cache/pip (PIP_CACHE_DIR)",
    ],
    perUser: ["~/.netrc", "~/.config/pip/pip.conf", "~/go (GOPATH)"],
  },
  {
    tool: "JVM",
    shared: [
      "/var/cache/gradle/caches and /var/cache/gradle/wrapper (~/.gradle/caches and ~/.gradle/wrapper link here)",
      "/var/cache/m2/repository (~/.m2/repository links here)",
    ],
    perUser: ["~/.gradle/gradle.properties", "~/.m2/settings.xml"],
  },
  {
    tool: "nvm, pyenv, gcloud, AWS, kubectl, Docker, gh, Hugging Face, firebase, git, curl",
    shared: [],
    perUser: ["their usual paths under ~"],
  },
];

/** The shared toolchain and cache directories. Created 2775 root:mend, empty. */
export const PERSON_SHARED_DIRS: readonly string[] = [
  "/opt/mise",
  "/opt/uv",
  "/opt/rust",
  "/opt/pnpm",
  "/opt/npm-global",
  "/opt/corepack",
  "/opt/bun",
  "/opt/ms-playwright",
  "/opt/puppeteer",
  "/opt/cypress",
  "/var/cache/uv",
  "/var/cache/cargo",
  "/var/cache/pnpm",
  "/var/cache/go",
  "/var/cache/pip",
  "/var/cache/gradle",
  "/var/cache/m2",
];

/**
 * Directories inside the shared ones that must exist before anyone runs a tool: the targets of the
 * `/etc/skel` links (a link to nothing makes `mkdir -p ~/.cargo/registry` fail) and the `bin`
 * directories on a person's `PATH`. Also 2775 root:mend.
 */
export const PERSON_SHARED_SUBDIRS: readonly string[] = [
  "/opt/uv/bin",
  "/opt/rust/rustup",
  "/opt/rust/cargo/bin",
  "/opt/pnpm/bin",
  "/opt/npm-global/bin",
  "/opt/npm-global/lib",
  "/opt/bun/bin",
  "/var/cache/cargo/registry",
  "/var/cache/cargo/git",
  "/var/cache/gradle/caches",
  "/var/cache/gradle/wrapper",
  "/var/cache/m2/repository",
];

/** `/etc/skel` links: each person's home links these paths to the shared ones. */
export const PERSON_SKEL_LINKS: ReadonlyArray<readonly [link: string, target: string]> = [
  [".cargo/bin", "/opt/rust/cargo/bin"],
  [".cargo/registry", "/var/cache/cargo/registry"],
  [".cargo/git", "/var/cache/cargo/git"],
  [".gradle/caches", "/var/cache/gradle/caches"],
  [".gradle/wrapper", "/var/cache/gradle/wrapper"],
  [".m2/repository", "/var/cache/m2/repository"],
];

/**
 * `/etc/skel` files. pnpm 10 (Fedora 41's) reads its store from its global rc and not from
 * `pnpm_config_*`; `npm_config_store_dir` would reach it, but npm 11 and later warn on every call
 * about a setting they do not know, and say the warning will become an error.
 */
export const PERSON_SKEL_FILES: ReadonlyArray<readonly [path: string, lines: readonly string[]]> = [
  [".config/pnpm/rc", ["store-dir=/var/cache/pnpm"]],
];

/** Shared bin directories, ahead of a person's `PATH`, so a person's install wins. */
export const PERSON_PATH_PREPEND: readonly string[] = [
  "/opt/npm-global/bin",
  // pnpm 11 and later put global bins in $PNPM_HOME/bin and refuse `add -g` without it on PATH;
  // pnpm 10 puts them in $PNPM_HOME.
  "/opt/pnpm/bin",
  "/opt/pnpm",
  "/opt/uv/bin",
  "/opt/rust/cargo/bin",
  "/opt/bun/bin",
];

/** The toolchain variables of a person's processes. `sudo` keeps every one of them. */
export const PERSON_ENV: ReadonlyArray<readonly [string, string]> = [
  ["MISE_DATA_DIR", "/opt/mise"],
  ["UV_PYTHON_INSTALL_DIR", "/opt/uv/python"],
  ["UV_PYTHON_BIN_DIR", "/opt/uv/bin"],
  ["UV_TOOL_DIR", "/opt/uv/tools"],
  ["UV_TOOL_BIN_DIR", "/opt/uv/bin"],
  ["UV_CACHE_DIR", "/var/cache/uv"],
  ["RUSTUP_HOME", "/opt/rust/rustup"],
  ["PNPM_HOME", "/opt/pnpm"],
  ["pnpm_config_store_dir", "/var/cache/pnpm"],
  // nvm refuses to run while an npm prefix is set: a person who uses nvm unsets it (nvm says so).
  ["npm_config_prefix", "/opt/npm-global"],
  ["COREPACK_HOME", "/opt/corepack"],
  ["BUN_INSTALL", "/opt/bun"],
  ["PLAYWRIGHT_BROWSERS_PATH", "/opt/ms-playwright"],
  ["PUPPETEER_CACHE_DIR", "/opt/puppeteer"],
  ["CYPRESS_CACHE_FOLDER", "/opt/cypress"],
  ["GOMODCACHE", "/var/cache/go/mod"],
  ["GOCACHE", "/var/cache/go/build"],
  ["PIP_CACHE_DIR", "/var/cache/pip"],
];

/** {@link PERSON_ENV_PATH}'s lines. */
export const PERSON_ENV_FILE: readonly string[] = [
  `# person-env ${String(PERSON_ENV_VERSION)}`,
  "# The environment sealantd gives every process it runs as a user (Mend ADR 0016). Never root's.",
  "# KEY=VALUE per line, values literal. PATH_PREPEND goes in front of the process's PATH.",
  ...PERSON_ENV.map(([key, value]) => `${key}=${value}`),
  `PATH_PREPEND=${PERSON_PATH_PREPEND.join(":")}`,
];

const SUDO_SECURE_PATH = [
  ...PERSON_PATH_PREPEND,
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");

/** `/etc/sudoers.d/mend`. Every default is bound to the group, so root's own `sudo` is as before. */
export const PERSON_SUDOERS: readonly string[] = [
  "# Mend's person layout (ADR 0016): everyone in mend has passwordless sudo. Not isolation.",
  `%${MEND_GROUP} ALL=(ALL:ALL) NOPASSWD: ALL`,
  `Defaults:%${MEND_GROUP} umask=0002, umask_override`,
  `Defaults:%${MEND_GROUP} env_keep += "${PERSON_ENV.map(([name]) => name).join(" ")}"`,
  `Defaults:%${MEND_GROUP} secure_path="${SUDO_SECURE_PATH}"`,
];

/** Repository packages each managed family adds for the person layout. */
export const PERSON_LAYOUT_PACKAGES = {
  fedora: ["sudo", "acl", "util-linux"],
  arch: ["sudo", "acl"],
  ubuntu: ["sudo", "acl"],
} as const;

export type PersonLayoutFamily = keyof typeof PERSON_LAYOUT_PACKAGES;

export const isPersonLayoutFamily = (family: string): family is PersonLayoutFamily =>
  Object.hasOwn(PERSON_LAYOUT_PACKAGES, family);

const shellQuote = (value: string): string => `'${value.split("'").join(`'"'"'`)}'`;

/** `printf` of lines into a file, as one Dockerfile-safe shell command. */
const writeLines = (path: string, lines: readonly string[]): string =>
  `printf '%s\\n' ${lines.map(shellQuote).join(" ")} > ${shellQuote(path)}`;

/**
 * Arch Linux Archive's flat pool of every package file Arch has published, signed as the mirrors'.
 * The layout layer installs against the sync database its package layer fetched, and Arch mirrors
 * keep only current packages: once that layer is older than sudo's or acl's last release, a mirror
 * answers 404. Listed after the mirrors, the archive serves exactly the version that database
 * names, so the install neither fails nor needs `-Sy`, which would be a partial upgrade.
 */
export const ARCH_ARCHIVE_POOL = "https://archive.archlinux.org/packages/.all";

/**
 * Each family's package install in the layout layer, with its package layer's cache mounts. The
 * layout layer comes after the harness installs, so a change to these packages rebuilds only it:
 * in the package layer, adding `sudo acl` (#327) ran `pacman -Syu` and `dnf upgrade` again, which
 * upgraded the whole OS under every layer above it and reinstalled every harness. Now a change
 * here rebuilds in seconds. Fedora pays for it in size: any RPM install rewrites `rpmdb.sqlite`
 * whole, so its layout layer weighs 13.8 MB, while its package layer is only 0.2 MB smaller for
 * leaving them out (measured 2026-10-06). Arch's layout layer weighs 2.5 MB.
 */
const LAYOUT_INSTALL: Readonly<
  Record<PersonLayoutFamily, { readonly mounts: string; readonly commands: readonly string[] }>
> = {
  fedora: {
    mounts: "--mount=type=cache,target=/var/cache/dnf",
    // --refresh: the cache mount's metadata may name packages a mirror has since dropped.
    commands: [
      `dnf -y install --refresh ${PERSON_LAYOUT_PACKAGES.fedora.join(" ")}`,
      "dnf clean all",
    ],
  },
  arch: {
    mounts: "--mount=type=cache,target=/var/cache/pacman/pkg",
    commands: [
      "cp /etc/pacman.d/mirrorlist /tmp/mirrorlist",
      `echo 'Server = ${ARCH_ARCHIVE_POOL}' >> /etc/pacman.d/mirrorlist`,
      `pacman -S --noconfirm --needed ${PERSON_LAYOUT_PACKAGES.arch.join(" ")}`,
      "mv /tmp/mirrorlist /etc/pacman.d/mirrorlist",
    ],
  },
  ubuntu: {
    mounts:
      "--mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked",
    commands: [
      "apt-get update",
      `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${PERSON_LAYOUT_PACKAGES.ubuntu.join(" ")}`,
    ],
  },
};

/**
 * The person layout's Dockerfile step for a managed family: one `RUN`, after the harness
 * installs, for the group, `sudo`, the shared directories, `/etc/skel` and the person environment
 * file, and the packages they need. No `ENV`: the image's environment is what it was.
 */
export const renderPersonLayoutSteps = (input: {
  readonly family: PersonLayoutFamily;
  readonly dockerService: boolean;
}): string => {
  const install = LAYOUT_INSTALL[input.family];
  const dirs = [...PERSON_SHARED_DIRS, ...PERSON_SHARED_SUBDIRS];
  const skelDirs = [
    ...new Set([
      ...PERSON_SKEL_LINKS.map(([link]) => link.slice(0, link.lastIndexOf("/"))),
      ...PERSON_SKEL_FILES.map(([path]) => path.slice(0, path.lastIndexOf("/"))),
    ]),
  ];
  const commands = [
    // `set -e` does not stop at a failed command inside `a && b`, so every step stands alone.
    "set -eu",
    ...install.commands,
    `groupadd -g ${String(MEND_GID)} ${MEND_GROUP}`,
    // An image that already has a docker group keeps it; gid 2375 taken by another group fails.
    ...(input.dockerService
      ? [`getent group docker >/dev/null || groupadd -g ${String(DOCKER_GID)} docker`]
      : []),
    "mkdir -p /etc/sudoers.d /etc/sealant",
    writeLines("/etc/sudoers.d/mend", PERSON_SUDOERS),
    "chmod 0440 /etc/sudoers.d/mend",
    "visudo -cqf /etc/sudoers.d/mend",
    `mkdir -p ${dirs.join(" ")}`,
    `chown root:${MEND_GROUP} ${dirs.join(" ")}`,
    `chmod 2775 ${dirs.join(" ")}`,
    writeLines(PERSON_SHARED_DIRS_PATH, dirs),
    writeLines(PERSON_ENV_PATH, PERSON_ENV_FILE),
    `mkdir -p ${skelDirs.map((dir) => `/etc/skel/${dir}`).join(" ")}`,
    ...PERSON_SKEL_LINKS.map(([link, target]) => `ln -sfn ${target} /etc/skel/${link}`),
    ...PERSON_SKEL_FILES.map(([path, lines]) => writeLines(`/etc/skel/${path}`, lines)),
    "git config --system --replace-all safe.directory '*'",
    // useradd -m makes homes with HOME_MODE: Ubuntu's is 0750, and every person's group is mend.
    "if grep -q '^HOME_MODE' /etc/login.defs; then sed -i 's/^HOME_MODE.*/HOME_MODE\\t0700/' /etc/login.defs; else printf 'HOME_MODE\\t0700\\n' >> /etc/login.defs; fi",
  ];
  return [
    "# Mend's person layout (ADR 0016): the mend group, sudo for it, shared toolchain directories",
    `# and ${PERSON_ENV_PATH} for processes run as a person. No ENV: root's environment is as before.`,
    `RUN ${install.mounts} \\`,
    `    ${commands.join("; \\\n    ")}`,
  ].join("\n");
};

/**
 * The probe, a POSIX `sh` script that runs in any base (custom ones guarantee nothing more). It
 * prints {@link WorkspaceImageProbe} as JSON. With `--require` it also fails when the image cannot
 * run the person layout, naming what is missing: the managed families build with it, so a managed
 * image that says it can always can. Run again at prepare, it also sees the runtime's
 * `no_new_privs`, under which `sudo` cannot raise a person's privileges.
 */
export const IMAGE_PROBE_SCRIPT: readonly string[] = [
  "#!/bin/sh",
  "# Sealant's image probe: can this image run one Linux user per person (Mend ADR 0016)?",
  'has() { command -v "$1" >/dev/null 2>&1; }',
  'flag() { if "$@"; then printf true; else printf false; fi; }',
  "sudo_path=$(command -v sudo 2>/dev/null || true)",
  "sudo_setuid=false",
  'if [ -n "$sudo_path" ] && [ -u "$sudo_path" ]; then sudo_setuid=true; fi',
  "passwd_writable=false",
  "if [ -f /etc/passwd ] && [ ! -L /etc/passwd ] && [ -w /etc/passwd ]; then passwd_writable=true; fi",
  "includes_dir=false",
  "if [ -r /etc/sudoers ]; then",
  '  while IFS= read -r line; do case "$line" in [@#]includedir*/etc/sudoers.d*) includes_dir=true;; esac; done < /etc/sudoers',
  "fi",
  "no_new_privs=false",
  "if [ -r /proc/self/status ]; then",
  '  while IFS= read -r line; do case "$line" in NoNewPrivs:*1) no_new_privs=true;; esac; done < /proc/self/status',
  "fi",
  "ids=''",
  'add_id() { case "$2" in *[!A-Za-z0-9._-]*) set -- "$1" invalid "$3";; esac; ids="$ids${ids:+,}\\"$1:$2:$3\\""; }',
  `in_range() { case "$1" in ''|*[!0-9]*) return 1;; esac; [ "$1" -ge ${String(RESERVED_ID_RANGE.first)} ] && [ "$1" -le ${String(RESERVED_ID_RANGE.last)} ]; }`,
  "if [ -r /etc/passwd ]; then",
  '  while IFS=: read -r name _ uid _; do if in_range "$uid"; then add_id user "$name" "$uid"; fi; done < /etc/passwd',
  "fi",
  "mend_group=absent",
  "if [ -r /etc/group ]; then",
  "  while IFS=: read -r name _ gid _; do",
  `    if [ "$name" = ${MEND_GROUP} ]; then if [ "$gid" = ${String(MEND_GID)} ]; then mend_group=present; else mend_group=conflict; fi; continue; fi`,
  `    if [ "$gid" = ${String(MEND_GID)} ]; then mend_group=conflict; fi`,
  '    if in_range "$gid"; then add_id group "$name" "$gid"; fi',
  "  done < /etc/group",
  "fi",
  "dirs=''",
  `if [ -r ${PERSON_SHARED_DIRS_PATH} ]; then`,
  `  while IFS= read -r d; do case "$d" in /*[!A-Za-z0-9/._-]*|'') ;; /*) dirs="$dirs\${dirs:+,}\\"$d\\"";; esac; done < ${PERSON_SHARED_DIRS_PATH}`,
  "fi",
  // `null`: this sealantd has no `capabilities` command. `"unreadable"`: it answered, but not with
  // a JSON object, which a reader takes as unknown rather than as missing capabilities.
  "sealantd_json=null",
  // The daemon to ask: the image's own, or another one a test names.
  "sealantd_bin=${SEALANT_PROBE_SEALANTD:-/usr/local/bin/sealantd}",
  'if [ -x "$sealantd_bin" ]; then',
  '  if has timeout; then out=$(timeout 10 "$sealantd_bin" capabilities --json 2>/dev/null); else out=$("$sealantd_bin" capabilities --json 2>/dev/null); fi',
  "  status=$?",
  '  out=${out#"${out%%[![:space:]]*}"}; out=${out%"${out##*[![:space:]]}"}',
  // Exit 2 is clap's "unrecognized subcommand": a sealantd from before the command. A timeout
  // (124), a crash or any other failure says nothing about what the daemon can do.
  '  if [ "$status" -eq 0 ]; then case "$out" in \'{\'*\'}\') sealantd_json=$out;; *) sealantd_json=\'"unreadable"\';; esac; elif [ "$status" -ne 2 ]; then sealantd_json=\'"unreadable"\'; fi',
  "fi",
  "sudoers_mend=$(flag test -f /etc/sudoers.d/mend)",
  `person_env=$(flag test -f ${PERSON_ENV_PATH})`,
  'printf \'{"version":1,"tools":{"sudo":%s,"sudoSetuid":%s,"useradd":%s,"groupadd":%s,"setfacl":%s,"getfacl":%s,"setpriv":%s,"flock":%s},\' \\',
  '  "$(flag has sudo)" "$sudo_setuid" "$(flag has useradd)" "$(flag has groupadd)" "$(flag has setfacl)" "$(flag has getfacl)" "$(flag has setpriv)" "$(flag has flock)"',
  'printf \'"sudoersMend":%s,"sudoersIncludesDir":%s,"noNewPrivileges":%s,"passwdWritable":%s,"mendGroup":"%s","reservedIdsInUse":[%s],"personEnv":%s,"sharedDirs":[%s],"sealantd":%s}\\n\' \\',
  '  "$sudoers_mend" "$includes_dir" "$no_new_privs" "$passwd_writable" "$mend_group" "$ids" "$person_env" "$dirs" "$sealantd_json"',
  'if [ "${1:-}" = --require ]; then',
  "  missing=''",
  '  [ "$sudo_setuid" = true ] || missing="$missing setuid-sudo"',
  '  [ "$sudoers_mend" = true ] || missing="$missing sudoers"',
  '  [ "$includes_dir" = true ] || missing="$missing sudoers-includedir"',
  '  has useradd || missing="$missing useradd"',
  '  has setfacl || missing="$missing setfacl"',
  '  has getfacl || missing="$missing getfacl"',
  // Every write of a person's logins into their home takes flock and drops to them with setpriv.
  '  has setpriv || missing="$missing setpriv"',
  '  has flock || missing="$missing flock"',
  '  [ "$passwd_writable" = true ] || missing="$missing passwd-writable"',
  '  [ "$mend_group" = present ] || missing="$missing mend-group"',
  '  [ "$person_env" = true ] || missing="$missing person-env"',
  '  [ -z "$ids" ] || missing="$missing reserved-ids:$ids"',
  '  if [ -n "$missing" ]; then echo "sealant: this image cannot run the person layout; missing:$missing" >&2; exit 1; fi',
  "fi",
];

/**
 * Writes the probe script into the image and runs it into {@link IMAGE_PROBE_PATH}. The last
 * filesystem step of every image, so it sees the image as it ships. The script stays in the image
 * so a prepare can ask the same question of a running executor. A managed family requires the
 * layout; a custom base may build as a user who cannot write `/etc`, so its probe never fails the
 * build and an image without an answer reads as unknown.
 */
export const renderImageProbeStep = (input: { readonly require: boolean }): string => {
  const steps = [
    "mkdir -p /usr/local/lib/sealant /etc/sealant",
    writeLines(IMAGE_PROBE_SCRIPT_PATH, IMAGE_PROBE_SCRIPT),
    `chmod 0755 ${IMAGE_PROBE_SCRIPT_PATH}`,
    `${IMAGE_PROBE_SCRIPT_PATH}${input.require ? " --require" : ""} > ${IMAGE_PROBE_PATH}`,
  ];
  return [
    "# The image probe: what this image offers the person layout, recorded in the image.",
    input.require
      ? `RUN ${steps.join(" && \\\n    ")}`
      : `RUN { ${steps.join(" && \\\n    ")}; } || echo 'sealant: the image probe could not be written; this image reads as unknown.' >&2`,
  ].join("\n");
};

/** sealantd capabilities the person layout needs (reported by `sealantd capabilities --json`). */
export const PERSON_LAYOUT_SEALANTD_CAPABILITIES = [
  "exec.user",
  "dotfiles.user",
  "restore.owner_map",
] as const;

export type PersonLayoutSupport = {
  /** `unknown` when nothing is missing but something could not be read. */
  readonly status: "supported" | "unsupported" | "unknown";
  readonly missing: readonly string[];
  readonly unknown: readonly string[];
};

/**
 * Whether an image can run the person layout, from its probe and what the runtime adds.
 * `missing` holds stable codes: `setuid-sudo`, `sudo-no-new-privileges` (the probe ran under
 * `no_new_privs`, or the runtime sets it: Kubernetes pods run with `allowPrivilegeEscalation:
 * false`), `useradd`, `groupadd` (no `mend` group and nothing to add it with), `sudoers` (no rule
 * and no `includedir` to add one in), `setfacl`, `passwd-writable`, `mend-group` (its name or gid
 * taken), `reserved-ids`, `setpriv` and `flock` (every write into a person's home needs them;
 * `flock` is unknown on images probed before it was recorded), and `sealantd:<capability>` for each capability a sealantd that answers
 * does not list (all three for a sealantd without the command). `unknown` holds `sealantd` when it
 * answered with something this reader cannot read. ACL support on `/workspace` is the runtime's to
 * report.
 */
export const imagePersonLayoutSupport = (
  probe: WorkspaceImageProbe,
  runtime: { readonly noNewPrivileges?: boolean } = {},
): PersonLayoutSupport => {
  const missing: string[] = [];
  const unknown: string[] = [];
  if (!probe.tools.sudo || !probe.tools.sudoSetuid) missing.push("setuid-sudo");
  if (probe.noNewPrivileges || runtime.noNewPrivileges === true) {
    missing.push("sudo-no-new-privileges");
  }
  if (!probe.tools.useradd) missing.push("useradd");
  if (probe.mendGroup === "absent" && !probe.tools.groupadd) missing.push("groupadd");
  if (!probe.sudoersMend && !probe.sudoersIncludesDir) missing.push("sudoers");
  if (!probe.tools.setfacl) missing.push("setfacl");
  // Core writes a person's logins into their home under flock, as them through setpriv.
  if (!probe.tools.setpriv) missing.push("setpriv");
  if (probe.tools.flock === false) missing.push("flock");
  if (probe.tools.flock === undefined) unknown.push("flock");
  if (!probe.passwdWritable) missing.push("passwd-writable");
  if (probe.mendGroup === "conflict") missing.push("mend-group");
  if (probe.reservedIdsInUse.length > 0) missing.push("reserved-ids");
  const reported = sealantdCapabilities(probe.sealantd);
  if (reported === "unknown") {
    unknown.push("sealantd");
  } else {
    for (const capability of PERSON_LAYOUT_SEALANTD_CAPABILITIES) {
      if (!reported.has(capability)) missing.push(`sealantd:${capability}`);
    }
  }
  const status = missing.length > 0 ? "unsupported" : unknown.length > 0 ? "unknown" : "supported";
  return { status, missing, unknown };
};

/**
 * The capability names a `sealantd capabilities --json` object lists under `supports` (sealantd#147:
 * `{ schemaVersion, daemonVersion, os, arch, supports }`, the list `runtime.getCapabilities`
 * answers): none for a sealantd without the command, unknown for an answer of another shape.
 */
const sealantdCapabilities = (
  report: WorkspaceImageProbe["sealantd"],
): ReadonlySet<string> | "unknown" => {
  if (report === null) return new Set();
  if (typeof report === "string") return "unknown";
  const listed = report["supports"];
  if (!Array.isArray(listed) || !listed.every((entry) => typeof entry === "string")) {
    return "unknown";
  }
  return new Set(listed);
};
