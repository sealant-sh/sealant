/**
 * The person layout of the managed workspace images (Mend's ADR 0016, delivery 9): what an image
 * needs so that every person who runs something in a workspace can be a Linux user of their own,
 * and the probe that records, inside every built image, whether it can.
 *
 * What the managed families (Fedora, Arch, Ubuntu) get:
 *
 * - **The `mend` group** (gid 40000) and **passwordless `sudo`** for it, with `umask 0002` and the
 *   toolchain variables kept, so `sudo npm i -g` lands where a person's own install would. This is
 *   deliberately not isolation: anyone in the group can read and change anyone's files.
 * - **`useradd` and the ACL tools** on every base: Ubuntu and Arch lack `sudo`, Ubuntu and Fedora
 *   lack `acl`, Fedora lacks `setpriv` (`util-linux`). Users themselves are made at executor
 *   prepare, by Mend, never at build.
 * - **Shared toolchains under `/opt` and caches under `/var/cache`**, owned by root and `mend`,
 *   mode 2775, and named in the image's `ENV` so every process sees them. Default ACLs set at build
 *   do not survive into the image (verified 2026-10-06 for BuildKit and the legacy builder), so
 *   sealantd sets them at boot, as root, on every directory the image names in
 *   `SEALANT_PERSON_SHARED_DIRS` ({@link PERSON_SHARED_DIRS} and {@link PERSON_SHARED_SUBDIRS}).
 * - **`/etc/skel` links** from the per-user homes into the shared caches, for the tools whose cache
 *   lives beside their credentials (cargo, Gradle, Maven). Each person's credential stores stay in
 *   their own home: see {@link PERSON_TOOLCHAINS}, which lists what is shared and what is not for
 *   every tool.
 * - **`safe.directory = *`** in `/etc/gitconfig`: files in a shared worktree belong to several uids,
 *   and git before 2.46 has no prefix wildcard for nested and linked repositories.
 *
 * Nix images get none of it and take one person: their passwd is in the read-only store, the store
 * cannot hold a setuid `sudo`, and non-root nix needs the daemon. Custom base images get only the
 * probe: whatever the base carries decides.
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
    shared: ["/opt/mise (MISE_DATA_DIR: installs, downloads, shims on PATH)"],
    // mise creates its lock files 0644 whatever the umask, so a second person could never take a
    // lock in a shared cache (measured 2026-10-06); the cache holds no install, only metadata.
    perUser: ["~/.config/mise", "~/.local/state/mise (trust)", "~/.cache/mise (lock files)"],
  },
  {
    tool: "uv",
    shared: [
      "/opt/uv/python (UV_PYTHON_INSTALL_DIR)",
      "/opt/uv/tools (UV_TOOL_DIR)",
      "/opt/uv/bin (UV_TOOL_BIN_DIR, UV_PYTHON_BIN_DIR)",
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
    perUser: ["~/.cargo (CARGO_HOME): credentials.toml, config.toml"],
  },
  {
    tool: "pnpm, npm, corepack, bun",
    shared: [
      "/opt/pnpm (PNPM_HOME, on PATH)",
      "/var/cache/pnpm (npm_config_store_dir, pnpm_config_store_dir)",
      "/var/cache/npm (npm_config_cache)",
      "/opt/npm-global (npm_config_prefix, bin on PATH)",
      "/opt/corepack (COREPACK_HOME)",
      "/opt/bun (BUN_INSTALL, bin on PATH)",
    ],
    perUser: ["~/.npmrc", "~/.bunfig.toml"],
  },
  {
    tool: "browsers for tests",
    shared: [
      "/opt/ms-playwright (PLAYWRIGHT_BROWSERS_PATH)",
      "/opt/puppeteer (PUPPETEER_CACHE_DIR)",
      "/opt/cypress (CYPRESS_CACHE_FOLDER)",
      "/var/cache/node-gyp (npm_config_devdir)",
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
    tool: "nvm, pyenv",
    shared: ["/opt/nvm (NVM_DIR)", "/opt/pyenv (PYENV_ROOT)"],
    perUser: [],
  },
  {
    tool: "gcloud, AWS, kubectl, Docker, gh, Hugging Face, firebase, git, curl",
    shared: [],
    perUser: ["their usual paths under ~"],
  },
];

/** The shared toolchain and cache directories. Created 2775 root:mend. */
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
  "/opt/nvm",
  "/opt/pyenv",
  "/var/cache/uv",
  "/var/cache/cargo",
  "/var/cache/pnpm",
  "/var/cache/npm",
  "/var/cache/node-gyp",
  "/var/cache/go",
  "/var/cache/pip",
  "/var/cache/gradle",
  "/var/cache/m2",
];

/**
 * Directories inside the shared ones that must exist before anyone runs a tool: the targets of the
 * `/etc/skel` links (a link to nothing makes `mkdir -p ~/.cargo/registry` fail) and the `bin`
 * directories on `PATH`. Also 2775 root:mend.
 */
export const PERSON_SHARED_SUBDIRS: readonly string[] = [
  "/opt/uv/bin",
  "/opt/rust/rustup",
  "/opt/rust/cargo/bin",
  "/opt/npm-global/bin",
  "/opt/npm-global/lib",
  "/opt/bun/bin",
  "/var/cache/cargo/registry",
  "/var/cache/cargo/git",
  "/var/cache/gradle/caches",
  "/var/cache/gradle/wrapper",
  "/var/cache/m2/repository",
];

/** `/etc/skel` entries: each person's home links these paths to the shared ones. */
export const PERSON_SKEL_LINKS: ReadonlyArray<readonly [link: string, target: string]> = [
  [".cargo/bin", "/opt/rust/cargo/bin"],
  [".cargo/registry", "/var/cache/cargo/registry"],
  [".cargo/git", "/var/cache/cargo/git"],
  [".gradle/caches", "/var/cache/gradle/caches"],
  [".gradle/wrapper", "/var/cache/gradle/wrapper"],
  [".m2/repository", "/var/cache/m2/repository"],
];

/** Shared bin directories, ahead of the image's own `PATH`, so a person's install wins. */
const PERSON_PATH_PREFIX = [
  "/opt/mise/shims",
  "/opt/npm-global/bin",
  "/opt/pnpm",
  "/opt/uv/bin",
  "/opt/rust/cargo/bin",
  "/opt/bun/bin",
];

/** The image's toolchain variables. `sudo` keeps every one of them. */
export const PERSON_TOOLCHAIN_ENV: ReadonlyArray<readonly [string, string]> = [
  ["MISE_DATA_DIR", "/opt/mise"],
  ["UV_PYTHON_INSTALL_DIR", "/opt/uv/python"],
  ["UV_PYTHON_BIN_DIR", "/opt/uv/bin"],
  ["UV_TOOL_DIR", "/opt/uv/tools"],
  ["UV_TOOL_BIN_DIR", "/opt/uv/bin"],
  ["UV_CACHE_DIR", "/var/cache/uv"],
  ["RUSTUP_HOME", "/opt/rust/rustup"],
  ["PNPM_HOME", "/opt/pnpm"],
  // pnpm reads its settings from `npm_config_*` up to 10 and from `pnpm_config_*` from 11 on.
  ["npm_config_store_dir", "/var/cache/pnpm"],
  ["pnpm_config_store_dir", "/var/cache/pnpm"],
  ["npm_config_cache", "/var/cache/npm"],
  ["npm_config_prefix", "/opt/npm-global"],
  ["npm_config_devdir", "/var/cache/node-gyp"],
  ["COREPACK_HOME", "/opt/corepack"],
  ["BUN_INSTALL", "/opt/bun"],
  ["PLAYWRIGHT_BROWSERS_PATH", "/opt/ms-playwright"],
  ["PUPPETEER_CACHE_DIR", "/opt/puppeteer"],
  ["CYPRESS_CACHE_FOLDER", "/opt/cypress"],
  ["GOMODCACHE", "/var/cache/go/mod"],
  ["GOCACHE", "/var/cache/go/build"],
  ["PIP_CACHE_DIR", "/var/cache/pip"],
  ["NVM_DIR", "/opt/nvm"],
  ["PYENV_ROOT", "/opt/pyenv"],
];

const SUDO_SECURE_PATH = [
  ...PERSON_PATH_PREFIX,
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");

/** `/etc/sudoers.d/mend`. */
export const PERSON_SUDOERS: readonly string[] = [
  "# Mend's person layout (ADR 0016): everyone in mend has passwordless sudo. Not isolation.",
  `%${MEND_GROUP} ALL=(ALL:ALL) NOPASSWD: ALL`,
  "Defaults umask=0002",
  "Defaults umask_override",
  `Defaults env_keep += "${PERSON_TOOLCHAIN_ENV.map(([name]) => name).join(" ")}"`,
  `Defaults secure_path="${SUDO_SECURE_PATH}"`,
];

/**
 * Repository packages each managed family adds for the person layout. Arch and Ubuntu install them
 * in the person layout's own layer, where the layer costs what the packages weigh (2.5 MB and
 * 4.3 MB, measured 2026-10-06). Fedora installs them in its package layer: any RPM install rewrites
 * `rpmdb.sqlite` whole, which made a layer of its own 13.7 MB for `acl`'s 224 KB.
 */
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

/** The families whose person-layout packages go in their package layer instead (see above). */
export const PERSON_LAYOUT_PACKAGES_IN_PACKAGE_LAYER: ReadonlySet<PersonLayoutFamily> = new Set([
  "fedora",
]);

/**
 * Installs a family's person-layout packages in the layout's layer, with the same cache mounts as
 * its package layer. None for a family that installs them in its package layer.
 */
const personLayoutPackageInstall = (
  family: PersonLayoutFamily,
): { mounts: string; commands: readonly string[] } => {
  const packages = PERSON_LAYOUT_PACKAGES[family].join(" ");
  switch (family) {
    case "fedora":
      return { mounts: "", commands: [] };
    case "arch":
      return {
        mounts: "--mount=type=cache,target=/var/cache/pacman/pkg",
        commands: [
          `pacman -S --noconfirm --needed ${packages}`,
          "{ pacman -Scc --noconfirm || true; }",
        ],
      };
    case "ubuntu":
      return {
        mounts:
          "--mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked",
        commands: [
          "apt-get update",
          `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages}`,
        ],
      };
  }
};

/**
 * The person layout's Dockerfile steps for a managed family: one `RUN` for its packages, the group,
 * `sudo`, the shared directories and the `/etc/skel` links, then one `ENV` for the toolchain
 * variables. Placed after the harness installs, so the package and harness layers of images built
 * before it stay cached (a rebuild for this layout pays seconds, not the whole image) and the
 * harness binaries stay where they were.
 */
export const renderPersonLayoutSteps = (input: {
  readonly family: PersonLayoutFamily;
  readonly dockerService: boolean;
}): string => {
  const install = personLayoutPackageInstall(input.family);
  const dirs = [...PERSON_SHARED_DIRS, ...PERSON_SHARED_SUBDIRS];
  const skelParents = [...new Set(PERSON_SKEL_LINKS.map(([link]) => link.split("/")[0] ?? link))];
  const commands = [
    // `set -e` does not stop at a failed command inside `a && b`, so every step stands alone.
    "set -eu",
    ...install.commands,
    `groupadd -g ${String(MEND_GID)} ${MEND_GROUP}`,
    ...(input.dockerService ? [`groupadd -f -g ${String(DOCKER_GID)} docker`] : []),
    "mkdir -p /etc/sudoers.d",
    writeLines("/etc/sudoers.d/mend", PERSON_SUDOERS),
    "chmod 0440 /etc/sudoers.d/mend",
    "visudo -cqf /etc/sudoers.d/mend",
    `mkdir -p ${dirs.join(" ")}`,
    `chown root:${MEND_GROUP} ${dirs.join(" ")}`,
    `chmod 2775 ${dirs.join(" ")}`,
    `mkdir -p ${skelParents.map((parent) => `/etc/skel/${parent}`).join(" ")}`,
    ...PERSON_SKEL_LINKS.map(([link, target]) => `ln -sfn ${target} /etc/skel/${link}`),
    "git config --system --replace-all safe.directory '*'",
  ];
  const env: ReadonlyArray<readonly [string, string]> = [
    // Every directory made here, so sealantd's default ACL at boot covers the ones made ahead of
    // the tools as well as the top ones.
    ["SEALANT_PERSON_SHARED_DIRS", dirs.join(":")],
    ...PERSON_TOOLCHAIN_ENV,
  ];
  return [
    "# Mend's person layout (ADR 0016): the mend group, sudo for it, shared toolchains under /opt",
    "# and caches under /var/cache, each person's credential stores in their own home.",
    `RUN ${install.mounts === "" ? "" : `${install.mounts} `}\\`,
    `    ${commands.join("; \\\n    ")}`,
    `ENV ${env.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" \\\n    ")} \\`,
    `    PATH=${PERSON_PATH_PREFIX.join(":")}:$PATH`,
  ].join("\n");
};

/**
 * The probe, a POSIX `sh` script that runs in any base (custom ones guarantee nothing more). It
 * prints {@link WorkspaceImageProbe} as JSON. With `--require` it also fails when the image cannot
 * run the person layout, naming what is missing: the managed families build with it, so a managed
 * image that says it can always can.
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
  "old_ifs=$IFS; IFS=:; set -f",
  'for d in ${SEALANT_PERSON_SHARED_DIRS:-}; do [ -n "$d" ] && dirs="$dirs${dirs:+,}\\"$d\\""; done',
  "IFS=$old_ifs; set +f",
  "sealantd_json=null",
  "if [ -x /usr/local/bin/sealantd ]; then",
  "  if has timeout; then out=$(timeout 10 /usr/local/bin/sealantd capabilities --json 2>/dev/null); else out=$(/usr/local/bin/sealantd capabilities --json 2>/dev/null); fi",
  "  status=$?",
  '  if [ "$status" -eq 0 ]; then case "$out" in \'{\'*) sealantd_json=$out;; esac; fi',
  "fi",
  "sudoers_mend=$(flag test -f /etc/sudoers.d/mend)",
  'printf \'{"version":1,"tools":{"sudo":%s,"sudoSetuid":%s,"useradd":%s,"groupadd":%s,"setfacl":%s,"getfacl":%s,"setpriv":%s},\' \\',
  '  "$(flag has sudo)" "$sudo_setuid" "$(flag has useradd)" "$(flag has groupadd)" "$(flag has setfacl)" "$(flag has getfacl)" "$(flag has setpriv)"',
  'printf \'"sudoersMend":%s,"passwdWritable":%s,"mendGroup":"%s","reservedIdsInUse":[%s],"sharedDirs":[%s],"sealantd":%s}\\n\' \\',
  '  "$sudoers_mend" "$passwd_writable" "$mend_group" "$ids" "$dirs" "$sealantd_json"',
  'if [ "${1:-}" = --require ]; then',
  "  missing=''",
  '  [ "$sudo_setuid" = true ] || missing="$missing setuid-sudo"',
  '  [ "$sudoers_mend" = true ] || missing="$missing sudoers"',
  '  has useradd || missing="$missing useradd"',
  '  has setfacl || missing="$missing setfacl"',
  '  has getfacl || missing="$missing getfacl"',
  '  [ "$passwd_writable" = true ] || missing="$missing passwd-writable"',
  '  [ "$mend_group" = present ] || missing="$missing mend-group"',
  '  [ -z "$ids" ] || missing="$missing reserved-ids:$ids"',
  '  if [ -n "$missing" ]; then echo "sealant: this image cannot run the person layout; missing:$missing" >&2; exit 1; fi',
  "fi",
];

/**
 * Writes the probe script into the image and runs it into {@link IMAGE_PROBE_PATH}. The last
 * filesystem step of every image, so it sees the image as it ships. The script stays in the image
 * so a prepare can ask the same question of a running executor.
 */
export const renderImageProbeStep = (input: { readonly require: boolean }): string =>
  [
    "# The image probe: what this image offers the person layout, recorded in the image.",
    `RUN mkdir -p /usr/local/lib/sealant /etc/sealant && \\`,
    `    ${writeLines(IMAGE_PROBE_SCRIPT_PATH, IMAGE_PROBE_SCRIPT)} && \\`,
    `    chmod 0755 ${IMAGE_PROBE_SCRIPT_PATH} && \\`,
    `    ${IMAGE_PROBE_SCRIPT_PATH}${input.require ? " --require" : ""} > ${IMAGE_PROBE_PATH}`,
  ].join("\n");

/** sealantd capabilities the person layout needs (reported by `sealantd capabilities --json`). */
export const PERSON_LAYOUT_SEALANTD_CAPABILITIES = [
  "exec.user",
  "dotfiles.user",
  "restore.owner_map",
] as const;

/**
 * Why an image can or cannot run the person layout, from its probe alone. Runtime facts (ACL
 * support on `/workspace`) are the runtime's to report. `missing` holds stable codes:
 * `setuid-sudo`, `useradd`, `setfacl`, `passwd-writable`, `mend-group`, `reserved-ids`, and
 * `sealantd:<capability>` for each capability the image's sealantd does not report (all three when
 * the sealantd has no `capabilities` command). A `mend` group or sudoers rule that is absent is not
 * missing: prepare runs as root and can add them; a `mend` name or gid taken by something else is.
 */
export const imagePersonLayoutSupport = (
  probe: WorkspaceImageProbe,
): { readonly supported: boolean; readonly missing: readonly string[] } => {
  const missing: string[] = [];
  if (!probe.tools.sudo || !probe.tools.sudoSetuid) missing.push("setuid-sudo");
  if (!probe.tools.useradd) missing.push("useradd");
  if (!probe.tools.setfacl) missing.push("setfacl");
  if (!probe.passwdWritable) missing.push("passwd-writable");
  if (probe.mendGroup === "conflict") missing.push("mend-group");
  if (probe.reservedIdsInUse.length > 0) missing.push("reserved-ids");
  const reported = sealantdCapabilities(probe.sealantd);
  for (const capability of PERSON_LAYOUT_SEALANTD_CAPABILITIES) {
    if (!reported.has(capability)) missing.push(`sealantd:${capability}`);
  }
  return { supported: missing.length === 0, missing };
};

/** The capability names a `sealantd capabilities --json` object lists under `capabilities`. */
const sealantdCapabilities = (report: WorkspaceImageProbe["sealantd"]): ReadonlySet<string> => {
  const listed = report?.["capabilities"];
  if (!Array.isArray(listed)) return new Set();
  return new Set(listed.filter((entry): entry is string => typeof entry === "string"));
};
